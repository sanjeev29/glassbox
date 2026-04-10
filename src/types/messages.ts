import type { PIIMatch } from "../content.ts";
import type { InferenceResult, SentimentResult } from "../inference.ts";

export interface SuspiciousChar {
  category: "zero-width" | "tag-char" | "bidi";
  codepoint: string; // e.g. "U+200B"
  index: number;     // character index in the source text
}

export interface TextSubmittedMessage {
  type: "TEXT_SUBMITTED";
  payload: {
    text: string;
    humanityScore: number;
    piiMatches: PIIMatch[];
    suspiciousChars: SuspiciousChar[];
    redacted: boolean;
    url: string;
    timestamp: number;
  };
}

export interface AIResponseCompleteMessage {
  type: "AI_RESPONSE_COMPLETE";
  payload: {
    text: string;
    source: string;
    url: string;
    timestamp: number;
  };
}

/** Sent from background → content script with sentiment analysis results */
export interface SentimentScoredMessage {
  type: "SENTIMENT_SCORED";
  payload: SentimentResult & {
    /** Preview of the analyzed text for matching */
    textPreview: string;
  };
}

export interface AckResponse {
  status: "ok";
  receivedAt: number;
  inference?: InferenceResult;
}

export type GlassboxMessage =
  | TextSubmittedMessage
  | AIResponseCompleteMessage
  | SentimentScoredMessage;
