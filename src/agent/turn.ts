import type { ConversationSnapshot } from "../domain/conversation.js";
import type { PersonaConfig } from "../config/persona.js";
import { extractUrls } from "./urls.js";

export interface TurnDecision {
  bookingLinkDetected: boolean;
  bookingUrl: string | null;
  declineDetected: boolean;
  declineReason?: string;
  replyText: string | null;
  reasoning?: string;
}

export interface TurnDecisionInput {
  snapshot: ConversationSnapshot;
  inboundBody: string;
  persona: PersonaConfig["persona"];
}

export interface TurnDecider {
  decide(input: TurnDecisionInput): Promise<TurnDecision>;
}

/**
 * Heuristic classifier used by the stub provider and as a fallback.
 * Marks common scheduling domains as booking links.
 */
export function classifyBookingUrls(urls: string[]): string | null {
  const bookingHints = [
    "calendly.com",
    "cal.com",
    "acuityscheduling.com",
    "squareup.com/appointments",
    "book.squareup.com",
    "setmore.com",
    "youcanbook.me",
    "appointlet.com",
    "hubspot.com/meetings",
    "microsoft.com/bookings",
    "outlook.office.com/book",
    "tidycal.com",
    "savvycal.com",
    "zcal.co",
    "koalendar.com",
  ];

  for (const url of urls) {
    const lower = url.toLowerCase();
    if (bookingHints.some((hint) => lower.includes(hint))) {
      return url;
    }
  }
  return null;
}

/**
 * Conservative keyword classifier for firm rejection / ineligibility messages.
 * Returns true when the inbound body clearly declines representation.
 */
export function classifyDeclineMessage(body: string): boolean {
  const lower = body.toLowerCase();
  const patterns = [
    /not\s+eligible/,
    /can(?:'|no)?t\s+represent/,
    /cannot\s+represent/,
    /unable\s+to\s+represent/,
    /won(?:'|no)?t\s+represent/,
    /will\s+not\s+represent/,
    /can(?:'|no)?t\s+take\s+(?:your|the)\s+case/,
    /cannot\s+take\s+(?:your|the)\s+case/,
    /unable\s+to\s+take\s+(?:your|the)\s+case/,
    /don(?:'|no)?t\s+handle/,
    /do\s+not\s+handle/,
    /outside\s+(?:of\s+)?our\s+practice\s+area/,
    /not\s+a\s+good\s+fit/,
    /we\s+must\s+decline/,
    /unable\s+to\s+assist/,
    /can(?:'|no)?t\s+assist/,
    /cannot\s+assist/,
    /we\s+(?:are\s+)?(?:unable|unable\s+to|not\s+able\s+to)\s+(?:help|assist)/,
  ];
  return patterns.some((p) => p.test(lower));
}

export class StubTurnDecider implements TurnDecider {
  async decide(input: TurnDecisionInput): Promise<TurnDecision> {
    const urls = extractUrls(input.inboundBody);
    const bookingUrl = classifyBookingUrls(urls);
    if (bookingUrl) {
      return {
        bookingLinkDetected: true,
        bookingUrl,
        declineDetected: false,
        replyText: null,
        reasoning: "stub classifier matched known booking domain",
      };
    }

    if (classifyDeclineMessage(input.inboundBody)) {
      return {
        bookingLinkDetected: false,
        bookingUrl: null,
        declineDetected: true,
        declineReason: "firm_declined",
        replyText: null,
        reasoning: "stub classifier matched firm decline phrasing",
      };
    }

    const replyText = buildStubReply(input);
    return {
      bookingLinkDetected: false,
      bookingUrl: null,
      declineDetected: false,
      replyText,
      reasoning: "stub reply generated from persona",
    };
  }
}

function buildStubReply(input: TurnDecisionInput): string {
  const body = input.inboundBody.toLowerCase();
  if (body.includes("consult") || body.includes("schedule") || body.includes("book")) {
    return `Thanks — that sounds helpful. Could you send a link so I can pick a time that works?`;
  }
  if (body.includes("yes") || body.includes("we do") || body.includes("handle")) {
    return `Great, thank you. What's the best next step to set up a short consultation?`;
  }
  return `Thanks for getting back to me. ${input.persona.problem.split(";")[0]}. Would it be possible to schedule a brief call or consultation?`;
}
