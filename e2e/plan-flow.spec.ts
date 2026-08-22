import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Plan (syllabus) UI, INCLUDING the UI-driven book
 * ingestion form itself: ingest the tiny fake book (`fixtures/libro-falso.pdf`)
 * against a fake, non-production level config (`e2e/fixtures/plan-level.json`,
 * merged in as the "fakebook" level via `src/server/syllabus/config.ts`'s
 * `SYLLABUS_EXTRA_CONFIG_DIR`, which `playwright.config.ts`'s `webServer.env`
 * points at `e2e/fixtures`) through `/plan`'s own ingest form
 * (`src/components/IngestBookForm.tsx`, `POST /api/syllabus/ingest`) — not
 * the `npm run ingest-book` CLI — then walk the full loop: `/plan` shows the
 * active unit with its sections and construction chips, a section opens as
 * an ordinary reader, a tarea opens `/fix/write` preselected with its prompt
 * and target construction, submitting a write updates the unit's evidence,
 * advancing moves to the next unit, and the home page picks up the new
 * active unit's Plan card. The CLI path itself stays covered by
 * `src/server/syllabus/ingest.test.ts` (unit tests over the shared
 * `ingestBook` pipeline both the CLI and this route call).
 *
 * Runs in the same shared e2e DB as every other *-flow spec — see
 * review-flow.spec.ts's note on that. This spec's own writes (2 seeded
 * items, 1 syllabus_advanced event, 1 Fix writing) are additive and never
 * assumed-empty by any other spec (verified against every other spec's
 * assertions before adding this file). It also relies on NO earlier
 * (alphabetically-sorted) spec file having ingested any syllabus content —
 * verified true as of this writing (fix-flow, fuentes-flow, listen-*, all
 * run before plan-flow and none touch the syllabus) — so `/plan` is still
 * genuinely in its empty state when test 1 below navigates to it.
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as the other *-flow specs.
 */

const FAKE_BOOK_PDF = "fixtures/libro-falso.pdf";
/** Any non-PDF file already on disk — used only to exercise the ingest form's wrong-type rejection. */
const WRONG_TYPE_FILE = "fixtures/article-es-mx.txt";

