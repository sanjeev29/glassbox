/**
 * Glassbox Content Script
 *
 * Tracks two things on every input element in the page:
 * 1. Humanity Score – ratio of typed characters vs pasted characters.
 * 2. PII Scrubber – regex detection for emails, phone numbers, and
 *    AWS / Stripe API keys.
 *
 * On ChatGPT and Claude.ai, also observes streaming AI responses and
 * sends the finalized text to the background service worker.
 *
 * Pure vanilla TS — no React, no framework dependencies.
 */

import { resolveAdapter, type SiteAdapter } from "./adapters.ts";
import { injectPanel } from "./panel/inject.tsx";
import type {
  TextSubmittedMessage,
  AIResponseCompleteMessage,
  SentimentScoredMessage,
  AckResponse,
} from "./types/messages.ts";

// ── Redact mode settings (chrome.storage.local) ─────────────────────
export type RedactMode = "warn" | "redact" | "block";

const MODE_KEY = "glassbox.redactMode";
let redactMode: RedactMode = "warn";

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local
    .get({ [MODE_KEY]: "warn" as RedactMode })
    .then((r) => {
      redactMode = r[MODE_KEY] as RedactMode;
    })
    .catch(() => {
      // Not in extension context — keep default
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[MODE_KEY]) {
      redactMode = changes[MODE_KEY].newValue as RedactMode;
    }
  });
}

// ── Humanity Score state ────────────────────────────────────────────
interface HumanityState {
  typedChars: number;
  pastedChars: number;
}

const stateMap = new WeakMap<HTMLElement, HumanityState>();

function getState(el: HTMLElement): HumanityState {
  let s = stateMap.get(el);
  if (!s) {
    s = { typedChars: 0, pastedChars: 0 };
    stateMap.set(el, s);
  }
  return s;
}

export function computeHumanityScore(state: HumanityState): number {
  const total = state.typedChars + state.pastedChars;
  if (total === 0) return 1; // no input yet → 100 % human
  return state.typedChars / total;
}

// ── PII patterns ────────────────────────────────────────────────────
const PII_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: "email", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: "phone", regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  { label: "aws-key", regex: /AKIA[0-9A-Z]{16}/g },
  { label: "stripe-key", regex: /(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,}/g },

  // GitHub personal access tokens (modern prefix format: ghp_, gho_, ghu_, ghs_, ghr_)
  { label: "github-pat", regex: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  // GitHub fine-grained PATs
  { label: "github-pat", regex: /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/g },

  // OpenAI API keys (user and project). Negative lookahead excludes
  // Anthropic keys (sk-ant-*) which are matched by a separate pattern.
  { label: "openai-key", regex: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },

  // Anthropic API keys
  { label: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },

  // Slack tokens (bot, app, user, refresh, config)
  { label: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },

  // JWTs — three base64url segments separated by dots
  { label: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },

  // PEM private key headers (any algorithm)
  { label: "private-key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },

  // Database URLs with embedded credentials
  { label: "db-url", regex: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^:\s/]+:[^@\s]+@[^\s]+/g },

  // Google API keys
  { label: "google-api-key", regex: /AIza[A-Za-z0-9_-]{35}/g },
];

export interface PIIMatch {
  label: string;
  match: string;
}

export function detectPII(text: string): PIIMatch[] {
  const results: PIIMatch[] = [];
  for (const { label, regex } of PII_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      results.push({ label, match: m[0] });
    }
  }
  return results;
}

/** Pure function: replace the first occurrence of each PII match with
 *  a [REDACTED:label] placeholder. Sorts by descending position so that
 *  earlier replacements don't shift later indices. */
export function redactText(text: string, piiMatches: PIIMatch[]): string {
  if (piiMatches.length === 0) return text;
  // Compute positions once, sort descending, splice from the end.
  const withPositions = piiMatches
    .map((m) => ({ m, idx: text.indexOf(m.match) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => b.idx - a.idx);

  let out = text;
  for (const { m, idx } of withPositions) {
    out = out.slice(0, idx) + `[REDACTED:${m.label}]` + out.slice(idx + m.match.length);
  }
  return out;
}

// ── Hidden / suspicious character detection ────────────────────────
export type SuspiciousCategory = "zero-width" | "tag-char" | "bidi";

export interface SuspiciousChar {
  category: SuspiciousCategory;
  codepoint: string; // e.g. "U+200B"
  index: number;
}

const ZERO_WIDTH_CODES = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e,
]);
const BIDI_OVERRIDE_CODES = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

function isTagChar(codepoint: number): boolean {
  return codepoint >= 0xe0000 && codepoint <= 0xe007f;
}

