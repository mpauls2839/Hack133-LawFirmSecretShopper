/**
 * The turn loop (spec 4.4 - 4.6). The router is the only writer: it owns the clock, the
 * transcript, dedupe, and the state machine. The persona agent is a stateless executor
 * that is handed full context per call — Maritime's --conversation-id leaks context
 * across ids (verified), so agent-side memory is never relied on.
 */
import { config, replyDelayMs, loadAllowlist } from '../config.ts';
import { logEvent, nowIso, sendsHalted } from '../db/index.ts';
import { messages, runs, sendQueue, targets, personas, type RunPatch } from '../db/repo.ts';
import { classifyInbound } from '../judge/classify.ts';
import { promiseDeadline } from '../judge/deterministic.ts';
import { composeReply, firstContactMessage, closingMessage } from '../judge/respond.ts';
import { decide, decideOnSilence, type RunView } from '../domain/decide.ts';
import { isBetterOutcome, isClosed } from '../domain/states.ts';
import { businessMinutesBetween, rawMinutesBetween } from '../domain/hours.ts';
import { assessReachability, recordSendFailure } from '../ingest/capability.ts';
import { qualify } from '../domain/qualify.ts';
import { buildScorecard } from '../judge/scorecard.ts';
import type { ChannelAdapter, InboundEvent } from '../channels/types.ts';
import type { Flags, Run, Scorecard, Target } from '../domain/types.ts';

let adapter: ChannelAdapter | null = null;

export function useAdapter(next: ChannelAdapter): void {
  adapter = next;
}

export function currentAdapter(): ChannelAdapter {
  if (!adapter) throw new Error('no channel adapter registered');
  return adapter;
}

export const todayCycle = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- guardrails ---

export type SendGate = { allowed: boolean; reason: string };

/**
 * Every outbound passes through here. Three independent gates, all of which must pass:
 * the kill switch, the master ALLOW_LIVE_SENDS flag, and the per-domain allowlist.
 */
export function checkSendGate(target: Target): SendGate {
  if (sendsHalted()) return { allowed: false, reason: 'kill switch engaged' };
  if (adapter?.name === 'mock') return { allowed: true, reason: 'mock adapter, nothing leaves the process' };
  if (!config.channel.allowLiveSends) {
    return { allowed: false, reason: 'ALLOW_LIVE_SENDS is false' };
  }
  const allowlist = loadAllowlist();
  if (allowlist.length === 0) return { allowed: false, reason: 'target allowlist is empty' };
  const ok = allowlist.some((entry) => target.domain === entry || target.domain.endsWith(`.${entry}`));
  return ok
    ? { allowed: true, reason: `${target.domain} is on the allowlist` }
    : { allowed: false, reason: `${target.domain} is not on the allowlist` };
}

// ------------------------------------------------------------------ open run ---

export type OpenRunResult =
  | { ok: true; run: Run; first_contact: string }
  | { ok: false; run: Run; reason: string };

/** Creates a run, derives qualification, picks a channel, and queues first contact. */
export async function openRun(targetId: string, opts: { cycle?: string; agentName?: string } = {}): Promise<OpenRunResult> {
  const target = targets.get(targetId);
  if (!target) throw new Error(`target ${targetId} not found`);
  const persona = personas.fixed();
  if (!persona) throw new Error('no persona seeded');

  const cycle = opts.cycle ?? todayCycle();
  const existing = runs.openForTarget(target.id, cycle);
  if (existing) {
    return { ok: false, run: existing, reason: 'a run already exists for this business this cycle' };
  }

  const q = qualify(persona, target);
  let run = runs.create({
    target_id: target.id,
    persona_id: persona.id,
    cycle,
    qualified: q.qualified,
    qualification_reason: q.reason,
    agent_name: opts.agentName ?? null,
  });

  const reachability = assessReachability(target);
  if (!reachability.reachable || !reachability.choice) {
    run = runs.transition(run.id, 'TERMINAL', {
      terminal_state: 'UNREACHABLE',
      terminal_reason: reachability.unreachable_reason ?? 'no usable asynchronous channel',
      cleanup_state: 'not_needed',
    });
    return { ok: false, run, reason: run.terminal_reason ?? 'unreachable' };
  }

  const gate = checkSendGate(target);
  if (!gate.allowed) {
    logEvent(run.id, 'send_blocked', { gate: gate.reason, kind: 'first_contact' });
    return { ok: false, run, reason: `send blocked: ${gate.reason}` };
  }

  const body = firstContactMessage(persona, target, reachability.choice.channel);
  run = runs.patch(run.id, {
    channel: reachability.choice.channel,
    channel_address: reachability.choice.address,
  });
  sendQueue.enqueue({ run_id: run.id, kind: 'first_contact', body, delayMs: 0 });
  return { ok: true, run, first_contact: body };
}

