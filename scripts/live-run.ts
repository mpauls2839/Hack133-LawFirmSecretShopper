/**
 * Live run driver: opens one run against a target and works the conversation until it
 * reaches a terminal state, printing every decision as it happens.
 *
 * The target for a human-played test is a fixture site whose contact number is the phone
 * of whoever is playing the business. Nothing else can receive traffic: the domain must
 * be on config/allowlist.txt and ALLOW_LIVE_SENDS must be true.
 *
 *   node --env-file=.env scripts/live-run.ts --phone +15551234567
 *   node --env-file=.env scripts/live-run.ts --status <run_id>
 *   node --env-file=.env scripts/live-run.ts --halt
 */
import { config, loadAllowlist } from '../src/config.ts';
import { db, logEvent, haltSends, resumeSends, sendsHalted, events } from '../src/db/index.ts';
import { targets, runs, messages, sendQueue, personas } from '../src/db/repo.ts';
import { seedPersona } from '../src/db/seed.ts';
import { ghlAdapter, bindRun, ensureContact, primeConversation } from '../src/channels/ghl.ts';
import { mockAdapter } from '../src/channels/mock.ts';
import { useAdapter, openRun, handleInbound, sweep, checkSendGate, cleanupRun } from '../src/pipeline/loop.ts';
import { OUTCOMES } from '../src/domain/states.ts';
import type { InboundEvent } from '../src/channels/types.ts';

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (...parts: unknown[]): void => console.log(`[${stamp()}]`, ...parts);

/**
 * The fixture "firm" a human plays. Services match the persona's need tags so the run is
 * qualified, and the contact number is whoever is playing the business.
 */
function seedPlayableTarget(phone: string, domain: string) {
  return targets.upsert({
    url: `https://${domain}/`,
    domain,
    name: 'Whitcomb Injury Law',
    category: 'law_firm',
    city: 'New York, NY',
    timezone: 'America/New_York',
    services: ['car_accident', 'personal_injury', 'truck_accident', 'wrongful_death'],
    stated_hours_text: 'Hours: Monday - Friday 9:00am - 6:00pm',
    hours: [1, 2, 3, 4, 5].map((day) => ({ day, open: 9 * 60, close: 18 * 60 })),
    hours_confidence: 'high',
    claims_247: false,
    chat_widget: null,
    form: null,
    reachable: true,
    ingest_notes: ['target seeded for a human-played live test, not scraped'],
    phones: [{ number: phone, line_type: 'mobile', sms_capable: true, source: 'live_test' }],
    emails: [],
  });
}

async function showRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) return log(`run ${runId} not found`);
  const outcome = run.terminal_state ? OUTCOMES[run.terminal_state] : null;
  console.log('\n' + '='.repeat(72));
  console.log(`run          ${run.id}`);
  console.log(`state        ${run.state}${run.terminal_state ? ` / ${run.terminal_state}` : ''}`);
  if (outcome) console.log(`outcome      rank ${outcome.rank} — ${outcome.blurb}`);
  console.log(`qualified    ${run.qualified}  (${run.qualification_reason})`);
  console.log(`channel      ${run.channel} -> ${run.channel_address}`);
  console.log(`turns        ${run.turns}   nudges ${run.nudges_sent}`);
  console.log(`t0           ${run.t0}`);
  console.log(`first reply  ${run.first_reply_at ?? '-'} (${run.first_reply_sender ?? '-'})`);
  console.log(`first human  ${run.first_human_at ?? '-'}`);
  console.log(`booking      ${run.booking_offered_at ?? '-'}`);
  if (run.promise_made_at) {
    console.log(`promise      "${run.promise_window_text}" due ${run.promise_deadline} kept=${run.promise_kept}`);
  }
  console.log('-'.repeat(72));
  for (const m of messages.forRun(run.id)) {
    const who = m.direction === 'out' ? 'DANA  ' : `FIRM  `;
    const tag = m.direction === 'in' ? ` [${m.sender_type ?? '?'}]` : '';
    console.log(`${m.ts.slice(11, 19)} ${who}${tag} ${m.body}`);
  }
  console.log('='.repeat(72) + '\n');
}

