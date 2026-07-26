import type { Env } from "../config/env.js";
import { DEFAULT_ANTHROPIC_BASE_URL } from "../config/env.js";
import {
  StubTurnDecider,
  classifyBookingUrls,
  classifyDeclineMessage,
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

    // Deterministic fast-path for well-known booking domains.
    if (urls.length > 0) {
      const heuristic = classifyBookingUrls(urls);
      if (heuristic) {
        return {
          bookingLinkDetected: true,
          bookingUrl: heuristic,
          declineDetected: false,
          replyText: null,
          reasoning: "deterministic booking-domain match",
        };
      }
    }

    // Deterministic fast-path for clear firm-decline phrasing.
    if (classifyDeclineMessage(input.inboundBody)) {
      return {
        bookingLinkDetected: false,
        bookingUrl: null,
        declineDetected: true,
        declineReason: "firm_declined",
        replyText: null,
        reasoning: "deterministic decline match",
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
    const priorOutbound = input.snapshot.messages
      .filter((m) => m.direction === "outbound")
      .map((m) => m.body);

    return [
      "You are assisting a secret-shopper SMS agent contacting a law firm.",
      "Return ONLY valid JSON with keys:",
      "bookingLinkDetected (boolean), bookingUrl (string|null), declineDetected (boolean), replyText (string|null), reasoning (string).",
      "If any URL is a meeting/booking/scheduling link, set bookingLinkDetected=true, bookingUrl to that URL, declineDetected=false, replyText=null.",
      "If the firm says the prospect is not eligible, they cannot/will not represent them, or otherwise declines the case, set declineDetected=true and replyText=null.",
      "Otherwise write replyText as a natural SMS from the persona, with declineDetected=false.",
      "",
      "Reply rules:",
      "- Directly answer whatever the latest inbound SMS asks, using the relevant concrete fact from Case facts below.",
      "- Include at least one NEW specific detail this turn (location, injury, insurance, date, etc.). Disclose facts progressively; do not dump everything at once.",
      "- 1–2 short SMS sentences max; no essays, no bullet lists, no markdown.",
      "- NEVER repeat a prior outbound message verbatim or near-verbatim. Do not reuse the same opener, sentence structure, or closing ask.",
      "- Vary phrasing every turn: avoid always starting with \"Thanks\", \"Thank you\", or \"Great\". Mix natural openers.",
      "- Progress the conversation: confirm fit → answer their questions with specifics → ask for next step → ask for a booking/scheduling link.",
      "- If the firm already agreed to help or schedule, ask for a concrete booking link or times.",
      "- Stay in persona tone; sound like a real prospect texting, not a bot. Only use facts listed below; do not invent new case details.",
      "",
      `Persona name: ${input.persona.name}`,
      `Persona summary: ${input.persona.summary}`,
      `Problem: ${input.persona.problem}`,
      `Tone: ${input.persona.tone}`,
      `Goals: ${input.persona.goals.join("; ")}`,
      formatBackground(input.persona.background),
      formatDisclosureStyle(input.persona.disclosureStyle),
      formatCaseFacts(input.persona.caseFacts),
      "",
      "Prior outbound messages (do not repeat these; do not reuse their wording):",
      priorOutbound.length ? priorOutbound.map((b, i) => `${i + 1}. ${b}`).join("\n") : "(none)",
      "",
      "Conversation so far:",
      history || "(none)",
      "",
      `Latest inbound SMS: ${input.inboundBody}`,
      `Extracted URLs: ${urls.length ? urls.join(", ") : "(none)"}`,
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  protected parseDecision(raw: string, urls: string[]): TurnDecision {
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText) as Partial<TurnDecision>;
    const bookingLinkDetected = Boolean(parsed.bookingLinkDetected);
    let bookingUrl = typeof parsed.bookingUrl === "string" ? parsed.bookingUrl : null;
    if (bookingLinkDetected && !bookingUrl && urls.length === 1) {
      bookingUrl = urls[0]!;
    }
    // Booking takes precedence over decline if both are set.
    const declineDetected = bookingLinkDetected ? false : Boolean(parsed.declineDetected);
    const stopReplying = bookingLinkDetected || declineDetected;
    return {
      bookingLinkDetected,
      bookingUrl: bookingLinkDetected ? bookingUrl : null,
      declineDetected,
      declineReason: declineDetected ? "firm_declined" : undefined,
      replyText: stopReplying
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
      throw new Error(
        "LLM_API_KEY or OPENAI_API_KEY is required when LLM_PROVIDER=openai",
      );
    }

    const baseUrl = this.env.LLM_BASE_URL.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
      throw new Error(`OpenAI-compatible request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI-compatible response missing content");
    }
    return this.parseDecision(content, urls);
  }
}

class AnthropicTurnDecider extends LlmTurnDecider {
  private static readonly SYSTEM_PROMPT =
    "You produce structured JSON decisions for an SMS secret-shopper agent. Respond with a single JSON object and nothing else.";

  protected async requestDecision(
    input: TurnDecisionInput,
    urls: string[],
  ): Promise<TurnDecision> {
    if (!this.env.LLM_API_KEY) {
      throw new Error(
        "LLM_API_KEY or ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
      );
    }

    // Fall back to Anthropic's host if the base URL is still the OpenAI default.
    const configured = this.env.LLM_BASE_URL;
    const baseUrl = (
      configured.includes("api.openai.com") ? DEFAULT_ANTHROPIC_BASE_URL : configured
    ).replace(/\/+$/, "");

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.env.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.env.LLM_MODEL,
        max_tokens: 512,
        temperature: 0.3,
        system: AnthropicTurnDecider.SYSTEM_PROMPT,
        messages: [{ role: "user", content: this.buildPrompt(input, urls) }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = data.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
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

function formatDisclosureStyle(style: string | undefined): string | null {
  if (!style) return null;
  return `Disclosure style: ${style}`;
}

function formatBackground(
  background:
    | { occupation?: string; situation?: string }
    | undefined,
): string | null {
  if (!background) return null;
  const parts: string[] = [];
  if (background.occupation) parts.push(`Occupation: ${background.occupation}`);
  if (background.situation) parts.push(`Situation: ${background.situation}`);
  if (parts.length === 0) return null;
  return ["Background:", ...parts.map((p) => `- ${p}`)].join("\n");
}

function formatCaseFacts(
  facts:
    | {
        incidentDate?: string;
        location?: string;
        howItHappened?: string;
        otherDriver?: string;
        injuries?: string[];
        medicalTreatment?: string;
        vehicleDamage?: string;
        policeReport?: string;
        insuranceStatus?: string;
        currentConcerns?: string;
        availability?: string;
      }
    | undefined,
): string | null {
  if (!facts) return null;
  const lines: string[] = [];
  if (facts.incidentDate) lines.push(`- Incident date: ${facts.incidentDate}`);
  if (facts.location) lines.push(`- Location: ${facts.location}`);
  if (facts.howItHappened) lines.push(`- How it happened: ${facts.howItHappened}`);
  if (facts.otherDriver) lines.push(`- Other driver: ${facts.otherDriver}`);
  if (facts.injuries?.length) lines.push(`- Injuries: ${facts.injuries.join("; ")}`);
  if (facts.medicalTreatment) lines.push(`- Medical treatment: ${facts.medicalTreatment}`);
  if (facts.vehicleDamage) lines.push(`- Vehicle damage: ${facts.vehicleDamage}`);
  if (facts.policeReport) lines.push(`- Police report: ${facts.policeReport}`);
  if (facts.insuranceStatus) lines.push(`- Insurance: ${facts.insuranceStatus}`);
  if (facts.currentConcerns) lines.push(`- Current concerns: ${facts.currentConcerns}`);
  if (facts.availability) lines.push(`- Availability: ${facts.availability}`);
  if (lines.length === 0) return null;
  return ["Case facts (use these when answering; do not invent others):", ...lines].join("\n");
}
