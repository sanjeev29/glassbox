import { useState, useEffect } from "react";
import type { PIIMatch } from "../content.ts";
import type { SentimentResult } from "../inference.ts";
import type { SuspiciousChar } from "../types/messages.ts";

const LABEL_DISPLAY: Record<string, string> = {
  email: "Email",
  phone: "Phone",
  "aws-key": "AWS Key",
  "stripe-key": "Stripe Key",
  "github-pat": "GitHub Token",
  "openai-key": "OpenAI Key",
  "anthropic-key": "Anthropic Key",
  "slack-token": "Slack Token",
  jwt: "JWT",
  "private-key": "Private Key",
  "db-url": "DB URL",
  "google-api-key": "Google API Key",
};

const CATEGORY_DISPLAY: Record<string, string> = {
  "zero-width": "Zero-width",
  "tag-char": "Tag char",
  bidi: "Bidi override",
};

type RedactMode = "warn" | "redact" | "block";
const MODE_KEY = "glassbox.redactMode";

function dispatchAction(
  detail:
    | { kind: "redact-pii"; match: string; label: string }
    | { kind: "strip-chars"; category: "zero-width" | "tag-char" | "bidi" },
) {
  document.dispatchEvent(
    new CustomEvent("glassbox:action", { detail, bubbles: true }),
  );
}

function groupByCategory(chars: SuspiciousChar[]) {
  const out: Record<string, SuspiciousChar[]> = {};
  for (const c of chars) {
    (out[c.category] ||= []).push(c);
  }
  return out;
}

