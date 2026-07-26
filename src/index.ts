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
import { OUTCOMES } from './domain/states.ts';
import { ghlAdapter, bindRun, ensureContact, runIdForConversation } from './channels/ghl.ts';
import { mockAdapter } from './channels/mock.ts';
import { runFrontdoorAgent } from './frontdoor/agent.ts';
import {
  claimAwaitInbound,
  isOurInboundNumber,
  listAwaitInbound,
  normalizePhone,
} from './frontdoor/await-inbound.ts';
import { guessLineType } from './ingest/extract.ts';
import type { InboundEvent } from './channels/types.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

db();
const persona = seedPersona();

const adapter = config.channel.default === 'ghl' && ghlAdapter.available() ? ghlAdapter : mockAdapter;
useAdapter(adapter);

/**
 * Path B matcher: when an inbound SMS arrives at our number with no run binding,
 * claim the oldest await-inbound run and bind the firm's sender as the GHL contact.
 */
async function resolveRunId(event: InboundEvent): Promise<string | null> {
  if (event.run_id) return event.run_id;
  if (event.conversation_id) {
    const byConv = runIdForConversation(event.conversation_id);
    if (byConv) return byConv;
  }

  if (!isOurInboundNumber(event.to) || listAwaitInbound().length === 0) return null;

  const claimed = claimAwaitInbound(event.to || config.frontdoor.inboundNumber);
  if (!claimed) return null;

  const firmPhone = normalizePhone(event.from);
  if (firmPhone && /\d{7,}/.test(firmPhone.replace(/\D/g, ''))) {
    runs.patch(claimed.run_id, { channel_address: firmPhone });
  }

  if (adapter.name === 'ghl' && firmPhone && /\d{7,}/.test(firmPhone.replace(/\D/g, ''))) {
    const contact = await ensureContact({
      phone: firmPhone,
      name: persona.name,
      runId: claimed.run_id,
    });
    if (!('error' in contact)) {
      bindRun(claimed.run_id, {
        contact_id: contact.contact_id,
        conversation_id: event.conversation_id ?? null,
      });
      logEvent(claimed.run_id, 'await_inbound_bound', {
        contact_id: contact.contact_id,
        firm_phone: firmPhone,
        conversation_id: event.conversation_id ?? null,
      });
    } else {
      logEvent(claimed.run_id, 'await_inbound_bind_failed', { error: contact.error, firm_phone: firmPhone });
    }
  } else if (event.conversation_id) {
    bindRun(claimed.run_id, { contact_id: event.from || 'unknown', conversation_id: event.conversation_id });
  }

  return claimed.run_id;
}

/** One entry point for inbound, whatever the transport. */
async function sink(event: InboundEvent): Promise<void> {
  const runId = await resolveRunId(event);
  if (!runId) {
    logEvent(null, 'inbound_unrouted', { provider: event.provider, provider_id: event.provider_id, to: event.to });
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
    frontdoor: {
      inbound_number: config.frontdoor.inboundNumber,
      model: config.frontdoor.model,
      awaiting: listAwaitInbound().length,
    },
  });
});

/**
 * The LLM proxy has no /models endpoint, so discovery is a test call per candidate.
 * A wrong model name in env is otherwise a silent 404 at the worst possible moment.
 */