// ------------------------------------------------------------------- inbound ---

/** Rebuilds the decision view from stored rows. Nothing is inferred by a model. */
export function buildView(run: Run): RunView {
  const all = messages.forRun(run.id);
  const inbound = all.filter((m) => m.direction === 'in');
  const machine = inbound.filter(
    (m) => m.sender_type === 'autoresponder' || m.sender_type === 'ai_agent',
  ).length;
  const humanIndex = inbound.findIndex((m) => m.sender_type === 'human');
  const flagsSeen = inbound.map((m) => m.flags).filter(Boolean) as Flags[];

  return {
    turns: run.turns,
    inboundCount: inbound.length,
    machineInbound: machine,
    humanSeen: humanIndex >= 0,
    turnsSinceHuman: humanIndex >= 0 ? inbound.length - 1 - humanIndex : 0,
    priceSeen: flagsSeen.some((f) => f.price_given),
    meetingOffered: flagsSeen.some((f) => f.meeting_offered),
    specialistSeen: flagsSeen.some((f) => f.specialist_identified),
    t0: run.t0,
  };
}

export type InboundOutcome = {
  handled: boolean;
  reason: string;
  run?: Run;
  sender_type?: string;
  decision?: string;
  reply?: string | null;
};

/**
 * One inbound message, start to finish. Runs under the per-run lock so a webhook and the
 * sweeper cannot interleave writes on the same run.
 */