export default function GlassboxPanel() {
  const [score, setScore] = useState(1);
  const [pii, setPii] = useState<PIIMatch[]>([]);
  const [suspicious, setSuspicious] = useState<SuspiciousChar[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [sentiment, setSentiment] = useState<SentimentResult | null>(null);
  const [mode, setMode] = useState<RedactMode>("warn");
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        humanityScore: number;
        piiMatches: PIIMatch[];
        suspiciousChars?: SuspiciousChar[];
      };
      setScore(detail.humanityScore);
      setPii(detail.piiMatches);
      setSuspicious(detail.suspiciousChars ?? []);
    };
    document.addEventListener("glassbox:update", handler, true);
    return () => document.removeEventListener("glassbox:update", handler, true);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as SentimentResult;
      setSentiment(detail);
    };
    document.addEventListener("glassbox:sentiment", handler, true);
    return () =>
      document.removeEventListener("glassbox:sentiment", handler, true);
  }, []);

  // Flash a BLOCKED banner for 2 seconds when the content script
  // dispatches glassbox:blocked.
  useEffect(() => {
    const handler = () => {
      setBlocked(true);
      setTimeout(() => setBlocked(false), 2000);
    };
    document.addEventListener("glassbox:blocked", handler, true);
    return () =>
      document.removeEventListener("glassbox:blocked", handler, true);
  }, []);

  // Load initial mode and listen for chrome.storage changes across tabs.
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    chrome.storage.local.get({ [MODE_KEY]: "warn" }).then((r) => {
      setMode(r[MODE_KEY] as RedactMode);
    });
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes[MODE_KEY]) {
        setMode(changes[MODE_KEY].newValue as RedactMode);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const setModeAndPersist = (m: RedactMode) => {
    setMode(m);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [MODE_KEY]: m });
    }
  };

  const pct = Math.round(score * 100);
  const hasPii = pii.length > 0;
  const hasHidden = suspicious.length > 0;
  const isPositive = sentiment?.label === "POSITIVE";

  // Color gradient: green (100%) → yellow (50%) → red (0%)
  const hue = score * 120; // 120=green, 0=red

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "40px",
          height: "40px",
          borderRadius: "50%",
          background: hasPii
            ? "#dc2626"
            : hasHidden
              ? "#f97316"
              : `hsl(${hue}, 72%, 44%)`,
          color: "#fff",
          fontSize: "14px",
          fontWeight: 700,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          boxShadow:
            "0 4px 12px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.1)",
          transition: "transform 0.15s ease",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.transform = "scale(1.1)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.transform = "scale(1)")
        }
        title="Glassbox – click to expand"
      >
        {hasPii ? "!" : hasHidden ? "\u26A0" : `${pct}`}
      </button>
    );
  }

  return (
    <div
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        width: "260px",
        borderRadius: "12px",
        overflow: "hidden",
        background: "#1a1a2e",
        color: "#e0e0e0",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06)",
        fontSize: "13px",
        lineHeight: "1.4",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "rgba(255,255,255,0.04)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <span
          style={{
            fontWeight: 700,
            fontSize: "13px",
            letterSpacing: "0.03em",
            color: "#fff",
          }}
        >
          GLASSBOX
        </span>
        <button
          onClick={() => setCollapsed(true)}
          style={{
            all: "unset",
            cursor: "pointer",
            color: "#888",
            fontSize: "16px",
            lineHeight: "1",
            padding: "2px 4px",
          }}
          title="Collapse"
        >
          &minus;
        </button>
      </div>

      {/* Humanity Score */}
      <div style={{ padding: "14px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: "8px",
          }}
        >
          <span style={{ fontSize: "12px", color: "#999", fontWeight: 500 }}>
            Humanity Score
          </span>
          <span
            style={{
              fontSize: "22px",
              fontWeight: 700,
              color: `hsl(${hue}, 72%, 58%)`,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {pct}%
          </span>
        </div>

        {/* Progress bar */}
        <div
          style={{
            height: "6px",
            borderRadius: "3px",
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              borderRadius: "3px",
              background: `hsl(${hue}, 72%, 50%)`,
              transition: "width 0.3s ease, background 0.3s ease",
            }}
          />
        </div>
      </div>

      {/* Mode selector */}
      <div
        style={{
          margin: "0 14px 14px",
          padding: "8px 10px",
          borderRadius: "8px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <span style={{ fontSize: "11px", color: "#888", fontWeight: 600 }}>
          MODE
        </span>
        <div style={{ display: "flex", gap: "4px", flex: 1 }}>
          {(["warn", "redact", "block"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setModeAndPersist(m)}
              style={{
                all: "unset",
                cursor: "pointer",
                flex: 1,
                textAlign: "center",
                padding: "4px 0",
                fontSize: "11px",
                fontWeight: 600,
                borderRadius: "4px",
                background:
                  mode === m
                    ? m === "warn"
                      ? "rgba(250, 204, 21, 0.25)"
                      : m === "redact"
                        ? "rgba(99, 102, 241, 0.25)"
                        : "rgba(220, 38, 38, 0.25)"
                    : "transparent",
                color:
                  mode === m
                    ? m === "warn"
                      ? "#facc15"
                      : m === "redact"
                        ? "#a5b4fc"
                        : "#f87171"
                    : "#888",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
              title={
                m === "warn"
                  ? "Warn only — submit anyway"
                  : m === "redact"
                    ? "Auto-redact PII on submit"
                    : "Block submission if any PII remains"
              }
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* BLOCKED banner (flashes for 2s) */}
      {blocked && (
        <div
          style={{
            margin: "0 14px 14px",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "rgba(220, 38, 38, 0.18)",
            border: "1px solid rgba(220, 38, 38, 0.5)",
            color: "#fca5a5",
            fontSize: "12px",
            fontWeight: 700,
            textAlign: "center",
            letterSpacing: "0.05em",
          }}
        >
          &#128683; SUBMISSION BLOCKED
        </div>
      )}

      {/* PII Warning with per-item Redact buttons */}
      {hasPii && (
        <div
          style={{
            margin: "0 14px 14px",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "rgba(220, 38, 38, 0.12)",
            border: "1px solid rgba(220, 38, 38, 0.3)",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: "12px",
              color: "#f87171",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span style={{ fontSize: "14px" }}>&#9888;</span>
            PII DETECTED ({pii.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {pii.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  fontSize: "12px",
                  color: "#fca5a5",
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  <strong>{LABEL_DISPLAY[m.label] ?? m.label}:</strong>{" "}
                  {m.match.slice(0, 4)}
                  ***
                </span>
                <button
                  onClick={() =>
                    dispatchAction({
                      kind: "redact-pii",
                      match: m.match,
                      label: m.label,
                    })
                  }
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    padding: "2px 8px",
                    fontSize: "10px",
                    fontWeight: 700,
                    borderRadius: "4px",
                    background: "rgba(220, 38, 38, 0.25)",
                    color: "#fca5a5",
                    border: "1px solid rgba(220, 38, 38, 0.4)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Redact
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hidden Characters warning with per-category Strip buttons */}
      {hasHidden && (
        <div
          style={{
            margin: "0 14px 14px",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "rgba(249, 115, 22, 0.12)",
            border: "1px solid rgba(249, 115, 22, 0.3)",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: "12px",
              color: "#fb923c",
              marginBottom: "8px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span style={{ fontSize: "14px" }}>&#9888;</span>
            HIDDEN CHARACTERS ({suspicious.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {Object.entries(groupByCategory(suspicious)).map(([cat, items]) => (
              <div
                key={cat}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  fontSize: "12px",
                  color: "#fdba74",
                }}
              >
                <span>
                  <strong>{CATEGORY_DISPLAY[cat] ?? cat}:</strong> {items.length}
                </span>
                <button
                  onClick={() =>
                    dispatchAction({
                      kind: "strip-chars",
                      category: cat as
                        | "zero-width"
                        | "tag-char"
                        | "bidi",
                    })
                  }
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    padding: "2px 8px",
                    fontSize: "10px",
                    fontWeight: 700,
                    borderRadius: "4px",
                    background: "rgba(249, 115, 22, 0.25)",
                    color: "#fdba74",
                    border: "1px solid rgba(249, 115, 22, 0.4)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Strip
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Response Sentiment (local on-device inference) */}
      {sentiment !== null && (
        <div style={{ padding: "0 14px 14px" }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              background: "rgba(99, 102, 241, 0.08)",
              border: "1px solid rgba(99, 102, 241, 0.2)",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                color: "#a5b4fc",
                fontWeight: 600,
                marginBottom: "6px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>&#x2728;</span>
              LOCAL AI ANALYSIS
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: "6px",
              }}
            >
              <span style={{ fontSize: "12px", color: "#999" }}>
                Response sentiment
              </span>
              <span
                style={{
                  fontSize: "14px",
                  fontWeight: 700,
                  color: isPositive ? "#4ade80" : "#f87171",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {sentiment.label}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: "8px",
              }}
            >
              <span style={{ fontSize: "12px", color: "#999" }}>
                Confidence
              </span>
              <span
                style={{
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#fff",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {Math.round(sentiment.confidence * 100)}%
              </span>
            </div>
            <div
              style={{
                height: "4px",
                borderRadius: "2px",
                background: "rgba(255,255,255,0.08)",
                overflow: "hidden",
                marginBottom: "6px",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${sentiment.confidence * 100}%`,
                  borderRadius: "2px",
                  background: isPositive ? "#4ade80" : "#f87171",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div
              style={{
                fontSize: "10px",
                color: "#666",
                fontFamily: "ui-monospace, Consolas, monospace",
              }}
            >
              DistilBERT · {sentiment.latencyMs}ms · WebGPU/WASM
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
