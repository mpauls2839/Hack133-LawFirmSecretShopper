import type { Env } from "../config/env.js";
import {
  StubTurnDecider,
  classifyBookingUrls,
  type TurnDecider,
  type TurnDecision,
  type TurnDecisionInput,
} from "./turn.js";
import { extractUrls } from "./urls.js";

export function createTurnDecider(env: Env): TurnDecider {
  switch (env.LLM_PROVIDER) {
    case "openai":
      return new OpenAiTurnDecider(env);
    case "anthropic":
      return new AnthropicTurnDecider(env);
    case "stub":
    default:
      return new StubTurnDecider();
  }
}

abstract class LlmTurnDecider implements TurnDecider {
  constructor(protected readonly env: Env) {}

  async decide(input: TurnDecisionInput): Promise<TurnDecision> {
    const urls = extractUrls(input.inboundBody);
    if (urls.length === 0) {
      return this.requestDecision(input, urls);
    }

    // Deterministic fast-path for well-known booking domains.
    const heuristic = classifyBookingUrls(urls);
    if (heuristic) {
      return {
        bookingLinkDetected: true,
        bookingUrl: heuristic,
        replyText: null,
        reasoning: "deterministic booking-domain match",
      };
    }

    return this.requestDecision(input, urls);
  }

  protected abstract requestDecision(
    input: TurnDecisionInput,
    urls: string[],
  ): Promise<TurnDecision>;

  protected buildPrompt(input: TurnDecisionInput, urls: string[]): string {
    const history = input.snapshot.messages
      .map((m) => `${m.direction.toUpperCase()}: ${m.body}`)
      .join("\n");

    return [
      "You are assisting a secret-shopper SMS agent contacting a law firm.",
      "Return ONLY valid JSON with keys:",
      'bookingLinkDetected (boolean), bookingUrl (string|null), replyText (string|null), reasoning (string).',
      "If any URL is a meeting/booking/scheduling link, set bookingLinkDetected=true, bookingUrl to that URL, replyText=null.",
      "Otherwise write a short SMS reply that stays in persona and nudges toward getting a booking link.",
      "",
      `Persona name: ${input.persona.name}`,
      `Persona summary: ${input.persona.summary}`,
      `Problem: ${input.persona.problem}`,
      `Tone: ${input.persona.tone}`,
      `Goals: ${input.persona.goals.join("; ")}`,
      "",
      "Conversation so far:",
      history || "(none)",
      "",
      `Latest inbound SMS: ${input.inboundBody}`,
      `Extracted URLs: ${urls.length ? urls.join(", ") : "(none)"}`,
    ].join("\n");
  }

  protected parseDecision(raw: string, urls: string[]): TurnDecision {
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText) as Partial<TurnDecision>;
    const bookingLinkDetected = Boolean(parsed.bookingLinkDetected);
    let bookingUrl = typeof parsed.bookingUrl === "string" ? parsed.bookingUrl : null;
    if (bookingLinkDetected && !bookingUrl && urls.length === 1) {
      bookingUrl = urls[0]!;
    }
    return {
      bookingLinkDetected,
      bookingUrl: bookingLinkDetected ? bookingUrl : null,
      replyText: bookingLinkDetected
        ? null
        : typeof parsed.replyText === "string"
          ? parsed.replyText
          : null,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
    };
  }
}

class OpenAiTurnDecider extends LlmTurnDecider {
  protected async requestDecision(
    input: TurnDecisionInput,
    urls: string[],
  ): Promise<TurnDecision> {
    if (!this.env.LLM_API_KEY) {
      throw new Error("LLM_API_KEY is required when LLM_PROVIDER=openai");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.env.LLM_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You produce structured JSON decisions for an SMS secret-shopper agent.",
          },
          { role: "user", content: this.buildPrompt(input, urls) },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response missing content");
    }
    return this.parseDecision(content, urls);
  }
}

class AnthropicTurnDecider extends LlmTurnDecider {
  protected async requestDecision(
    input: TurnDecisionInput,
    urls: string[],
  ): Promise<TurnDecision> {
    if (!this.env.LLM_API_KEY) {
      throw new Error("LLM_API_KEY is required when LLM_PROVIDER=anthropic");
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.env.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.env.LLM_MODEL,
        max_tokens: 500,
        temperature: 0.3,
        messages: [{ role: "user", content: this.buildPrompt(input, urls) }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const content = data.content?.find((part) => part.type === "text")?.text;
    if (!content) {
      throw new Error("Anthropic response missing text content");
    }
    return this.parseDecision(content, urls);
  }
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error(`Model response was not JSON: ${raw}`);
}
