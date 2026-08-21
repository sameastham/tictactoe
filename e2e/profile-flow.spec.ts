import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the learner mastery profile (`/profile`): generate
 * activity via `page.request` (capture two items, then a Fix write that
 * targets one of them and also trips the fixture judge's "hacer sentido" ->
 * incorrect -> word_choice rule — the same pattern report-flow.spec.ts uses),
 * then confirm `/report` links to `/profile` and that the profile page
 * renders "Qué te está frenando", "Ítems más frágiles", and "Por categoría"
 * from that activity.
 *
 * Runs in the same shared e2e DB as every other *-flow spec (single worker,
 * one global-setup reset per `npm run e2e` invocation — see
 * playwright.config.ts), so assertions are written to hold regardless of
 * what else has already landed in the log: exact counts are avoided in favor
 * of "this chunk is present, with this band" and "the word_choice example
 * text is exactly what the fixture judge always produces for 'hacer
 * sentido'" (deterministic no matter how many times that rule has already
 * fired elsewhere in the suite).
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as the other *-flow specs.
 */

const CONTENT_TEXT = [
  "El mercado sobre ruedas abre temprano cada domingo por la mañana.",
  "Los vecinos organizan una kermés grande para recaudar fondos escolares.",
  "Casi nadie encuentra estacionamiento libre cerca del centro histórico.",
  "Preferimos llegar caminando antes de que se llene demasiado la plaza.",
].join(" ");

test.describe.serial("Profile flow", () => {
  let context: BrowserContext;
  let page: Page;
  let itemAId: string;
  let itemAChunk: string;
  let itemBChunk: string;

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

  test("1. generate activity: capture two items, then a Fix write targeting one plus a known fixture error", async () => {
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
    itemBChunk = candidateB.chunk;

    const fixText = [`Ya ${itemAChunk} bastante seguido en la plaza.`, "Para mí, eso no hacer sentido en absoluto."].join(
      " ",
    );

    const fixRes = await page.request.post("/api/fix", { data: { text: fixText, targetItemIds: [itemAId] } });
    expect(fixRes.ok()).toBe(true);
  });

  test("2. /report links to /profile", async () => {
    await page.goto("/report");
    const link = page.getByTestId("link-to-profile");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/profile");
  });

  test("3. Qué te está frenando shows the word_choice card with the fixture's example", async () => {
    await page.goto("/profile");

    const card = page.locator('[data-testid="blocking-card"][data-tag="word_choice"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("Elección de palabra");
    const example = card.getByTestId("blocking-example");
    await expect(example).toContainText("hacer sentido");
    await expect(example).toContainText("tener sentido");
  });

  test("4. Ítems más frágiles lists both captured chunks with the Frágil band", async () => {
    const rowA = page.locator('[data-testid="weak-item-row"]', { hasText: itemAChunk });
    await expect(rowA).toBeVisible();
    await expect(rowA.getByTestId("band-chip")).toHaveText("Frágil");

    const rowB = page.locator('[data-testid="weak-item-row"]', { hasText: itemBChunk });
    await expect(rowB).toBeVisible();
    await expect(rowB.getByTestId("band-chip")).toHaveText("Frágil");
  });

  test("5. Por categoría renders all 11 taxonomy tags", async () => {
    const rows = page.locator('[data-testid="category-row"]');
    await expect(rows).toHaveCount(11);
    await expect(page.locator('[data-testid="category-row"][data-tag="word_choice"]')).toBeVisible();
  });

  test("6. /profile links back to /report", async () => {
    const link = page.getByTestId("link-to-report");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/report");
  });
});
