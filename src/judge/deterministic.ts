/**
 * Deterministic backstops (spec section 6). Cheaper and more reliable than any model, and
 * they win every disagreement. Nothing here calls out to anything.
 */
import type { Flags, Target } from '../domain/types.ts';
import { emptyFlags } from '../domain/types.ts';
import { addBusinessMinutes } from '../domain/hours.ts';

const BOOKING_LINK =
  /(calendly\.com|cal\.com\/|acuityscheduling|app\.acuity|meetings\.hubspot|hubspot\.com\/meetings|youcanbook\.me|savvycal|tidycal|zcal\.co|calendar\.app\.google|book(?:ing)?\.setmore|squareup\.com\/appointments|scheduler\.zoom|clio\.com\/scheduling|lawmatics|doodle\.com|zoom\.us\/j\/)/i;
const BOOKING_PATH = /https?:\/\/[^\s]*\/(?:book(?:-a-call|ing)?|schedule(?:-a-call|-consult(?:ation)?)?|appointments?|consult(?:ation)?)\b/i;

const PRICE =
  /(\$\s?\d[\d,.]*|\bno (?:up[- ]?front|upfront|out[- ]of[- ]pocket) (?:cost|fee|fees)\b|\bfree (?:consultation|case (?:review|evaluation)|quote|estimate)\b|\bcontingency\b|\b\d{1,2}\s?%\s?(?:fee|contingency)\b|\b(?:hourly|flat)[- ]rate\b|\bretainer of\b|\bwe only get paid\b)/i;

/**
 * A promise to come back to us. The commitment verb often sits several words after the
 * subject ("an intake specialist will review your information and be in touch"), so the
 * gap is allowed rather than requiring them to be adjacent.
 */
const CALLBACK =
  /\b(?:someone|somebody|an?\s+\w+(?:\s+\w+)?|we|i|our\s+\w+)\s+(?:will|'ll|shall|can|are going to)\b[^.?!]{0,60}?\b(?:be in touch|reach out|get back to you|call you|contact you|follow up|text you|email you|return your (?:call|message))\b|\b(?:let me|i'?ll)\b[^.?!]{0,40}?\b(?:and|then)?\s*(?:text|call|email|get back to|message)\s+you\b|\b(?:text|call|email)\s+you\s+(?:right\s+)?back\b|\bexpect a call\b|\byou'?ll hear (?:back )?from (?:us|me)\b/i;

const WINDOW =
  /\b(?:with?in|in)\s+(?:the\s+next\s+)?(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|business days?|days?)\b|\b(shortly|momentarily|right away|as soon as possible|asap|today|this (?:morning|afternoon|evening)|first thing (?:tomorrow|in the morning)|by (?:end of day|eod|close of business|tomorrow)|next business day|within the hour)\b/i;

const SPECIALIST =
  /\b(?:attorney|lawyer|esq\.?|partner|associate|paralegal|case manager|intake (?:specialist|coordinator)|claims (?:adjuster|specialist)|senior (?:technician|estimator)|dr\.)\b/i;
