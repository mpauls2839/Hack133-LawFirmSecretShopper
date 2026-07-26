/**
 * All environment reading happens here. Nothing else in the codebase touches process.env.
 * Live sending is off unless explicitly turned on AND the target is on the allowlist.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, dflt: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

/** Trailing whitespace in a .env value silently corrupts auth headers. Always trim. */
const str = (v: string | undefined, dflt = ''): string => (v ?? dflt).trim();

export const ROOT = resolve(import.meta.dirname, '..');

export const config = {
  port: int(process.env.PORT, 3000),
  /** The port declared to Maritime at create time, which is what public traffic hits. */
  exposedPort: int(process.env.EXPOSED_PORT, 3000),
  dbPath: process.env.DB_PATH ?? resolve(ROOT, 'data/intake-grader.db'),
  routerPublicUrl: str(process.env.ROUTER_PUBLIC_URL),
  /**
   * Shared secret for inbound webhooks. GoHighLevel workflow actions cannot sign their
   * requests, so the secret travels in the URL or an x-webhook-secret header. Unset means
   * the endpoint is open, which is acceptable locally and not on a public router.
   */
  webhookSecret: str(process.env.WEBHOOK_SECRET),

  // ---- judge -------------------------------------------------------------
  /**
   * Inside a Maritime agent the platform injects OPENAI_BASE_URL + OPENAI_API_KEY
   * (`mllm_<agentId>_…`), so those win. MARITIME_* are the local-dev fallback.
   *
   * That proxy is an OpenAI passthrough: gemma-4-12b / glm-5.2 / deepseek-v4 all 404, and
   * no Anthropic model is offered — a deployed agent asked directly reports it runs as
   * `openai/gpt-5.4` and lists no Claude ids. Note the gpt-5 family rejects `max_tokens`
   * and requires `max_completion_tokens`, which judge/llm.ts handles.
   */
  llm: {
    baseUrl:
      str(process.env.OPENAI_BASE_URL) ||
      str(process.env.MARITIME_LLM_BASE, 'https://api.maritime.sh/api/llm/v1'),
    apiKey: str(process.env.OPENAI_API_KEY) || str(process.env.MARITIME_TOKEN),
    /**
     * Chosen by measurement, not reputation. Latency and judgement pull against each other
     * here, so both were timed on real cases from a live run — a blunt lowercase human
     * reply, a canned acknowledgement, a scripted qualification script. gpt-5.4 was the
     * fastest of seven tried (705ms average) and correct on all three; the larger models
     * agreed but took two to three times as long, and the nano tier called the human a bot,
     * which is the one error that matters because it makes the harness give up on a person.
     *
     * Ids are unprefixed for a direct provider call. The Maritime proxy namespaces them
     * ("openai/gpt-5.4"), so override both when pointing at that instead.
     */
    fastModel: str(process.env.JUDGE_FAST_MODEL, 'gpt-5.4'),
    /** Narrative only, written once per run at close. Nothing waits on it. */
    deepModel: str(process.env.JUDGE_DEEP_MODEL, 'gpt-5.5'),
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 30_000),
    /** 'auto' uses the HTTP driver when a key exists, else the offline stub. */
    driver: (str(process.env.JUDGE_DRIVER, 'auto')) as 'auto' | 'http' | 'stub',
  },

  // ---- channels ----------------------------------------------------------
  channel: {
    /** Master gate. False means no message can leave this machine, whatever else is set. */
    allowLiveSends: bool(process.env.ALLOW_LIVE_SENDS, false),
    default: (process.env.DEFAULT_CHANNEL_DRIVER ?? 'mock') as 'mock' | 'maritime' | 'ghl',
    maritime: {
      token: process.env.MARITIME_TOKEN ?? '',
      personaTemplate: process.env.MARITIME_PERSONA_TEMPLATE ?? 'openclaw_identity',
      cli: process.env.MARITIME_CLI ?? 'maritime',
    },
    ghl: {
      pit: str(process.env.GHL_PIT),
      apiBase: str(process.env.GHL_API_BASE, 'https://services.leadconnectorhq.com'),
      locationId: str(process.env.GHL_LOCATION_ID),
      /**
       * The number sends actually leave from. Verified by receipt, not read from
       * /locations — that record's `phone` field is a different number entirely.
       */
      fromNumber: str(process.env.GHL_FROM_NUMBER),
      pollMs: int(process.env.GHL_POLL_MS, 30_000),
    },
  },

  // ---- loop timing -------------------------------------------------------
  loop: {
    /**
     * Must stay above ESCALATION_FLOOR_INBOUND, or the cap fires before the persona is ever
     * allowed to ask for a person and the escalation path becomes unreachable.
     */
    maxTurns: int(process.env.MAX_TURNS, 40),

    /**
     * Stay in the conversation while the other side is still talking.
     *
     * Reaching a human is the harness's objective, so the loop used to close a few turns
     * after one appeared. In a live demo that reads as the persona hanging up mid-intake,
     * and it also cuts off the part of the exchange worth watching. With this on, the
     * "good enough, stop here" terminations are suppressed and the run ends on something
     * real instead: a confirmed booking, a decline, an opt-out, silence, or the turn cap.
     *
     * OPTED_OUT is never suppressed. Nothing overrides someone asking us to stop.
     */
    keepTalking: bool(process.env.KEEP_TALKING, true),
    wallClockHours: int(process.env.WALL_CLOCK_HOURS, 72),
    replyDelayMinMs: int(process.env.REPLY_DELAY_MIN_MS, 2 * 60_000),
    replyDelayMaxMs: int(process.env.REPLY_DELAY_MAX_MS, 5 * 60_000),
    /** Business-hours minutes of silence before a nudge. */
    nudgeAfterBizMinutes: int(process.env.NUDGE_AFTER_BIZ_MINUTES, 240),
    maxNudges: int(process.env.MAX_NUDGES, 2),
    noResponseCutoffBizMinutes: int(process.env.NO_RESPONSE_CUTOFF_BIZ_MINUTES, 24 * 60),
    sweepMs: int(process.env.SWEEP_MS, 60_000),
  },

  /** Test/demo speedup: collapses all waits so a full run finishes in seconds. */
  fastClock: bool(process.env.FAST_CLOCK, false),
} as const;

/**
 * Targets that may receive real traffic. Empty means nobody, which is the safe default:
 * the allowlist file is deliberately gitignored, so a deployed container starts with no
 * permitted targets until they are named explicitly.
 *
 * Two sources, unioned — a local file for development and TARGET_ALLOWLIST_DOMAINS for
 * deployment, where there is no file to mount.
 */
export function loadAllowlist(): string[] {
  const domains = new Set<string>();

  for (const entry of str(process.env.TARGET_ALLOWLIST_DOMAINS).split(/[,\s]+/)) {
    const clean = entry.trim().toLowerCase();
    if (clean && !clean.startsWith('#')) domains.add(clean);
  }

  const path = str(process.env.TARGET_ALLOWLIST) || resolve(ROOT, 'config/allowlist.txt');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const clean = line.trim().toLowerCase();
      if (clean && !clean.startsWith('#')) domains.add(clean);
    }
  }
  return [...domains];
}

export function replyDelayMs(): number {
  if (config.fastClock) return 0;
  const { replyDelayMinMs: lo, replyDelayMaxMs: hi } = config.loop;
  return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
}
