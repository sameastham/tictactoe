import { test, expect, devices, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the desktop layout wave (1440x900, the
 * `desktop-chromium` project — see playwright.config.ts): the sidebar shell
 * replacing the tab bar, and the handful of surfaces whose `lg:` layout is a
 * genuine structural change rather than a plain reflow — home's grid, Read's
 * two-pane panel, Fix's side-by-side better_version, Listen's two-pane
 * dictation, Talk's report rail, and Fuentes' card grid. Kept lean (mirrors
 * the *-flow specs' one-assertion-group-per-surface shape) rather than
 * re-covering behavior the mobile suite already owns.
 *
 * Runs against the SAME webServer/db as the mobile project, always after it
 * (project order in playwright.config.ts) — so seeded content, and whatever
 * the mobile specs decided/captured, already exists. Nothing here decides a
 * candidate, captures an item, or targets a syllabus item, so unlike
 * read-pdf.spec.ts/plan-flow.spec.ts this file adds no due-item state for a
 * later spec to worry about — there IS no later spec in this invocation, but
 * the same "don't crowd the due pool" reasoning would apply if there were,
 * so it's called out here rather than silently relied upon.
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as every other e2e file, built by hand from `devices["Desktop
 * Chrome"]` + the 1440x900 viewport (mirroring the desktop-chromium
 * project's own `use` config) for the same reason read-flow.spec.ts's doc
 * comment gives: a manually-created `browser.newContext()` doesn't inherit
 * project-level `use` options the way the built-in `page` fixture does.
 */

const SEED_ARTICLE_TITLE = "El café de especialidad en México";
const SEED_AUDIO_TITLE = "En el tianguis";

/** Bounding boxes of two elements meant to sit in the same row, side by side (left, then right). */
async function expectSideBySide(left: Locator, right: Locator): Promise<void> {
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  // Same row: tops within a small tolerance (rows can differ slightly in
  // internal padding/line-height without meaning "not side by side").
  expect(Math.abs(leftBox!.y - rightBox!.y)).toBeLessThan(80);
  // Side by side, in order: left's right edge doesn't cross right's left edge.
  expect(leftBox!.x + leftBox!.width).toBeLessThanOrEqual(rightBox!.x + 1);
}

test.describe.serial("Desktop layout", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    context = await browser.newContext({
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 900 },
      baseURL: testInfo.project.use.baseURL,
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("1. the sidebar shows all 8 destinations and the mobile tab bar is hidden", async () => {
    await page.goto("/");

    for (const testId of [
      "nav-leer",
      "nav-escribir",
      "nav-escuchar",
      "nav-hablar",
      "nav-reporte",
      "nav-perfil",
      "nav-plan",
      "nav-fuentes",
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    await expect(page.getByTestId("tab-leer")).toBeHidden();
  });

  test("2. home renders a 2-col content grid, no FAB, and a header 'Agregar contenido' button", async () => {
    await expect(page.getByTestId("home-add-desktop")).toBeVisible();
    await expect(page.getByTestId("home-add-fab")).toBeHidden();

    const cards = page.locator('main a[href^="/read/"]');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(2);
    await expectSideBySide(cards.nth(0), cards.nth(1));
  });

  test("3. Read opens in a two-pane layout: tapping a candidate shows the side panel, never the mobile sheet", async () => {
    const res = await page.request.get("/api/content?limit=50");
    expect(res.ok()).toBe(true);
    const { contents } = (await res.json()) as { contents: { id: string; title: string | null }[] };
    const article = contents.find((c) => c.title === SEED_ARTICLE_TITLE);
    expect(article).toBeTruthy();

    await page.goto(`/read/${article!.id}`);

    const panel = page.getByTestId("candidate-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("candidate-panel-empty")).toBeVisible();

    const undecided = page.locator('article [data-testid="candidate-mark"][data-state="undecided"]').first();
    await expect(undecided).toBeVisible({ timeout: 15_000 });
    await undecided.click();

    await expect(panel.getByTestId("candidate-register")).toBeVisible();
    await expect(page.getByTestId("candidate-sheet")).toHaveCount(0);

    await expectSideBySide(page.locator("article"), panel);
  });

  test("4. a judged Fix writing shows the original sentence and its better_version side by side", async () => {
    const fixRes = await page.request.post("/api/fix", {
      data: { text: "Para mí, eso no hacer sentido en absoluto." },
    });
    expect(fixRes.ok()).toBe(true);
    const { writingId } = (await fixRes.json()) as { writingId: string };

    await page.goto(`/fix/${writingId}`);

    const card = page.locator('[data-testid="sentence-card"][data-rung="incorrect"]');
    await expect(card).toHaveCount(1);

    const better = card.getByTestId("better-version");
    await expect(better).toBeVisible();
    const original = card.locator("p").first();
    await expectSideBySide(original, better);
  });

  test("5. Listen detail shows the segment list on the left and the dictation panel on the right", async () => {
    const res = await page.request.get("/api/content?limit=50");
    expect(res.ok()).toBe(true);
    const { contents } = (await res.json()) as { contents: { id: string; title: string | null }[] };
    const audio = contents.find((c) => c.title === SEED_AUDIO_TITLE);
    expect(audio).toBeTruthy();

    await page.goto(`/listen/${audio!.id}`);

    const listPanel = page.getByTestId("segment-list-panel");
    const rows = page.getByTestId("segment-row");
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    await expect(page.getByTestId("dictation-panel-empty")).toBeVisible();

    await rows.first().getByTestId("segment-open").click();
    const dictationPanel = page.getByTestId("dictation-panel");
    await expect(dictationPanel).toBeVisible();
    await expect(dictationPanel.getByTestId("dictation-textarea")).toBeVisible();

    await expectSideBySide(listPanel, dictationPanel);
  });

  test("6. a Talk report shows a sticky right rail (Para practicar) beside the sentence list", async () => {
    const startRes = await page.request.post("/api/talk/start");
    expect(startRes.ok()).toBe(true);
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    const messageRes = await page.request.post("/api/talk/message", {
      data: { sessionId, text: "Para mí, eso no hacer sentido en absoluto." },
    });
    expect(messageRes.ok()).toBe(true);

    const endRes = await page.request.post("/api/talk/end", { data: { sessionId } });
    expect(endRes.ok()).toBe(true);

    await page.goto(`/talk/${sessionId}`);

    const sentenceList = page.getByTestId("talk-sentence-list");
    const rail = page.getByTestId("talk-report-rail");
    await expect(sentenceList).toBeVisible();
    await expect(rail).toBeVisible();
    await expect(rail.getByTestId("practice-next")).toBeVisible();

    await expectSideBySide(sentenceList, rail);
  });

  test("7. Fuentes renders a 2-col card grid", async () => {
    await page.goto("/fuentes");

    const cards = page.getByTestId("source-card");
    expect(await cards.count()).toBeGreaterThanOrEqual(2);
    await expectSideBySide(cards.nth(0), cards.nth(1));
  });
});
