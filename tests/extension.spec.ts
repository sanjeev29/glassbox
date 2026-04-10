import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "../dist");
const USER_DATA_DIR = "/tmp/glassbox-pw-profile";

let context: BrowserContext;

test.beforeAll(async () => {
  // Rebuild after the dev server starts — the crxjs plugin's dev mode
  // writes a stub to dist/index.html that breaks the popup. Re-running
  // the production build restores the real popup HTML before Chrome
  // loads the extension.
  execSync("npm run build", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });

  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, // extensions only run in headed mode
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
});

test.afterAll(async () => {
  await context.close();
});

test.describe("Glassbox extension (real Chrome)", () => {
  test("extension loads and content script injects panel host", async () => {
    const page = await context.newPage();
    await page.goto("http://localhost:5174/tests/fixture.html");

    // Wait for the Shadow DOM panel host to appear
    const panelHost = page.locator("#glassbox-panel-host");
    await expect(panelHost).toBeAttached({ timeout: 5000 });

    // Verify the panel is fixed-positioned bottom-right
    const style = await panelHost.getAttribute("style");
    expect(style?.replace(/\s+/g, "")).toContain("position:fixed");
    expect(style).toContain("bottom");
    expect(style).toContain("right");

    await page.close();
  });

  test("typing in textarea updates humanity score in panel", async () => {
    const page = await context.newPage();
    await page.goto("http://localhost:5174/tests/fixture.html");

    // Wait for panel to be injected
    await page.waitForSelector("#glassbox-panel-host");
    await page.waitForTimeout(300);

    // Type in the textarea
    const textarea = page.locator("#input");
    await textarea.click();
    await textarea.pressSequentially("hello world this is human typing");

    // The fixture page mirrors glassbox events to data attributes
    const results = page.locator("#results");
    await expect(results).toHaveAttribute("data-humanity-score", "1");
    await expect(results).toHaveAttribute("data-pii-count", "0");

    // Read the score from the Shadow DOM panel
    const panelScore = await page.evaluate(() => {
      const host = document.getElementById("glassbox-panel-host");
      const shadow = host?.shadowRoot;
      // Find the percentage display in the panel
      const text = shadow?.textContent ?? "";
      const match = text.match(/(\d+)%/);
      return match ? Number(match[1]) : null;
    });
    expect(panelScore).toBe(100);

    await page.close();
  });

  test("pasting an email triggers PII warning in Shadow DOM panel", async () => {
    const page = await context.newPage();
    await page.goto("http://localhost:5174/tests/fixture.html");

    await page.waitForSelector("#glassbox-panel-host");
    await page.waitForTimeout(300);

    // Simulate paste of an email
    await page.evaluate(() => {
      const ta = document.querySelector("#input") as HTMLTextAreaElement;
      const pasteText = "contact me at alice@example.com";
      const dt = new DataTransfer();
      dt.setData("text/plain", pasteText);
      ta.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
      ta.value = pasteText;
      ta.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertFromPaste",
          data: pasteText,
          bubbles: true,
        }),
      );
    });

    // Verify the fixture page sees the PII
    const results = page.locator("#results");
    await expect(results).toHaveAttribute("data-pii-count", "1");
    await expect(results).toHaveAttribute("data-pii-labels", "email");

    // Verify the Shadow DOM panel shows the PII warning
    const piiWarningVisible = await page.evaluate(() => {
      const host = document.getElementById("glassbox-panel-host");
      const shadow = host?.shadowRoot;
      const text = shadow?.textContent ?? "";
      return text.includes("PII DETECTED");
    });
    expect(piiWarningVisible).toBe(true);

    await page.close();
  });

  test("clicking submit button sends TEXT_SUBMITTED to background", async () => {
    const page = await context.newPage();

    // Capture console logs to detect the background acknowledgement
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("http://localhost:5174/tests/fixture.html");
    await page.waitForSelector("#glassbox-panel-host");
    await page.waitForTimeout(300);

    const textarea = page.locator("#input");
    await textarea.click();
    await textarea.pressSequentially("test submission");

    // Click the submit button
    await page.click("#submit");

    // Wait for the background ack log
    await page.waitForTimeout(1000);

    const ackLog = logs.find((l) =>
      l.includes("Background acknowledged (TEXT_SUBMITTED)"),
    );
    expect(ackLog).toBeDefined();

    await page.close();
  });

  test("popup help screen renders", async () => {
    // Find the extension's popup HTML
    // First we need the extension ID — get it from the service worker
    let extensionId: string | undefined;

    // Wait for the service worker to register
    for (let i = 0; i < 20; i++) {
      const workers = context.serviceWorkers();
      if (workers.length > 0) {
        const url = workers[0].url();
        const match = url.match(/chrome-extension:\/\/([a-z]+)\//);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(extensionId).toBeDefined();

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/index.html`, {
      waitUntil: "domcontentloaded",
    });

    // Verify the help content rendered
    await expect(popupPage.locator("h1")).toHaveText("Glassbox", {
      timeout: 10000,
    });
    await expect(popupPage.locator("text=Humanity Score")).toBeVisible();
    await expect(popupPage.locator("text=PII Scrubber")).toBeVisible();
    await expect(popupPage.locator("text=Local AI Response Analyzer")).toBeVisible();
    await expect(popupPage.locator("text=Site Support")).toBeVisible();
    await expect(popupPage.locator("text=100% local")).toBeVisible();

    await popupPage.close();
  });

  // Helper: set the redact mode via the service worker, where
  // chrome.storage.local is directly accessible.
  async function setMode(mode: "warn" | "redact" | "block") {
    const workers = context.serviceWorkers();
    if (workers.length === 0) throw new Error("no service worker");
    await workers[0].evaluate(async (m: string) => {
      await chrome.storage.local.set({ "glassbox.redactMode": m });
    }, mode);
    // Give content scripts a beat to receive the storage.onChanged event
    await new Promise((r) => setTimeout(r, 300));
  }

  // Helper: click a button inside the Shadow DOM panel by its exact text
  // (case-sensitive — "Redact" (PII button) and "redact" (mode pill) must
  // not collide).
  async function clickPanelButton(
    page: import("@playwright/test").Page,
    text: string,
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
    }, text);
  }

  // Helper: count matching buttons inside the Shadow DOM panel (case-sensitive).
  async function countPanelButtons(
    page: import("@playwright/test").Page,
    text: string,
  ) {
    return page.evaluate((label) => {
      const host = document.getElementById("glassbox-panel-host");
      const shadow = host?.shadowRoot;
      if (!shadow) return 0;
      return Array.from(shadow.querySelectorAll("button")).filter(
        (b) => (b.textContent ?? "").trim() === label,
      ).length;
    }, text);
  }

  // Helper: paste text into the fixture textarea (simulates clipboard paste).
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

  test("per-item Redact button cleans one PII match at a time", async () => {
    await setMode("warn");
    const page = await context.newPage();
    await page.goto("http://localhost:5174/tests/fixture.html");
    await page.waitForSelector("#glassbox-panel-host");
    await page.waitForTimeout(300);

    // Expand the panel
    await clickPanelButton(page, "100");
    await page.waitForTimeout(200);

    // Paste two emails
    await pasteInto(page, "contact alice@example.com and bob@example.com");
    await page.waitForTimeout(300);

    // Verify two Redact buttons appear
    expect(await countPanelButtons(page, "Redact")).toBe(2);

    // Click the first Redact button
    await clickPanelButton(page, "Redact");
    await page.waitForTimeout(300);

    // Textarea should now have the first email redacted
    let textareaValue = await page.locator("#input").inputValue();
    expect(textareaValue).toBe(
      "contact [REDACTED:email] and bob@example.com",
    );

    // Only one Redact button should remain
    expect(await countPanelButtons(page, "Redact")).toBe(1);

    // Click the second Redact button
    await clickPanelButton(page, "Redact");
    await page.waitForTimeout(300);

    textareaValue = await page.locator("#input").inputValue();
    expect(textareaValue).toBe(
      "contact [REDACTED:email] and [REDACTED:email]",
    );

    // Zero Redact buttons left
    expect(await countPanelButtons(page, "Redact")).toBe(0);

    await page.close();
  });

  test("Redact mode auto-cleans remaining PII on submit (Enter)", async () => {
    await setMode("redact");
    const page = await context.newPage();

    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("http://localhost:5174/tests/fixture.html");
    await page.waitForSelector("#glassbox-panel-host");
    await page.waitForTimeout(300);

    // Paste an AWS key (no manual redact)
    await pasteInto(page, "my key is AKIAIOSFODNN7EXAMPLE");
    await page.waitForTimeout(300);

    // Press Enter (our capture-phase keydown handler will redact).
    // On a plain textarea with no form, the Enter key's default action
    // inserts a newline — we trim it off for the comparison.
    await page.locator("#input").press("Enter");
    await page.waitForTimeout(600);

    const textareaValue = (
      await page.locator("#input").inputValue()
    ).replace(/\n$/, "");
    expect(textareaValue).toBe("my key is [REDACTED:aws-key]");

    // The TEXT_SUBMITTED ack should appear in the logs
    const ack = logs.find((l) =>
      l.includes("Background acknowledged (TEXT_SUBMITTED)"),
    );
    expect(ack).toBeDefined();

    // Restore default for subsequent tests
    await setMode("warn");
    await page.close();
  });

  test("Block mode prevents submission when PII remains", async () => {
    await setMode("block");
    const page = await context.newPage();

    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    await page.goto("http://localhost:5174/tests/fixture.html");
    await page.waitForSelector("#glassbox-panel-host");
    await page.waitForTimeout(300);

    // Paste a Stripe key
    await pasteInto(page, "pk_test_abcdefghijklmnopqrstuvwx");
    await page.waitForTimeout(300);

    // Press Enter — should be blocked
    await page.locator("#input").press("Enter");
    await page.waitForTimeout(600);

    // Textarea should be unchanged
    const textareaValue = await page.locator("#input").inputValue();
    expect(textareaValue).toBe("pk_test_abcdefghijklmnopqrstuvwx");

    // No TEXT_SUBMITTED ack should have been logged
    const ack = logs.find((l) =>
      l.includes("Background acknowledged (TEXT_SUBMITTED)"),
    );
    expect(ack).toBeUndefined();

    // The blocked warning should have fired
    const blockedWarning = logs.find((l) =>
      l.includes("Submission blocked"),
    );
    expect(blockedWarning).toBeDefined();

    // Restore default
    await setMode("warn");
    await page.close();
  });
});
