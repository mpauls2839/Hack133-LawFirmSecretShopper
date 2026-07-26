import type { ConversationSnapshot } from "../domain/conversation.js";
import type { PersonaConfig } from "../config/persona.js";
import { extractUrls } from "./urls.js";

export interface TurnDecision {
  bookingLinkDetected: boolean;
  bookingUrl: string | null;
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
  ];

  for (const url of urls) {
    const lower = url.toLowerCase();
    if (bookingHints.some((hint) => lower.includes(hint))) {
      return url;
    }
  }
  return null;
}

export class StubTurnDecider implements TurnDecider {
  async decide(input: TurnDecisionInput): Promise<TurnDecision> {
    const urls = extractUrls(input.inboundBody);
    const bookingUrl = classifyBookingUrls(urls);
    if (bookingUrl) {
      return {
        bookingLinkDetected: true,
        bookingUrl,
        replyText: null,
        reasoning: "stub classifier matched known booking domain",
      };
    }

    const replyText = buildStubReply(input);
    return {
      bookingLinkDetected: false,
      bookingUrl: null,
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
