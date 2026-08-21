import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Listen surface's two "further stages" (plan
 * §4.1): the 1.25x playback-speed toggle and the "Ahora dilo tú" production
 * follow-up. Kept as a separate spec from listen-flow.spec.ts (which already
 * covers the core dictation loop — segment reveal, diff, all four miss
 * classes, capture) so this file's failures are unambiguous about which new
 * stage broke.
 *
 * Same idioms as listen-flow.spec.ts: one `describe.serial` sharing a single
 * page/context, Pixel 7 device, against the shared e2e webServer/db.
 */

const SEED_AUDIO_TITLE = "En el tianguis";

/** Any imperfect-enough typed text — this spec doesn't assert on the diff itself (listen-flow.spec.ts already does), only that submitting one reveals the follow-up block. */
const ANY_DICTATION_TEXT = "cualquier texto de prueba";

/** Deliberately trips the fixture judge's "hacer sentido" -> incorrect/word_choice rule (see src/server/language/providers/fixture.ts). */
const REFORMULATION_TEXT = "Fue al tianguis pero los precios no hacer sentido para nadie.";

test.describe.serial("Listen stages (speed toggle + production follow-up)", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({
      ...devices["Pixel 7"],
      baseURL: testInfo.project.use.baseURL,
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("1. open the seeded audio's dictation screen", async () => {
    await page.goto("/");
    await page.getByTestId("tab-escuchar").click();
    await page.waitForURL(/\/listen$/);
    await page.getByRole("link", { name: new RegExp(SEED_AUDIO_TITLE) }).click();
    await page.waitForURL(/\/listen\//);

    await expect(page.getByTestId("segment-card")).toHaveCount(2, { timeout: 15_000 });
  });

  test("2. the speed toggle defaults to 1x and switches the <audio> element's playbackRate", async () => {
    const toggle = page.getByTestId("speed-toggle");
    await expect(toggle).toBeVisible();

    const initialRate = await page.evaluate(() => document.querySelector("audio")?.playbackRate);
    expect(initialRate).toBe(1);
    await expect(page.getByTestId("speed-1x")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("speed-125x")).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("speed-125x").click();

    const sped = await page.evaluate(() => document.querySelector("audio")?.playbackRate);
    expect(sped).toBe(1.25);
    await expect(page.getByTestId("speed-125x")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("speed-1x")).toHaveAttribute("aria-pressed", "false");

    // The replay button inside an active segment reuses the same play path, so it must pick up the speed too.
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    await segment0.getByTestId("segment-open").click();
    await segment0.getByTestId("segment-replay").click();
    const rateAfterReplay = await page.evaluate(() => document.querySelector("audio")?.playbackRate);
    expect(rateAfterReplay).toBe(1.25);

    // Switch back to 1x for the rest of the suite — not load-bearing, just leaves state predictable.
    await page.getByTestId("speed-1x").click();
  });

  test("3. submitting a dictation attempt reveals the 'Ahora dilo tú' follow-up block", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    await expect(segment0.getByTestId("dictation-textarea")).toBeVisible();

    await segment0.getByTestId("dictation-textarea").fill(ANY_DICTATION_TEXT);
    await segment0.getByTestId("dictation-submit").click();
    await expect(segment0.getByTestId("diff-tokens")).toBeVisible();

    const followUp = segment0.getByTestId("followup-block");
    await expect(followUp).toBeVisible();
    await expect(followUp.getByTestId("followup-textarea")).toBeVisible();
    await expect(followUp.getByTestId("followup-result")).toHaveCount(0);
  });

  test("4. reformulating with a fixture-error phrase judges it and shows an Incorrecta card with the word_choice issue", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    const followUp = segment0.getByTestId("followup-block");

    await followUp.getByTestId("followup-textarea").fill(REFORMULATION_TEXT);
    await followUp.getByTestId("followup-submit").click();

    await expect(followUp.getByTestId("followup-result")).toBeVisible({ timeout: 15_000 });
    await expect(followUp.getByTestId("followup-textarea")).toHaveCount(0);

    const incorrectCard = followUp.locator('[data-testid="followup-sentence"][data-rung="incorrect"]');
    await expect(incorrectCard).toHaveCount(1);
    await expect(incorrectCard.getByTestId("followup-rung-badge")).toHaveText("Incorrecta");

    await incorrectCard.getByTestId("followup-issues-toggle").click();
    const issue = incorrectCard.locator('[data-testid="followup-issue"][data-tag="word_choice"]');
    await expect(issue).toHaveCount(1);
    await expect(issue).toContainText("hacer sentido");
    await expect(issue).toContainText("tener sentido");

    await expect(incorrectCard.getByTestId("followup-better-version")).toContainText("tener sentido");
  });

  test("5. 'Reformular de nuevo' hides the result and re-shows an empty textarea", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    const followUp = segment0.getByTestId("followup-block");

    await followUp.getByTestId("followup-again").click();

    await expect(followUp.getByTestId("followup-textarea")).toBeVisible();
    await expect(followUp.getByTestId("followup-textarea")).toHaveValue("");
    await expect(followUp.getByTestId("followup-result")).toHaveCount(0);
  });

  test("6. the reformulation persisted as a writing with task prefix 'listen:reformula:'", async () => {
    const res = await page.request.get("/api/fix?limit=50");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { writings: { task: string | null; excerpt: string }[] };
    const match = body.writings.find((w) => typeof w.task === "string" && w.task.startsWith("listen:reformula:"));
    expect(match).toBeDefined();
    expect(match?.excerpt).toContain("hacer sentido");
  });
});