export async function handleInbound(event: InboundEvent): Promise<InboundOutcome> {
  const runId = event.run_id;
  if (!runId) return { handled: false, reason: 'event carries no run id' };
  const current = runs.get(runId);
  if (!current) return { handled: false, reason: `unknown run ${runId}` };
  if (isClosed(current.state)) {
    logEvent(runId, 'inbound_after_close', { provider_id: event.provider_id });
    return { handled: false, reason: `run is ${current.state}` };
  }

  return runs.withLock(runId, async (run) => {
    /**
     * Nothing that predates the run may enter it, whichever transport delivered it. A
     * shared CRM number carries prior history, and treating any of it as a live reply
     * fabricates a conversation — which is worse than dropping an event, because the
     * scorecard then grades a business on words it never said to us.
     */
    const opened = new Date(run.t0 ?? run.created_at).getTime();
    const arrived = new Date(event.ts).getTime();
    if (Number.isFinite(arrived) && Number.isFinite(opened) && arrived < opened) {
      logEvent(runId, 'inbound_predates_run', {
        provider_id: event.provider_id,
        at: event.ts,
        run_opened: run.t0 ?? run.created_at,
      });
      return { handled: false, reason: 'message predates this run; treated as history', run };
    }

    const target = targets.get(run.target_id)!;
    const persona = personas.get(run.persona_id)!;

    const priorInbound = messages.inboundBodies(run.id);
    const lastOut = messages.lastOutbound(run.id);
    const secondsSinceOutbound = lastOut
      ? Math.max(0, Math.round((new Date(event.ts).getTime() - new Date(lastOut.ts).getTime()) / 1000))
      : null;

    const stored = messages.add({
      run_id: run.id,
      direction: 'in',
      body: event.body,
      ts: event.ts,
      provider: event.provider,
      provider_id: event.provider_id,
    });
    if (!stored.inserted) {
      logEvent(run.id, 'inbound_duplicate', { provider_id: event.provider_id });
      return { handled: false, reason: 'duplicate provider message id', run };
    }

    const cls = await classifyInbound({
      body: event.body,
      priorInbound,
      secondsSinceOutbound,
      lastOutbound: lastOut?.body ?? null,
    });

    // Persist what we perceived, on the message it belongs to.
    messages.setJudgement(stored.message.id, cls.sender_type, cls.flags, cls.classifier);

    // Latency facts come from timestamps only.
    const patch: RunPatch = {
      last_inbound_at: event.ts,
      turns: run.turns + 1,
    };
    if (!run.first_reply_at) {
      patch.first_reply_at = event.ts;
      patch.first_reply_sender = cls.sender_type;
    }
    if (!run.first_human_at && cls.sender_type === 'human') {
      patch.first_human_at = event.ts;
      const view = buildView(run);
      patch.turns_in_automation = view.machineInbound;
    }
    if (!run.booking_offered_at && (cls.flags.meeting_offered || cls.flags.booking_link)) {
      patch.booking_offered_at = event.ts;
    }
    // A promise that arrives is resolved here; the sweeper only ever resolves the negative.
    if (cls.flags.callback_promised && !run.promise_made_at) {
      patch.promise_made_at = event.ts;
      patch.promise_window_text = cls.flags.promised_window;
      patch.promise_deadline = promiseDeadline(cls.flags.promised_window, event.ts, target);
    }
    if (run.promise_made_at && run.promise_kept === null && cls.sender_type === 'human') {
      patch.promise_kept = true;
    }

    let updated = runs.patch(run.id, patch);
    const view = buildView(updated);
    const decision = decide(view, cls, event.body);

    logEvent(run.id, 'inbound_processed', {
      provider_id: event.provider_id,
      sender_type: cls.sender_type,
      classifier: cls.classifier,
      flags: cls.flags,
      reasons: cls.reasons,
      decision: decision.action,
      terminal_state: decision.terminal_state ?? null,
      goal: decision.goal,
      seconds_since_outbound: secondsSinceOutbound,
    });

    if (decision.action === 'terminate') {
      updated = closeRun(updated, decision.terminal_state!, decision.reason);
      return {
        handled: true,
        reason: decision.reason,
        run: updated,
        sender_type: cls.sender_type,
        decision: `TERMINAL:${decision.terminal_state}`,
        reply: null,
      };
    }

    if (updated.state === 'CONTACTED' || updated.state === 'AWAITING_REPLY') {
      updated = runs.transition(updated.id, 'IN_CONVERSATION');
    }

    const gate = checkSendGate(target);
    if (!gate.allowed) {
      logEvent(run.id, 'send_blocked', { gate: gate.reason, kind: 'reply' });
      return { handled: true, reason: `reply blocked: ${gate.reason}`, run: updated, sender_type: cls.sender_type };
    }

    const composed = await composeReply({
      persona,
      target,
      goal: decision.goal,
      classification: cls,
      transcript: messages.forRun(run.id).map((m) => ({ direction: m.direction, body: m.body })),
      channel: updated.channel ?? 'sms',
    });

    sendQueue.enqueue({ run_id: run.id, kind: 'reply', body: composed.body, delayMs: replyDelayMs() });
    logEvent(run.id, 'reply_composed', { goal: decision.goal, source: composed.source });

    return {
      handled: true,
      reason: decision.reason,
      run: updated,
      sender_type: cls.sender_type,
      decision: `reply:${decision.goal}`,
      reply: composed.body,
    };
  });
}

// -------------------------------------------------------------------- closing ---