app.get('/api/health/models', async (_req, res) => {
  res.json(await listModels());
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

// ----------------------------------------------------------------- frontdoor ---

/**
 * Browser-driven first contact. Prefers submitting the firm's intake form with our
 * inbound number; falls back to discovering a phone to text. Live form submission
 * intentionally bypasses ALLOW_LIVE_SENDS / allowlist.
 *
 * Body: { url: string, domain?: string, open_run?: boolean }
 *   open_run (default true for form_submitted / sms when channel is ready):
 *     form_submitted -> opens an await-inbound run
 *     sms            -> opens a run that texts the discovered number (if send gate allows)
 */
app.post('/api/frontdoor', async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  const openRunFlag = req.body?.open_run !== false;

  try {
    const ingested = await ingestTarget(url, { domain: req.body?.domain ?? null });
    const target = ingested.target;

    const result = await runFrontdoorAgent({
      url,
      persona: {
        name: persona.name,
        email: persona.contact.email,
        phone: persona.contact.phone,
        need: persona.need,
      },
      inboundNumber: config.frontdoor.inboundNumber,
      hints: {
        phones: target.phones.map((p) => p.number),
        formUrl: target.form?.url ?? null,
        formCaptcha: target.form?.captcha ?? null,
      },
    });

    logEvent(null, 'frontdoor_plan', {
      target_id: target.id,
      plan: result.plan,
      steps: result.steps,
      tool_trace: result.tool_trace.slice(-20),
    });

    if (result.plan.mode === 'unreachable') {
      return res.json({
        ok: false,
        target_id: target.id,
        plan: result.plan,
        steps: result.steps,
        tool_trace: result.tool_trace,
      });
    }

    if (result.plan.mode === 'sms') {
      const phone = normalizePhone(result.plan.phone);
      const guess = guessLineType(phone);
      // Persist the discovered number so subsequent openRun / UI can see it.
      targets.upsert({
        url: target.url,
        domain: target.domain,
        name: target.name,
        category: target.category,
        city: target.city,
        timezone: target.timezone,
        services: target.services,
        stated_hours_text: target.stated_hours_text,
        hours: target.hours,
        hours_confidence: target.hours_confidence,
        claims_247: target.claims_247,
        chat_widget: target.chat_widget,
        form: target.form,
        reachable: true,
        unreachable_reason: null,
        ingest_notes: [...target.ingest_notes, `frontdoor sms: ${phone}`],
        phones: [
          { number: phone, line_type: guess.line_type, sms_capable: guess.sms_capable, source: 'frontdoor' },
          ...target.phones
            .filter((p) => normalizePhone(p.number) !== phone)
            .map((p) => ({
              number: p.number,
              line_type: p.line_type,
              sms_capable: p.sms_capable,
              source: p.source,
            })),
        ],
        emails: target.emails,
      });

      let opened: Awaited<ReturnType<typeof openRun>> | null = null;
      if (openRunFlag) {
        if (adapter.name === 'ghl') {
          const contact = await ensureContact({ phone, name: persona.name, runId: 'pending' });
          if ('error' in contact) {
            return res.status(502).json({
              ok: false,
              error: contact.error,
              target_id: target.id,
              plan: result.plan,
              steps: result.steps,
              tool_trace: result.tool_trace,
            });
          }
          opened = await openRun(target.id, {
            cycle: req.body?.cycle,
            channel: 'sms',
            address: phone,
            agentName: 'frontdoor-sms',
          });
          if (opened.ok) bindRun(opened.run.id, { contact_id: contact.contact_id, conversation_id: null });
        } else {
          opened = await openRun(target.id, {
            cycle: req.body?.cycle,
            channel: 'sms',
            address: phone,
            agentName: 'frontdoor-sms',
          });
        }
      }

      return res.json({
        ok: true,
        target_id: target.id,
        plan: { ...result.plan, phone },
        steps: result.steps,
        tool_trace: result.tool_trace,
        run: opened?.run ?? null,
        run_ok: opened?.ok ?? null,
        run_reason: opened && !opened.ok ? opened.reason : opened?.ok ? opened.first_contact : null,
      });
    }

    // form_submitted
    let opened: Awaited<ReturnType<typeof openRun>> | null = null;
    if (openRunFlag) {
      opened = await openRun(target.id, {
        cycle: req.body?.cycle,
        awaitInbound: true,
        inboundNumber: result.plan.expected_inbound_number || config.frontdoor.inboundNumber,
        agentName: 'frontdoor-form',
      });
    }

    return res.json({
      ok: true,
      target_id: target.id,
      plan: result.plan,
      steps: result.steps,
      tool_trace: result.tool_trace,
      run: opened?.run ?? null,
      run_ok: opened?.ok ?? null,
      run_reason: opened && !opened.ok ? opened.reason : 'awaiting inbound SMS',
    });
  } catch (err) {
    logEvent(null, 'frontdoor_error', { url, error: (err as Error).message });
    return res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/frontdoor/awaiting', (_req, res) => {
  res.json({ ok: true, awaiting: listAwaitInbound() });
});

// ---------------------------------------------------------------------- runs ---

app.post('/api/runs', async (req, res) => {
  const targetId = String(req.body?.target_id ?? '');
  const target = targets.get(targetId);
  if (!target) return res.status(404).json({ ok: false, error: 'target not found' });

  const channelOverride = req.body?.channel as 'sms' | 'email' | 'form' | undefined;
  const addressOverride = req.body?.address ? String(req.body.address) : undefined;

  // Bind a CRM contact before the first send so inbound polling is scoped to this run.
  if (adapter.name === 'ghl' && !req.body?.await_inbound) {
    const phone = addressOverride || target.phones[0]?.number;
    if (!phone) return res.status(400).json({ ok: false, error: 'target has no phone to bind' });
    const contact = await ensureContact({ phone, name: persona.name, runId: 'pending' });
    if ('error' in contact) return res.status(502).json({ ok: false, error: contact.error });
    const opened = await openRun(targetId, {
      cycle: req.body?.cycle,
      channel: channelOverride,
      address: addressOverride,
    });
    if (opened.ok) bindRun(opened.run.id, { contact_id: contact.contact_id, conversation_id: null });
    return res.json({ ok: opened.ok, run: opened.run, reason: opened.ok ? opened.first_contact : opened.reason });
  }

  if (req.body?.await_inbound) {
    const opened = await openRun(targetId, {
      cycle: req.body?.cycle,
      awaitInbound: true,
      inboundNumber: req.body?.inbound_number ? String(req.body.inbound_number) : undefined,
    });
    return res.json({ ok: opened.ok, run: opened.run, reason: opened.ok ? 'awaiting inbound SMS' : opened.reason });
  }

  const opened = await openRun(targetId, {
    cycle: req.body?.cycle,
    channel: channelOverride,
    address: addressOverride,
  });
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
    from: String(body.from ?? body.phone ?? body.contactId ?? ''),
    to: String(body.to ?? config.frontdoor.inboundNumber),
    body: String(body.message ?? body.body ?? ''),
    ts: String(body.dateAdded ?? body.ts ?? new Date().toISOString()),
    run_id: body.run_id,
    conversation_id: body.conversationId ?? body.conversation_id,
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

const server = app.listen(config.port, () => {
  const judge = judgeStatus();
  console.log(`intake-grader router on :${config.port}`);
  console.log(`  adapter      ${adapter.name}`);
  console.log(`  judge        ${judge.driver}${judge.driver === 'http' ? ` (${judge.model})` : ''} — ${judge.reason}`);
  console.log(`  live sends   ${config.channel.allowLiveSends}   allowlist ${JSON.stringify(loadAllowlist())}`);
  console.log(`  persona      ${persona.name} [${persona.need_tags.join(', ')}]`);
  console.log(`  frontdoor    inbound ${config.frontdoor.inboundNumber} model ${config.frontdoor.model}`);
  console.log(`  sweep every  ${config.loop.sweepMs / 1000}s`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    adapter.stop?.();
    clearInterval(sweepTimer);
    server.close(() => process.exit(0));
  });
}
