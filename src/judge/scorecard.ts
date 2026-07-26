/**
 * Tier 2 and the scorecard (spec section 7).
 *
 * Every number here comes from stored timestamps and flags. The model is given one job —
 * a two-sentence narrative — and if it is unavailable the scorecard is still complete.
 * That ordering is deliberate: a grade that depends on a model call is a grade that
 * disappears when the model is down.
 *
 * The two scores never merge. An unqualified persona that gets booked is a harness success
 * and a business failure, and collapsing them into one number destroys the finding.
 */
import { config } from '../config.ts';
import { chatText } from './llm.ts';
import { businessMinutesBetween, rawMinutesBetween } from '../domain/hours.ts';
import { OUTCOMES, screeningVerdict } from '../domain/states.ts';
import type { Message, Persona, Run, Scorecard, Target } from '../domain/types.ts';

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

function latencyPair(
  fromIso: string | null,
  toIso: string | null,
  target: Target,
): { raw: number | null; business: number | null } {
  if (!fromIso || !toIso) return { raw: null, business: null };
  return {
    raw: rawMinutesBetween(fromIso, toIso),
    business: businessMinutesBetween(fromIso, toIso, target.hours, target.timezone),
  };
}

/**
 * Grade the business against its own marketing claim. A firm advertising 24/7 is held to
 * the wall clock; everyone else gets business hours, because an 11pm inquiry answered at
 * 9am is not a slow business and raw elapsed time would libel them.
 */
function gradingBasis(target: Target): { basis: 'raw' | 'business'; why: string } {
  if (target.claims_247) {
    return { basis: 'raw', why: 'business advertises 24/7, so it is held to the wall clock' };
  }
  if (target.hours_confidence === 'none') {
    return { basis: 'raw', why: 'no parseable published hours, so business time cannot be computed' };
  }
  return { basis: 'business', why: 'graded on business hours from published opening times' };
}

/** Response-speed bands, in the units we are grading on. */
function speedPoints(minutes: number | null, basis: 'raw' | 'business'): { points: number; note: string } {
  if (minutes === null) return { points: 0, note: 'never replied' };
  const unit = basis === 'raw' ? 'elapsed' : 'business';
  if (minutes <= 5) return { points: 30, note: `replied in ${minutes}m ${unit}` };
  if (minutes <= 15) return { points: 26, note: `replied in ${minutes}m ${unit}` };
  if (minutes <= 60) return { points: 20, note: `replied in ${minutes}m ${unit}` };
  if (minutes <= 240) return { points: 12, note: `replied in ${Math.round(minutes / 60)}h ${unit}` };
  if (minutes <= 1440) return { points: 6, note: `replied after ${Math.round(minutes / 60)}h ${unit}` };
  return { points: 2, note: `replied after ${Math.round(minutes / 1440)}d ${unit}` };
}

function outcomePoints(terminalState: string, qualified: boolean): { points: number; note: string } {
  // For an unqualified persona a clean decline is the best possible behaviour, so the
  // ladder is not simply inverted rank — correctness depends on who was asking.
  if (!qualified) {
    if (terminalState === 'DEFLECTED') return { points: 45, note: 'correctly screened out an unqualified inquiry' };
    if (terminalState.startsWith('BOOKED')) {
      return { points: 5, note: 'booked a matter it does not handle, consuming intake capacity' };
    }
    if (terminalState.startsWith('HUMAN')) {
      return { points: 20, note: 'engaged a human on a matter it does not handle without screening it out' };
    }
  }
  const byOutcome: Record<string, [number, string]> = {
    BOOKED_WITH_SPECIALIST: [45, 'booked with someone who handles this matter'],
    BOOKED_GENERIC: [38, 'booked a meeting, specialist unconfirmed'],
    HUMAN_SPECIALIST: [32, 'reached the right person, no booking offered'],
    HUMAN_GENERIC: [22, 'reached only a gatekeeper'],
    DEFLECTED: [18, 'declined a matter it advertises'],
    PROMISE_BROKEN: [4, 'promised a callback and never delivered it'],
    BOT_LOOP: [6, 'never escaped its own automation'],
    STALLED: [8, 'conversation went nowhere'],
    NO_RESPONSE: [0, 'never responded at all'],
    UNREACHABLE: [0, 'published no usable asynchronous channel'],
    OPTED_OUT: [0, 'not graded'],
  };
  const [points, note] = byOutcome[terminalState] ?? [0, 'unrecognised outcome'];
  return { points, note };
}

function toGrade(points: number): Grade {
  if (points >= 85) return 'A';
  if (points >= 70) return 'B';
  if (points >= 55) return 'C';
  if (points >= 35) return 'D';
  return 'F';
}

export type ScorecardInput = {
  run: Run;
  target: Target;
  persona: Persona;
  transcript: Message[];
};