/** Terminal transition plus cleanup bookkeeping. Never downgrades a better outcome. */
export function closeRun(run: Run, terminalState: string, reason: string): Run {
  sendQueue.cancelPending(run.id, `run closing as ${terminalState}`);

  if (run.terminal_state && !isBetterOutcome(terminalState, run.terminal_state)) {
    terminalState = run.terminal_state;
  }
  const needsCleanup =
    terminalState.startsWith('BOOKED') || run.turns > 0 ? ('pending' as const) : ('not_needed' as const);

  const closed = runs.transition(run.id, 'TERMINAL', {
    terminal_state: terminalState,
    terminal_reason: reason,
    cleanup_state: terminalState === 'OPTED_OUT' ? 'not_needed' : needsCleanup,
  });
  logEvent(run.id, 'run_closed', { terminal_state: terminalState, reason });
  return closed;
}

/**
 * Politeness is non-negotiable (spec 4.7 + 11): every conversation gets a closing
 * message and any booking is cancelled. Opt-outs are the one exception — the correct
 * way to honour "stop" is silence.
 */
export async function cleanupRun(runId: string): Promise<{ sent: boolean; reason: string }> {
  const run = runs.get(runId);
  if (!run) return { sent: false, reason: 'run not found' };
  // Checked before the cleanup_state guard: the correct way to honour "stop" is silence,
  // and that has to be the answer no matter what state the run is already in.
  if (run.terminal_state === 'OPTED_OUT') {
    if (run.cleanup_state !== 'not_needed') runs.patch(runId, { cleanup_state: 'not_needed' });
    return { sent: false, reason: 'opt-out honoured with silence; no closing message sent' };
  }
  if (run.cleanup_state !== 'pending') return { sent: false, reason: `cleanup_state is ${run.cleanup_state}` };

  const target = targets.get(run.target_id)!;
  const persona = personas.get(run.persona_id)!;
  const gate = checkSendGate(target);
  if (!gate.allowed) {
    runs.patch(runId, { cleanup_state: 'failed' });
    logEvent(runId, 'cleanup_blocked', { gate: gate.reason });
    return { sent: false, reason: `blocked: ${gate.reason}` };
  }

  const hadBooking = (run.terminal_state ?? '').startsWith('BOOKED');
  sendQueue.enqueue({
    run_id: runId,
    kind: 'closing',
    body: closingMessage(persona, hadBooking),
    delayMs: 0,
  });
  runs.patch(runId, { cleanup_state: 'done' });
  logEvent(runId, 'cleanup_queued', { had_booking: hadBooking });
  return { sent: true, reason: hadBooking ? 'cancelling the booking' : 'closing politely' };
}

// -------------------------------------------------------------------- grading ---

/**
 * TERMINAL -> GRADED. Idempotent, so a re-sweep never regrades. Runs after the outcome is
 * fixed, which is why lifecycle and outcome are separate columns: grading cannot change
 * what happened.
 */
export async function gradeRun(runId: string): Promise<Scorecard | null> {
  const run = runs.get(runId);
  if (!run) return null;
  if (run.state !== 'TERMINAL') return run.scorecard;
  if (run.scorecard) return run.scorecard;

  const target = targets.get(run.target_id)!;
  const persona = personas.get(run.persona_id)!;
  const scorecard = await buildScorecard({
    run,
    target,
    persona,
    transcript: messages.forRun(run.id),
  });

  runs.transition(runId, 'GRADED', { scorecard, narrative: scorecard.narrative });
  logEvent(runId, 'graded', {
    terminal_state: scorecard.terminal_state,
    business_grade: scorecard.business_score.grade,
    harness_pass: scorecard.harness_score.completed_mission,
    screening: scorecard.screening.verdict,
    graded_on: scorecard.latency.graded_on,
  });
  return scorecard;
}

// -------------------------------------------------------------------- sweeper ---

export type SweepReport = {
  sent: number;
  nudged: number;
  closed: number;
  promises_broken: number;
  graded: number;
  cleaned: number;
  errors: string[];
};

