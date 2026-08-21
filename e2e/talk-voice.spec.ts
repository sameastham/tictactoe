import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Talk surface's voice mode (plan §4.3 week 7,
 * design §5/§6): record a spoken turn, confirm the recording/transcribing
 * states render, confirm the transcribed (fixture) text lands editable in
 * the input, confirm sending it — edited to trip the fixture judge's
 * "hacer sentido" rule, same idiom `talk-flow.spec.ts` uses — flows all the
 * way through evaluation, and confirm the post-session report's "Fluidez"
 * section reflects exactly one voice turn.
 *
 * Chromium is launched with `--use-fake-device-for-media-stream
 * --use-fake-ui-for-media-stream` (`playwright.config.ts`) so
 * `getUserMedia` resolves with a synthetic audio stream and the mic
 * permission prompt never appears. `STT_PROVIDER=fixture` (webServer env)
 * means ANY recorded audio transcribes to the same canned tianguis-market
 * text (`fixtures/dictation-es-mx.json`) — that's what makes this spec
 * deterministic regardless of what the fake mic actually "says".
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as the other *-flow specs.
 */

const CANNED_TRANSCRIPT_START = "Hoy en la mañana fui al tianguis de Coyoacán";
// Mirrors talk-flow.spec.ts's own FIRST_MESSAGE: "hacer sentido" (not the
// grammatically-normal "hace sentido") is the exact substring the fixture
// judge's word_choice rule matches (see judgeSentenceFixture in
// src/server/language/providers/fixture.ts) — this is what proves the
// voice-transcribed-then-edited text actually flowed into evaluation.
const APPENDED_TEXT = " Además, para mí eso no hacer sentido.";

test.describe.serial("Talk voice mode", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({
      ...devices["Pixel 7"],
      baseURL: testInfo.project.use.baseURL,
      permissions: ["microphone"],
    });
    page = await context.newPage();

    // The fixture STT provider resolves near-instantly (it just reads a
    // local JSON file), so without this the "Transcribiendo…" state can
    // come and go inside a single event-loop tick — too fast for even a
    // polling assertion to reliably observe. Delaying the real request
    // (not mocking it — `route.continue()` still hits the actual handler)
    // gives the UI state a deterministic window to be visible in, without
    // touching app behavior.
    await page.route("**/api/stt", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("1. starting a talk shows a visible mic button beside the send button", async () => {
    await page.goto("/");
    await page.getByTestId("tab-hablar").click();
    await page.getByTestId("start-talk").click();
    await page.waitForURL(/\/talk\/[0-9a-f-]{36}$/, { timeout: 15_000 });

    await expect(page.getByTestId("talk-transcript")).toBeVisible();
    await expect(page.getByTestId("voice-mic-button")).toBeVisible();
    await expect(page.getByTestId("talk-send")).toBeVisible();
  });

  test("2. tapping the mic starts recording: pulsing dot, elapsed timer, Detener/Cancelar", async () => {
    await page.getByTestId("voice-mic-button").click();

    await expect(page.getByTestId("voice-recording-bar")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("voice-stop")).toBeVisible();
    await expect(page.getByTestId("voice-cancel")).toBeVisible();
    // The normal input row is gone while recording — replaced, not overlaid.
    await expect(page.getByTestId("talk-input")).toHaveCount(0);

    await page.waitForTimeout(1800);
    await expect(page.getByTestId("voice-timer")).not.toHaveText("0:00");
  });

  test("3. Detener transcribes (fixture STT) and fills the input with the canned transcript, editable", async () => {
    await page.getByTestId("voice-stop").click();

    await expect(page.getByTestId("voice-transcribing")).toBeVisible();
    await expect(page.getByTestId("voice-transcribing")).toHaveCount(0, { timeout: 15_000 });

    const input = page.getByTestId("talk-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(new RegExp(`^${CANNED_TRANSCRIPT_START}`));
    await expect(input).toBeEditable();
  });

  test("4. editing the transcribed text and sending it shows the edited text in a learner bubble", async () => {
    const input = page.getByTestId("talk-input");
    const transcribed = await input.inputValue();
    await input.fill(transcribed + APPENDED_TEXT);
    await page.getByTestId("talk-send").click();

    const learnerBubbles = page.locator('[data-testid="talk-bubble"][data-role="learner"]');
    await expect(learnerBubbles).toHaveCount(1);
    await expect(learnerBubbles.first()).toContainText("hacer sentido");

    await expect(page.locator('[data-testid="talk-bubble"][data-role="tutor"]')).toHaveCount(2, { timeout: 10_000 });
  });

  test("5. ending the session shows Fluidez with 1 voice turn, and the judged transcript flags 'hacer sentido'", async () => {
    await page.getByTestId("talk-end").click();
    await expect(page.getByTestId("talk-report")).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("talk-fluency")).toBeVisible();
    await expect(page.getByTestId("fluency-voice-turns-value")).toHaveText("1");

    const incorrectCards = page.locator('[data-testid="sentence-card"][data-rung="incorrect"]');
    await expect(incorrectCards).toHaveCount(1);
    await expect(incorrectCards.getByTestId("issue-mark")).toHaveText("hacer sentido");
  });

  test("6. tutor bubble speaker button: present iff a Spanish speechSynthesis voice is actually available", async () => {
    await page.getByTestId("toggle-transcript").click();
    await expect(page.getByTestId("talk-transcript-review")).toBeVisible();

    const hasSpanishVoice = await page.evaluate(() => {
      if (typeof window.speechSynthesis === "undefined") return false;
      return window.speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith("es"));
    });

    const tutorBubbles = page.locator(
      '[data-testid="talk-transcript-review"] [data-testid="talk-bubble"][data-role="tutor"]',
    );
    const firstTtsButton = tutorBubbles.first().getByTestId("talk-tts-button");

    if (hasSpanishVoice) {
      await expect(firstTtsButton).toBeVisible();
    } else {
      await expect(firstTtsButton).toHaveCount(0);
    }
    console.log(`[talk-voice.spec] speechSynthesis branch: ${hasSpanishVoice ? "voice available" : "no es-* voice"}`);
  });
});
