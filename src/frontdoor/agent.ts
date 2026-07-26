/**
 * Front-door browser agent. Spawns Playwright MCP, runs an LLM tool-calling loop, and
 * returns a ContactPlan (form submitted with our inbound number, firm phone to text, or
 * unreachable). Live form submission intentionally bypasses ALLOW_LIVE_SENDS / allowlist.
 */
import { config } from '../config.ts';
import { logEvent } from '../db/index.ts';
import { chatWithTools, llmAvailable, type ChatMessage } from '../judge/llm.ts';
import { PlaywrightMcpSession } from './mcp.ts';
import { allOpenAiTools, parseContactPlan, REPORT_CONTACT_PLAN } from './tools.ts';
import type { ContactPlan, FrontdoorPersonaHints, FrontdoorRunResult } from './types.ts';

export type RunFrontdoorOpts = {
  url: string;
  persona: FrontdoorPersonaHints;
  inboundNumber?: string;
  /** Optional hints from HTTP ingest (phones / form url) to seed the agent. */
  hints?: { phones?: string[]; formUrl?: string | null; formCaptcha?: boolean | null };
};

function buildSystemPrompt(inboundNumber: string, persona: FrontdoorPersonaHints): string {
  return `You are a secret-shopper front-door agent. Your job is to open a law firm's website in a real browser and establish first contact so the rest of the intake-grader system can continue an SMS conversation.

## Decision rule (strict priority)

1. PREFER submitting the firm's intake / contact / free-consultation form.
2. When filling the form, use these persona details for name, email, and message — but the PHONE field MUST be our receiving number ${inboundNumber} (not the persona phone). The firm must be able to text that number.
   - Name: ${persona.name}
   - Email: ${persona.email}
   - Phone (MUST use this): ${inboundNumber}
   - Message / how can we help: summarize the need: ${persona.need}
3. If the form has a CAPTCHA, ATTEMPT to solve or complete it. Do not give up solely because a captcha is present.
4. SUBMIT the form live. Do not dry-run.
5. Only if the form cannot be submitted (missing, broken, captcha impossible after a serious attempt, or no phone field), fall back to finding the firm's phone number to text (prefer a local/mobile-looking number over toll-free when both exist).
6. If neither path works, report unreachable.

## Tooling

- Use the Playwright browser tools to navigate, snapshot, click, type, and submit.
- When finished, call ${REPORT_CONTACT_PLAN} exactly once with the final plan. Do not call it until you have either submitted a form, confirmed a firm phone, or exhausted both paths.
- For mode=form_submitted set expected_inbound_number to ${inboundNumber} and submitted=true only if you actually clicked submit and saw a plausible success (or at least no hard error).
- For mode=sms put the firm phone in E.164 (+1…).
- Stay on the firm's own domain. Do not create accounts, pay anything, or leave the site.

## Output discipline

Be efficient. Prefer contact / free consult pages. Snapshot after navigation before acting. Fill required fields only. After submit, snapshot once to confirm, then report.`;
}

function buildUserPrompt(opts: RunFrontdoorOpts, inboundNumber: string): string {
  const lines = [
    `Target URL: ${opts.url}`,
    `Our inbound SMS number (put this in any phone field): ${inboundNumber}`,
  ];
  if (opts.hints?.phones?.length) {
    lines.push(`HTTP ingest already found phones: ${opts.hints.phones.join(', ')}`);
  }
  if (opts.hints?.formUrl) {
    lines.push(
      `HTTP ingest already found a form at ${opts.hints.formUrl}` +
        (opts.hints.formCaptcha ? ' (captcha gated — still attempt)' : ''),
    );
  }
  lines.push('Begin. Prefer the form path.');
  return lines.join('\n');
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Runs one front-door session. Always tears down the browser, even on failure.
 */
export async function runFrontdoorAgent(opts: RunFrontdoorOpts): Promise<FrontdoorRunResult> {
  if (!llmAvailable()) {
    return {
      plan: { mode: 'unreachable', reason: 'LLM unavailable for front-door agent', notes: [] },
      steps: 0,
      tool_trace: [],
    };
  }

  const inboundNumber = opts.inboundNumber ?? config.frontdoor.inboundNumber;
  const session = new PlaywrightMcpSession();
  const toolTrace: FrontdoorRunResult['tool_trace'] = [];
  let plan: ContactPlan | null = null;
  let steps = 0;
  const deadline = Date.now() + config.frontdoor.timeoutMs;

  try {
    await session.start();
    const mcpTools = await session.listTools();
    const tools = allOpenAiTools(mcpTools);

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(inboundNumber, opts.persona) },
      { role: 'user', content: buildUserPrompt(opts, inboundNumber) },
    ];

    while (steps < config.frontdoor.maxSteps && Date.now() < deadline && !plan) {
      steps += 1;
      const turn = await chatWithTools({
        model: config.frontdoor.model,
        messages,
        tools,
        maxTokens: 1_600,
        tag: 'frontdoor',
      });

      if (!turn) {
        plan = {
          mode: 'unreachable',
          reason: 'LLM call failed during front-door session',
          notes: toolTrace.map((t) => t.summary),
        };
        break;
      }

      if (turn.tool_calls.length === 0) {
        // Model talked without tools — nudge it once, then give up.
        messages.push({ role: 'assistant', content: turn.content });
        messages.push({
          role: 'user',
          content: `You must call a browser tool or ${REPORT_CONTACT_PLAN}. Do not reply with prose only.`,
        });
        continue;
      }

      messages.push({
        role: 'assistant',
        content: turn.content,
        tool_calls: turn.tool_calls,
      });

      for (const call of turn.tool_calls) {
        const name = call.function?.name ?? '';
        const args = parseToolArgs(call.function?.arguments ?? '{}');

        if (name === REPORT_CONTACT_PLAN) {
          try {
            plan = parseContactPlan(args, inboundNumber);
            toolTrace.push({ tool: name, ok: true, summary: `reported ${plan.mode}` });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ ok: true, plan }),
            });
          } catch (err) {
            const msg = (err as Error).message;
            toolTrace.push({ tool: name, ok: false, summary: msg });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ ok: false, error: msg }),
            });
          }
          continue;
        }

        const result = await session.callTool(name, args);
        const summary = `${name}: ${result.ok ? 'ok' : 'err'} ${result.text.slice(0, 160).replace(/\s+/g, ' ')}`;
        toolTrace.push({ tool: name, ok: result.ok, summary });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.text || (result.ok ? 'ok' : 'error'),
        });
      }
    }

    if (!plan) {
      plan = {
        mode: 'unreachable',
        reason:
          steps >= config.frontdoor.maxSteps
            ? `hit FRONTDOOR_MAX_STEPS (${config.frontdoor.maxSteps}) without a contact plan`
            : 'front-door session timed out without a contact plan',
        notes: toolTrace.map((t) => t.summary),
      };
    }
  } catch (err) {
    plan = {
      mode: 'unreachable',
      reason: `front-door agent error: ${(err as Error).message}`,
      notes: toolTrace.map((t) => t.summary),
    };
  } finally {
    await session.stop();
  }

  logEvent(null, 'frontdoor_complete', {
    url: opts.url,
    mode: plan.mode,
    steps,
    tools: toolTrace.length,
  });

  return { plan, steps, tool_trace: toolTrace };
}
