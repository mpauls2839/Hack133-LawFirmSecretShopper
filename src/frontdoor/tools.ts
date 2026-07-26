/**
 * Maps Playwright MCP tool descriptors to OpenAI function-tool schemas, plus the
 * synthetic report_contact_plan tool the model uses to terminate with a ContactPlan.
 */
import type { McpToolDescriptor } from './mcp.ts';
import type { ContactPlan } from './types.ts';

export type OpenAiFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const REPORT_CONTACT_PLAN = 'report_contact_plan';

const REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['form_submitted', 'sms', 'unreachable'] },
    phone: { type: 'string', description: 'E.164 firm phone when mode=sms' },
    form_url: { type: 'string', description: 'URL of the form that was submitted' },
    expected_inbound_number: {
      type: 'string',
      description: 'Our receiving number the firm will text (mode=form_submitted)',
    },
    submitted: { type: 'boolean', description: 'True if the form was actually submitted' },
    fields_filled: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Map of field labels/names to values that were filled',
    },
    evidence: { type: 'string', description: 'Short quote or observation supporting the plan' },
    reason: { type: 'string', description: 'Why unreachable when mode=unreachable' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['mode', 'notes'],
};

export function mcpToolsToOpenAi(tools: McpToolDescriptor[]): OpenAiFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? t.name,
      parameters: sanitizeSchema(t.inputSchema ?? { type: 'object', properties: {} }),
    },
  }));
}

export function reportContactPlanTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: REPORT_CONTACT_PLAN,
      description:
        'Terminate the session with a final contact plan. Call this exactly once when you have submitted a form, found a phone to text, or determined the firm is unreachable.',
      parameters: REPORT_SCHEMA,
    },
  };
}

export function allOpenAiTools(mcpTools: McpToolDescriptor[]): OpenAiFunctionTool[] {
  return [...mcpToolsToOpenAi(mcpTools), reportContactPlanTool()];
}

/** Strip MCP-only keys that confuse some OpenAI-compatible proxies. */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (!out.type) out.type = 'object';
  if (!out.properties) out.properties = {};
  delete out.$schema;
  delete out.additionalProperties;
  return out;
}

export function parseContactPlan(args: Record<string, unknown>, inboundNumber: string): ContactPlan {
  const mode = String(args.mode ?? '');
  const notes = Array.isArray(args.notes) ? args.notes.map(String) : [];
  const evidence = String(args.evidence ?? '');

  if (mode === 'sms') {
    const phone = String(args.phone ?? '').trim();
    if (!phone) throw new Error('report_contact_plan sms mode requires phone');
    return { mode: 'sms', phone, evidence, notes };
  }

  if (mode === 'form_submitted') {
    const fields =
      args.fields_filled && typeof args.fields_filled === 'object' && !Array.isArray(args.fields_filled)
        ? Object.fromEntries(
            Object.entries(args.fields_filled as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {};
    return {
      mode: 'form_submitted',
      form_url: String(args.form_url ?? ''),
      expected_inbound_number: String(args.expected_inbound_number ?? inboundNumber),
      submitted: args.submitted !== false,
      fields_filled: fields,
      evidence,
      notes,
    };
  }

  if (mode === 'unreachable') {
    return {
      mode: 'unreachable',
      reason: String(args.reason ?? 'no usable form or phone'),
      notes,
    };
  }

  throw new Error(`report_contact_plan unknown mode: ${mode}`);
}
