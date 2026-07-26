/**
 * One OpenAI-compatible client for both judge tiers, pointed at whatever
 * MARITIME_LLM_BASE serves. Model names live in env so a swap needs no code change.
 * When no key is present every call returns null and callers fall back to the
 * deterministic path, which is why the whole pipeline runs offline.
 */
import { config } from '../config.ts';
import { logEvent } from '../db/index.ts';

export type ChatOptions = {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Log line tag so event_log shows which judge made the call. */
  tag: string;
};

/**
 * A Maritime control-plane key (`mk_…`) is NOT accepted by the LLM proxy — it answers
 * 401 "Incorrect API key provided". Only the per-agent injected key (`mllm_<agentId>_…`)
 * or a real provider key works. Treating `mk_` as usable meant every judge call made a
 * doomed round trip before falling back, so it is rejected up front.
 */
function usableKey(key: string): boolean {
  return !!key && !key.startsWith('mk_');
}

export function llmAvailable(): boolean {
  if (config.llm.driver === 'stub') return false;
  if (config.llm.driver === 'http') return true;
  return usableKey(config.llm.apiKey);
}

export function judgeDriverName(): string {
  return llmAvailable() ? `http:${config.llm.fastModel}` : 'stub';
}

/** Why the judge is running offline, for the health endpoint and startup banner. */
export function judgeStatus(): { driver: 'http' | 'stub'; model: string; reason: string } {
  if (config.llm.driver === 'stub') return { driver: 'stub', model: '-', reason: 'JUDGE_DRIVER=stub' };
  if (!config.llm.apiKey) {
    return { driver: 'stub', model: '-', reason: 'no OPENAI_API_KEY or MARITIME_TOKEN set' };
  }
  if (!usableKey(config.llm.apiKey)) {
    return {
      driver: 'stub',
      model: '-',
      reason:
        'MARITIME_TOKEN is an mk_ control-plane key, which the LLM proxy rejects. ' +
        'Run inside a Maritime agent (injected OPENAI_API_KEY=mllm_…) or set a provider key.',
    };
  }
  return { driver: 'http', model: config.llm.fastModel, reason: 'provider key present' };
}

/** Pulls a JSON object out of a model response that may be fenced or prefixed. */
export function extractJson<T>(raw: string): T | null {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logEvent(null, 'llm_error', { path, status: res.status, body: (await res.text()).slice(0, 400) });
      return null;
    }
    return await res.json();
  } catch (err) {
    logEvent(null, 'llm_error', { path, error: (err as Error).message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * gpt-5 family rejects `max_tokens` ("Unsupported parameter … use max_completion_tokens")
 * and also rejects a non-default temperature. Verified against the proxy.
 */
/**
 * The Maritime proxy namespaces ids ("openai/gpt-5.4"), so the family has to be matched
 * after any provider prefix. Anchoring on the raw string sent `max_tokens` to a gpt-5 model
 * and every judge call failed with a 400 that looked like a key problem.
 */
const isReasoningModel = (model: string): boolean =>
  /^(?:o\d|gpt-5)/.test(model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model);

export async function chatText(opts: ChatOptions): Promise<string | null> {
  if (!llmAvailable()) return null;
  const limit = opts.maxTokens ?? 800;
  const reasoning = isReasoningModel(opts.model);
  const json = await post('/chat/completions', {
    model: opts.model,
    ...(reasoning ? { max_completion_tokens: limit } : { max_tokens: limit, temperature: opts.temperature ?? 0 }),
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  });
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : null;
}

/** Strict-JSON call with one retry. Returns null so the caller can fall back. */
export async function chatJson<T>(opts: ChatOptions): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chatText({
      ...opts,
      system: `${opts.system}\n\nReturn one JSON object and nothing else. No prose, no markdown fence.`,
    });
    if (raw === null) return null;
    const parsed = extractJson<T>(raw);
    if (parsed) return parsed;
    logEvent(null, 'llm_bad_json', { tag: opts.tag, attempt, sample: raw.slice(0, 200) });
  }
  return null;
}

/**
 * Health probe. A wrong model name in env is a silent 404 at the worst moment, so the
 * router exposes what the proxy actually serves at /api/health/models.
 */
export async function listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  if (!llmAvailable()) return { ok: false, models: [], error: 'no LLM key configured (stub driver)' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${config.llm.apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return { ok: true, models: (json.data ?? []).map((m) => m.id ?? '').filter(Boolean) };
  } catch (err) {
    return { ok: false, models: [], error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