/** Business-hours elapsed, or raw when the business advertises 24/7 or hours are unknown. */
export function elapsed(run: Run, target: Target, fromIso: string): { minutes: number; basis: 'raw' | 'business' } {
  const useBusiness = !target.claims_247 && target.hours_confidence !== 'none';
  return useBusiness
    ? { minutes: businessMinutesBetween(fromIso, nowIso(), target.hours, target.timezone), basis: 'business' }
    : { minutes: rawMinutesBetween(fromIso, nowIso()), basis: 'raw' };
}

/** Everything the inbound path cannot see: silence, timeouts, broken promises, cleanup. */
export async function sweep(): Promise<SweepReport> {
  const report: SweepReport = { sent: 0, nudged: 0, closed: 0, promises_broken: 0, graded: 0, cleaned: 0, errors: [] };

  // 1. Drain due outbound.
  for (const queued of sendQueue.due()) {
    try {
      const delivered = await drainOne(queued.id);
      if (delivered) report.sent += 1;
    } catch (err) {
      report.errors.push(`send ${queued.id}: ${(err as Error).message}`);
    }
  }

  // 2. Silence, promises, caps.
  for (const run of runs.inStates(['CONTACTED', 'AWAITING_REPLY', 'IN_CONVERSATION'])) {
    try {
      const acted = await sweepRun(run.id);
      if (acted === 'nudged') report.nudged += 1;
      if (acted === 'closed') report.closed += 1;
      if (acted === 'promise_broken') {
        report.closed += 1;
        report.promises_broken += 1;
      }
    } catch (err) {
      if ((err as Error).name !== 'RunBusy') report.errors.push(`sweep ${run.id}: ${(err as Error).message}`);
    }
  }

  // 3. Grade anything that reached a terminal state.
  for (const run of runs.inStates(['TERMINAL'])) {
    try {
      if (await gradeRun(run.id)) report.graded += 1;
    } catch (err) {
      report.errors.push(`grade ${run.id}: ${(err as Error).message}`);
    }
  }

  // 4. Politeness pass. Every conversation gets a closing message and any booking is
  //    cancelled — ghosting a receptionist who did their job well is not acceptable.
  for (const run of runs.inStates(['TERMINAL', 'GRADED'])) {
    if (run.cleanup_state !== 'pending') continue;
    const res = await cleanupRun(run.id);
    if (res.sent) report.cleaned += 1;
  }

  return report;
}

async function drainOne(queueId: string): Promise<boolean> {
  const queued = sendQueue.get(queueId);
  if (!queued || queued.state !== 'pending') return false;
  // Take the row before doing anything else. Two overlapping sweeps double-sent without this.
  if (!sendQueue.claim(queueId)) return false;
  const run = runs.get(queued.run_id);
  if (!run) return false;
  if (isClosed(run.state) && queued.kind !== 'closing') {
    sendQueue.release(queueId);
    sendQueue.cancelPending(run.id, 'run closed before send');
    return false;
  }

  const target = targets.get(run.target_id)!;
  const persona = personas.get(run.persona_id)!;
  const gate = checkSendGate(target);
  if (!gate.allowed) {
    sendQueue.markFailed(queueId, `blocked: ${gate.reason}`, false);
    logEvent(run.id, 'send_blocked', { gate: gate.reason, kind: queued.kind });
    return false;
  }

  const result = await currentAdapter().send({
    run,
    target,
    persona,
    channel: (run.channel ?? 'sms') as any,
    address: run.channel_address ?? '',
    body: queued.body,
    kind: queued.kind,
  });

  if (!result.ok) {
    sendQueue.markFailed(queueId, result.error, result.retryable);
    logEvent(run.id, 'send_failed', { kind: queued.kind, error: result.error, retryable: result.retryable });
    if (!result.retryable && run.channel === 'sms' && run.channel_address) {
      // Cache the carrier's verdict so this dead number is not retried next cycle.
      recordSendFailure(target, run.channel_address, result.error);
      if (queued.kind === 'first_contact') {
        closeRun(run, 'UNREACHABLE', `carrier rejected the only channel: ${result.error.slice(0, 160)}`);
      }
    }
    return false;
  }

  const ts = nowIso();
  sendQueue.markSent(queueId, result.provider_id ?? null);
  messages.add({
    run_id: run.id,
    direction: 'out',
    body: queued.body,
    ts,
    sender_type: 'persona',
    provider: currentAdapter().name,
    provider_id: result.provider_id,
    kind: queued.kind,
  });

  const patch: RunPatch = { last_outbound_at: ts, live: currentAdapter().name !== 'mock' };
  if (queued.kind === 'first_contact') patch.t0 = ts;
  if (queued.kind === 'nudge') patch.nudges_sent = run.nudges_sent + 1;
  runs.patch(run.id, patch);

  if (run.state === 'CREATED') runs.transition(run.id, 'CONTACTED');
  const after = runs.get(run.id)!;
  if (after.state === 'CONTACTED') runs.transition(run.id, 'AWAITING_REPLY');

  logEvent(run.id, 'sent', { kind: queued.kind, provider_id: result.provider_id, note: result.note });
  return true;
}

