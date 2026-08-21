import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the weekly `/report` page: generate activity via
 * `page.request` (capture two items, submit one Fix write that both uses a
 * captured chunk and trips the fixture judge's "hacer sentido" -> incorrect
 * -> word_choice rule, mirroring fix-flow.spec.ts's own use of that literal
 * string), then confirm the report renders and reflects only what this run
 * can provably produce — no assertion on `npm run eval`-only data (no eval
 * run exists in this DB) or on transfer (capture and write happen seconds
 * apart in this test, never a full day apart).
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as the other *-flow specs.
 */

const CONTENT_TEXT = [
  "Los estudiantes prefieren estudiar temprano por la mañana antes de clases.",
  "Muchas familias mexicanas preparan tamales para las fiestas de diciembre próximas.",
  "El tráfico en la ciudad empeora bastante durante la hora pico de la tarde.",
  "Nos gusta caminar por el parque cuando hace buen clima los domingos por la tarde.",
].join(" ");

test.describe.serial("Report flow", () => {
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

  test("1. generate activity: capture two items, then a Fix write using one chunk plus a known fixture error", async () => {
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
    const itemAId = ((await decisionARes.json()) as { itemId: string }).itemId;
    const itemAChunk = candidateA.chunk;

    const decisionBRes = await page.request.post("/api/decisions", {
      data: { contentId, candidateId: candidateB.id, action: "keep" },
    });
    expect(decisionBRes.ok()).toBe(true);

    const fixText = [`Hoy ${itemAChunk} mucho antes de la reunión.`, "Para mí, eso no hacer sentido en absoluto."].join(
      " ",
    );

    const fixRes = await page.request.post("/api/fix", { data: { text: fixText, targetItemIds: [itemAId] } });
    expect(fixRes.ok()).toBe(true);
  });

  test("2. /report renders and Esta semana shows at least one active day", async () => {
    await page.goto("/report");
    await expect(page.getByTestId("report-week")).toBeVisible();

    const activeDots = page.locator('[data-testid="active-day-dot"][data-active="true"]');
    expect(await activeDots.count()).toBeGreaterThanOrEqual(1);
  });

  test("3. Categorías recurrentes shows the word_choice error from the fixture judge", async () => {
    const row = page.locator('[data-testid="recurrence-row"][data-tag="word_choice"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText("Elección de palabra");
  });

  test("4. Evaluador shows the empty state — no eval run exists in this DB", async () => {
    await expect(page.getByTestId("report-eval")).toContainText("npm run eval");
  });
});
