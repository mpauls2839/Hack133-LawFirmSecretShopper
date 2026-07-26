/**
 * Tier 1, perception only.
 *
 * The spec had one model call emit sender_type, flags, next_state AND the reply text.
 * That is untestable: you cannot assert a classification fixture against a blob that also
 * contains a persona reply, and a refusal on the reply half destroys the classification
 * half. So this file answers exactly one question — who is talking and what did they
 * commit to — and nothing here decides policy or writes prose.
 */
import { config } from '../config.ts';
import { chatJson } from './llm.ts';
import { readInbound } from './deterministic.ts';
import type { Classification, Flags, SenderType } from '../domain/types.ts';

export type ClassifyInput = {
  body: string;
  /** Every earlier inbound body on this run, for near-duplicate detection. */
  priorInbound: string[];
  /** Seconds between our last outbound and this inbound. Timestamps, never a model. */
  secondsSinceOutbound: number | null;
  /** What we last asked, so "did they answer the question" is answerable. */
  lastOutbound: string | null;
};

type ModelRead = {
  sender_type?: string;
  question_answered?: boolean;
  specialist_identified?: boolean;
  specialist_role?: string | null;
  declined_or_referred?: boolean;
};

const SENDER_TYPES = ['autoresponder', 'ai_agent', 'human'] as const;

const SYSTEM = `You classify one inbound message from a service business replying to a prospective customer.

sender_type:
  autoresponder - canned acknowledgement, out-of-office, hours notice, compliance boilerplate. No awareness of what was asked.
  ai_agent      - conversational automation. Fluent and on-topic but scripted: runs a qualification script, never deviates, no personal detail, no human name.
  human         - a person. Signs a name, reacts to specifics, apologises for delay, has typos or informal phrasing, or answers something only a person would.

Also report:
  question_answered      - did this message actually answer what the customer last asked?
  specialist_identified  - does the sender identify a specific role or named person who handles this matter?
  specialist_role        - that role, lowercase, or null.
  declined_or_referred   - did they decline the matter or refer it elsewhere?

Shape: { "sender_type": string, "question_answered": boolean, "specialist_identified": boolean, "specialist_role": string|null, "declined_or_referred": boolean }`;

/**
 * Offline heuristic, and the fallback when the model is unavailable.
 *
 * Timing is weak evidence, not strong. A human on their phone answers a text in 30
 * seconds all the time; only a sub-10-second reply is machine-grade fast. Content wins
 * ties, because "this is Marcy at the front desk" is far better evidence of a person than
 * a 39-second gap is of a robot.
 */
export function heuristicSenderType(
  hints: { autoresponder: number; ai_agent: number; human: number },
  secondsSinceOutbound: number | null,
): { sender_type: Exclude<SenderType, 'persona'>; reason: string } {
  const scored = { ...hints };
  const gap = secondsSinceOutbound;
  if (gap !== null) {
    // Nobody reads and types a reply in under ten seconds. Weighted so a clear content
    // signal still wins: "this is Marcy, sorry for the delay" beats a fast clock.
    if (gap <= 10) scored.autoresponder += 2;
    else if (gap <= 30) scored.ai_agent += 1;
    else if (gap > 900) scored.human += 1;
  }

  // Content signals break ties: human, then ai_agent, then autoresponder.
  const order: Array<Exclude<SenderType, 'persona'>> = ['human', 'ai_agent', 'autoresponder'];
  const ranked = order
    .map((k) => [k, scored[k]] as const)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));

  const [top, topScore] = ranked[0];
  if (topScore === 0) {
    return { sender_type: 'ai_agent', reason: 'no distinguishing signal; scripted automation is the base rate' };
  }
  return { sender_type: top, reason: `heuristic ${JSON.stringify(scored)} gap=${gap ?? '?'}s` };
}

export async function classifyInbound(input: ClassifyInput): Promise<Classification> {
  const det = readInbound(input.body, input.priorInbound);
  const flags: Flags = det.flags;
  const reasons = [...det.reasons];

  const model = await chatJson<ModelRead>({
    model: config.llm.fastModel,
    tag: 'tier1_classify',
    maxTokens: 300,
    system: SYSTEM,
    user:
      `Customer's last message: ${input.lastOutbound ?? '(none)'}\n\n` +
      `Business reply: ${input.body}\n\n` +
      `Seconds between them: ${input.secondsSinceOutbound ?? 'unknown'}`,
  });

  let senderType: Exclude<SenderType, 'persona'>;
  let classifier: string;

  if (model && SENDER_TYPES.includes(model.sender_type as any)) {
    senderType = model.sender_type as Exclude<SenderType, 'persona'>;
    classifier = `http:${config.llm.fastModel}`;
    if (model.question_answered !== undefined) flags.question_answered = !!model.question_answered;
    if (model.specialist_identified) {
      flags.specialist_identified = true;
      flags.specialist_role ??= model.specialist_role?.toLowerCase() ?? null;
    }
    if (model.declined_or_referred) flags.declined_or_referred = true;
  } else {
    const h = heuristicSenderType(det.senderHints, input.secondsSinceOutbound);
    senderType = h.sender_type;
    classifier = 'stub';
    reasons.push(h.reason);
    // Offline read of "did they answer": a machine acknowledgement never does.
    flags.question_answered =
      senderType !== 'autoresponder' &&
      !!input.lastOutbound &&
      (flags.price_given || flags.meeting_offered || flags.declined_or_referred || input.body.length > 60);
  }

  // Deterministic wins every disagreement (spec section 6).
  if (det.forcedSenderType) {
    if (senderType !== det.forcedSenderType) {
      reasons.push(`deterministic override: model said ${senderType}, duplicate body says autoresponder`);
    }
    senderType = det.forcedSenderType;
  }
  if (senderType === 'autoresponder' && flags.question_answered) {
    flags.question_answered = false;
    reasons.push('autoresponder cannot have answered the question');
  }

  return { sender_type: senderType, flags, classifier, reasons };
}