export async function buildScorecard(input: ScorecardInput): Promise<Scorecard> {
  const { run, target, persona, transcript } = input;
  const terminalState = run.terminal_state ?? 'STALLED';
  const outcome = OUTCOMES[terminalState] ?? OUTCOMES.STALLED;
  const gradable = outcome.gradable;

  const inbound = transcript.filter((m) => m.direction === 'in');
  const outbound = transcript.filter((m) => m.direction === 'out');
  const flagsSeen = inbound.map((m) => m.flags).filter(Boolean);

  const firstReply = latencyPair(run.t0, run.first_reply_at, target);
  const firstHuman = latencyPair(run.t0, run.first_human_at, target);
  const bookingOffer = latencyPair(run.t0, run.booking_offered_at, target);

  const { basis, why: basisWhy } = gradingBasis(target);
  const gradedMinutes = basis === 'raw' ? firstReply.raw : firstReply.business;

  const screening = screeningVerdict(run.qualified, outcome.bucket);

  // ---- business score: speed + outcome + conduct --------------------------
  const speed = speedPoints(gradedMinutes, basis);
  const outcomeScore = outcomePoints(terminalState, run.qualified);
  const reasons: string[] = [];
  let conduct = 0;

  if (flagsSeen.some((f) => f!.question_answered)) {
    conduct += 10;
    reasons.push('answered the question that was asked');
  } else if (inbound.length > 0) {
    reasons.push('never actually answered the question asked');
  }
  if (flagsSeen.some((f) => f!.price_given)) {
    conduct += 8;
    reasons.push('disclosed cost or fee terms');
  } else if (inbound.length > 0) {
    reasons.push('never disclosed what it would cost');
  }
  if (flagsSeen.some((f) => f!.specialist_identified)) {
    conduct += 7;
    reasons.push('identified who handles this matter');
  }
  if (run.promise_kept === true) {
    conduct += 5;
    reasons.push('kept a promised callback');
  }
  if (run.promise_kept === false) {
    conduct -= 10;
    reasons.push('broke a promised callback — the most damning finding available');
  }
  if (target.claims_247 && (gradedMinutes === null || gradedMinutes > 60)) {
    conduct -= 8;
    reasons.push('advertises 24/7 availability but did not answer promptly');
  }
  if (terminalState === 'UNREACHABLE' && target.claims_247) {
    reasons.push('advertises 24/7 availability with no asynchronous channel at all');
  }
  if (run.turns_in_automation && run.turns_in_automation >= 3) {
    conduct -= 5;
    reasons.push(`${run.turns_in_automation} automated replies before any human appeared`);
  }

  reasons.unshift(speed.note, outcomeScore.note);
  const points = Math.max(0, Math.min(100, speed.points + outcomeScore.points + conduct));

  // ---- harness score: did OUR agent do its job ---------------------------
  const harness = harnessScore(run, terminalState, inbound.length, outbound.length);

  const narrative = await writeNarrative({
    run,
    target,
    persona,
    transcript,
    terminalState,
    screening: screening.verdict,
    gradedMinutes,
    basis,
  });

  return {
    run_id: run.id,
    target: { name: target.name, url: target.url, category: target.category, claims_247: target.claims_247 },
    persona: { name: persona.name, need: persona.need },
    qualified: run.qualified,
    terminal_state: terminalState,
    terminal_rank: outcome.rank,
    latency: {
      first_reply_raw_minutes: firstReply.raw,
      first_reply_business_minutes: firstReply.business,
      first_human_raw_minutes: firstHuman.raw,
      first_human_business_minutes: firstHuman.business,
      booking_offer_raw_minutes: bookingOffer.raw,
      graded_on: basis,
      graded_minutes: gradedMinutes,
      hours_confidence: target.hours_confidence,
    },
    conversation: {
      inbound_count: inbound.length,
      outbound_count: outbound.length,
      turns: run.turns,
      turns_in_automation: run.turns_in_automation,
      first_reply_sender: run.first_reply_sender,
      reached_human: !!run.first_human_at,
      question_answered: flagsSeen.some((f) => f!.question_answered),
      price_disclosed: flagsSeen.some((f) => f!.price_given),
      followups_from_business: Math.max(0, inbound.length - outbound.length),
      nudges_sent: run.nudges_sent,
    },
    promise: {
      made: !!run.promise_made_at,
      window: run.promise_window_text,
      deadline: run.promise_deadline,
      kept: run.promise_kept,
    },
    screening: { outcome_bucket: outcome.bucket, verdict: screening.verdict, note: screening.note },
    harness_score: harness,
    business_score: gradable
      ? { grade: toGrade(points), points, reasons }
      : { grade: 'F', points: 0, reasons: [`${terminalState} is excluded from business grading`, ...reasons] },
    narrative,
    generated_at: new Date().toISOString(),
    judge: `${basisWhy}; narrative ${narrative ? config.llm.deepModel : 'unavailable'}`,
  };
}

