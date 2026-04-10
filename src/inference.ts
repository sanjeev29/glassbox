/**
 * Glassbox Inference Module
 *
 * Initializes a Transformers.js pipeline inside the service worker context.
 * Configured to prefer WebGPU, falling back to WASM if unavailable.
 * Uses a tiny quantized model suitable for browser memory.
 */

import {
  pipeline,
  env,
  type TextClassificationPipeline,
  type TextClassificationOutput,
} from "@huggingface/transformers";

// ── Environment config ──────────────────────────────────────────────
// Disable local model caching (service workers can't use IndexedDB reliably)
env.allowLocalModels = false;
// Models will be fetched from HuggingFace Hub CDN
env.useBrowserCache = true;

// ── Pipeline singleton ──────────────────────────────────────────────
let classifierPromise: Promise<TextClassificationPipeline> | null = null;

function getClassifier(): Promise<TextClassificationPipeline> {
  if (!classifierPromise) {
    classifierPromise = pipeline(
      "text-classification",
      "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
      {
        device: "webgpu",
        dtype: "q4",
      },
    ).catch((err) => {
      console.warn(
        "[Glassbox] WebGPU not available, falling back to WASM:",
        err.message,
      );
      // Retry with WASM backend
      return pipeline(
        "text-classification",
        "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
        {
          device: "wasm" as "cpu",
          dtype: "q8",
        },
      );
    }) as Promise<TextClassificationPipeline>;
  }
  return classifierPromise;
}

// ── Public inference API ────────────────────────────────────────────
export interface InferenceResult {
  label: string;
  score: number;
  modelId: string;
  latencyMs: number;
}

export async function runInference(text: string): Promise<InferenceResult> {
  const start = performance.now();

  // Truncate to 512 chars to stay within model token limits
  const input = text.slice(0, 512);

  const classifier = await getClassifier();
  const output = (await classifier(input)) as TextClassificationOutput;

  const top = Array.isArray(output) ? output[0] : output;

  return {
    label: top.label,
    score: top.score,
    modelId: "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    latencyMs: Math.round(performance.now() - start),
  };
}

// ── AI Response Sentiment Analysis ──────────────────────────────────
// Runs the classifier over an AI-generated response and returns the
// dominant sentiment (POSITIVE / NEGATIVE) with the model's confidence.
// This is a thin alias over runInference, semantically scoped to "AI
// response analysis" rather than "user input analysis".

export interface SentimentResult {
  /** "POSITIVE" or "NEGATIVE" */
  label: string;
  /** Model confidence in the top label, 0-1 */
  confidence: number;
  modelId: string;
  latencyMs: number;
}

export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  const result = await runInference(text);
  return {
    label: result.label,
    confidence: result.score,
    modelId: result.modelId,
    latencyMs: result.latencyMs,
  };
}