type SweepAction = 'none' | 'nudged' | 'closed' | 'promise_broken';

async function sweepRun(runId: string): Promise<SweepAction> {
  return runs.withLock(runId, async (run) => {
    if (!run.t0) return 'none';
    const target = targets.get(run.target_id)!;
    const persona = personas.get(run.persona_id)!;

    // Wall clock is absolute and ignores business hours by design.
    const wallHours = rawMinutesBetween(run.t0, nowIso()) / 60;
    if (wallHours >= config.loop.wallClockHours) {
      closeRun(run, run.first_reply_at ? 'STALLED' : 'NO_RESPONSE', `${config.loop.wallClockHours}h wall clock reached`);
      return 'closed';
    }

    // A promise with an expired deadline and nothing since is the damning finding.
    if (run.promise_deadline && run.promise_kept === null && new Date(run.promise_deadline) < new Date()) {
      const view = buildView(run);
      const decision = decideOnSilence(view, { promiseOverdue: true, pastCutoff: false, nudgesSent: run.nudges_sent });
      runs.patch(run.id, { promise_kept: false });
      closeRun(runs.get(run.id)!, decision!.terminal_state!, decision!.reason);
      return 'promise_broken';
    }

    // Anything still queued means we are not actually waiting on them.
    if (sendQueue.pendingForRun(run.id).length > 0) return 'none';

    const since = run.last_inbound_at ?? run.last_outbound_at ?? run.t0;
    const { minutes, basis } = elapsed(run, target, since);
    const view = buildView(run);

    const pastCutoff = minutes >= config.loop.noResponseCutoffBizMinutes;
    const pastNudge = minutes >= config.loop.nudgeAfterBizMinutes;
    if (!pastCutoff && !pastNudge) return 'none';

    const decision = decideOnSilence(view, { promiseOverdue: false, pastCutoff, nudgesSent: run.nudges_sent });
    if (!decision) return 'none';

    if (decision.action === 'terminate') {
      closeRun(run, decision.terminal_state!, `${decision.reason} (${minutes}m ${basis})`);
      return 'closed';
    }

    const gate = checkSendGate(target);
    if (!gate.allowed) return 'none';
    const composed = await composeReply({
      persona,
      target,
      goal: decision.goal,
      classification: null,
      transcript: messages.forRun(run.id).map((m) => ({ direction: m.direction, body: m.body })),
      channel: run.channel ?? 'sms',
    });
    sendQueue.enqueue({ run_id: run.id, kind: 'nudge', body: composed.body, delayMs: 0 });
    logEvent(run.id, 'nudge_queued', { silent_minutes: minutes, basis, nudge_number: run.nudges_sent + 1 });
    return 'nudged';
  });
}
