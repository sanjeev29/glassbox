# Glassbox

> Your local AI bodyguard. A Chrome extension that watches every textarea on the web for sensitive data, tracks how much of your writing is actually yours, and runs a real local AI model on every chatbot response — all without sending a single byte to a server.

**100% local. No API keys. No telemetry. Inference runs on your GPU via WebGPU.**

## Demo

https://github.com/user-attachments/assets/645e5231-9cc6-40e1-8274-89a81bfdf6b2

The demo video walks through every feature:

1. **Popup help screen** — click the toolbar icon to see the four feature cards
2. **Floating Shadow DOM panel** expands bottom-right, showing the Humanity Score and the **Warn / Redact / Block** mode selector
3. **Typing normally** keeps the Humanity Score at 100%
4. **Paste a GitHub personal access token** → red "PII DETECTED" card with an inline **Redact** button → click it → the textarea updates to `[REDACTED:github-pat]` in place
5. **Paste an email and an OpenAI key together** → two separate PII entries, each with its own Redact button → click each one to clean up
6. **Paste text containing invisible zero-width characters** → orange "HIDDEN CHARACTERS" card with a **Strip** button → click to remove them
7. **Switch mode to Redact** → paste an AWS key → press Enter → the key is auto-redacted before submission, then the background service worker acknowledges the send
8. **Switch mode to Block** → paste a Stripe key → press Enter → submission is blocked entirely and a red **🚫 SUBMISSION BLOCKED** banner flashes in the panel

## What it does

Glassbox is a Manifest V3 Chrome extension built with React, TypeScript, Vite, and Transformers.js. It runs five distinct features in concert:

| # | Feature | What it actually does |
|---|---|---|
| 1 | **PII Scrubber** | Real-time regex detection of emails, phone numbers, AWS access keys, and Stripe API keys in any textarea on any website. Warns you before you paste a credential into ChatGPT by mistake. |
| 2 | **Humanity Score** | Tracks the ratio of typed vs. pasted characters. 100% means you typed every character yourself. The number drops as you paste content in. A `WeakMap` keeps independent state per textarea. |
| 3 | **Floating Shadow DOM Panel** | A React UI injected into every page through a closed Shadow DOM, so the host page's CSS can't touch it. Collapses to a small circle in the bottom-right; click to expand. |
| 4 | **Local AI Response Analyzer** | When ChatGPT or Claude finishes streaming a response, the extension extracts the text from the DOM and runs a quantized DistilBERT sentiment classifier **on your device** via WebGPU (with WASM fallback). The result lands back in the floating panel within ~50ms. The model is downloaded once from HuggingFace and cached. |
| 5 | **Multi-Site Adapters** | Purpose-built CSS selector adapters for `chatgpt.com` and `claude.ai` know where the input field and the AI response blocks live, so the streaming-response observer Just Works on those sites. Falls back to a generic `<textarea>` adapter on every other site. |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Web page (any site)                          │
│                                                                  │
│  ┌─────────────┐         ┌────────────────────────────────────┐  │
│  │  textarea   │◄────────┤ content.ts (vanilla TS)            │  │
│  │  (input)    │         │  - input/paste/keydown listeners   │  │
│  └─────────────┘         │  - PII regex scanner               │  │
│                          │  - Humanity Score tracker          │  │
│  ┌─────────────┐         │  - MutationObserver (AI responses) │  │
│  │  AI msg     │◄────────┤  - Site adapter resolver           │  │
│  │  block      │         └────────────┬───────────────────────┘  │
│  └─────────────┘                      │                          │
│                                       │ injects                  │
│  ┌────────────────────────────────────▼───────────────────────┐  │
│  │  Shadow DOM (closed)                                       │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  React App: GlassboxPanel.tsx                        │  │  │
│  │  │   - listens to glassbox:update / glassbox:sentiment  │  │  │
│  │  │   - displays Humanity Score, PII warnings, AI result │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────┬───────────────────┘
                                               │
                                  chrome.runtime.sendMessage
                                  chrome.tabs.sendMessage
                                               │
