/**
 * Persona voice. Separate from classify.ts so a bad reply can never corrupt a
 * classification, and separate from decide.ts so prose can never change the outcome.
 * The model only phrases a decision that has already been made.
 */
import { config } from '../config.ts';
import { chatText } from './llm.ts';
import { improviseAll, improvisedSummary, PERSONA_FIELDS } from './improvise.ts';
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
  answer_question:
    'They asked you something. Answer ONLY that, directly and specifically, in one or two short sentences. ' +
    'Do not ask to speak to a person, do not ask about cost, do not ask for an appointment, do not add any ' +
    'question of your own. Answering and then immediately asking for something else is what makes an ' +
    'automated sender obvious.',
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
  // Deliberately just the answer. No request appended: when someone asks you a question,
  // replying with an answer plus a demand of your own is what a script does.
  answer_question: (p) => `${firstLine(p.need)}`,
  acknowledge_wait: () => `No problem, I'll wait. Thanks.`,
  wrap_up: () => `Understood, thanks for the clear answer. I appreciate you taking the time.`,
};

const firstLine = (text: string): string => (text.split(/(?<=[.?!])\s/)[0] ?? text).trim();

/**
 * Which case fact answers this question. Keyed by the words a business actually uses when
 * asking, matched against the labels in the persona's `## Case facts` bullets.
 *
 * This exists so a direct question gets a specific answer even with no model available.
 * Replying "unsure about insurance and next steps" to "where did it happen?" is worse than
 * useless: it reads as a bot and changes how the business treats the rest of the exchange.
 */
const FACT_QUESTIONS: Array<[RegExp, string]> = [
  // Availability is checked before "when", because "when are you available" is a question
  // about scheduling, not about the date of the accident.
  [/\b(?:available|availability|when (?:can|could|are) you|what times? (?:work|are you)|free (?:to|for|on))\b/i, 'availability'],
  // "date of" alone also matches "date of birth", which is not the accident date.
  [/\b(?:when did|when was|what date|which day|how long ago|date of (?:the )?(?:accident|crash|incident|wreck|collision))\b/i, 'when'],
  [/\b(?:where|location|which (?:street|road|intersection)|what city)\b/i, 'where'],
  [/\b(?:how did|what happened|describe|tell me (?:what|more)|circumstances)\b/i, 'how'],
  [/\b(?:other driver|at fault|who hit|their (?:info|insurance|details))\b/i, 'other driver'],
  // No trailing \b on a stem: "injur\b" cannot match "injured", which is the single most
  // likely word in an intake question about a car accident.
  [/\b(?:injur\w*|hurt|pain\w*|sore|symptom\w*)\b/i, 'injuries'],
  [/\b(?:doctor|hospital|urgent care|treat\w*|seen anyone|medical care|physician)\b/i, 'medical treatment'],
  [/\b(?:car damage|damage to (?:your|the) (?:car|vehicle)|driv(?:able|eable)|bumper|totaled|body ?work)\b/i, 'vehicle damage'],
  [/\b(?:police|report|officer|citation)\b/i, 'police report'],
  [/\b(?:insur\w*|claim\w*|adjuster|settlement)\b/i, 'insurance status'],
  [/\b(?:worried|concern\w*|what do you (?:want|need)|looking for|goal)\b/i, 'main concern'],
];

/**
 * Parses the `- **Label:** value` bullets from the persona's case facts.
 *
 * Bullets wrap across lines in markdown, so continuation lines are folded into the value.
 * Without that the answer gets cut off mid-sentence, which reads worse than not answering.
 */
function parseFacts(caseFacts: string): Map<string, string> {
  const facts = new Map<string, string>();
  let currentKey: string | null = null;

  for (const raw of caseFacts.split('\n')) {
    const bullet = raw.match(/^\s*[-*]\s*\*\*(.+?):?\*\*\s*(.*)$/);
    if (bullet) {
      currentKey = bullet[1].trim().toLowerCase();
      facts.set(currentKey, bullet[2].trim());
      continue;
    }
    // An indented, non-bullet line continues the previous fact.
    if (currentKey && /^\s+\S/.test(raw) && !/^\s*[-*]/.test(raw)) {
      facts.set(currentKey, `${facts.get(currentKey)} ${raw.trim()}`.trim());
      continue;
    }
    if (raw.trim() === '') currentKey = null;
  }

  for (const [k, v] of facts) facts.set(k, v.replace(/\s+/g, ' ').trim());
  return facts;
}

