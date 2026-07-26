/**
 * The router. Only writer of state, owner of the clock, host of the scorecard UI.
 *
 * Deployed as an always-on Maritime agent (`--always-on` matters: a sleeping webhook
 * receiver drops events). Inside that container the platform injects OPENAI_BASE_URL and
 * OPENAI_API_KEY, which is how the judge gets a working model without any key of ours.
 */
import express from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config, ROOT, loadAllowlist } from './config.ts';
import { db, events, haltSends, resumeSends, sendsHalted, logEvent } from './db/index.ts';
import { seedPersona } from './db/seed.ts';
import { targets, runs, messages, personas, sendQueue } from './db/repo.ts';
import { ingestTarget } from './pipeline/intake.ts';
import { openRun, handleInbound, sweep, useAdapter, checkSendGate, cleanupRun, todayCycle } from './pipeline/loop.ts';
import { judgeStatus, listModels } from './judge/llm.ts';
import { runCalibration } from './judge/calibrate.ts';
import { OUTCOMES } from './domain/states.ts';
import { ghlAdapter, bindRun, ensureContact, runIdForConversation } from './channels/ghl.ts';
import { mockAdapter } from './channels/mock.ts';
import type { InboundEvent } from './channels/types.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

db();
const persona = seedPersona();

const adapter = config.channel.default === 'ghl' && ghlAdapter.available() ? ghlAdapter : mockAdapter;
useAdapter(adapter);

/** One entry point for inbound, whatever the transport. */
async function sink(event: InboundEvent): Promise<void> {
  const runId = event.run_id ?? runIdForConversation(event.provider_id);
  if (!runId) {
    logEvent(null, 'inbound_unrouted', { provider: event.provider, provider_id: event.provider_id });
    return;
  }
  const res = await handleInbound({ ...event, run_id: runId });
  logEvent(runId, 'inbound_result', { handled: res.handled, reason: res.reason, decision: res.decision ?? null });
}

adapter.start?.(sink);

// -------------------------------------------------------------------- health ---

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    adapter: adapter.name,
    judge: judgeStatus(),
    live_sends: config.channel.allowLiveSends,
    sends_halted: sendsHalted(),
    allowlist: loadAllowlist(),
    persona: { id: persona.id, name: persona.name, need_tags: persona.need_tags },
    runs: runs.list().length,
  });
});

/**
 * The LLM proxy has no /models endpoint, so discovery is a test call per candidate.
 * A wrong model name in env is otherwise a silent 404 at the worst possible moment.
 */
app.get('/api/health/models', async (_req, res) => {
  res.json(await listModels());
});

/**
 * Runs the hand-labeled calibration set against whatever judge is live (spec section 6).
 * The 80% gate is an assertion in the test suite, but it also has to be checkable against
 * the deployed configuration — the model in production is not the one tests ran with.
 */