export function detectSuspiciousChars(text: string): SuspiciousChar[] {
  const results: SuspiciousChar[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Handle supplementary plane (surrogate pairs) for Unicode tag chars
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        if (isTagChar(cp)) {
          results.push({
            category: "tag-char",
            codepoint: `U+${cp.toString(16).toUpperCase().padStart(5, "0")}`,
            index: i,
          });
        }
        i++; // skip low surrogate
        continue;
      }
    }
    if (ZERO_WIDTH_CODES.has(code)) {
      results.push({
        category: "zero-width",
        codepoint: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
        index: i,
      });
    } else if (BIDI_OVERRIDE_CODES.has(code)) {
      results.push({
        category: "bidi",
        codepoint: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
        index: i,
      });
    }
  }
  return results;
}

/** Strip characters of a single category. Used by per-item cleanup. */
export function stripCharsByCategory(
  text: string,
  category: SuspiciousCategory,
): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        if (category === "tag-char" && isTagChar(cp)) {
          i++; // skip both halves
          continue;
        }
        // Surrogate pair but not a tag char — keep both halves
        out += text[i] + text[i + 1];
        i++;
        continue;
      }
    }
    if (category === "zero-width" && ZERO_WIDTH_CODES.has(code)) continue;
    if (category === "bidi" && BIDI_OVERRIDE_CODES.has(code)) continue;
    out += text[i];
  }
  return out;
}

// ── Event dispatching (custom events for testability) ───────────────
function dispatchGlassbox(
  el: HTMLElement,
  detail: {
    humanityScore: number;
    piiMatches: PIIMatch[];
    suspiciousChars: SuspiciousChar[];
  },
) {
  el.dispatchEvent(
    new CustomEvent("glassbox:update", { bubbles: true, detail }),
  );
}

// ── Helpers ─────────────────────────────────────────────────────────
function getInputText(el: HTMLElement, adapter: SiteAdapter): string {
  return adapter.getInputText(el);
}

// ── Input listeners ─────────────────────────────────────────────────
function onInput(e: Event, adapter: SiteAdapter) {
  const el = e.target as HTMLElement;
  if (!el) return;

  // Guard: programmatic setInputText dispatches an `input` event without a
  // meaningful inputType (or "insertReplacementText"). We want the panel to
  // re-scan the text but we must NOT increment the typed/pasted counters,
  // or the Humanity Score will double-count the mutation.
  const isProgrammatic =
    e instanceof InputEvent &&
    (e.inputType === "insertReplacementText" || !e.inputType);

  const state = getState(el);

  if (!isProgrammatic) {
    if (e instanceof InputEvent && e.inputType === "insertFromPaste") {
      const pastedLen = (e.data ?? "").length;
      state.pastedChars += pastedLen;
    } else if (
      e instanceof InputEvent &&
      (e.inputType === "insertText" || e.inputType === "insertLineBreak")
    ) {
      state.typedChars += (e.data ?? "").length || 1;
    }
  }

  const text = getInputText(el, adapter);
  const humanityScore = computeHumanityScore(state);
  const piiMatches = detectPII(text);
  const suspiciousChars = detectSuspiciousChars(text);

  // Dispatch on the nearest textarea for compatibility with the panel
  // listener, or on the element itself
  const dispatchTarget =
    el instanceof HTMLTextAreaElement
      ? el
      : (el.closest("textarea") as HTMLTextAreaElement) ?? el;
  dispatchGlassbox(dispatchTarget, { humanityScore, piiMatches, suspiciousChars });
}

function onPaste(e: ClipboardEvent) {
  const el = e.target as HTMLElement;
  if (!el) return;
  const state = getState(el);
  const pasted = e.clipboardData?.getData("text/plain") ?? "";
  state.pastedChars += pasted.length;
}

// ── Message passing to background ───────────────────────────────────
function sendMessage(message: TextSubmittedMessage | AIResponseCompleteMessage) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return; // Not running in extension context (e.g. test fixture)
  }
  chrome.runtime.sendMessage(message, (response: AckResponse) => {
    if (chrome.runtime.lastError) {
      console.warn(
        "[Glassbox] Message send failed:",
        chrome.runtime.lastError.message,
      );
      return;
    }
    console.log(
      `[Glassbox] Background acknowledged (${message.type}) at ${new Date(response.receivedAt).toISOString()}`,
    );
  });
}

function sendTextSubmitted(
  el: HTMLElement,
  adapter: SiteAdapter,
  redacted = false,
) {
  const state = getState(el);
  const text = getInputText(el, adapter);
  const humanityScore = computeHumanityScore(state);
  const piiMatches = detectPII(text);
  const suspiciousChars = detectSuspiciousChars(text);

  const message: TextSubmittedMessage = {
    type: "TEXT_SUBMITTED",
    payload: {
      text,
      humanityScore,
      piiMatches,
      suspiciousChars,
      redacted,
      url: window.location.href,
      timestamp: Date.now(),
    },
  };

  sendMessage(message);
}

