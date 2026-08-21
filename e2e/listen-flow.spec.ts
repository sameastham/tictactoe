import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Listen surface's dictation loop: open the
 * seeded "En el tianguis" audio, confirm the transcript is hidden before any
 * submission, type a deliberately imperfect transcription of segment 1
 * (index 0), submit, and verify the diff (token stream + all four miss
 * classes it provably produces — see the derivation below), capture the
 * lexical miss, confirm it lands in the item store, then re-attempt with a
 * perfect transcription and confirm zero misses.
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as read-flow.spec.ts and fix-flow.spec.ts, for the same reason: a
 * failure at any step reports exactly which part of the flow broke.
 *
 * --- Miss-class derivation (fixtures/dictation-es-mx.json + src/lib/segments.ts) ---
 *
 * `buildSegments`'s default knobs (minMs 10s, maxMs 20s, minGapMs 400ms) cut
 * the fixture's word timestamps at the one >=400ms gap that falls at or
 * after the 10s floor: the 850ms gap between "bien." (ends 13912ms) and "Al"
 * (starts 14762ms). That makes segment 0 (words 0-29):
 *
 *   "Hoy en la mañana fui al tianguis de Coyoacán a comprar fruta y verdura
 *    bien fresca. La neta, los precios estaban bien baratos y las señoras
 *    me trataron súper bien."
 *
 * `IMPERFECT_TYPED` below drops "la", "Coyoacán", and "verdura" outright and
 * substitutes "tianguis" -> "tianguiz", leaving every other word (including
 * every repeated "bien"/"y"/"las") untouched and in the same order, so the
 * LCS alignment in `diffDictation` is unambiguous. Per `classifyMiss` in
 * src/lib/dictation.ts:
 *   - "la"       (dropped, heard=null)              -> function word       -> reduction
 *   - "tianguis" (heard="tianguiz", edit distance 1) -> not function/capped -> near_miss
 *   - "Coyoacán" (dropped, heard=null)               -> capitalized mid-sentence -> proper_noun
 *   - "verdura"  (dropped, heard=null)               -> none of the above   -> lexical
 * i.e. this one input provably exercises all four `DictationMissClass` values.
 */

const SEED_AUDIO_TITLE = "En el tianguis";

const SEGMENT_0_TEXT =
  "Hoy en la mañana fui al tianguis de Coyoacán a comprar fruta y verdura bien fresca. La neta, los precios estaban bien baratos y las señoras me trataron súper bien.";

const IMPERFECT_TYPED =
  "Hoy en mañana fui al tianguiz de a comprar fruta y bien fresca. La neta, los precios estaban bien baratos y las señoras me trataron súper bien.";

test.describe.serial("Listen flow", () => {
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

  test("1. home -> Escuchar tab shows the seeded audio card", async () => {
    await page.goto("/");
    await page.getByTestId("tab-escuchar").click();
    await page.waitForURL(/\/listen$/);
    await expect(page.getByRole("link", { name: new RegExp(SEED_AUDIO_TITLE) })).toBeVisible();
  });

  test("2. opening it shows two segment cards with the transcript hidden", async () => {
    await page.getByRole("link", { name: new RegExp(SEED_AUDIO_TITLE) }).click();
    await page.waitForURL(/\/listen\//);

    const cards = page.getByTestId("segment-card");
    await expect(cards).toHaveCount(2, { timeout: 15_000 });

    await expect(page.getByTestId("segment-card").nth(0)).toContainText("Fragmento 1");
    await expect(page.getByTestId("segment-card").nth(1)).toContainText("Fragmento 2");

    // No peeking: the underlying transcript text must not be present anywhere
    // on the page before a first submission.
    await expect(page.locator("body")).not.toContainText(SEGMENT_0_TEXT);
    await expect(page.locator("body")).not.toContainText("fui al tianguis de Coyoacán");

    await expect(
      page.locator('[data-testid="segment-card"][data-segment-index="0"] [data-testid="segment-play"]'),
    ).toBeVisible();
  });

  test("3. typing an imperfect transcription and comparing shows the diff", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    await segment0.getByTestId("segment-open").click();

    await expect(segment0.getByTestId("dictation-textarea")).toBeVisible();
    // Still hidden once the card is expanded but before any attempt.
    await expect(page.locator("body")).not.toContainText(SEGMENT_0_TEXT);

    await segment0.getByTestId("dictation-textarea").fill(IMPERFECT_TYPED);
    await segment0.getByTestId("dictation-submit").click();

    await expect(segment0.getByTestId("diff-tokens")).toBeVisible();
    const missTokens = segment0.locator('[data-testid="diff-token"][data-kind="miss"]');
    expect(await missTokens.count()).toBeGreaterThanOrEqual(3);
  });

  test("4. all four miss classes are present, derived exactly as expected", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    const chips = segment0.locator('[data-testid="miss-chip"]');
    await expect(chips).toHaveCount(4);

    const reductionChip = segment0.locator('[data-testid="miss-chip"][data-class="reduction"]');
    await expect(reductionChip).toHaveCount(1);
    await expect(reductionChip).toHaveAttribute("data-expected", "la");

    const nearMissChip = segment0.locator('[data-testid="miss-chip"][data-class="near_miss"]');
    await expect(nearMissChip).toHaveCount(1);
    await expect(nearMissChip).toHaveAttribute("data-expected", "tianguis");

    const properNounChip = segment0.locator('[data-testid="miss-chip"][data-class="proper_noun"]');
    await expect(properNounChip).toHaveCount(1);
    await expect(properNounChip).toHaveAttribute("data-expected", "Coyoacán");

    const lexicalChip = segment0.locator('[data-testid="miss-chip"][data-class="lexical"]');
    await expect(lexicalChip).toHaveCount(1);
    await expect(lexicalChip).toHaveAttribute("data-expected", "verdura");

    // Only the lexical miss carries a capture affordance.
    await expect(lexicalChip.getByTestId("capture-button")).toHaveCount(1);
    await expect(reductionChip.getByTestId("capture-button")).toHaveCount(0);
    await expect(nearMissChip.getByTestId("capture-button")).toHaveCount(0);
    await expect(properNounChip.getByTestId("capture-button")).toHaveCount(0);
  });

  test("5. capturing the lexical miss flips the chip and lands in the item store", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    const captureButton = segment0
      .locator('[data-testid="miss-chip"][data-class="lexical"]')
      .getByTestId("capture-button");

    await expect(captureButton).toHaveText("+ Guardar");
    await captureButton.click();

    await expect(captureButton).toHaveText("Guardada ✓");
    await expect(captureButton).toBeDisabled();

    const res = await page.request.get("/api/items/recent?limit=50");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { items: { chunk: string }[] };
    expect(body.items.some((item) => item.chunk === "verdura")).toBe(true);
  });

  test("6. re-attempting with the perfect transcript yields zero misses", async () => {
    const segment0 = page.locator('[data-testid="segment-card"][data-segment-index="0"]');
    await segment0.getByTestId("retry-attempt").click();

    await expect(segment0.getByTestId("dictation-textarea")).toBeVisible();
    await expect(segment0.getByTestId("dictation-textarea")).toHaveValue("");

    await segment0.getByTestId("dictation-textarea").fill(SEGMENT_0_TEXT);
    await segment0.getByTestId("dictation-submit").click();

    await expect(segment0.getByTestId("diff-perfect")).toBeVisible();
    await expect(segment0.locator('[data-testid="diff-token"][data-kind="miss"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="segment-card"][data-segment-index="0"] [data-testid="segment-state-badge"]'),
    ).toHaveText("Perfecto");
  });
});
