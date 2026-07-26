/**
 * Persona voice. Separate from classify.ts so a bad reply can never corrupt a
 * classification, and separate from decide.ts so prose can never change the outcome.
 * The model only phrases a decision that has already been made.
 */
import { config } from '../config.ts';
import { chatText } from './llm.ts';
import type { Goal } from '../domain/decide.ts';
import type { Classification, Persona, Target } from '../domain/types.ts';

/** Anything that would commit the persona. If a model emits one, we drop its output. */
const FORBIDDEN =
  /\b(?:i (?:agree|accept|consent)(?: to)?|sign(?:ed|ing)? (?:the|this|your) (?:agreement|retainer|contract)|e-?sign|retainer agreement is fine|you may charge|here is my (?:card|credit card|ssn|social)|i authorize)\b/i;

const MAX_SMS = 320;

function trim(text: string, max = MAX_SMS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trim();
}

export function firstContactMessage(persona: Persona, target: Target, channel: string): string {
  const need = persona.need.split(/(?<=[.?!])\s/)[0] ?? persona.need;
  const who = target.name ? `Hi ${target.name.replace(/\s*[|–—-].*$/, '')}` : 'Hi';
  const body = `${who} — my name is ${persona.name}. ${need} Is this something you handle, and what would it cost to talk to someone?`;
  return channel === 'email' ? body : trim(body);
}

const GOAL_INSTRUCTION: Record<Goal, string> = {
  answer_and_seek_human:
    'Answer what they asked using the backstory, then ask to speak with a person who handles this.',
  escalate_to_human:
    'You have now had multiple automated replies. Ask directly and politely for a real person, and say what you need from them.',
  seek_specialist:
    'You are talking to a person. Ask whether they are the one who handles this kind of matter, or who is.',
  seek_booking: 'Ask for a specific time to talk, today or tomorrow.',
  confirm_booking:
    'They offered a time or a booking link. Accept the earliest option and confirm plainly. Do not agree to fees or sign anything.',
  ask_cost: 'Ask concretely what talking to them would cost you.',
  acknowledge_wait:
    'They asked you to hold. Say briefly that you will wait and nothing more. Do not ask a new question.',
  wrap_up: 'Acknowledge their answer briefly and close the conversation politely.',
};

const TEMPLATES: Record<Goal, (p: Persona) => string> = {
  answer_and_seek_human: (p) =>
    `Thanks. ${firstLine(p.need)} Could I speak with someone there about it?`,
  escalate_to_human: (p) =>
    `I think I've only reached an automated reply so far. Is there a person I can talk to about ${topic(p)}? I'd rather not go through the insurer without advice.`,
  seek_specialist: () =>
    `Thanks for getting back to me. Are you the person who handles these, or is there someone else I should speak with?`,
  seek_booking: () =>
    `That helps, thank you. Is there a time today or tomorrow I could talk to someone for a few minutes?`,
  confirm_booking: () =>
    `That works for me — please put me down for the earliest time you have. I'll keep it short.`,
  ask_cost: () =>
    `Before I go further: what would talking to you actually cost me? I don't have anything to put down up front.`,
  acknowledge_wait: () => `No problem, I'll wait. Thanks.`,
  wrap_up: () => `Understood, thanks for the clear answer. I appreciate you taking the time.`,
};

const firstLine = (text: string): string => (text.split(/(?<=[.?!])\s/)[0] ?? text).trim();
const topic = (p: Persona): string => p.need_tags[0]?.replace(/_/g, ' ') ?? 'my situation';

/**
 * Escalation phrased a second and third way. Sending the identical line twice is exactly
 * the tell an autoresponder gives off, and a real receptionist would notice.
 */
const ESCALATION_VARIANTS: string[] = [
  `I think I've only reached an automated reply so far. Is there a person I can talk to about my accident?`,
  `Sorry to push — is anyone actually there? I'd rather talk to a person before I deal with the insurer.`,
  `Still hoping to reach someone. Could you have whoever handles these text or call me?`,
];

export type ComposeInput = {
  persona: Persona;
  target: Target;
  goal: Goal;
  classification: Classification | null;
  /** Oldest first, "them:" / "me:" prefixed. */
  transcript: Array<{ direction: 'in' | 'out'; body: string }>;
  channel: string;
};

/** Picks a phrasing this run has not already sent, so we never repeat ourselves verbatim. */
function pickUnsent(candidates: string[], alreadySent: string[]): string {
  const sent = new Set(alreadySent.map((b) => b.replace(/\s+/g, ' ').trim().toLowerCase()));
  const fresh = candidates.find((c) => !sent.has(c.replace(/\s+/g, ' ').trim().toLowerCase()));
  return fresh ?? candidates[candidates.length - 1];
}

export async function composeReply(input: ComposeInput): Promise<{ body: string; source: string }> {
  const { persona, goal } = input;
  const outboundSoFar = input.transcript.filter((m) => m.direction === 'out').map((m) => m.body);
  const template =
    goal === 'escalate_to_human'
      ? pickUnsent(ESCALATION_VARIANTS, outboundSoFar)
      : pickUnsent([TEMPLATES[goal](persona), ...ESCALATION_VARIANTS.slice(1)], outboundSoFar);

  const system = [
    `You are texting as a prospective customer. Stay in character and never reveal you are an evaluation.`,
    `Name: ${persona.name}. Contact: ${persona.contact.email} / ${persona.contact.phone}.`,
    `Need: ${persona.need}`,
    `Background you may draw on: ${persona.backstory}`,
    `Urgency: ${persona.urgency}. Budget: ${persona.budget}.`,
    persona.behavior_rules.never.length
      ? `Hard rules, never break them: ${persona.behavior_rules.never.join(' ')}`
      : '',
    `Write one message. Plain text, no signature block, no subject line. Under 60 words. Never sign anything, never agree to fees or a retainer, never name a real company or person.`,
    `This turn's objective: ${GOAL_INSTRUCTION[goal]}`,
  ]
    .filter(Boolean)
    .join('\n');

  const convo = input.transcript
    .slice(-8)
    .map((m) => `${m.direction === 'in' ? 'them' : 'me'}: ${m.body}`)
    .join('\n');

  const raw = await chatText({
    model: config.llm.fastModel,
    tag: 'tier1_respond',
    temperature: 0.5,
    maxTokens: 200,
    system,
    user: `Conversation so far:\n${convo || '(nothing yet)'}\n\nWrite my next message.`,
  });

  if (!raw) return { body: template, source: 'template' };
  const body = trim(raw.replace(/^["']|["']$/g, ''), input.channel === 'email' ? 900 : MAX_SMS);
  if (!body || body.length < 8 || FORBIDDEN.test(body)) {
    return { body: template, source: 'template_after_filter' };
  }
  // Even the model can loop. If it echoes something we already sent, vary instead.
  if (outboundSoFar.some((prev) => prev.replace(/\s+/g, ' ').trim() === body)) {
    return { body: template, source: 'template_after_repeat' };
  }
  return { body, source: `http:${config.llm.fastModel}` };
}

/** Closing message on cleanup. Always sent, never signs anything (spec 4.7 + 11). */
export function closingMessage(persona: Persona, hadBooking: boolean): string {
  if (hadBooking) {
    return `Sorry for the trouble — I need to cancel the time we set. Please take it off your calendar; nothing else is needed from you. Thanks for your help.`;
  }
  return `Thanks again for your time — I'm not going to move forward right now. No need to follow up. Appreciate the help.`;
}
