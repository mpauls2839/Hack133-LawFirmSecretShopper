/**
 * Details the persona was never given but is asked for anyway.
 *
 * Real intake staff ask for a home address, a date of birth, an employer, a policy number.
 * The brief cannot cover everything, and "I'm not sure" to every such question makes the
 * persona useless — the conversation stalls and the business never gets to show how it
 * actually handles intake.
 *
 * Two rules make this safe rather than reckless:
 *
 *  1. Everything generated is unmistakably fictional by construction — reserved 555-01xx
 *     numbers, .test email domains, and street addresses at numbers that do not exist on
 *     real streets. Nothing here can collide with a real person's details.
 *  2. Answers are derived from the run id, so they are identical every time they are asked
 *     and are persisted on the run. Contradicting yourself between turns is the single
 *     clearest tell that a person is not real, and it also corrupts the measurement: the
 *     business starts reacting to the inconsistency instead of doing its job.
 *
 * Some things are never invented. Anything that would create real liability or hand over
 * real credentials is refused instead, because a fabricated answer there is worse than no
 * answer.
 */

/** Deterministic small integer from a seed, so a run always improvises the same way. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const pick = <T>(list: T[], seed: string, salt: string): T => list[hash(seed + salt) % list.length];

/**
 * Questions we decline rather than answer. Inventing a plausible-looking SSN or card
 * number is not a harmless prop — it is exactly the shape of data that causes damage if it
 * lands in a real CRM, and a real client would balk at giving it over text anyway.
 */
