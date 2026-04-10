/**
 * Glassbox Demo Recorder
 *
 * Launches a real Chrome instance with the extension loaded, walks through
 * every feature in sequence, and records the entire session as a video.
 *
 * Run with:  npx playwright test tests/demo-recorder.spec.ts --headed
 * Output:    demo.webm in the project root (copied from Playwright's
 *            test-results dir on completion)
 */

import { test, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const EXTENSION_PATH = path.resolve(PROJECT_ROOT, "dist");
const USER_DATA_DIR = "/tmp/glassbox-demo-profile";
const VIDEO_DIR = path.resolve(PROJECT_ROOT, "test-results/demo-video");

let context: BrowserContext;

test.beforeAll(async () => {
  // Rebuild to undo any dev-server stub
  execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });

  // Clean any prior video output
  if (fs.existsSync(VIDEO_DIR)) {
    fs.rmSync(VIDEO_DIR, { recursive: true });
  }
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  // Clean profile dir
  if (fs.existsSync(USER_DATA_DIR)) {
    fs.rmSync(USER_DATA_DIR, { recursive: true });
  }

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 1280, height: 800 },
    },
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
    ],
  });
});

test.afterAll(async () => {
  await context.close();

  // Find the LARGEST recorded video (Playwright produces one webm per page;
  // the initial blank tab gets a tiny file, the actual demo page gets the
  // big one).
  const files = fs
    .readdirSync(VIDEO_DIR)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => ({
      name: f,
      size: fs.statSync(path.join(VIDEO_DIR, f)).size,
    }))
    .sort((a, b) => b.size - a.size);

  if (files.length > 0) {
    const winner = files[0];
    const src = path.join(VIDEO_DIR, winner.name);
    const dst = path.join(PROJECT_ROOT, "demo.webm");
    fs.copyFileSync(src, dst);
    const sizeKB = Math.round(fs.statSync(dst).size / 1024);
    console.log(`\n✅ Demo video saved to ${dst} (${sizeKB} KB)`);
    console.log(`   (chose largest of ${files.length} recordings)\n`);
  } else {
    console.error("❌ No video file found in", VIDEO_DIR);
  }
});

// ──────────────────────────────────────────────────────────────────
// Helpers (scoped to this spec file)
// ──────────────────────────────────────────────────────────────────

async function pasteInto(
  page: import("@playwright/test").Page,
  text: string,
) {
  await page.evaluate((t) => {
    const ta = document.querySelector("#input") as HTMLTextAreaElement;
    ta.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    ta.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
    ta.value = ta.value + t;
    ta.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertFromPaste",
        data: t,
        bubbles: true,
      }),
    );
  }, text);
}

async function clearTextarea(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const ta = document.querySelector("#input") as HTMLTextAreaElement;
    ta.focus();
    ta.select();
  });
  await page.keyboard.press("Backspace");
}

async function clickPanelButton(
  page: import("@playwright/test").Page,
  exactText: string,
) {
  await page.evaluate((label) => {
    const host = document.getElementById("glassbox-panel-host");
    const shadow = host?.shadowRoot;
    if (!shadow) return;
    const buttons = shadow.querySelectorAll("button");
    for (const btn of Array.from(buttons)) {
      if ((btn.textContent ?? "").trim() === label) {
        (btn as HTMLButtonElement).click();
        return;
      }
    }
  }, exactText);
}

