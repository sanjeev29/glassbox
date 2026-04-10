/**
 * Site-specific DOM adapters for ChatGPT and Claude.ai.
 *
 * Each adapter knows how to find:
 *   - the user's input element (textarea or contenteditable)
 *   - AI response blocks already in the DOM
 *   - the container to observe for new/streaming AI responses
 *
 * Selectors are layered from most-specific (data attributes, ARIA roles)
 * to structural fallbacks so they survive minor UI reshuffles.
 */

export interface SiteAdapter {
  /** Human-readable name for logging */
  name: string;
  /** Returns true if this adapter handles the current page */
  match: () => boolean;
  /** Find the user's input element */
  findInput: () => HTMLElement | null;
  /** Return text from the input element (handles contenteditable + textarea) */
  getInputText: (el: HTMLElement) => string;
  /**
   * Replace the full text content of the input element. Must fire
   * appropriate events so framework-managed inputs (React, ProseMirror)
   * sync their internal state.
   */
  setInputText: (el: HTMLElement, text: string) => void;
  /** Selectors for completed AI response blocks */
  responseSelector: string;
  /**
   * Given a DOM node that was just added/mutated, return the response
   * container element if this node is part of a streaming AI response,
   * or null otherwise.
   */
  getStreamingResponse: (node: Node) => HTMLElement | null;
  /** The root element to observe for mutations (defaults to document.body) */
  observeRoot: () => HTMLElement;
}

/**
 * Shared implementation of setInputText. Handles both plain `<textarea>`
 * (via the React-compatible native setter trick) and contenteditable
 * elements (via execCommand which ProseMirror handles through its own
 * DOMObserver).
 */
function writeInputText(el: HTMLElement, text: string): void {
  if (el instanceof HTMLTextAreaElement) {
    // React monkey-patches .value on the instance to track controlled
    // inputs. Bypass by calling the prototype setter directly, which
    // still updates React's internal _valueTracker so the subsequent
    // input event triggers a re-render.
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    );
    const setter = descriptor?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (el instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    const setter = descriptor?.set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // Contenteditable path — ChatGPT and Claude both use ProseMirror here.
  // execCommand("insertText") works because ProseMirror's DOMObserver
  // treats the resulting beforeinput/input as a normal edit transaction.
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand("insertText", false, text);
}

// ── ChatGPT (chatgpt.com) ───────────────────────────────────────────
const chatgpt: SiteAdapter = {
  name: "ChatGPT",
  match: () =>
    location.hostname === "chatgpt.com" ||
    location.hostname === "chat.openai.com",

  findInput: () =>
    // Primary: the ProseMirror contenteditable used since late 2024
    document.querySelector<HTMLElement>(
      '#prompt-textarea, [id="prompt-textarea"]',
    ) ??
    // Fallback: contenteditable div inside the composer
    document.querySelector<HTMLElement>(
      'form textarea, form [contenteditable="true"]',
    ),

  getInputText: (el) => {
    if (el instanceof HTMLTextAreaElement) return el.value;
    // ProseMirror contenteditable — innerText preserves line breaks
    return el.innerText ?? "";
  },

  setInputText: writeInputText,

  // ChatGPT wraps each assistant turn in a [data-message-author-role="assistant"]
  // container. The markdown is rendered inside a .markdown element within it.
  responseSelector: [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .prose',
    // Structural fallback: assistant message groups
    ".agent-turn .markdown",
    // Older DOM shape
    ".group\\/conversation-turn .markdown",
  ].join(", "),

  getStreamingResponse: (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const container =
      node.closest<HTMLElement>('[data-message-author-role="assistant"]') ??
      node.querySelector<HTMLElement>('[data-message-author-role="assistant"]');
    if (container) {
      return (
        container.querySelector<HTMLElement>(".markdown, .prose") ??
        (container as HTMLElement)
      );
    }
    if (
      node.closest?.(".markdown") &&
      node.closest?.('[data-message-author-role="assistant"]')
    ) {
      return node.closest<HTMLElement>(".markdown");
    }
    return null;
  },

  observeRoot: () =>
    document.querySelector<HTMLElement>("main") ?? document.body,
};

// ── Claude.ai ───────────────────────────────────────────────────────
const claude: SiteAdapter = {
  name: "Claude",
  match: () => location.hostname === "claude.ai",

  findInput: () =>
    // Claude uses a contenteditable div with a specific aria / data attribute
    document.querySelector<HTMLElement>(
      '[contenteditable="true"].ProseMirror',
    ) ??
    document.querySelector<HTMLElement>(
      'fieldset [contenteditable="true"]',
    ) ??
    document.querySelector<HTMLElement>(
      '[aria-label="Write your prompt to Claude"] [contenteditable="true"]',
    ) ??
    // Fallback: any contenteditable in the composer area
    document.querySelector<HTMLElement>(
      'form [contenteditable="true"], [role="textbox"]',
    ),

  getInputText: (el) => el.innerText ?? "",

  setInputText: writeInputText,

  // Claude renders assistant messages inside containers with data-is-streaming
  // or specific grid/flex layouts. The actual text lives in rendered markdown.
  responseSelector: [
    // Response content wrapper with specific data attributes
    '[data-is-streaming] .font-claude-message',
    '[data-is-streaming="false"] .font-claude-message',
    // Structural: the assistant message grid rows
    ".font-claude-message",
    // Fallback: markdown rendered inside response blocks
    '[class*="response"] .prose',
    '[class*="response"] .markdown',
  ].join(", "),

  getStreamingResponse: (node) => {
    if (!(node instanceof HTMLElement)) return null;
    // Look for the streaming container ancestor
    const streamingContainer =
      node.closest?.("[data-is-streaming]") ??
      node.querySelector?.("[data-is-streaming]");
    if (streamingContainer) {
      return (
        streamingContainer.querySelector<HTMLElement>(".font-claude-message") ??
        (streamingContainer as HTMLElement)
      );
    }
    // Also detect text mutations inside an existing response block
    if (node.closest?.(".font-claude-message")) {
      return node.closest<HTMLElement>(".font-claude-message");
    }
    return null;
  },

  observeRoot: () =>
    document.querySelector<HTMLElement>('[role="main"], main') ?? document.body,
};

// ── Generic fallback ────────────────────────────────────────────────
const generic: SiteAdapter = {
  name: "Generic",
  match: () => true,

  findInput: () => document.querySelector<HTMLTextAreaElement>("textarea"),

  getInputText: (el) => {
    if (el instanceof HTMLTextAreaElement) return el.value;
    return el.innerText ?? "";
  },

  setInputText: writeInputText,

  responseSelector: "textarea",

  getStreamingResponse: () => null,

  observeRoot: () => document.body,
};

// ── Adapter resolution ──────────────────────────────────────────────
const ADAPTERS: SiteAdapter[] = [chatgpt, claude, generic];

export function resolveAdapter(): SiteAdapter {
  for (const adapter of ADAPTERS) {
    if (adapter.match()) return adapter;
  }
  return generic;
}