app.get('/api/health/calibration', async (_req, res) => {
  try {
    const result = await runCalibration();
    res.status(result.passed ? 200 : 503).json({ ok: result.passed, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ------------------------------------------------------------------- targets ---

app.post('/api/targets', async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  try {
    const result = await ingestTarget(url, { domain: req.body?.domain ?? null });
    res.json({
      ok: true,
      target: result.target,
      reachability: result.reachability,
      pages: result.pages,
      services_source: result.services_source,
      send_gate: checkSendGate(result.target),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/targets', (_req, res) => res.json({ ok: true, targets: targets.list() }));

// ---------------------------------------------------------------------- runs ---

app.post('/api/runs', async (req, res) => {
  const targetId = String(req.body?.target_id ?? '');
  const target = targets.get(targetId);
  if (!target) return res.status(404).json({ ok: false, error: 'target not found' });

  // Bind a CRM contact before the first send so inbound polling is scoped to this run.
  if (adapter.name === 'ghl') {
    const phone = target.phones[0]?.number;
    if (!phone) return res.status(400).json({ ok: false, error: 'target has no phone to bind' });
    const contact = await ensureContact({ phone, name: persona.name, runId: 'pending' });
    if ('error' in contact) return res.status(502).json({ ok: false, error: contact.error });
    const opened = await openRun(targetId, { cycle: req.body?.cycle });
    if (opened.ok) bindRun(opened.run.id, { contact_id: contact.contact_id, conversation_id: null });
    return res.json({ ok: opened.ok, run: opened.run, reason: opened.ok ? opened.first_contact : opened.reason });
  }

  const opened = await openRun(targetId, { cycle: req.body?.cycle });
  res.json({ ok: opened.ok, run: opened.run, reason: opened.ok ? opened.first_contact : opened.reason });
});

app.get('/api/runs', (_req, res) => {
  const list = runs.list().map((run) => {
    const target = targets.get(run.target_id);
    return {
      ...run,
      target_name: target?.name ?? null,
      target_domain: target?.domain ?? null,
      outcome: run.terminal_state ? OUTCOMES[run.terminal_state] : null,
    };
  });
  res.json({ ok: true, runs: list, cycle: todayCycle() });
});

app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'run not found' });
  res.json({
    ok: true,
    run,
    target: targets.get(run.target_id),
    persona: personas.get(run.persona_id),
    transcript: messages.forRun(run.id),
    pending_sends: sendQueue.pendingForRun(run.id),
    outcome: run.terminal_state ? OUTCOMES[run.terminal_state] : null,
    events: events(run.id, 100),
  });
});

app.post('/api/runs/:id/cleanup', async (req, res) => {
  res.json({ ok: true, ...(await cleanupRun(req.params.id)) });
});

// ------------------------------------------------------------------- inbound ---

/**
 * Webhook receiver. Dedupe happens in the DB on (provider, provider_id), so a replayed
 * delivery is safe and we always answer 200 — a 500 makes the provider retry forever.
 */
app.post('/api/inbound/:provider', async (req, res) => {
  const body = req.body ?? {};
  const event: InboundEvent = {
    provider: req.params.provider,
    provider_id: String(body.messageId ?? body.id ?? body.provider_id ?? ''),
    from: String(body.from ?? body.contactId ?? ''),
    to: String(body.to ?? ''),
    body: String(body.message ?? body.body ?? ''),
    ts: String(body.dateAdded ?? body.ts ?? new Date().toISOString()),
    run_id: body.run_id,
  };
  if (!event.provider_id || !event.body) {
    return res.status(202).json({ ok: true, ignored: 'missing message id or body' });
  }
  try {
    await sink(event);
  } catch (err) {
    logEvent(event.run_id ?? null, 'inbound_error', { error: (err as Error).message });
  }
  res.json({ ok: true });
});

// ------------------------------------------------------------------- control ---

app.post('/api/control/halt', (req, res) => {
  haltSends(String(req.body?.reason ?? 'halted via API'));
  res.json({ ok: true, sends_halted: true });
});

app.post('/api/control/resume', (_req, res) => {
  resumeSends();
  res.json({ ok: true, sends_halted: false });
});

app.post('/api/control/sweep', async (_req, res) => res.json({ ok: true, report: await sweep() }));

app.get('/api/events', (req, res) => {
  res.json({ ok: true, events: events(req.query.run_id as string | undefined, 200) });
});

// ------------------------------------------------------------------------ ui ---

const publicDir = resolve(ROOT, 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(publicDir, 'index.html')));
}

// --------------------------------------------------------------------- boot ---

const sweepTimer = setInterval(() => {
  void sweep().catch((err) => logEvent(null, 'sweep_error', { error: (err as Error).message }));
}, config.loop.sweepMs);
sweepTimer.unref?.();

/**
 * Maritime injects PORT (e.g. 18789) but routes public traffic to the port declared at
 * `maritime create --port`. Those disagree, and guessing wrong means the platform health
 * check fails and kills the process. Binding both removes the guess.
 */
const ports = [...new Set([config.port, config.exposedPort].filter((p) => p > 0))];
const servers = ports.map((port) =>
  app.listen(port, () => {
    console.log(`  listening    :${port}`);
  }),
);

{
  const judge = judgeStatus();
  console.log(`intake-grader router`);
  console.log(`  adapter      ${adapter.name}`);
  console.log(`  judge        ${judge.driver}${judge.driver === 'http' ? ` (${judge.model})` : ''} — ${judge.reason}`);
  console.log(`  live sends   ${config.channel.allowLiveSends}   allowlist ${JSON.stringify(loadAllowlist())}`);
  console.log(`  persona      ${persona.name} [${persona.need_tags.join(', ')}]`);
  console.log(`  sweep every  ${config.loop.sweepMs / 1000}s`);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    adapter.stop?.();
    clearInterval(sweepTimer);
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