┌──────────────────────────────────────────────▼───────────────────┐
│        Service Worker (background.ts) — extension origin         │
│                                                                  │
│   onMessage: TEXT_SUBMITTED       → log + ack                    │
│   onMessage: AI_RESPONSE_COMPLETE → analyzeSentiment(text)       │
│                                     ↓                            │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │  inference.ts (Transformers.js)                          │   │
│   │   pipeline("text-classification",                        │   │
│   │     "Xenova/distilbert-base-uncased-finetuned-sst-2",    │   │
│   │     { device: "webgpu", dtype: "q4" }) ── falls back ──► │   │
│   │     wasm + q8 if WebGPU unavailable                      │   │
│   └──────────────────────────────────────────────────────────┘   │
│                                     ↓                            │
│   sendMessage(SENTIMENT_SCORED) ──► back to content script       │
└──────────────────────────────────────────────────────────────────┘
```

### File map

```
src/
  manifest.json           MV3 manifest. Permissions: activeTab, scripting, storage.
                          Declares content_scripts (<all_urls>), background SW,
                          and a CSP that allows wasm-unsafe-eval + HF CDN.

  content.ts              Runs on every page. Tracks input, observes streaming
                          AI responses, manages site adapter selection, listens
                          for SENTIMENT_SCORED replies from background.

  adapters.ts             Site-specific CSS selector adapters. Three of them:
                          - chatgpt: #prompt-textarea + [data-message-author-role="assistant"]
                          - claude: ProseMirror contenteditable + .font-claude-message
                          - generic: <textarea> fallback

  background.ts           MV3 service worker. Receives messages, runs sentiment
                          analysis on AI responses, sends results back via
                          chrome.tabs.sendMessage.

  inference.ts            Transformers.js pipeline singleton. Lazy-loads the
                          DistilBERT model on first call. Tries WebGPU/q4 first,
                          falls back to WASM/q8 on failure.

  panel/inject.tsx        Creates the Shadow DOM host element, attaches an open
                          shadow root with a CSS reset, and mounts the React root.

  panel/GlassboxPanel.tsx The React UI. Listens to glassbox:update and
                          glassbox:sentiment custom events. Renders the
                          collapsible floating panel.

  App.tsx, App.css        The popup help screen (what you see when you click the
                          extension toolbar icon). Dark themed, four feature cards.

  types/messages.ts       Shared TypeScript message contract between content
                          script and service worker.

tests/
  content.spec.ts         Playwright unit tests for PII detection logic.
  extension.spec.ts       Playwright end-to-end tests against the real loaded
                          extension in a Chrome instance.
  fixture.html            Test page used by content.spec.ts.
  manual.html             Manual testing page for development.
```

## Install & run

### Prerequisites
- Node.js 22+
- A Chromium-based browser (Chrome 113+ recommended for WebGPU)

### Build the extension
```bash
git clone <this repo>
cd glassbox
npm install
npm run build
```

The production extension is now at `dist/`.

### Load it into Chrome
1. Open `chrome://extensions`
2. Toggle **Developer mode** ON (top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder

The Glassbox icon appears in your toolbar. Click it to see the help popup.

### Try it
- Visit any site with a textarea (e.g. `https://gist.github.com/`)
- Look for the floating circle in the bottom-right corner
- Click the circle to expand the panel
- Type something → 100% Humanity Score
- Paste an email like `test@example.com` → red PII warning
- Open `chatgpt.com`, send a prompt → after the response streams, watch the panel show "LOCAL AI ANALYSIS · POSITIVE 87%"

The first time the AI analyzer runs, the model (~50MB) downloads from HuggingFace and caches in your browser. Subsequent runs are local-only.

## Development

```bash
npm run dev      # Vite dev server
npm run build    # Production build to dist/
npm run lint     # ESLint
npm test         # Run Playwright tests (unit + extension E2E)
```

After any code change while developing:
1. `npm run build`
2. Go to `chrome://extensions` → click the reload (↻) icon on the Glassbox card
3. Refresh tabs where the content script is running

## Tests

Two Playwright suites, both passing:

| Suite | What it tests |
|---|---|
| `tests/content.spec.ts` | 5 unit tests of PII regex, Humanity Score calculation, and the custom event dispatch |
| `tests/extension.spec.ts` | 5 end-to-end tests against the real loaded extension in a Chrome instance launched by Playwright. Verifies content script injection, Shadow DOM rendering, message passing to background, and popup HTML rendering. |

```bash
npx playwright test
```

## Tech stack

- **Manifest V3 Chrome Extension** with `@crxjs/vite-plugin`
- **React 19** + **TypeScript** for the popup help screen and the in-page panel
- **Vite 8** for bundling
- **Vanilla TypeScript** for the content script (no React in the page-context entry)
- **Shadow DOM** for CSS isolation of the in-page panel
- **`@huggingface/transformers`** (the maintained successor to `@xenova/transformers`) for on-device inference
- **DistilBERT SST-2 sentiment model**, q4 quantized, ~50MB
- **WebGPU device backend** with WASM fallback
- **`chrome.runtime.sendMessage` + `chrome.tabs.sendMessage`** for the bidirectional message bus
- **`MutationObserver`** for streaming AI response capture
- **Playwright** for unit and end-to-end testing

## Why "Glassbox"?

Black-box AI is opaque. Glassbox makes it transparent — you can see what's going in (PII warnings), see how much of it is actually you (Humanity Score), and see what's coming back (local AI analysis on the response). All while running 100% on your machine.

## Privacy

- No network requests except: (1) the one-time model download from HuggingFace's CDN, (2) acknowledgement messages between content script and the local service worker.
- No analytics, no telemetry, no tracking.
- Inference runs in your browser's process. Your text never leaves your device.
- The PII scrubber runs synchronously on every keystroke — it never sends your text anywhere.

## License

MIT