test("Glassbox feature walkthrough", async () => {
  test.setTimeout(180_000);
  const page = await context.newPage();

  // ── 1. Popup help screen (3s) ─────────────────────────────────────
  let extensionId: string | undefined;
  for (let i = 0; i < 30; i++) {
    const workers = context.serviceWorkers();
    if (workers.length > 0) {
      const m = workers[0].url().match(/chrome-extension:\/\/([a-z]+)\//);
      if (m) {
        extensionId = m[1];
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (extensionId) {
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await page.waitForTimeout(3500);
  }

  // ── 2. Navigate to test page (1s) ─────────────────────────────────
  await page.goto("http://localhost:8765/tests/manual.html");
  await page.waitForTimeout(1500);

  // Wait for panel host + button
  await page.waitForFunction(
    () => {
      const host = document.getElementById("glassbox-panel-host");
      const shadow = host?.shadowRoot;
      return !!shadow?.querySelector("button");
    },
    { timeout: 5000 },
  );
  await page.waitForTimeout(600);

  // ── 3. Ensure the floating panel is expanded (1s) ─────────────────
  // The panel's initial React state is `collapsed = false` (expanded).
  // We only need to click the circle if we're in the collapsed state.
  await page.evaluate(() => {
    const host = document.getElementById("glassbox-panel-host");
    const shadow = host?.shadowRoot;
    if (!shadow) return;
    // If the shadow root doesn't contain the "GLASSBOX" header, the
    // panel is collapsed to the circle — click to expand.
    if (!(shadow.textContent ?? "").includes("GLASSBOX")) {
      const btn = shadow.querySelector("button") as HTMLButtonElement | null;
      btn?.click();
    }
  });
  await page.waitForTimeout(1500);

  // ── 4. Type normally → Humanity Score stays 100% (4s) ────────────
  const textarea = page.locator("#input");
  await textarea.click();
  await textarea.pressSequentially(
    "Typing normally keeps the score at 100%",
    { delay: 35 },
  );
  await page.waitForTimeout(2000);

  // ── 5. Paste a GitHub PAT → per-item Redact button (6s) ──────────
  await clearTextarea(page);
  await textarea.pressSequentially("My GitHub token is ", { delay: 35 });
  await page.waitForTimeout(400);
  await pasteInto(
    page,
    "ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123",
  );
  await page.waitForTimeout(2500);

  // Click the per-item Redact button (exact text "Redact" in the PII section)
  await clickPanelButton(page, "Redact");
  await page.waitForTimeout(2000);

  // ── 6. Paste an OpenAI key + email → two Redact buttons (6s) ────
  await clearTextarea(page);
  await textarea.pressSequentially("Please email ", { delay: 35 });
  await pasteInto(page, "alice@example.com");
  await page.waitForTimeout(800);
  await textarea.pressSequentially(" with key ", { delay: 35 });
  await pasteInto(page, "sk-proj-abcdefghijklmnopqrstu");
  await page.waitForTimeout(2500);

  // Click first Redact (email, which appears first in PII_PATTERNS order)
  await clickPanelButton(page, "Redact");
  await page.waitForTimeout(1500);
  // Click second Redact (OpenAI key)
  await clickPanelButton(page, "Redact");
  await page.waitForTimeout(2000);

  // ── 7. Paste text with a hidden zero-width char → Strip button (5s)
  await clearTextarea(page);
  // Paste normal text first so there's context
  await textarea.pressSequentially("Invisible text: ", { delay: 35 });
  // Inject zero-width chars via programmatic paste
  await pasteInto(page, "hel\u200Blo\u200Cwor\u200Dld");
  await page.waitForTimeout(2500);

  // Click the Strip button on the Hidden Characters section
  await clickPanelButton(page, "Strip");
  await page.waitForTimeout(2000);

  // ── 8. Switch to Redact mode → auto-cleanup on submit (6s) ──────
  await clearTextarea(page);
  // Click the "redact" mode pill (lowercase text)
  await clickPanelButton(page, "redact");
  await page.waitForTimeout(1200);

  await textarea.pressSequentially("AWS credentials: ", { delay: 35 });
  await pasteInto(page, "AKIAIOSFODNN7EXAMPLE");
  await page.waitForTimeout(1500);

  // Press Enter — should auto-redact
  await textarea.press("Enter");
  await page.waitForTimeout(2500);

  // ── 9. Switch to Block mode → submission prevented (6s) ─────────
  await clearTextarea(page);
  await clickPanelButton(page, "block");
  await page.waitForTimeout(1200);

  await textarea.pressSequentially("Stripe key: ", { delay: 35 });
  await pasteInto(page, "pk_test_abcdefghijklmnopqrstuvwx");
  await page.waitForTimeout(1500);

  // Press Enter — should be blocked, BLOCKED banner flashes
  await textarea.press("Enter");
  await page.waitForTimeout(3000);

  // ── 10. Restore Warn mode and final pause (2s) ─────────────────
  await clickPanelButton(page, "warn");
  await page.waitForTimeout(2000);
});
