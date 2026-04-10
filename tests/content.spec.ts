import { test, expect } from "@playwright/test";

test.describe("Glassbox Content Script", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
    await page.waitForSelector("#input");
  });

  test("pasting an email triggers PII detection and lowers Humanity Score", async ({
    page,
  }) => {
    const textarea = page.locator("#input");
    const results = page.locator("#results");

    // Type a few characters first so we have a baseline
    await textarea.click();
    await textarea.pressSequentially("hello ");

    // Wait for glassbox:update to fire
    await expect(results).toHaveAttribute("data-humanity-score", "1");
    await expect(results).toHaveAttribute("data-pii-count", "0");

    // Now paste an email address via clipboard
    await page.evaluate(() => {
      const ta = document.querySelector("#input") as HTMLTextAreaElement;
      const pasteText = "test@example.com";
      // Simulate a paste event with clipboard data
      const dt = new DataTransfer();
      dt.setData("text/plain", pasteText);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      ta.dispatchEvent(pasteEvent);

      // Manually insert the pasted text (browsers do this natively, but
      // in headless mode we need to simulate the full cycle)
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      ta.value =
        ta.value.slice(0, start) + pasteText + ta.value.slice(end);

      // Fire the input event that normally follows a paste
      ta.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertFromPaste",
          data: pasteText,
          bubbles: true,
        }),
      );
    });

    // Verify PII was detected
    await expect(results).toHaveAttribute("data-pii-count", "1");
    await expect(results).toHaveAttribute("data-pii-labels", "email");

    // Verify Humanity Score dropped below 1
    const score = await results.getAttribute("data-humanity-score");
    expect(Number(score)).toBeLessThan(1);
    expect(Number(score)).toBeGreaterThan(0);
  });

  test("typing only keeps Humanity Score at 1.0", async ({ page }) => {
    const textarea = page.locator("#input");
    const results = page.locator("#results");

    await textarea.click();
    await textarea.pressSequentially("just typing normally");

    await expect(results).toHaveAttribute("data-humanity-score", "1");
    await expect(results).toHaveAttribute("data-pii-count", "0");
  });

  test("detects phone numbers as PII", async ({ page }) => {
    const textarea = page.locator("#input");
    const results = page.locator("#results");

    await textarea.click();
    await textarea.pressSequentially("call me at 555-123-4567");

    await expect(results).toHaveAttribute("data-pii-count", "1");
    await expect(results).toHaveAttribute("data-pii-labels", "phone");
  });

  test("detects AWS keys as PII", async ({ page }) => {
    const textarea = page.locator("#input");
    const results = page.locator("#results");

    await textarea.click();
    await textarea.pressSequentially("key: AKIAIOSFODNN7EXAMPLE");

    await expect(results).toHaveAttribute("data-pii-count", "1");
    await expect(results).toHaveAttribute("data-pii-labels", "aws-key");
  });

  test("detects Stripe keys as PII", async ({ page }) => {
    const textarea = page.locator("#input");
    const results = page.locator("#results");

    await textarea.click();
    // Stripe publishable test-key format — matches our (sk|pk)_(test|live) regex.
    await textarea.pressSequentially("pk_test_abcdefghijklmnopqrstuvwx");

    await expect(results).toHaveAttribute("data-pii-count", "1");
    await expect(results).toHaveAttribute("data-pii-labels", "stripe-key");
  });
});

