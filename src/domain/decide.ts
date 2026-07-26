/**
 * Policy. Given what the judge perceived and where the run is, decide continue or stop.
 *
 * Kept out of the model on purpose: an outcome ladder decided by a prompt is a scorecard
 * that cannot be tested. Every branch here is a pure function of stored facts.
 */
import { config } from '../config.ts';
import type { Classification } from './types.ts';

export type RunView = {
  turns: number;
  inboundCount: number;
  /** Inbound messages classified autoresponder or ai_agent. */
  machineInbound: number;
  humanSeen: boolean;
  /** Inbound turns since the first human appeared, 0 when none. */
  turnsSinceHuman: number;
  priceSeen: boolean;
  meetingOffered: boolean;
  specialistSeen: boolean;
  t0: string | null;
};

export type Goal =
  | 'answer_and_seek_human'
  | 'escalate_to_human'
  | 'seek_specialist'
  | 'seek_booking'
  | 'confirm_booking'
  | 'ask_cost'
  | 'answer_question'
  | 'acknowledge_wait'
  | 'wrap_up';

export type Decision = {
  action: 'reply' | 'terminate';
  terminal_state?: string;
  reason: string;
  goal: Goal;
};

/** Turns spent chasing a human after one appeared before we accept HUMAN_* and stop. */
const HUMAN_PURSUIT_TURNS = 2;

/**
 * How many inbound messages the business gets before the persona asks to be put through to
 * a person.
 *
 * A real client with a fresh injury answers what they are asked. They do not demand a
 * supervisor on the second message — and a persona that does corrupts the measurement,
 * because a well-run intake desk offers the callback itself once it has the facts. Asking
 * early pre-empts exactly the behaviour under test and makes every business look the same.
 *
 * Below this floor the persona stays a cooperative client: answer, volunteer detail, accept
 * whatever next step is offered. Above it, silence from a human is a real finding.
 */
const ESCALATION_FLOOR_INBOUND = 10;

/**
 * Policy switches. Passed in rather than read from config inside, so the decision function
 * stays pure and a test can exercise both settings in one process.
 */
export type DecideOptions = { keepTalking?: boolean };

export function decide(
  view: RunView,
  cls: Classification,
  lastInbound: string | null = null,
  opts: DecideOptions = {},
): Decision {
  const f = cls.flags;
  const keepTalking = opts.keepTalking ?? config.loop.keepTalking;

  if (f.opt_out_requested) {
    return {
      action: 'terminate',
      terminal_state: 'OPTED_OUT',
      reason: 'recipient asked to stop; honoured immediately',
      goal: 'wrap_up',
    };
  }

  if (f.booking_confirmed) {
    const specialist = f.specialist_identified || view.specialistSeen;
    return {
      action: 'terminate',
      terminal_state: specialist ? 'BOOKED_WITH_SPECIALIST' : 'BOOKED_GENERIC',
      reason: specialist
        ? `slot confirmed with ${f.specialist_role ?? 'an identified specialist'}`
        : 'slot confirmed, specialist unconfirmed',
      goal: 'wrap_up',
    };
  }

  if (f.declined_or_referred) {
    return {
      action: 'terminate',
      terminal_state: 'DEFLECTED',
      reason: 'business declined the matter or referred it elsewhere',
      goal: 'wrap_up',
    };
  }

  const humanNow = cls.sender_type === 'human';
  const humanSeen = view.humanSeen || humanNow;
  const turnsSinceHuman = humanNow && !view.humanSeen ? 0 : view.turnsSinceHuman;

  // Turn cap. BOT_LOOP and STALLED are different findings: one never escaped automation,
  // the other had a human and still went nowhere.
  if (view.turns >= config.loop.maxTurns) {
    if (!humanSeen && view.inboundCount > 0 && view.machineInbound === view.inboundCount) {
      return {
        action: 'terminate',
        terminal_state: 'BOT_LOOP',
        reason: `turn cap reached after ${view.inboundCount} machine replies and no human`,
        goal: 'wrap_up',
      };
    }
    return {
      action: 'terminate',
      terminal_state: humanSeen ? bestHumanOutcome(f.specialist_identified || view.specialistSeen) : 'STALLED',
      reason: `turn cap (${config.loop.maxTurns}) reached`,
      goal: 'wrap_up',
    };
  }

  // Only settle for HUMAN_* once there is genuinely nothing still in play. Closing while a
  // slot is on the table throws away the better outcome one turn before it lands, and
  // closing after someone says "wait, let me check" hangs up on a person mid-sentence —
  // recording a worse outcome than they earned and being rude while doing it.
  const bookingInPlay = f.meeting_offered || f.booking_link || view.meetingOffered;
  if (f.asked_to_wait) {
    return {
      action: 'reply',
      reason: 'the business asked us to hold, so the run stays open',
      goal: 'acknowledge_wait',
    };
  }
  /**
   * An unanswered question keeps the run open, for the same reason `asked_to_wait` does:
   * terminating on a question leaves the business mid-intake and grades them on an exchange
   * we abandoned. Answer first; settle when they stop asking.
   */
  if (
    !keepTalking &&
    humanSeen &&
    turnsSinceHuman >= HUMAN_PURSUIT_TURNS &&
    !bookingInPlay &&
    !askedUsSomething(lastInbound)
  ) {
    const specialist = f.specialist_identified || view.specialistSeen;
    return {
      action: 'terminate',
      terminal_state: bestHumanOutcome(specialist),
      reason: specialist
        ? 'reached the person who handles this matter; no booking on offer'
        : 'reached a human but only a gatekeeper, and no booking on offer',
      goal: 'wrap_up',
    };
  }

  return {
    action: 'reply',
    reason: 'conversation still progressing',
    goal: nextGoal(view, cls, humanSeen, lastInbound),
  };
}