async function main(): Promise<void> {
  db();
  seedPersona();

  if (flag('halt')) {
    haltSends('operator requested halt');
    return log('KILL SWITCH ENGAGED. No further sends will leave the process.');
  }
  if (flag('resume')) {
    resumeSends();
    return log('sends resumed');
  }
  const statusId = opt('status');
  if (statusId) return showRun(statusId);

  const useMock = flag('mock');
  useAdapter(useMock ? mockAdapter : ghlAdapter);

  if (!useMock && !ghlAdapter.available()) {
    console.error('GHL adapter unavailable: GHL_PIT and GHL_LOCATION_ID must be set');
    process.exit(2);
  }

  const phone = opt('phone');
  if (!phone && !useMock) {
    console.error('pass --phone <E.164> — the number of whoever is playing the business');
    process.exit(4);
  }

  const domain = opt('domain') ?? 'whitcomb-injury.test';
  const target = seedPlayableTarget(phone ?? '+15550000000', domain);
  const persona = personas.fixed()!;

  const gate = checkSendGate(target);
  console.log('\n' + '#'.repeat(72));
  console.log(`# adapter        ${useMock ? 'mock (nothing leaves the process)' : 'ghl'}`);
  console.log(`# sending from   ${config.channel.ghl.fromNumber || '(mock)'}`);
  console.log(`# business is    ${phone ?? '(mock)'}`);
  console.log(`# target         ${target.name} <${target.domain}>`);
  console.log(`# persona        ${persona.name} — ${persona.need_tags.join(', ')}`);
  console.log(`# allowlist      ${JSON.stringify(loadAllowlist())}`);
  console.log(`# live sends     ${config.channel.allowLiveSends}   halted=${sendsHalted()}`);
  console.log(`# send gate      ${gate.allowed ? 'OPEN' : 'CLOSED'} — ${gate.reason}`);
  console.log(`# reply delay    ${config.loop.replyDelayMinMs / 1000}-${config.loop.replyDelayMaxMs / 1000}s`);
  console.log(`# nudge after    ${config.loop.nudgeAfterBizMinutes}m business time`);
  console.log(`# judge          ${config.llm.fastModel} / ${config.llm.deepModel}`);
  console.log('#'.repeat(72) + '\n');

  if (!gate.allowed) {
    console.error('send gate is closed; refusing to start a live run');
    process.exit(1);
  }

  // Bind the run to a GHL contact before the first send so polling is scoped correctly.
  if (!useMock) {
    const contact = await ensureContact({ phone: phone!, name: 'Dana Whitfield', runId: 'pending' });
    if ('error' in contact) {
      console.error(contact.error);
      process.exit(1);
    }
    log(`GHL contact ${contact.contact_id}`);
    (globalThis as any).__contactId = contact.contact_id;
  }

  const opened = await openRun(target.id);
  if (!opened.ok) {
    log(`could not open run: ${opened.reason}`);
    await showRun(opened.run.id);
    return;
  }
  const runId = opened.run.id;
  log(`run ${runId} opened`);
  log(`first contact queued: "${opened.first_contact}"`);

  if (!useMock) {
    bindRun(runId, { contact_id: (globalThis as any).__contactId, conversation_id: null });
  }

  // Inbound sink: one entry point for both adapters.
  const sink = async (event: InboundEvent): Promise<void> => {
    const res = await handleInbound({ ...event, run_id: event.run_id ?? runId });
    if (!res.handled) return log(`inbound ignored — ${res.reason}`);
    log(`FIRM [${res.sender_type}] ${event.body.slice(0, 120)}`);
    log(`  -> ${res.decision}  (${res.reason})`);
    if (res.reply) log(`  -> queued reply: "${res.reply}"`);
  };
  currentAdapterStart(sink);

  // First send goes out immediately, then the sweeper drives everything.
  const firstSweep = await sweep();
  log(`first sweep: ${JSON.stringify(firstSweep)}`);
  const afterFirst = runs.get(runId)!;
  if (afterFirst.state === 'TERMINAL') {
    await showRun(runId);
    return;
  }

  // Prime the conversation so prior sub-account traffic is never ingested as turn one.
  if (!useMock) {
    const conv = messages
      .forRun(runId)
      .find((m) => m.direction === 'out' && m.provider_id);
    const binding = (await import('../src/channels/ghl.ts')).bindingFor(runId);
    if (binding?.conversation_id) {
      const primed = await primeConversation(runId, binding.conversation_id);
      log(`primed ${primed} historical messages as already-seen (conversation ${binding.conversation_id})`);
    }
    void conv;
  }

  log('waiting. reply from the business phone and the loop will respond.');
  log('ctrl-c to stop; run with --status <run_id> afterwards to see the transcript.');

  const interval = setInterval(async () => {
    try {
      const report = await sweep();
      if (report.sent || report.nudged || report.closed || report.errors.length) {
        log(`sweep: ${JSON.stringify(report)}`);
      }
      const run = runs.get(runId)!;
      if (run.state === 'TERMINAL' || run.state === 'GRADED' || run.state === 'CLEANED_UP') {
        clearInterval(interval);
        ghlAdapter.stop?.();
        mockAdapter.stop?.();
        await cleanupRun(runId);
        await sweep();
        log(`run reached ${run.state} / ${run.terminal_state}`);
        await showRun(runId);
        process.exit(0);
      }
    } catch (err) {
      log(`sweep error: ${(err as Error).message}`);
    }
  }, 10_000);
}

function currentAdapterStart(sink: (e: InboundEvent) => Promise<void>): void {
  ghlAdapter.available() ? ghlAdapter.start?.(sink) : undefined;
  mockAdapter.start?.(sink);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