const SPECIALIST_ROLE =
  /\b(personal injury attorney|injury lawyer|family law attorney|criminal defense attorney|immigration attorney|estate planning attorney|workers'? comp(?:ensation)? attorney|trial attorney|managing partner|paralegal|case manager|intake specialist|intake coordinator|attorney|lawyer)\b/i;

/**
 * Bare "stop" is only an opt-out when the message IS that word — the SMS carrier
 * convention. Matching it anywhere treats "I had to stop at the hospital" as a request to
 * never contact them again, which would end a legitimate run and lose the finding.
 */
const OPT_OUT_STANDALONE =
  /^\s*(?:stop|stopall|unsubscribe|quit|cancel|end|revoke|optout|opt[- ]out|remove)\s*[.!]?\s*$/i;

const OPT_OUT_PHRASE =
  /\b(?:unsubscribe|opt[- ]?out|do not (?:contact|text|call|email|message) (?:me|us)|don'?t (?:contact|text|call|email|message) (?:me|us)|remove (?:me|us) from|take (?:me|us) off|stop (?:texting|messaging|contacting|calling|emailing) (?:me|us)|wrong number|not interested)\b/i;

const DECLINE =
  /\b(?:we (?:do not|don'?t) (?:handle|take|practice|do)|not (?:something we|our) (?:handle|practice area|area of)|outside (?:of )?our (?:practice|scope|service area)|cannot (?:take|assist with|help with) (?:your|this)|unable to (?:take|assist)|refer you (?:to|out)|recommend (?:you )?(?:contact|reach out to) (?:another|a different)|we only handle|no longer accepting)\b/i;

const MEETING_OFFERED =
  /\b(?:(?:schedule|set ?up|book) (?:a|an|your) (?:call|consult(?:ation)?|meeting|appointment|time)|are you (?:available|free)|what time works|does\s+\w+day\s+(?:at\s+)?\d|available (?:tomorrow|today|this week)|come (?:in|by) (?:for|to)|offer (?:a )?free consultation)\b/i;

/**
 * A concrete slot on offer: "has 4:30pm today or 9:15am tomorrow. Which works?".
 * Naming times and asking the customer to choose is an offer even when no scheduling
 * verb appears, and missing it kept the loop asking for a human it had already reached.
 */
const TIME_SLOT_OFFERED =
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b[\s\S]{0,80}?\b(?:or|and)\b[\s\S]{0,40}?\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:has|have|open at|free at|availability at|can do|could do|how about|what about)\b[^.?!]{0,40}\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:which|what)\s+(?:one\s+)?works\b|\bdoes (?:that|either|one of those) work\b/i;

/**
 * A relative time offer: "how about a phone call after 30 minutes", "can we talk in an
 * hour". No am/pm for the clock-time patterns to catch, but it is unambiguously an offer,
 * and missing it left the persona chasing a human it had already reached.
 */
const RELATIVE_TIME_OFFERED =
  /\b(?:how about|what about|can we|could we|shall we|would you like|are you free for|available for|call you|talk)\b[^.?!]{0,50}\b(?:in|after|within|around)\s+(?:a|an|another|\d{1,3})\s*(?:min(?:ute)?s?|hours?|hrs?|moments?)\b|\b(?:in|after)\s+(?:a|an|\d{1,3})\s*(?:min(?:ute)?s?|hours?|hrs?)\b[^.?!]{0,30}\b(?:call|chat|talk|meet|consult)\b/i;

const BOOKING_CONFIRMED =
  /\b(?:you'?re (?:all )?(?:set|booked|scheduled|confirmed)|(?:appointment|consultation|consult|call|meeting) (?:is )?(?:now )?(?:confirmed|scheduled|booked|set) for|i'?ve (?:got|put) you (?:down|scheduled|booked)|added you to (?:the|our|his|her|their) calendar|see you (?:on|at) \w+|confirming (?:your|our) (?:call|appointment|consultation))\b/i;

const AUTORESPONDER_PHRASES =
  /\b(?:this is an automat(?:ed|ic)|auto(?:mated|matic)? (?:reply|response)|do not reply to this|please do not reply|out of (?:the )?office|currently (?:closed|unavailable)|we (?:have )?received your (?:message|inquiry|request)|thank you for (?:contacting|reaching out to|your message)|your (?:message|inquiry) (?:has been|is) (?:received|important)|our (?:regular )?(?:business )?hours are|msg&data rates|reply stop to)\b/i;

const AI_AGENT_PHRASES =
  /\b(?:virtual (?:assistant|agent|receptionist)|ai (?:assistant|agent)|automated assistant|i'?m an? (?:ai|bot|virtual)|to better (?:assist|serve) you,? (?:i|we)|i can help you get started|let'?s get some (?:basic )?information|answer a few (?:quick )?questions|on a scale of|please (?:select|choose|reply with) (?:one|a number|1)|press \d)\b/i;

const HUMAN_PHRASES =
  /\b(?:this is \w+|my name is \w+|i'?m \w+,? (?:the|one of|an? )|speaking with|sorry (?:for|about) the (?:delay|late|wait)|just (?:saw|got) your|let me (?:check|pull up|grab|ask|see)|i'?ll (?:check|ask|walk|text|call|have) \w+|hang on|give me (?:a|one) (?:sec|minute)|ope\b|honestly)\b/i;

/**
 * Softer human tells. Individually weak, jointly decisive — a person apologising,
 * committing personally, or confirming something they did reads nothing like a script.
 */
const HUMAN_SOFT =
  /\b(?:i'?m sorry|sorry to hear|unfortunately|we (?:don'?t|do not) (?:handle|take|do)|you'?re (?:all )?set|i'?ve got you|i put you|i can see|i'?d (?:recommend|say|suggest)|feel free|no worries|of course|absolutely|happy to)\b/i;

/** Machine tells that a short message can still carry. */
const BOT_STRUCTURE = /(?:\breply with\b|\bpress \d|\b\d\)\s|\bhttps?:\/\/|\bMM\/DD|\boption \d)/i;

/** Typos and informal spelling: people fat-finger phones, generators do not. */
const INFORMAL =
  /\b(?:thr|teh|adn|recieve|seperate|definately|alot|gonna|wanna|yeah|yep|nope|ok thanks|k\b|pls|plz|u\b|ur\b)\b|\w+\s{2,}\w+|[a-z]{2,}\s+[A-Z][a-z]+\s+[A-Z][a-z]+/;

export function normalizeForCompare(body: string): string {
  return body
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/\b\d[\d\s().+-]{6,}\b/g, ' phone ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token Jaccard. Cheap, and "near-identical" is all we need it to answer. */
export function similarity(a: string, b: string): number {
  const ta = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export type DeterministicRead = {
  flags: Flags;
  /** Hard signals about who is talking; classify.ts merges these over any model output. */
  forcedSenderType: 'autoresponder' | null;
  senderHints: { autoresponder: number; ai_agent: number; human: number };
  reasons: string[];
};

export function readInbound(body: string, priorInbound: string[]): DeterministicRead {
  const flags = emptyFlags();
  const reasons: string[] = [];
  const hints = { autoresponder: 0, ai_agent: 0, human: 0 };

  const hasBookingLink = BOOKING_LINK.test(body) || BOOKING_PATH.test(body);
  if (hasBookingLink) {
    flags.booking_link = true;
    flags.meeting_offered = true;
    reasons.push('calendar link in body implies meeting_offered + booking_link');
  }
  if (MEETING_OFFERED.test(body)) {
    flags.meeting_offered = true;
    reasons.push('explicit scheduling offer');
  }
  if (TIME_SLOT_OFFERED.test(body)) {
    flags.meeting_offered = true;
    reasons.push('specific time slots named and offered for selection');
  }
  if (RELATIVE_TIME_OFFERED.test(body)) {
    flags.meeting_offered = true;
    reasons.push('a call offered at a relative time');
  }
  if (BOOKING_CONFIRMED.test(body)) {
    flags.booking_confirmed = true;
    flags.meeting_offered = true;
    reasons.push('a specific slot was confirmed, not just offered');
  }
  if (PRICE.test(body)) {
    flags.price_given = true;
    reasons.push('price or fee statement present');
  }
  if (CALLBACK.test(body)) {
    flags.callback_promised = true;
    reasons.push('callback commitment phrase');
  }
  const windowMatch = body.match(WINDOW);
  if (windowMatch) {
    flags.promised_window = (windowMatch[0] ?? '').trim().toLowerCase();
    if (flags.callback_promised) reasons.push(`stated window "${flags.promised_window}"`);
  }
  if (SPECIALIST.test(body)) {
    flags.specialist_identified = true;
    flags.specialist_role = body.match(SPECIALIST_ROLE)?.[0]?.toLowerCase() ?? null;
    reasons.push('role title named in body');
  }
  if (OPT_OUT_STANDALONE.test(body) || OPT_OUT_PHRASE.test(body)) {
    flags.opt_out_requested = true;
    reasons.push('opt-out language, honoured immediately');
  }
  if (DECLINE.test(body)) {
    flags.declined_or_referred = true;
    reasons.push('declined or referred out');
  }

  // Near-identical repeat of an earlier inbound is an autoresponder, whatever it says.
  const duplicate = priorInbound.find((prev) => similarity(prev, body) >= 0.85);
  let forcedSenderType: 'autoresponder' | null = null;
  if (duplicate) {
    forcedSenderType = 'autoresponder';
    reasons.push('body near-identical to an earlier inbound message');
  }

  if (AUTORESPONDER_PHRASES.test(body)) hints.autoresponder += 2;
  if (/reply stop|msg&data|standard (?:message|msg) rates/i.test(body)) hints.autoresponder += 2;

  if (AI_AGENT_PHRASES.test(body)) hints.ai_agent += 2;
  if (BOT_STRUCTURE.test(body)) hints.ai_agent += 1;
  if (/\?/.test(body) && body.length > 140 && !HUMAN_PHRASES.test(body)) hints.ai_agent += 1;

  if (HUMAN_PHRASES.test(body)) hints.human += 2;
  if (HUMAN_SOFT.test(body)) hints.human += 2;
  if (INFORMAL.test(body)) hints.human += 1;
  // Automation is verbose and branded. A terse message is almost always a person.
  if (body.length <= 45 && !BOT_STRUCTURE.test(body) && !AUTORESPONDER_PHRASES.test(body)) {
    hints.human += 1;
  }
  if (flags.opt_out_requested) hints.human += 1;
  if (/\b(?:thanks|thank you)\b[!.]?$/i.test(body.trim()) && body.length < 80) hints.human += 1;

  return { flags, forcedSenderType, senderHints: hints, reasons };
}

const WINDOW_MINUTES: Array<[RegExp, number, boolean]> = [
  // [pattern, minutes, business-hours aware]
  [/within the hour|right away|momentarily|asap|as soon as possible/i, 60, false],
  [/shortly/i, 120, true],
  [/today|this (?:morning|afternoon|evening)/i, 240, true],
  [/first thing (?:tomorrow|in the morning)|next business day|by tomorrow/i, 480, true],
  [/(\d{1,3})\s*(?:minutes?|mins?)/i, -1, false],
  [/(\d{1,3})\s*(?:hours?|hrs?)/i, -60, false],
  [/(\d{1,3})\s*business days?/i, -480, true],
  [/(\d{1,3})\s*days?/i, -1440, false],
];

/**
 * Turns a stated window into a hard deadline. Business-hours aware where the phrase is
 * relative to a working day, raw where the business said a clock number.
 */
export function promiseDeadline(windowText: string | null, fromIso: string, target: Target): string | null {
  if (!windowText) return null;
  for (const [re, unit, businessAware] of WINDOW_MINUTES) {
    const m = windowText.match(re);
    if (!m) continue;
    const minutes = unit > 0 ? unit : Math.abs(unit) * Number.parseInt(m[1] ?? '1', 10);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const useBusiness = businessAware && target.hours_confidence !== 'none' && !target.claims_247;
    return useBusiness
      ? addBusinessMinutes(fromIso, minutes, target.hours, target.timezone)
      : new Date(new Date(fromIso).getTime() + minutes * 60_000).toISOString();
  }
  // Promised a callback with no window at all: 1 business day is the generous reading.
  return addBusinessMinutes(fromIso, 480, target.hours, target.timezone);
}