function bestHumanOutcome(specialist: boolean): string {
  return specialist ? 'HUMAN_SPECIALIST' : 'HUMAN_GENERIC';
}

/**
 * Words that name a detail an intake desk collects. Used only to read telegraphic requests.
 */
const DETAIL_WORDS =
  /\b(?:name|dob|birth|address|location|city|street|intersection|time|date|day|phone|number|email|insurance|insurer|policy|claim|injur\w*|hurt|doctor|hospital|police|report|damage|vehicle|car|plate|employer|driver)\b/i;

/**
 * Did they ask us something? A question mark is the cheap signal, but intake staff
 * routinely ask without one ("tell me what happened", "let me know the date").
 *
 * They also type telegraphically, with no verb and no punctuation at all: "location", "what
 * time and date", "dob". Those are requests, and reading them as remarks makes the persona
 * pursue its own agenda while a real question sits unanswered — the exact behaviour that
 * produced "what time and date" → "Are you the person who handles these?" in a live run.
 * The word cap keeps this to fragments; a full sentence that merely mentions a car is prose.
 */
function askedUsSomething(body: string | null): boolean {
  if (!body) return false;
  if (body.includes('?')) return true;
  if (
    /\b(?:tell me|let me know|can you (?:confirm|send|share|provide)|what (?:is|was|are|time|date)|when (?:did|was)|where (?:did|was)|how (?:did|bad|many|long)|who (?:was|is)|please (?:confirm|send|share|provide|describe)|need (?:to know|your)|send me)\b/i.test(
      body,
    )
  ) {
    return true;
  }
  const words = body.trim().split(/\s+/);
  // A fragment about themselves is a statement, not a request: "we handle car accidents"
  // names a detail word and asks for nothing.
  if (/\b(?:we|our|us)\b/i.test(body)) return false;
  return words.length <= 8 && DETAIL_WORDS.test(body);
}

function nextGoal(view: RunView, cls: Classification, humanSeen: boolean, lastInbound: string | null): Goal {
  const f = cls.flags;
  if (f.booking_link || f.meeting_offered) return 'confirm_booking';

  /**
   * If they asked a question, answer it. This outranks every other objective.
   *
   * Ignoring a direct question to pursue our own agenda is both rude and useless as
   * measurement: a business that asks "when did this happen" and gets an unrelated
   * question back is being tested on our behaviour, not theirs. It also reads instantly
   * as a bot, which changes how they treat the rest of the conversation.
   */
  if (askedUsSomething(lastInbound)) return 'answer_question';

  // Below the floor the persona never asks for a person; it cooperates and waits to be
  // offered a next step. See ESCALATION_FLOOR_INBOUND.
  const mayAskForPerson = view.inboundCount >= ESCALATION_FLOOR_INBOUND;

  if (cls.sender_type === 'autoresponder' || cls.sender_type === 'ai_agent') {
    if (!mayAskForPerson) return 'seek_booking';
    // Two machine replies is enough patience before asking for a person.
    return view.machineInbound >= 2 ? 'escalate_to_human' : 'answer_and_seek_human';
  }
  if (mayAskForPerson && humanSeen && !view.specialistSeen && !f.specialist_identified) return 'seek_specialist';
  if (humanSeen && !view.priceSeen && !f.price_given) return 'ask_cost';
  return 'seek_booking';
}

/** Sweeper path: silence, not a message. Kept here so all policy lives in one file. */
export function decideOnSilence(view: RunView, opts: { promiseOverdue: boolean; pastCutoff: boolean; nudgesSent: number }): Decision | null {
  if (opts.promiseOverdue) {
    return {
      action: 'terminate',
      terminal_state: 'PROMISE_BROKEN',
      reason: 'callback was promised in a stated window and the window expired in silence',
      goal: 'wrap_up',
    };
  }
  if (opts.pastCutoff) {
    if (view.inboundCount === 0) {
      return {
        action: 'terminate',
        terminal_state: 'NO_RESPONSE',
        reason: 'no reply of any kind before the cutoff',
        goal: 'wrap_up',
      };
    }
    if (!view.humanSeen && view.machineInbound === view.inboundCount) {
      return {
        action: 'terminate',
        terminal_state: 'BOT_LOOP',
        reason: 'only automation ever replied, then it stopped',
        goal: 'wrap_up',
      };
    }
    return {
      action: 'terminate',
      terminal_state: view.humanSeen ? bestHumanOutcome(view.specialistSeen) : 'STALLED',
      reason: 'conversation went quiet past the cutoff',
      goal: 'wrap_up',
    };
  }
  if (opts.nudgesSent < config.loop.maxNudges) {
    return { action: 'reply', reason: 'silence past nudge threshold', goal: 'escalate_to_human' };
  }
  return null;
}