/**
 * Did the harness complete its mission? Deliberately independent of whether the business
 * behaved well. UNREACHABLE is a harness success: it correctly established that no channel
 * existed, which is a real finding rather than a failure to try.
 */
function harnessScore(
  run: Run,
  terminalState: string,
  inboundCount: number,
  outboundCount: number,
): { completed_mission: boolean; reason: string } {
  if (terminalState === 'UNREACHABLE') {
    return { completed_mission: true, reason: 'correctly established that no usable channel existed' };
  }
  if (terminalState === 'OPTED_OUT') {
    return { completed_mission: true, reason: 'honoured an opt-out immediately, as required' };
  }
  if (outboundCount === 0) {
    return { completed_mission: false, reason: 'never managed to send anything' };
  }
  // Any outcome where the business actually engaged means the harness got where it was
  // going, whatever the business then did with the inquiry.
  if (/^(?:BOOKED|HUMAN|DEFLECTED)/.test(terminalState)) {
    return { completed_mission: true, reason: `drove the conversation to ${terminalState}` };
  }
  if (terminalState === 'NO_RESPONSE') {
    return {
      completed_mission: true,
      reason: `made contact and waited out the cutoff with ${run.nudges_sent} nudges; silence is the business's answer`,
    };
  }
  if (inboundCount === 0) {
    return { completed_mission: false, reason: 'closed without ever receiving a reply or reaching the cutoff' };
  }
  if (terminalState === 'STALLED' && run.turns < config.loop.maxTurns) {
    return { completed_mission: false, reason: 'stalled before exhausting its turn budget' };
  }
  return {
    completed_mission: true,
    reason: `worked the conversation for ${run.turns} turns to a terminal state`,
  };
}

const NARRATIVE_SYSTEM = `You write two sentences about how a business handled an inbound customer inquiry.

Rules:
- Exactly two sentences. No preamble, no bullet points, no restating the label.
- Describe what the business actually did and what it cost the customer.
- Be specific about latency and who replied. Never invent a number that is not given.
- Neutral and factual. This is an audit finding, not marketing copy.`;

async function writeNarrative(input: {
  run: Run;
  target: Target;
  persona: Persona;
  transcript: Message[];
  terminalState: string;
  screening: string;
  gradedMinutes: number | null;
  basis: string;
}): Promise<string | null> {
  const convo = input.transcript
    .map((m) => `${m.direction === 'in' ? 'business' : 'customer'}${m.sender_type ? ` (${m.sender_type})` : ''}: ${m.body}`)
    .join('\n')
    .slice(0, 6000);

  const facts = [
    `Business: ${input.target.name ?? input.target.domain}`,
    `Advertises 24/7: ${input.target.claims_247}`,
    `Customer need: ${input.persona.need}`,
    `Was this a matter they advertise? ${input.run.qualified ? 'yes' : 'no'}`,
    `Outcome: ${input.terminalState}`,
    `Screening verdict: ${input.screening}`,
    `Time to first reply: ${input.gradedMinutes === null ? 'never replied' : `${input.gradedMinutes} minutes (${input.basis})`}`,
    `First reply came from: ${input.run.first_reply_sender ?? 'nobody'}`,
    `Reached a human: ${input.run.first_human_at ? 'yes' : 'no'}`,
    `Automated replies before a human: ${input.run.turns_in_automation ?? 'n/a'}`,
    input.run.promise_made_at
      ? `Promised a callback "${input.run.promise_window_text}" — ${input.run.promise_kept === false ? 'BROKEN' : input.run.promise_kept ? 'kept' : 'unresolved'}`
      : 'No callback promised',
  ].join('\n');

  const raw = await chatText({
    model: config.llm.deepModel,
    tag: 'tier2_narrative',
    maxTokens: 400,
    system: NARRATIVE_SYSTEM,
    user: `Facts:\n${facts}\n\nTranscript:\n${convo || '(nothing was ever exchanged)'}`,
  });
  if (!raw) return deterministicNarrative(input);
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > 10 ? text : deterministicNarrative(input);
}

/** Written from facts when the model is unavailable, so a scorecard is never empty. */
function deterministicNarrative(input: {
  run: Run;
  target: Target;
  terminalState: string;
  gradedMinutes: number | null;
  basis: string;
}): string {
  const name = input.target.name ?? input.target.domain;
  const blurb = OUTCOMES[input.terminalState]?.blurb ?? 'The run ended without resolution.';
  const speed =
    input.gradedMinutes === null
      ? 'Nothing ever came back.'
      : `First reply took ${input.gradedMinutes} minutes of ${input.basis} time and came from ${input.run.first_reply_sender ?? 'an unknown sender'}.`;
  const promise =
    input.run.promise_kept === false
      ? ` A callback was promised (${input.run.promise_window_text}) and never arrived.`
      : '';
  return `${name}: ${blurb} ${speed}${promise}`.replace(/\s+/g, ' ').trim();
}