// ── Extended secret scanner tests ────────────────────────────────────
test.describe("Extended secret scanner", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
    await page.waitForFunction(() => (window as any).__glassbox);
  });

  type DetectResult = Array<{ label: string; match: string }>;

  const detect = (page: import("@playwright/test").Page, text: string) =>
    page.evaluate(
      (t) => (window as any).__glassbox.detectPII(t) as DetectResult,
      text,
    );

  test("detects GitHub PAT (ghp_)", async ({ page }) => {
    const out = await detect(
      page,
      "token: ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123",
    );
    expect(out.some((m) => m.label === "github-pat")).toBe(true);
  });

  test("detects OpenAI key (sk-proj-)", async ({ page }) => {
    const out = await detect(
      page,
      "key sk-proj-abcdefghijklmnopqrstu in env",
    );
    expect(out.some((m) => m.label === "openai-key")).toBe(true);
  });

  test("detects Anthropic key (sk-ant-) without colliding with openai", async ({
    page,
  }) => {
    const out = await detect(
      page,
      "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz here",
    );
    const labels = out.map((m) => m.label);
    expect(labels).toContain("anthropic-key");
    expect(labels).not.toContain("openai-key");
  });

  test("detects JWT", async ({ page }) => {
    const out = await detect(
      page,
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c done",
    );
    expect(out.some((m) => m.label === "jwt")).toBe(true);
  });

  test("detects PEM private key header", async ({ page }) => {
    const out = await detect(
      page,
      "here is the key\n-----BEGIN RSA PRIVATE KEY-----\nstuff",
    );
    expect(out.some((m) => m.label === "private-key")).toBe(true);
  });

  test("detects database URL with credentials", async ({ page }) => {
    const out = await detect(
      page,
      "connect to postgres://user:secretpass@db.example.com:5432/app",
    );
    expect(out.some((m) => m.label === "db-url")).toBe(true);
  });

  test("detects Google API key (AIza...)", async ({ page }) => {
    const out = await detect(
      page,
      "key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
    expect(out.some((m) => m.label === "google-api-key")).toBe(true);
  });

  test("detects Slack token", async ({ page }) => {
    const out = await detect(
      page,
      "token xoxb-1234567890-abcdefghij in config",
    );
    expect(out.some((m) => m.label === "slack-token")).toBe(true);
  });
});

// ── Hidden character detector tests ──────────────────────────────────
test.describe("Hidden character detector", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
    await page.waitForFunction(() => (window as any).__glassbox);
  });

  type SuspResult = Array<{
    category: string;
    codepoint: string;
    index: number;
  }>;

  const detect = (page: import("@playwright/test").Page, text: string) =>
    page.evaluate(
      (t) =>
        (window as any).__glassbox.detectSuspiciousChars(t) as SuspResult,
      text,
    );

  test("detects zero-width space", async ({ page }) => {
    const out = await detect(page, "hello\u200Bworld");
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("zero-width");
    expect(out[0].codepoint).toBe("U+200B");
  });

  test("detects zero-width joiner and BOM", async ({ page }) => {
    const out = await detect(page, "a\u200Db\uFEFFc");
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.category)).toEqual(["zero-width", "zero-width"]);
  });

  test("detects bidi override (RLO)", async ({ page }) => {
    const out = await detect(page, "text\u202EREVERSED");
    expect(out.some((c) => c.category === "bidi")).toBe(true);
  });

  test("detects Unicode tag character (supplementary plane)", async ({
    page,
  }) => {
    // U+E0041 is a tag character (lowercase 'a')
    const tagChar = String.fromCodePoint(0xe0041);
    const out = await detect(page, "hello" + tagChar + "world");
    expect(out.some((c) => c.category === "tag-char")).toBe(true);
  });

  test("ignores normal text", async ({ page }) => {
    const out = await detect(page, "just a normal sentence with emoji 🎉");
    expect(out).toHaveLength(0);
  });
});

// ── redactText + stripCharsByCategory ───────────────────────────────
test.describe("Redaction helpers", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/fixture.html");
    await page.waitForFunction(() => (window as any).__glassbox);
  });

  test("redactText replaces an email match", async ({ page }) => {
    const out = await page.evaluate(() => {
      const g = (window as any).__glassbox;
      const text = "contact alice@example.com please";
      const matches = g.detectPII(text);
      return g.redactText(text, matches);
    });
    expect(out).toBe("contact [REDACTED:email] please");
  });

  test("redactText handles multiple distinct PII matches", async ({
    page,
  }) => {
    const out = await page.evaluate(() => {
      const g = (window as any).__glassbox;
      const text =
        "email alice@example.com and aws AKIAIOSFODNN7EXAMPLE now";
      const matches = g.detectPII(text);
      return g.redactText(text, matches);
    });
    expect(out).toBe(
      "email [REDACTED:email] and aws [REDACTED:aws-key] now",
    );
  });

  test("stripCharsByCategory removes only zero-width, leaves bidi intact", async ({
    page,
  }) => {
    const out = await page.evaluate(() => {
      const g = (window as any).__glassbox;
      const text = "a\u200Bb\u202Ec";
      return g.stripCharsByCategory(text, "zero-width");
    });
    expect(out).toBe("ab\u202Ec");
  });

  test("stripCharsByCategory removes only bidi overrides", async ({
    page,
  }) => {
    const out = await page.evaluate(() => {
      const g = (window as any).__glassbox;
      const text = "a\u200Bb\u202Ec";
      return g.stripCharsByCategory(text, "bidi");
    });
    expect(out).toBe("a\u200Bbc");
  });
});
