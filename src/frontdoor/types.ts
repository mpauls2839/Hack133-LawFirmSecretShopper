/**
 * Structured result of a front-door browser session. The agent terminates by
 * calling report_contact_plan with one of these shapes.
 */

export type ContactPlanSms = {
  mode: 'sms';
  phone: string;
  evidence: string;
  notes: string[];
};

export type ContactPlanForm = {
  mode: 'form_submitted';
  form_url: string;
  expected_inbound_number: string;
  submitted: boolean;
  fields_filled: Record<string, string>;
  evidence: string;
  notes: string[];
};

export type ContactPlanUnreachable = {
  mode: 'unreachable';
  reason: string;
  notes: string[];
};

export type ContactPlan = ContactPlanSms | ContactPlanForm | ContactPlanUnreachable;

export type FrontdoorPersonaHints = {
  name: string;
  email: string;
  phone: string;
  need: string;
};

export type FrontdoorRunResult = {
  plan: ContactPlan;
  steps: number;
  tool_trace: Array<{ tool: string; ok: boolean; summary: string }>;
};
