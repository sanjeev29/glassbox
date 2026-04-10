# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Glassbox** is a Manifest V3 Chrome Extension that performs all AI inference locally in the browser. It uses React and TypeScript for UI (popup and Shadow DOM injected components), with `@xenova/transformers` configured for the WebGPU backend.

## Architecture

- **Manifest V3 Chrome Extension** — service worker background script, popup UI, content scripts
- **Local-only inference** — no external AI APIs; all models run via `@xenova/transformers` with WebGPU backend
- **Models** — target lightweight quantized models suitable for browser memory (e.g., quantized Gemma 4)
- **Web Workers** — all Transformers.js pipeline logic runs in a Web Worker to avoid blocking the main UI thread
- **Content scripts** — vanilla TypeScript injected via `content_scripts` for DOM manipulation features (PII Scrubber, Humanity Score)
- **Shadow DOM** — injected UI components are isolated via Shadow DOM to avoid style conflicts with host pages

## Key Constraints

1. Never add external API calls for inference — everything must run locally
2. Keep model sizes small enough for browser memory
3. Heavy computation (model inference) must always be offloaded to Web Workers
4. Content script DOM manipulation should use vanilla TS, not React