test.describe.serial("Plan flow", () => {
  let context: BrowserContext;
  let page: Page;
  /** u1's two seeded construction item ids, captured while u1 is still active — needed for the final cleanup step below. */
  let constructionItemIds: string[];

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

  test("1. ingest the fake book via the Plan page's UI form, then /plan shows the active unit with its sections and construction chips", async () => {
    await page.goto("/plan");

    await expect(page.getByTestId("plan-empty-state")).toBeVisible();
    await expect(page.getByTestId("ingest-book-form")).toBeVisible();

    // A wrong-type file is rejected with an honest error and leaves the form
    // usable — never silently "succeeds" into a bogus ingestion.
    await page.getByTestId("ingest-level-select").selectOption("fakebook");
    await page.getByTestId("ingest-files-input").setInputFiles(WRONG_TYPE_FILE);
    await page.getByTestId("ingest-submit").click();
    await expect(page.getByTestId("ingest-error")).toContainText("PDF");
    await expect(page.getByTestId("ingest-book-form")).toBeVisible();

    // The real fake book, via the same form.
    await page.getByTestId("ingest-files-input").setInputFiles(FAKE_BOOK_PDF);
    await page.getByTestId("ingest-submit").click();

    const reportRows = page.locator('[data-testid="ingest-report-unit-row"]');
    await expect(reportRows).toHaveCount(2, { timeout: 30_000 });
    await expect(reportRows.nth(0)).toContainText("2 secciones");
    await expect(reportRows.nth(0)).toContainText("2 construcciones");
    await expect(reportRows.nth(1)).toContainText("2 secciones");

    await page.getByTestId("ingest-view-plan").click();

    const hero = page.getByTestId("active-unit-hero");
    await expect(hero).toBeVisible();
    await expect(hero).toHaveAttribute("data-unit-id", "u1");
    await expect(hero).toContainText("Tema de prueba uno");

    const sectionRows = page.locator('[data-testid="unit-section-row"]');
    await expect(sectionRows).toHaveCount(2);

    const chips = page.locator('[data-testid="construction-chip"]');
    await expect(chips).toHaveCount(2);
    await expect(page.locator('[data-testid="construction-chip"][data-chunk="a menos que"]')).toBeVisible();
    await expect(page.locator('[data-testid="construction-chip"][data-chunk="por más que"]')).toBeVisible();

    // Captured now (while u1 is still active) for test 8's cleanup below —
    // GET /api/syllabus only ever reflects the *active* unit's evidence, and
    // u1 stops being active once test 6 advances past it.
    const syllabusRes = await page.request.get("/api/syllabus");
    const syllabusBody = (await syllabusRes.json()) as { evidence: { constructions: { itemId: string | null }[] } };
    constructionItemIds = syllabusBody.evidence.constructions
      .map((c) => c.itemId)
      .filter((id): id is string => id !== null);
    expect(constructionItemIds).toHaveLength(2);
  });

  test("2. opening a section renders the didactic content like any article", async () => {
    const firstSectionLink = page.locator('[data-testid="unit-section-row"]').first().locator("a");
    await firstSectionLink.click();
    await page.waitForURL(/\/read\//);

    const marks = page.locator('article [data-testid="candidate-mark"]');
    await expect(marks.first()).toBeVisible({ timeout: 15_000 });
  });

  test("3. back on /plan, tapping the tarea opens Reto preselected with its prompt and construction chip", async () => {
    await page.goto("/plan");

    const tareaRow = page.locator('[data-testid="tarea-row"]').first();
    await expect(tareaRow).toBeVisible();
    await tareaRow.getByTestId("tarea-write-link").click();

    await page.waitForURL(/\/fix\/write\?tarea=/);
    await expect(page.getByTestId("mode-reto")).toBeVisible();

    await expect(page.getByTestId("fix-task-preview")).toContainText(
      "Escribe 3-4 frases de prueba usando a menos que.",
    );

    const chips = page.locator('[data-testid="item-chip"]');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveText("a menos que");
    await expect(chips.first()).toHaveAttribute("data-selected", "true");
  });

  test("4. submitting a write using the construction judges it", async () => {
    await page.getByTestId("fix-textarea").fill("No voy a menos que confirmes tu boleto de autobús.");
    await page.getByTestId("fix-submit").click();

    await page.waitForURL(/\/fix\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByTestId("sentence-list")).toBeVisible();
  });

  test("5. /plan's evidence line reflects the written tarea", async () => {
    await page.goto("/plan");
    await expect(page.getByTestId("unit-evidence-footer")).toContainText("1 de 1 tareas escritas");
  });

  test("6. advancing shows the still-weak constructions, then moves to the next unit", async () => {
    await page.getByTestId("advance-unit-button").click();

    const dialog = page.getByTestId("advance-confirm-dialog");
    await expect(dialog).toBeVisible();
    // One write targeting one construction is one positive signal — well
    // short of the mastery model's 3-signal consistency floor (see
    // src/server/mastery.ts), so both constructions are still "fragil".
    await expect(page.locator('[data-testid="advance-weak-chip"]')).toHaveCount(2);

    await page.getByTestId("advance-confirm-submit").click();
    await expect(dialog).toHaveCount(0);

    const hero = page.getByTestId("active-unit-hero");
    await expect(hero).toHaveAttribute("data-unit-id", "u2");
    await expect(hero).toContainText("Tema de prueba dos");
  });

  test("7. home shows the Plan card for the newly active unit", async () => {
    await page.goto("/");
    const card = page.getByTestId("home-plan-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Unidad 2");
    await expect(card).toContainText("Tema de prueba dos");
  });

  test("8. cleanup: review u1's construction items away so they don't crowd out later specs' due-item chips", async () => {
    // Same test-hygiene idiom as read-pdf.spec.ts's own step 5: this suite
    // shares one DB across every spec file, and /fix/write's Reto mode (no
    // tarea param) only shows the top RETO_CHIP_COUNT (6) due items,
    // earliest-due first. Left freshly-seeded (and thus "due"), u1's two
    // construction items sort ahead of every later spec's own items —
    // review-flow.spec.ts, talk-flow.spec.ts, talk-voice.spec.ts all run
    // after this file alphabetically — and can crowd them out of that
    // top-6 window. Rating them here removes them from the due pool without
    // touching anything this spec already asserted on above.
    for (const itemId of constructionItemIds) {
      const res = await page.request.post("/api/reviews", { data: { itemId, rating: "easy" } });
      expect(res.ok()).toBe(true);
    }
  });
});
