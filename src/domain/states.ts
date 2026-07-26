/**
 * Two axes, deliberately not one.
 *
 *  - lifecycle  (runs.state)          where the machine is: CREATED .. CLEANED_UP
 *  - outcome    (runs.terminal_state) how far the conversation got, ranked
 *
 * The spec folded these together, which meant reaching a terminal state and then
 * grading it overwrote the outcome. It also ranked PROMISE_KEPT as an outcome, but a
 * kept callback IS a human on the line, so it resolves to HUMAN_* / BOOKED_* and
 * promise.kept becomes a separate boolean. DEFLECTED is likewise not "bad": rank here
 * measures engagement reached, and correctness comes from the qualification matrix.
 */

export const LIFECYCLE = [
  'CREATED',
  'CONTACTED',
  'AWAITING_REPLY',
  'IN_CONVERSATION',
  'TERMINAL',
  'GRADED',
  'CLEANED_UP',
] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

const EDGES: Record<Lifecycle, Lifecycle[]> = {
  CREATED: ['CONTACTED', 'TERMINAL'], // TERMINAL covers UNREACHABLE before any send
  CONTACTED: ['AWAITING_REPLY', 'TERMINAL'],
  AWAITING_REPLY: ['IN_CONVERSATION', 'AWAITING_REPLY', 'TERMINAL'],
  IN_CONVERSATION: ['IN_CONVERSATION', 'AWAITING_REPLY', 'TERMINAL'],
  TERMINAL: ['GRADED'],
  GRADED: ['CLEANED_UP'],
  CLEANED_UP: [],
};

export type OutcomeDef = {
  rank: number;
  label: string;
  /** Did the business actually handle the inquiry (human contact or booking)? */
  bucket: 'handled' | 'not_handled';
  /** OPTED_OUT is excluded from business grading: we stopped, they did not fail. */
  gradable: boolean;
  blurb: string;
};

export const OUTCOMES: Record<string, OutcomeDef> = {
  BOOKED_WITH_SPECIALIST: {
    rank: 1,
    label: 'Booked with specialist',
    bucket: 'handled',
    gradable: true,
    blurb: 'Meeting scheduled with someone who handles this matter.',
  },
  BOOKED_GENERIC: {
    rank: 2,
    label: 'Booked (generic)',
    bucket: 'handled',
    gradable: true,
    blurb: 'Meeting scheduled, specialist unconfirmed.',
  },
  HUMAN_SPECIALIST: {
    rank: 3,
    label: 'Human specialist',
    bucket: 'handled',
    gradable: true,
    blurb: 'Live human, right person, no booking.',
  },
  HUMAN_GENERIC: {
    rank: 4,
    label: 'Human generic',
    bucket: 'handled',
    gradable: true,
    blurb: 'Live human, wrong person or gatekeeper only.',
  },
  DEFLECTED: {
    rank: 5,
    label: 'Deflected',
    bucket: 'handled',
    gradable: true,
    blurb: 'Declined or referred elsewhere. Correct for an unqualified persona.',
  },
  PROMISE_BROKEN: {
    rank: 6,
    label: 'Promise broken',
    bucket: 'not_handled',
    gradable: true,
    blurb: 'Callback promised in a stated window, never arrived.',
  },
  BOT_LOOP: {
    rank: 7,
    label: 'Bot loop',
    bucket: 'not_handled',
    gradable: true,
    blurb: 'Never escaped the automation.',
  },
  STALLED: {
    rank: 8,
    label: 'Stalled',
    bucket: 'not_handled',
    gradable: true,
    blurb: 'Turn cap or wall clock hit with no resolution.',
  },
  NO_RESPONSE: {
    rank: 9,
    label: 'No response',
    bucket: 'not_handled',
    gradable: true,
    blurb: 'Nothing came back at all.',
  },
  UNREACHABLE: {
    rank: 10,
    label: 'Unreachable',
    bucket: 'not_handled',
    gradable: true,
    blurb: 'No usable asynchronous channel existed.',
  },
  OPTED_OUT: {
    rank: 11,
    label: 'Opted out',
    bucket: 'not_handled',
    gradable: false,
    blurb: 'Recipient asked us to stop. Honoured immediately, excluded from grading.',
  },
};

export const OUTCOME_NAMES = Object.keys(OUTCOMES).sort(
  (a, b) => OUTCOMES[a].rank - OUTCOMES[b].rank,
);

export function isOutcome(name: string | null | undefined): boolean {
  return !!name && name in OUTCOMES;
}

export function outcomeRank(name: string | null | undefined): number {
  return isOutcome(name) ? OUTCOMES[name as string].rank : 99;
}

/** True when `next` is a strictly better outcome than `current`. */
export function isBetterOutcome(next: string, current: string | null): boolean {
  return outcomeRank(next) < outcomeRank(current);
}

export function canTransition(from: string, to: string): boolean {
  const allowed = EDGES[from as Lifecycle];
  return !!allowed && allowed.includes(to as Lifecycle);
}

export class IllegalTransition extends Error {
  from: string;
  to: string;
  constructor(from: string, to: string) {
    super(`illegal state transition ${from} -> ${to}`);
    this.name = 'IllegalTransition';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export function isClosed(lifecycle: string): boolean {
  return lifecycle === 'TERMINAL' || lifecycle === 'GRADED' || lifecycle === 'CLEANED_UP';
}

/**
 * Confusion matrix from spec section 7, as data rather than prose.
 * A qualified persona that never got handled is the expensive miss; an unqualified
 * persona that got booked is a business failure and a harness success.
 */
export function screeningVerdict(
  qualified: boolean,
  bucket: 'handled' | 'not_handled',
): { verdict: 'correct' | 'miss_expensive' | 'wasted_time' | 'correct_decline'; note: string } {
  if (qualified && bucket === 'handled')
    return { verdict: 'correct', note: 'Qualified inquiry was handled.' };
  if (qualified && bucket === 'not_handled')
    return { verdict: 'miss_expensive', note: 'Qualified inquiry never handled. Lost matter.' };
  if (!qualified && bucket === 'handled')
    return {
      verdict: 'wasted_time',
      note: 'Unqualified inquiry consumed intake capacity instead of being screened out.',
    };
  return { verdict: 'correct_decline', note: 'Unqualified inquiry was correctly screened out.' };
}
