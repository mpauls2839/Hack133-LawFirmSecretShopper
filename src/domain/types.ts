export type LineType = 'mobile' | 'landline' | 'voip' | 'unknown';
export type Direction = 'in' | 'out';
export type SenderType = 'autoresponder' | 'ai_agent' | 'human' | 'persona';
export type MessageKind = 'first_contact' | 'reply' | 'nudge' | 'closing';
export type ChannelName = 'sms' | 'email' | 'form' | 'mock';
export type HoursConfidence = 'none' | 'low' | 'high';

export type Phone = {
  id: string;
  target_id: string;
  number: string;
  line_type: LineType;
  sms_capable: boolean | null;
  checked_at: string | null;
  source: string;
};

export type FormProfile = {
  url: string;
  fields: string[];
  captcha: boolean;
  captcha_vendor?: string | null;
};

/** Parsed opening hours. day 0 = Sunday. Minutes since local midnight. */
export type HoursWindow = { day: number; open: number; close: number };

export type Target = {
  id: string;
  url: string;
  domain: string;
  name: string | null;
  category: string | null;
  city: string | null;
  timezone: string;
  services: string[];
  stated_hours_text: string | null;
  hours: HoursWindow[];
  hours_confidence: HoursConfidence;
  claims_247: boolean;
  chat_widget: string | null;
  form: FormProfile | null;
  reachable: boolean;
  unreachable_reason: string | null;
  ingest_notes: string[];
  phones: Phone[];
  emails: string[];
  created_at: string;
  updated_at: string;
};

export type Persona = {
  id: string;
  name: string;
  contact: { email: string; phone: string; preferred_channel: ChannelName };
  backstory: string;
  need: string;
  need_tags: string[];
  urgency: string;
  budget: string;
  behavior_rules: {
    answer_when: string[];
    push_when: string[];
    go_quiet_when: string[];
    never: string[];
  };
};

export type Flags = {
  price_given: boolean;
  question_answered: boolean;
  meeting_offered: boolean;
  booking_link: boolean;
  /** A specific slot was actually confirmed, not merely offered. */
  booking_confirmed: boolean;
  callback_promised: boolean;
  promised_window: string | null;
  specialist_identified: boolean;
  specialist_role: string | null;
  /** Inbound asked us to stop. Hard terminal, always honoured. */
  opt_out_requested: boolean;
  /** Inbound asked us to hold. Keeps the run open rather than closing it. */
  asked_to_wait: boolean;
  declined_or_referred: boolean;
};

export const emptyFlags = (): Flags => ({
  price_given: false,
  question_answered: false,
  meeting_offered: false,
  booking_link: false,
  booking_confirmed: false,
  callback_promised: false,
  promised_window: null,
  specialist_identified: false,
  specialist_role: null,
  opt_out_requested: false,
  asked_to_wait: false,
  declined_or_referred: false,
});

export type Classification = {
  sender_type: Exclude<SenderType, 'persona'>;
  flags: Flags;
  /** Which driver produced this: 'http:<model>' or 'stub'. */
  classifier: string;
  reasons: string[];
};

export type Message = {
  id: string;
  run_id: string;
  direction: Direction;
  body: string;
  ts: string;
  sender_type: SenderType | null;
  flags: Flags | null;
  classifier: string | null;
  provider: string | null;
  provider_id: string | null;
  kind: MessageKind | null;
};

export type Run = {
  id: string;
  target_id: string;
  persona_id: string;
  cycle: string;
  channel: ChannelName | null;
  channel_address: string | null;
  qualified: boolean;
  qualification_reason: string | null;
  agent_name: string | null;
  live: boolean;
  /** Lifecycle position. See domain/states.ts. */
  state: string;
  /** Outcome ladder value, set once and preserved through GRADED / CLEANED_UP. */
  terminal_state: string | null;
  terminal_reason: string | null;
  t0: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  turns: number;
  nudges_sent: number;
  first_reply_at: string | null;
  first_reply_sender: SenderType | null;
  first_human_at: string | null;
  booking_offered_at: string | null;
  turns_in_automation: number | null;
  promise_made_at: string | null;
  promise_window_text: string | null;
  promise_deadline: string | null;
  promise_kept: boolean | null;
  scorecard: Scorecard | null;
  narrative: string | null;
  closed_at: string | null;
  cleanup_state: 'not_needed' | 'pending' | 'done' | 'failed';
  created_at: string;
  updated_at: string;
};

export type Scorecard = {
  run_id: string;
  target: { name: string | null; url: string; category: string | null; claims_247: boolean };
  persona: { name: string; need: string };
  qualified: boolean;
  terminal_state: string;
  terminal_rank: number;
  latency: {
    first_reply_raw_minutes: number | null;
    first_reply_business_minutes: number | null;
    first_human_raw_minutes: number | null;
    first_human_business_minutes: number | null;
    booking_offer_raw_minutes: number | null;
    graded_on: 'raw' | 'business';
    graded_minutes: number | null;
    hours_confidence: HoursConfidence;
  };
  conversation: {
    inbound_count: number;
    outbound_count: number;
    turns: number;
    turns_in_automation: number | null;
    first_reply_sender: SenderType | null;
    reached_human: boolean;
    question_answered: boolean;
    price_disclosed: boolean;
    followups_from_business: number;
    nudges_sent: number;
  };
  promise: {
    made: boolean;
    window: string | null;
    deadline: string | null;
    kept: boolean | null;
  };
  screening: {
    outcome_bucket: 'handled' | 'not_handled';
    verdict: 'correct' | 'miss_expensive' | 'wasted_time' | 'correct_decline';
    note: string;
  };
  /** Kept deliberately separate and never merged (spec section 7). */
  harness_score: { completed_mission: boolean; reason: string };
  business_score: { grade: 'A' | 'B' | 'C' | 'D' | 'F'; points: number; reasons: string[] };
  narrative: string | null;
  generated_at: string;
  judge: string;
};
