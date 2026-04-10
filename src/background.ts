import type {
  GlassboxMessage,
  AckResponse,
  SentimentScoredMessage,
} from "./types/messages.ts";
import { runInference, analyzeSentiment } from "./inference.ts";

chrome.runtime.onMessage.addListener(
  (
    message: GlassboxMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: AckResponse) => void,
  ) => {
    if (message.type === "TEXT_SUBMITTED") {
      const { text, humanityScore, piiMatches, url, timestamp } =
        message.payload;

      console.log(
        `[Glassbox BG] TEXT_SUBMITTED received`,
        `\n  from tab ${sender.tab?.id ?? "unknown"} (${url})`,
        `\n  text length: ${text.length}`,
        `\n  humanity score: ${(humanityScore * 100).toFixed(0)}%`,
        `\n  PII matches: ${piiMatches.length}`,
        `\n  timestamp: ${new Date(timestamp).toISOString()}`,
      );

      // Run inference asynchronously, then respond
      runInference(text)
        .then((inference) => {
          console.log(
            `[Glassbox BG] Inference complete`,
            `\n  label: ${inference.label}`,
            `\n  score: ${inference.score.toFixed(4)}`,
            `\n  latency: ${inference.latencyMs}ms`,
          );
          sendResponse({ status: "ok", receivedAt: Date.now(), inference });
        })
        .catch((err) => {
          console.error("[Glassbox BG] Inference failed:", err);
          sendResponse({ status: "ok", receivedAt: Date.now() });
        });
    }

    if (message.type === "AI_RESPONSE_COMPLETE") {
      const { text: responseText, source, url: pageUrl, timestamp: ts } =
        message.payload;

      console.log(
        `[Glassbox BG] AI_RESPONSE_COMPLETE received`,
        `\n  source: ${source}`,
        `\n  from tab ${sender.tab?.id ?? "unknown"} (${pageUrl})`,
        `\n  response length: ${responseText.length} chars`,
        `\n  timestamp: ${new Date(ts).toISOString()}`,
        `\n  preview: ${responseText.slice(0, 120)}…`,
      );

      sendResponse({ status: "ok", receivedAt: Date.now() });

      // Run local AI sentiment analysis on the response and send result back
      const tabId = sender.tab?.id;
      if (tabId != null && responseText.length > 0) {
        analyzeSentiment(responseText)
          .then((sentiment) => {
            console.log(
              `[Glassbox BG] Sentiment analyzed`,
              `\n  label: ${sentiment.label}`,
              `\n  confidence: ${(sentiment.confidence * 100).toFixed(1)}%`,
              `\n  latency: ${sentiment.latencyMs}ms`,
            );

            const msg: SentimentScoredMessage = {
              type: "SENTIMENT_SCORED",
              payload: {
                ...sentiment,
                textPreview: responseText.slice(0, 80),
              },
            };

            chrome.tabs.sendMessage(tabId, msg);
          })
          .catch((err) => {
            console.error("[Glassbox BG] Sentiment analysis failed:", err);
          });
      }
    }

    // Return true to keep the message channel open for async sendResponse
    return true;
  },
);

console.log("[Glassbox BG] Service worker started.");
