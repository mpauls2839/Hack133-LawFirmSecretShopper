import { z } from "zod";
import path from "node:path";

/** Treat blank env values as unset so optional keys can be empty in .env. */
const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const envSchema = z.object({
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default("./data"),
  REPLY_DELAY_SECONDS: z.coerce.number().int().nonnegative().default(45),
  CONVERSATION_TTL_HOURS: z.coerce.number().positive().default(12),

  // GoHighLevel (Twilio is managed inside GHL)
  GHL_PRIVATE_TOKEN: optionalNonEmptyString,
  GHL_LOCATION_ID: optionalNonEmptyString,
  GHL_FROM_NUMBER: optionalNonEmptyString,
  GHL_VALIDATE_SIGNATURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  QSTASH_TOKEN: optionalNonEmptyString,
  QSTASH_CURRENT_SIGNING_KEY: optionalNonEmptyString,
  QSTASH_NEXT_SIGNING_KEY: optionalNonEmptyString,
  QSTASH_VALIDATE_SIGNATURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /** stub = tests; openai = OpenAI-compatible API (incl. Maritime LLM proxy). */
  LLM_PROVIDER: z.enum(["stub", "openai"]).default("stub"),
  /** Explicit key, or fall back to Maritime-injected OPENAI_API_KEY. */
  LLM_API_KEY: optionalNonEmptyString,
  /** Explicit base URL, or fall back to OPENAI_BASE_URL, then api.openai.com. */
  LLM_BASE_URL: z.string().url().default(DEFAULT_OPENAI_BASE_URL),
  LLM_MODEL: z.string().default("gpt-4o"),

  /** Shared secret for POST /conversations/start (header x-start-token). */
  START_CONVERSATION_TOKEN: optionalNonEmptyString,
});

export type Env = z.infer<typeof envSchema> & {
  databasePath: string;
};

let cached: Env | null = null;

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  const merged = { ...process.env, ...overrides };

  // Maritime injects OPENAI_BASE_URL + OPENAI_API_KEY for its LLM proxy.
  const resolvedBaseUrl =
    firstNonEmpty(merged.LLM_BASE_URL, merged.OPENAI_BASE_URL) ??
    DEFAULT_OPENAI_BASE_URL;
  const resolvedApiKey = firstNonEmpty(merged.LLM_API_KEY, merged.OPENAI_API_KEY);

  const parsed = envSchema.parse({
    ...merged,
    LLM_BASE_URL: resolvedBaseUrl,
    LLM_API_KEY: resolvedApiKey,
  });
  const databasePath = path.resolve(parsed.DATA_DIR, "conversations.db");
  const env: Env = { ...parsed, databasePath };
  cached = env;
  return env;
}

export function getEnv(): Env {
  if (!cached) {
    return loadEnv();
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
