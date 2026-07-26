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
import { ghlAdapter, bindRun, ensureContact, runForProviderIds, parseGhlWebhook, markSeen, drainForContact } from './channels/ghl.ts';
import { mockAdapter } from './channels/mock.ts';
import type { InboundEvent } from './channels/types.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

db();
const persona = seedPersona();

const adapter = config.channel.default === 'ghl' && ghlAdapter.available() ? ghlAdapter : mockAdapter;
useAdapter(adapter);

/**
 * One entry point for inbound, whatever the transport.
 *
 * Routing is by contact or conversation id, never by message id — a message id identifies
 * the message, not the run it belongs to, and looking a run up by it always fails.
 */
async function sink(
  event: InboundEvent & { contact_id?: string | null; conversation_id?: string | null },
): Promise<{ handled: boolean; reason: string; run_id: string | null }> {
  const runId =
    event.run_id ??
    runForProviderIds({ conversationId: event.conversation_id, contactId: event.contact_id ?? event.from });

  if (!runId) {
    logEvent(null, 'inbound_unrouted', {
      provider: event.provider,
      provider_id: event.provider_id,
      contact_id: event.contact_id ?? event.from,
      conversation_id: event.conversation_id ?? null,
    });
    return { handled: false, reason: 'no run is bound to this contact or conversation', run_id: null };
  }
  const res = await handleInbound({ ...event, run_id: runId });
  logEvent(runId, 'inbound_result', {
    handled: res.handled,
    reason: res.reason,
    decision: res.decision ?? null,
    source: event.run_id ? 'poll' : 'webhook',
  });
  return { handled: res.handled, reason: res.reason, run_id: runId };
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
    webhook: {
      path: '/api/inbound/ghl',
      url: config.routerPublicUrl ? config.routerPublicUrl.replace(/\/$/, '') + '/api/inbound/ghl' : null,
      secret_required: !!config.webhookSecret,
      poll_backstop_ms: config.channel.ghl.pollMs,
    },
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

/**
 * Seeds a synthetic target for a human-played run: someone plays the business on a phone
 * they own, so there is no site to ingest. Services are set to match the persona's need
 * tags, which makes the run qualified and exercises the full path.
 *
 * Still fully gated — the domain must be on the allowlist, so this cannot be used to
 * point the harness at a real business that has not been named explicitly.
 */
app.post('/api/targets/seed', (req, res) => {
  const phone = String(req.body?.phone ?? '').trim();
  if (!/^\+\d{8,15}$/.test(phone)) {
    return res.status(400).json({ ok: false, error: 'phone must be E.164, e.g. +15551234567' });
  }
  const domain = String(req.body?.domain ?? 'whitcomb-injury.test').trim().toLowerCase();
  const timezone = String(req.body?.timezone ?? 'America/New_York');

  const target = targets.upsert({
    url: `https://${domain}/`,
    domain,
    name: String(req.body?.name ?? 'Whitcomb Injury Law'),
    category: 'law_firm',
    city: String(req.body?.city ?? 'New York, NY'),
    timezone,
    services: Array.isArray(req.body?.services) && req.body.services.length
      ? req.body.services
      : ['car_accident', 'personal_injury', 'truck_accident', 'wrongful_death'],
    stated_hours_text: 'Hours: Monday - Friday 9:00am - 6:00pm',
    hours: [1, 2, 3, 4, 5].map((day) => ({ day, open: 9 * 60, close: 18 * 60 })),
    hours_confidence: 'high',
    claims_247: !!req.body?.claims_247,
    chat_widget: null,
    form: null,
    reachable: true,
    ingest_notes: ['seeded for a human-played run; not scraped from a site'],
    phones: [{ number: phone, line_type: 'mobile', sms_capable: true, source: 'seeded' }],
    emails: [],
  });

  const gate = checkSendGate(target);
  res.json({ ok: true, target, send_gate: gate });
});

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
 * Webhook receiver.
 *
 * Always answers 2xx once the payload is authenticated. Dedupe on (provider, provider_id)
 * makes a replayed delivery harmless, and a 500 would make the provider retry the same bad
 * payload indefinitely — so parse failures are logged and acknowledged, not errored.
 *
 * GoHighLevel workflow webhooks cannot sign their requests, so the shared secret travels
 * in the URL or a header. Without WEBHOOK_SECRET set the endpoint is open, which is fine
 * locally and not fine on a public router; the health endpoint reports which it is.
 */
function webhookAuthorized(req: express.Request): boolean {
  const expected = config.webhookSecret;
  if (!expected) return true;
  const supplied =
    (req.get('x-webhook-secret') ?? '') ||
    String(req.query.secret ?? '') ||
    String((req.body ?? {}).secret ?? '');
  // Length-first comparison avoids leaking the secret's length through timing.
  return supplied.length === expected.length && supplied === expected;
}

app.post('/api/inbound/:provider', async (req, res) => {
  if (!webhookAuthorized(req)) {
    logEvent(null, 'webhook_rejected', { provider: req.params.provider, reason: 'bad or missing secret' });
    return res.status(401).json({ ok: false, error: 'bad or missing webhook secret' });
  }

  const payload = (req.body ?? {}) as Record<string, any>;
  logEvent(null, 'webhook_received', { provider: req.params.provider, keys: Object.keys(payload).slice(0, 25) });

  try {
    if (req.params.provider === 'ghl') {
      const { event, skip } = parseGhlWebhook(payload);

      if (event) {
        markSeen(event.provider_id);
        const result = await sink(event);
        return res.json({ ok: true, source: 'payload', ...result });
      }

      /**
       * GoHighLevel's workflow webhook action fires "containing the contact's details" —
       * it carries the contact but not reliably a message id or body. Rather than depend
       * on merge tags being configured correctly in the UI, treat the webhook as a signal
       * and read the conversation from the API, which is authoritative. Latency is then the
       * webhook's rather than the poll interval's, and dedupe still uses the provider's own
       * message ids.
       */
      const contactId = payload.contact_id ?? payload.contactId ?? null;
      const conversationId = payload.conversation_id ?? payload.conversationId ?? null;
      if (contactId || conversationId) {
        const drained = await drainForContact({ contactId, conversationId });
        logEvent(drained.run_id, 'webhook_triggered_read', {
          reason: skip,
          contact_id: contactId,
          delivered: drained.delivered,
        });
        return res.json({ ok: true, source: 'webhook_triggered_read', ...drained });
      }

      logEvent(null, 'webhook_skipped', { reason: skip, keys: Object.keys(payload).slice(0, 25) });
      return res.status(202).json({ ok: true, ignored: skip });
    }

    // Generic shape, used by tests and by anything that posts our own format.
    const event: InboundEvent & { contact_id?: string | null; conversation_id?: string | null } = {
      provider: req.params.provider,
      provider_id: String(payload.messageId ?? payload.id ?? payload.provider_id ?? ''),
      from: String(payload.from ?? payload.contactId ?? ''),
      to: String(payload.to ?? ''),
      body: String(payload.message ?? payload.body ?? ''),
      ts: String(payload.dateAdded ?? payload.ts ?? new Date().toISOString()),
      run_id: payload.run_id,
      contact_id: payload.contactId ?? payload.contact_id ?? null,
      conversation_id: payload.conversationId ?? payload.conversation_id ?? null,
    };
    if (!event.provider_id || !event.body) {
      return res.status(202).json({ ok: true, ignored: 'missing message id or body' });
    }
    const result = await sink(event);
    res.json({ ok: true, ...result });
  } catch (err) {
    logEvent(null, 'inbound_error', { provider: req.params.provider, error: (err as Error).message });
    // Acknowledged deliberately: the event is logged, and a retry storm helps nobody.
    res.status(202).json({ ok: false, error: (err as Error).message });
  }
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