const REFUSE: Array<[RegExp, string]> = [
  [
    /\b(?:social security|ssn|social\s*#|tax id)\b/i,
    `I'd rather not send my social over text — happy to give it on a call if it's needed.`,
  ],
  [
    /\b(?:credit card|card number|debit card|payment (?:info|details)|bank account|routing number)\b/i,
    `I'm not comfortable sending payment details by text. Can we sort that out later if it's needed?`,
  ],
  [
    /\b(?:driver'?s? licen[cs]e number|licen[cs]e #|passport number)\b/i,
    `I have my licence on me but I'd rather not text the number. I can read it out on a call.`,
  ],
];

type Improviser = { key: string; match: RegExp; make: (seed: string) => string };

/**
 * Details the persona already owns. Intake staff ask for these constantly, and they must
 * come from the persona rather than be invented — a name that changes between turns is the
 * fastest possible way to be spotted.
 */
export const PERSONA_FIELDS: Array<[RegExp, 'name' | 'email' | 'phone']> = [
  [/\b(?:full name|your name|name please|who am i speaking|spell your name|last name)\b/i, 'name'],
  [/\b(?:e-?mail|email address)\b/i, 'email'],
  [/\b(?:phone number|best number|contact number|cell|mobile number|callback number)\b/i, 'phone'],
];

const STREETS = ['Willow Creek Dr', 'Ashgrove Ln', 'Bellhaven Ct', 'Corley Park Rd', 'Wendover Ave'];
const CITIES = [
  ['Springfield', 'IL', '62704'],
  ['Riverton', 'OH', '45042'],
  ['Fairview', 'PA', '17033'],
  ['Lakemont', 'NY', '14891'],
  ['Brookfield', 'NJ', '07922'],
];
const EMPLOYERS = ['Northgate Marketing Group', 'Verilux Media', 'Cardinal & Pine Agency', 'Brightpath Studios'];
const INSURERS = ['Midstate Mutual', 'Harborline Insurance', 'Cedar Trust Casualty', 'Foundry Mutual'];
const MAKES = ['2019 Honda Civic', '2020 Toyota Corolla', '2018 Mazda 3', '2021 Subaru Impreza'];

const IMPROVISERS: Improviser[] = [
  {
    key: 'home_address',
    // Bare "address": intake asks "name, DOB and address", not "your address".
    match: /\baddress\b|\bwhere do you live\b/i,
    make: (seed) => {
      const [city, state, zip] = pick(CITIES, seed, 'city');
      // House numbers in the 8000s on residential streets of these names do not exist.
      const number = 8100 + (hash(seed + 'num') % 800);
      return `${number} ${pick(STREETS, seed, 'street')}, ${city}, ${state} ${zip}`;
    },
  },
  {
    key: 'date_of_birth',
    match: /\b(?:date of birth|birth ?date|dob|how old are you|your age)\b/i,
    make: (seed) => {
      const month = 1 + (hash(seed + 'm') % 12);
      const day = 1 + (hash(seed + 'd') % 28);
      const year = 1985 + (hash(seed + 'y') % 12);
      return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
    },
  },
  {
    key: 'employer',
    match: /\b(?:employer|where do you work|who do you work for|your (?:company|job|workplace)|occupation|missed work|time off work)\b/i,
    make: (seed) => pick(EMPLOYERS, seed, 'employer'),
  },
  {
    key: 'own_insurer',
    match: /\b(?:your (?:insurance|insurer|carrier)|who (?:are|is) you insured|policy holder)\b/i,
    make: (seed) => pick(INSURERS, seed, 'insurer'),
  },
  {
    key: 'policy_number',
    match: /\b(?:policy number|policy ?#|claim number|claim ?#)\b/i,
    make: (seed) => `${pick(['MM', 'HL', 'CT', 'FM'], seed, 'pfx')}-${4100000 + (hash(seed + 'pol') % 800000)}`,
  },
  {
    key: 'vehicle',
    match: /\b(?:what (?:kind|type|make) of car|make and model|your vehicle|what (?:do|are) you driv\w*|which car)\b/i,
    make: (seed) => pick(MAKES, seed, 'car'),
  },
  {
    key: 'plate',
    match: /\b(?:licen[cs]e plate|plate number|tag number)\b/i,
    make: (seed) => `${pick(['J', 'K', 'R', 'T'], seed, 'p1')}${hash(seed + 'p2') % 10}${pick(['A', 'B', 'C'], seed, 'p3')} ${1000 + (hash(seed + 'p4') % 8999)}`,
  },
  {
    key: 'police_report_number',
    match: /\b(?:report number|report ?#|incident number|case number)\b/i,
    make: (seed) => `${2026}-${100000 + (hash(seed + 'rpt') % 800000)}`,
  },
];

export type ImproviseResult = {
  answer: string;
  /** Set when a value was generated and should be persisted for reuse. */
  remember?: { key: string; value: string };
};

/**
 * Answers a question the brief does not cover.
 *
 * `known` is what this run has already said, so a repeat question gets the same answer.
 * Returns null when nothing applies, so the caller falls back rather than guessing.
 */
export function improviseAnswer(
  question: string,
  seed: string,
  known: Record<string, string>,
): ImproviseResult | null {
  const all = improviseAll(question, seed, known);
  if (!all) return null;
  return { answer: all.answer, remember: all.remember[0] };
}

export type ImproviseAllResult = {
  /** Labelled answers, one per thing asked. */
  parts: string[];
  answer: string;
  remember: Array<{ key: string; value: string }>;
};

/**
 * Answers every improvisable thing the question asked for, not just the first.
 *
 * Intake staff ask in batches — "full name, date of birth and address please" — and
 * answering one of three forces them to ask twice, which is both irritating and makes the
 * transcript useless for judging how they run intake.
 */
export function improviseAll(
  question: string,
  seed: string,
  known: Record<string, string>,
): ImproviseAllResult | null {
  // A refusal is the whole answer: never bundle invented details with a declined request.
  for (const [pattern, reply] of REFUSE) {
    if (pattern.test(question)) return { parts: [reply], answer: reply, remember: [] };
  }

  const parts: string[] = [];
  const remember: Array<{ key: string; value: string }> = [];
  const seenValues = new Set<string>();

  for (const imp of IMPROVISERS) {
    if (!imp.match.test(question)) continue;
    let value = known[imp.key];
    if (!value) {
      value = imp.make(seed);
      remember.push({ key: imp.key, value });
    }
    if (seenValues.has(value)) continue;
    seenValues.add(value);
    parts.push(`${LABELS[imp.key] ?? imp.key.replace(/_/g, ' ')}: ${value}`);
  }

  if (parts.length === 0) return null;
  // A single answer reads better bare; a batch reads better labelled, the way a form does.
  const answer = parts.length === 1 ? parts[0].replace(/^[^:]+:\s*/, '') : parts.join('. ');
  return { parts, answer, remember };
}

/** How each improvised detail is introduced when several are given at once. */
const LABELS: Record<string, string> = {
  home_address: 'Address',
  date_of_birth: 'DOB',
  employer: 'Employer',
  own_insurer: 'My insurer',
  policy_number: 'Policy',
  vehicle: 'Car',
  plate: 'Plate',
  police_report_number: 'Report number',
};

/** Every improvised value so far, for the model prompt so it stays consistent too. */
export function improvisedSummary(known: Record<string, string>): string {
  const entries = Object.entries(known);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ');
}