function sendAIResponseComplete(text: string, source: string) {
  const message: AIResponseCompleteMessage = {
    type: "AI_RESPONSE_COMPLETE",
    payload: {
      text,
      source,
      url: window.location.href,
      timestamp: Date.now(),
    },
  };

  sendMessage(message);
}

// ── Streaming response tracker ──────────────────────────────────────
// Tracks elements that are actively streaming. Once content stabilizes
// (no mutations for STABILIZE_MS), we consider the response finalized.
const STABILIZE_MS = 1500;
const activeStreams = new Map<
  HTMLElement,
  { timer: ReturnType<typeof setTimeout>; lastText: string }
>();
const sentResponses = new WeakSet<HTMLElement>();

function onStreamMutation(el: HTMLElement, adapter: SiteAdapter) {
  const text = (el.innerText ?? "").trim();
  if (!text || text.length < 2) return;

  const existing = activeStreams.get(el);

  // If text hasn't changed, skip
  if (existing && existing.lastText === text) return;

  // Clear previous debounce timer
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    activeStreams.delete(el);
    // Only send if we haven't already sent this exact block
    if (!sentResponses.has(el)) {
      sentResponses.add(el);
      const finalText = (el.innerText ?? "").trim();
      console.log(
        `[Glassbox] AI response finalized (${adapter.name}):`,
        finalText.slice(0, 80) + "…",
      );
      // Track for highlighting when entropy score comes back
      recentResponseEls.length = 0;
      recentResponseEls.push(el);
      sendAIResponseComplete(finalText, adapter.name);
    }
  }, STABILIZE_MS);

  activeStreams.set(el, { timer, lastText: text });
}

// ── Submit interception (shared by keydown and click handlers) ─────
function handleSubmitIntercept(
  e: KeyboardEvent | MouseEvent,
  el: HTMLElement,
  adapter: SiteAdapter,
) {
  const text = adapter.getInputText(el);
  const piiMatches = detectPII(text);
  const suspiciousChars = detectSuspiciousChars(text);
  const hasSensitive = piiMatches.length > 0 || suspiciousChars.length > 0;

  if (!hasSensitive) {
    sendTextSubmitted(el, adapter, false);
    return;
  }

  if (redactMode === "block") {
    // Block if ANY PII or hidden char remains. User must clean via the
    // panel's per-item buttons before they can submit.
    e.preventDefault();
    e.stopImmediatePropagation();
    document.dispatchEvent(
      new CustomEvent("glassbox:blocked", {
        detail: { piiMatches, suspiciousChars },
      }),
    );
    console.warn(
      "[Glassbox] Submission blocked:",
      piiMatches.length,
      "PII,",
      suspiciousChars.length,
      "hidden chars",
    );
    return;
  }

  if (redactMode === "redact" && piiMatches.length > 0) {
    // Auto-redact any REMAINING PII. Hidden chars are NOT stripped here
    // — those always require a manual click in the panel.
    const redacted = redactText(text, piiMatches);
    adapter.setInputText(el, redacted);
    sendTextSubmitted(el, adapter, true);
    console.log(
      "[Glassbox] Auto-redacted",
      piiMatches.length,
      "PII match(es) before submission",
    );
    return;
  }

  // warn mode (or redact mode with no PII remaining)
  sendTextSubmitted(el, adapter, false);
}

// ── Bootstrap ───────────────────────────────────────────────────────
const attachedInputs = new WeakSet<HTMLElement>();

function attachInput(el: HTMLElement, adapter: SiteAdapter) {
  if (attachedInputs.has(el)) return;
  attachedInputs.add(el);
  el.addEventListener("input", (e) => onInput(e, adapter));
  el.addEventListener("paste", onPaste);
  // Capture phase so we run BEFORE ProseMirror's own Enter handler
  // attached on the same element (they fire in insertion order otherwise,
  // and ProseMirror typically attaches first).
  el.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        handleSubmitIntercept(e, el, adapter);
      }
    },
    { capture: true },
  );
}

function scanInputs(adapter: SiteAdapter) {
  // Adapter-specific input
  const adapterInput = adapter.findInput();
  if (adapterInput) attachInput(adapterInput, adapter);

  // Also attach to all textareas as a safety net
  document.querySelectorAll("textarea").forEach((el) => {
    attachInput(el as HTMLTextAreaElement, adapter);
  });
}