/**
 * Answers from the case facts when possible. Returns null when nothing matches, so the
 * caller falls back rather than inventing something the persona was never given.
 */
export function answerFromFacts(question: string, caseFacts: string): string | null {
  const facts = parseFacts(caseFacts);
  if (facts.size === 0) return null;

  /**
   * Answer everything asked, not just the first match. Intake staff ask in batches —
   * "when did it happen, were you hurt, and did you see a doctor?" — and answering one of
   * three forces them to ask again, which irritates a real person and makes the transcript
   * useless for judging how they actually run intake.
   */
  const matched: string[] = [];
  for (const [pattern, key] of FACT_QUESTIONS) {
    if (!pattern.test(question)) continue;
    const value = facts.get(key);
    if (value && !matched.includes(value)) matched.push(value);
  }
  if (matched.length === 0) return null;

  const joined = matched
    .map((m) => m.replace(/\s*\.\s*$/, ''))
    .join('. ')
    .concat('.');
  return trim(joined, 600);
}
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
  /** The message we are replying to, used to answer from case facts. */
  lastInbound?: string | null;
  /** Run id, used as the seed so improvised details are stable per run. */
  runId?: string;
  /** Details already improvised on this run, so answers never contradict. */
  improvised?: Record<string, string>;
};

/** Picks a phrasing this run has not already sent, so we never repeat ourselves verbatim. */
function pickUnsent(candidates: string[], alreadySent: string[]): string {
  const sent = new Set(alreadySent.map((b) => b.replace(/\s+/g, ' ').trim().toLowerCase()));
  const fresh = candidates.find((c) => !sent.has(c.replace(/\s+/g, ' ').trim().toLowerCase()));
  return fresh ?? candidates[candidates.length - 1];
}

export async function composeReply(
  input: ComposeInput,
): Promise<{ body: string; source: string; remember?: Array<{ key: string; value: string }> }> {
  const { persona, goal } = input;
  const outboundSoFar = input.transcript.filter((m) => m.direction === 'out').map((m) => m.body);
  // A specific answer from the case facts beats any generic template, and works offline.
  /**
   * Answer everything asked, drawing on both sources.
   *
   * Improvised details are put first because their patterns are the narrow ones: "date of
   * birth" contains "date" and "where do you work" contains "where", so letting the broad
   * fact patterns win answered both with details of the car accident instead.
   */
  let factAnswer: string | null = null;
  let remembered: Array<{ key: string; value: string }> = [];

  if (goal === 'answer_question' && input.lastInbound) {
    // Name, email and phone are the persona's own and are never invented.
    const own: string[] = [];
    for (const [pattern, field] of PERSONA_FIELDS) {
      if (!pattern.test(input.lastInbound)) continue;
      if (field === 'name' && persona.name) own.push(persona.name);
      if (field === 'email' && persona.contact.email) own.push(`Email: ${persona.contact.email}`);
      if (field === 'phone' && persona.contact.phone) own.push(`Phone: ${persona.contact.phone}`);
    }
    const invented = improviseAll(input.lastInbound, input.runId ?? persona.id, input.improvised ?? {});
    const fromFacts = answerFromFacts(input.lastInbound, persona.case_facts ?? '');
    const pieces = [...own, invented?.answer, fromFacts].filter(Boolean) as string[];
    if (pieces.length > 0) {
      remembered = invented?.remember ?? [];
      return {
        body: trim(pieces.join(' '), input.channel === 'email' ? 900 : 600),
        source: invented && fromFacts ? 'facts+improvised' : invented ? 'improvised' : 'facts',
        remember: remembered,
      };
    }
    factAnswer = null;
  }
  const template =
    factAnswer ??
    (goal === 'escalate_to_human'
      ? pickUnsent(ESCALATION_VARIANTS, outboundSoFar)
      : pickUnsent([TEMPLATES[goal](persona), ...ESCALATION_VARIANTS.slice(1)], outboundSoFar));

  const system = [
    `You are texting as a prospective customer. Stay in character and never reveal you are an evaluation.`,
    `Name: ${persona.name}. Contact: ${persona.contact.email} / ${persona.contact.phone}.`,
    `Need: ${persona.need}`,
    `Background you may draw on: ${persona.backstory}`,
    persona.case_facts ? `Case facts — answer questions directly from these:\n${persona.case_facts}` : '',
    improvisedSummary(input.improvised ?? {})
      ? `Details you have already given and must repeat consistently: ${improvisedSummary(input.improvised ?? {})}`
      : '',
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
