import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Review scheduler: capture two items via the
 * API (both due immediately — a freshly captured item's FSRS card is born
 * due), confirm the home screen's "Repaso" queue renders one of them as a
 * pre-reveal cloze card (gap shown, answer text absent), reveal it, rate it
 * "Bien", confirm it leaves the local queue and a fresh `GET /api/queue` no
 * longer reports it as due, then confirm `/fix/write`'s Reto mode still
 * shows the *other* (still-due) item's chip with a due badge.
 *
 * Same idiom as read-flow.spec.ts / fix-flow.spec.ts: one `describe.serial`
 * sharing a single page/context across numbered steps. Because all three
 * spec files share one throwaway DB for the whole `npm run e2e` run (reset
 * once by global-setup, not per file), earlier specs' items are also due by
 * the time this one runs — every assertion below is scoped to *our own*
 * `itemAId`/`itemBId` rather than assuming the queue is empty or that our
 * cards are first.
 */

const CONTENT_TEXT = [
  "Los estudiantes repasan expresiones nuevas cada tarde después de clases.",
  "Muchas familias mexicanas preparan tamales para las fiestas de diciembre.",
  "El tráfico en la ciudad empeora bastante durante la hora pico de la tarde.",
  "Nos gusta caminar por el parque cuando hace buen clima los domingos.",
].join(" ");

test.describe.serial("Review flow", () => {
  let context: BrowserContext;
  let page: Page;
  let itemAId: string;
  let itemAChunk: string;
  let itemBId: string;
  let itemBChunk: string;
  /** Whichever of itemA/itemB we actually review in step 4 — the other stays due for step 6. */
  let reviewedId: string;
  let remainingId: string;
  let remainingChunk: string;

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

  test("1. capture two items via the API (content -> extract -> keep decisions)", async () => {
    const contentRes = await page.request.post("/api/content", { data: { text: CONTENT_TEXT } });
    expect(contentRes.ok()).toBe(true);
    const contentId = ((await contentRes.json()) as { content: { id: string } }).content.id;

    const extractRes = await page.request.post(`/api/content/${contentId}/extract`);
    expect(extractRes.ok()).toBe(true);
    const extraction = (
      (await extractRes.json()) as { extraction: { result: { candidates: { id: string; chunk: string }[] } } }
    ).extraction;
    expect(extraction.result.candidates.length).toBeGreaterThanOrEqual(2);

    const [candidateA, candidateB] = extraction.result.candidates;

    const decisionARes = await page.request.post("/api/decisions", {
      data: { contentId, candidateId: candidateA.id, action: "keep" },
    });
    expect(decisionARes.ok()).toBe(true);
    itemAId = ((await decisionARes.json()) as { itemId: string }).itemId;
    itemAChunk = candidateA.chunk;

    const decisionBRes = await page.request.post("/api/decisions", {
      data: { contentId, candidateId: candidateB.id, action: "keep" },
    });
    expect(decisionBRes.ok()).toBe(true);
    itemBId = ((await decisionBRes.json()) as { itemId: string }).itemId;
    itemBChunk = candidateB.chunk;

    expect(itemAId).toBeTruthy();
    expect(itemBId).toBeTruthy();
    expect(itemAId).not.toBe(itemBId);
  });

  test("2. both captured items are due immediately, per GET /api/items/due", async () => {
    const res = await page.request.get("/api/items/due?limit=50");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { items: { id: string }[] };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(itemAId);
    expect(ids).toContain(itemBId);
  });

  test("3. home's Repaso queue shows one of our items as a pre-reveal cloze card", async () => {
    await page.goto("/");
    await expect(page.getByTestId("review-queue")).toBeVisible();

    const ourCard = page
      .locator(
        `[data-testid="review-card"][data-item-id="${itemAId}"], [data-testid="review-card"][data-item-id="${itemBId}"]`,
      )
      .first();
    await expect(ourCard).toBeVisible();

    reviewedId = (await ourCard.getAttribute("data-item-id"))!;
    expect([itemAId, itemBId]).toContain(reviewedId);
    remainingId = reviewedId === itemAId ? itemBId : itemAId;
    remainingChunk = reviewedId === itemAId ? itemBChunk : itemAChunk;
    const reviewedChunk = reviewedId === itemAId ? itemAChunk : itemBChunk;

    await expect(ourCard).toHaveAttribute("data-revealed", "false");
    await expect(ourCard.getByTestId("cloze-gap")).toBeVisible();
    await expect(ourCard.getByTestId("cloze-gap")).toHaveText("____");
    await expect(ourCard.getByTestId("review-card-answer")).toHaveCount(0);
    // The chunk itself must not be readable before the card is revealed.
    await expect(ourCard).not.toContainText(reviewedChunk);
  });

  test("4. tapping the card reveals the answer; rating 'Bien' removes it from the queue", async () => {
    const ourCard = page.locator(`[data-testid="review-card"][data-item-id="${reviewedId}"]`);
    const countBefore = await page.locator('[data-testid="review-card"]').count();

    await ourCard.getByTestId("review-card-prompt").click();
    await expect(ourCard).toHaveAttribute("data-revealed", "true");
    await expect(ourCard.getByTestId("review-card-answer")).toBeVisible();

    await ourCard.getByTestId("review-rate-good").click();

    await expect(page.locator('[data-testid="review-card"]')).toHaveCount(countBefore - 1, { timeout: 5_000 });
    await expect(page.locator(`[data-testid="review-card"][data-item-id="${reviewedId}"]`)).toHaveCount(0);
  });

  test("5. a fresh GET /api/queue no longer reports the reviewed item as due", async () => {
    const res = await page.request.get("/api/queue");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { cards: { item: { id: string } }[] };
    const ids = body.cards.map((c) => c.item.id);
    expect(ids).not.toContain(reviewedId);
    // The other item was never touched — it's still due.
    expect(ids).toContain(remainingId);
  });

  test("6. /fix/write's Reto mode shows the remaining due item's chip with a due badge", async () => {
    await page.goto("/fix/write");
    await page.getByTestId("mode-reto").click();

    const chip = page.locator(`[data-testid="item-chip"][data-item-id="${remainingId}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(remainingChunk);
    await expect(chip).toHaveAttribute("data-due", "true");
    await expect(chip.getByTestId("item-chip-due-dot")).toBeVisible();
  });
});