// Listen for submit buttons (capture phase so block mode can cancel
// the click before the platform's own bubble-phase handlers run).
function setupSubmitListener(adapter: SiteAdapter) {
  document.addEventListener(
    "click",
    (e) => {
      const btn = (e.target as HTMLElement).closest?.(
        'button, [type="submit"], [data-testid="send-button"], [aria-label="Send"]',
      );
      if (!btn) return;

      // Find the active input via the adapter first, then fall back
      const input =
        adapter.findInput() ??
        btn.closest("form")?.querySelector("textarea") ??
        document.querySelector("textarea");

      if (input instanceof HTMLElement) {
        handleSubmitIntercept(e, input, adapter);
      }
    },
    true,
  );
}

// ── Main observer ───────────────────────────────────────────────────
function startObserver(adapter: SiteAdapter) {
  const root = adapter.observeRoot();

  // Scan existing AI responses already in DOM
  root.querySelectorAll(adapter.responseSelector).forEach((el) => {
    sentResponses.add(el as HTMLElement);
  });

  const observer = new MutationObserver((mutations) => {
    // Re-scan for inputs (they may be lazily added)
    scanInputs(adapter);

    for (const mutation of mutations) {
      // Handle added nodes — new response blocks or new textareas
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // Check if this is a streaming AI response
        const responseEl = adapter.getStreamingResponse(node);
        if (responseEl) {
          onStreamMutation(responseEl, adapter);
        }

        // Also check children for response blocks
        node.querySelectorAll?.(adapter.responseSelector)?.forEach((child) => {
          if (!sentResponses.has(child as HTMLElement)) {
            onStreamMutation(child as HTMLElement, adapter);
          }
        });
      }

      // Handle characterData / subtree text changes inside response blocks
      if (
        mutation.type === "characterData" ||
        mutation.type === "childList"
      ) {
        const target = mutation.target;
        const responseEl = adapter.getStreamingResponse(
          target instanceof HTMLElement
            ? target
            : target.parentElement ?? target,
        );
        if (responseEl && !sentResponses.has(responseEl)) {
          onStreamMutation(responseEl, adapter);
        }
      }
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return observer;
}

// ── Sentiment score listener (background → content) ────────────────
// Receives the local AI sentiment analysis result for the most recent
// AI response block and forwards it to the React panel.
const recentResponseEls: HTMLElement[] = [];

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: SentimentScoredMessage) => {
    if (message.type !== "SENTIMENT_SCORED") return;

    const { label, confidence, textPreview } = message.payload;

    console.log(
      `[Glassbox] Sentiment received: ${label} (${(confidence * 100).toFixed(0)}%)`,
      `\n  text: ${textPreview}…`,
    );

    // Dispatch custom event for the React panel
    document.dispatchEvent(
      new CustomEvent("glassbox:sentiment", {
        bubbles: true,
        detail: message.payload,
      }),
    );

    // Subtle outline on the analyzed response block (blue = analyzed)
    for (const el of recentResponseEls) {
      el.style.outline = "2px solid rgba(99, 102, 241, 0.4)";
      el.style.outlineOffset = "4px";
      el.style.borderRadius = "8px";
      el.dataset.glassboxSentiment = label;
    }
  });
}

// ── Per-item action type (panel → content script via custom event) ─
// The panel dispatches glassbox:action events when the user clicks a
// per-item Redact or Strip button. We resolve the current input via the
// adapter and mutate it in place. The resulting `input` event feeds
// back into onInput which re-scans and updates the panel state.
type GlassboxAction =
  | { kind: "redact-pii"; match: string; label: string }
  | { kind: "strip-chars"; category: SuspiciousCategory };

// ── Init ────────────────────────────────────────────────────────────
const adapter = resolveAdapter();

function handleAction(detail: GlassboxAction) {
  const el = adapter.findInput();
  if (!el) return;
  const text = adapter.getInputText(el);
  let next = text;

  if (detail.kind === "redact-pii") {
    const idx = text.indexOf(detail.match);
    if (idx < 0) return;
    next =
      text.slice(0, idx) +
      `[REDACTED:${detail.label}]` +
      text.slice(idx + detail.match.length);
  } else if (detail.kind === "strip-chars") {
    next = stripCharsByCategory(text, detail.category);
  }

  if (next !== text) {
    adapter.setInputText(el, next);
    console.log(`[Glassbox] per-item action ${detail.kind}: text updated`);
  }
}

document.addEventListener("glassbox:action", (e: Event) => {
  const detail = (e as CustomEvent).detail as GlassboxAction;
  handleAction(detail);
});

// Inject the floating Shadow DOM panel (statically bundled to avoid
// runtime fetches that would be blocked by host page CSPs)
injectPanel();

scanInputs(adapter);
setupSubmitListener(adapter);
startObserver(adapter);

console.log(`[Glassbox] Content script loaded – adapter: ${adapter.name}`);
