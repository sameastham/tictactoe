import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Read surface's capture loop: open the seeded
 * article, decide on two candidates, confirm the decisions persist across a
 * reload and through the API, confirm the home list reflects them, then
 * confirm the "paste text" add flow also produces a readable, highlighted
 * article.
 *
 * Structured as one `describe.serial` sharing a single page/context across
 * numbered steps (rather than one giant test) so a failure at any point
 * reports exactly which step of the flow broke. The shared context is built
 * by hand from `devices["Pixel 7"]` (mirroring the project's `use` config)
 * because a manually-created `browser.newContext()` does not automatically
 * inherit project-level `use` options the way the built-in `page` fixture
 * does.
 */

const SEED_TITLE = "El café de especialidad en México";

/** Four unrelated 6+ word sentences — enough for the fixture provider's
 * synthetic (non-canned) extraction path to yield real candidates. */
const ADD_FLOW_TEXT = [
  "Aprender español es un proceso largo pero muy satisfactorio para cualquier persona.",
  "Cada día se pueden descubrir nuevas expresiones y palabras interesantes en el idioma.",
  "La práctica constante ayuda mucho a mejorar la fluidez con el tiempo.",
  "Escuchar música y ver películas en español también resulta muy útil para aprender.",
].join(" ");

test.describe.serial("Read flow", () => {
  let context: BrowserContext;
  let page: Page;
  let contentId: string;
  let firstCandidateId: string;
  let secondCandidateId: string;

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

  test("1. home shows the seeded article card", async () => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: new RegExp(SEED_TITLE) })).toBeVisible();
  });

  test("2. opening it runs extraction and renders highlights", async () => {
    await page.getByRole("link", { name: new RegExp(SEED_TITLE) }).click();
    await page.waitForURL(/\/read\//);
    contentId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;

    const marks = page.locator('article [data-testid="candidate-mark"]');
    await expect(marks.first()).toBeVisible({ timeout: 15_000 });
    expect(await marks.count()).toBeGreaterThanOrEqual(8);

    await expect(page.getByTestId("decision-counter")).toHaveText("0/10");
  });

  test("3. keeping the first candidate advances to the next one", async () => {
    const marks = page.locator('article [data-testid="candidate-mark"]');
    firstCandidateId = (await marks.first().getAttribute("data-candidate-id"))!;
    expect(firstCandidateId).toBeTruthy();

    await marks.first().click();

    const sheet = page.getByTestId("candidate-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("candidate-register")).toBeVisible();
    const why = await sheet.getByTestId("candidate-why").textContent();
    expect(why?.trim().length ?? 0).toBeGreaterThan(0);

    await sheet.getByRole("button", { name: "Guardar" }).click();

    // The sheet closes immediately, then auto-advances to the next
    // undecided candidate ~250ms later — `toBeVisible` polls through that gap.
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("decision-counter")).toHaveText("1/10");

    const firstMark = page.locator(`[data-candidate-id="${firstCandidateId}"][data-testid="candidate-mark"]`);
    await expect(firstMark).toHaveAttribute("data-state", "keep");
  });

  test("4. discarding the auto-advanced candidate updates its mark", async () => {
    const sheet = page.getByTestId("candidate-sheet");
    await expect(sheet).toBeVisible();
    secondCandidateId = (await sheet.getAttribute("data-candidate-id"))!;
    expect(secondCandidateId).toBeTruthy();
    expect(secondCandidateId).not.toBe(firstCandidateId);

    await sheet.getByRole("button", { name: "Descartar" }).click();

    await expect(page.getByTestId("decision-counter")).toHaveText("2/10");

    const secondMark = page.locator(`[data-candidate-id="${secondCandidateId}"][data-testid="candidate-mark"]`);
    await expect(secondMark).toHaveAttribute("data-state", "discard");
  });

  test("5. reloading the page keeps both decisions", async () => {
    await page.reload();

    const firstMark = page.locator(`[data-candidate-id="${firstCandidateId}"][data-testid="candidate-mark"]`);
    const secondMark = page.locator(`[data-candidate-id="${secondCandidateId}"][data-testid="candidate-mark"]`);
    await expect(firstMark).toHaveAttribute("data-state", "keep");
    await expect(secondMark).toHaveAttribute("data-state", "discard");
    await expect(page.getByTestId("decision-counter")).toHaveText("2/10");
  });

  test("6. GET /api/content/:id reports exactly those two decisions", async () => {
    const res = await page.request.get(`/api/content/${contentId}`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { decisions: Record<string, "keep" | "discard"> };

    expect(Object.keys(body.decisions).sort()).toEqual([firstCandidateId, secondCandidateId].sort());
    expect(body.decisions[firstCandidateId]).toBe("keep");
    expect(body.decisions[secondCandidateId]).toBe("discard");
  });

  test("7. the home card reflects the decision count", async () => {
    await page.goto("/");
    await expect(page.getByText("2 de 10")).toBeVisible();
  });

  test("8. adding pasted text runs extraction and renders a highlight", async () => {
    await page.goto("/add");
    await page.getByRole("button", { name: "Texto" }).click();
    await page.getByLabel(/Título/).fill("Prueba");
    await page.getByLabel("Texto").fill(ADD_FLOW_TEXT);
    await page.getByRole("button", { name: "Agregar contenido" }).click();

    await page.waitForURL(/\/read\//);

    const marks = page.locator('article [data-testid="candidate-mark"]');
    await expect(marks.first()).toBeVisible({ timeout: 15_000 });
    expect(await marks.count()).toBeGreaterThanOrEqual(1);
  });
});
