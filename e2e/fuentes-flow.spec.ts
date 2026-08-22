import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Fuentes directory (`/fuentes`,
 * src/components/SourceDirectory.tsx): the curated-source cards render, the
 * inline ingest row rejects a URL from the wrong host without ever hitting
 * the network, a stubbed happy path lands on a real working reader, and the
 * quiet entry links from /add and /listen/add are present.
 *
 * Per the project's e2e constraints this suite makes NO real network calls:
 * the happy-path ingest stubs POST /api/content via `page.route` and
 * navigates to a REAL content id created beforehand through the ordinary
 * (fixture-backed, no-network) paste path — same idiom as
 * `e2e/listen-url.spec.ts`'s stubbed-happy-path test.
 *
 * Same structure as the other specs here: one `describe.serial` sharing a
 * single page/context, Pixel 7 device, against the shared e2e webServer/db.
 */

const PASTE_TEXT = [
  "El maíz ha sido la base de la alimentación mexicana desde hace miles de años.",
  "Cada región del país tiene su propia manera de prepararlo y de nombrarlo.",
  "Aprender sobre esta tradición ayuda a entender mucho de la cultura contemporánea.",
].join(" ");

test.describe.serial("Fuentes directory", () => {
  let context: BrowserContext;
  let page: Page;
  /** A real content id, created via the ordinary (fixture-backed) paste path — the stubbed happy path below navigates here. */
  let realContentId: string;

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

  test("1. seed a real, working content id via the ordinary paste path", async () => {
    const res = await page.request.post("/api/content", {
      data: { text: PASTE_TEXT, title: "Fuentes e2e fixture" },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { content: { id: string } };
    realContentId = body.content.id;
    expect(realContentId.length).toBeGreaterThan(0);
  });

  test("2. /fuentes renders all 6 curated cards with kind badges", async () => {
    await page.goto("/fuentes");

    const cards = page.getByTestId("source-card");
    await expect(cards).toHaveCount(6);

    const kindOf = (id: string) => page.locator(`[data-source-id="${id}"]`).getByTestId("source-kind-badge");
    await expect(kindOf("revista-unam")).toHaveText("Lectura");
    await expect(kindOf("gaceta-unam")).toHaveText("Lectura");
    await expect(kindOf("unam-global")).toHaveText("Lectura");
    await expect(kindOf("descarga-cultura")).toHaveText("Audio");
    await expect(kindOf("sep-documentos")).toHaveText("PDF");
    await expect(kindOf("gob-mx-blog")).toHaveText("Mixto");

    // Every card opens its source externally.
    await expect(page.locator('[data-source-id="revista-unam"]').getByTestId("source-open-site")).toHaveAttribute(
      "href",
      "https://www.revistadelauniversidad.mx/",
    );
  });

  test("3. a wrong-host URL in the revista card shows a friendly error and fires no request", async () => {
    let contentRequests = 0;
    await page.route("**/api/content", async (route) => {
      if (route.request().method() === "POST") contentRequests += 1;
      await route.continue();
    });

    const revistaCard = page.locator('[data-source-id="revista-unam"]');
    await revistaCard.getByTestId("source-url-input").fill("https://www.nytimes.com/es/algun-articulo");
    await revistaCard.getByTestId("source-ingest-submit").click();

    await expect(revistaCard.getByTestId("source-error")).toHaveText(
      "Esa URL no es de esta fuente — pégala en Agregar contenido si es de otro sitio.",
    );
    expect(contentRequests).toBe(0);

    await page.unroute("**/api/content");
  });

  test("4. happy path: stubbed 201 for a real revista URL navigates to a real, working /read/[id]", async () => {
    await page.route("**/api/content", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && (req.headers()["content-type"] ?? "").includes("application/json")) {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            content: {
              id: realContentId,
              title: "Fuentes e2e fixture",
              source: "url",
              type: "article",
              createdAt: new Date().toISOString(),
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    const revistaCard = page.locator('[data-source-id="revista-unam"]');
    await revistaCard.getByTestId("source-url-input").fill("https://www.revistadelauniversidad.mx/articulos/x");
    await revistaCard.getByTestId("source-ingest-submit").click();

    await page.waitForURL(new RegExp(`/read/${realContentId}$`));
    // Lands on a real, working page — not a 404.
    await expect(page.getByRole("heading", { name: "Fuentes e2e fixture" })).toBeVisible();

    await page.unroute("**/api/content");
  });

  test("5. entry links to Fuentes are present on /add and /listen/add", async () => {
    await page.goto("/add");
    await expect(page.getByTestId("link-to-fuentes")).toHaveAttribute("href", "/fuentes");

    await page.goto("/listen/add");
    await expect(page.getByTestId("link-to-fuentes")).toHaveAttribute("href", "/fuentes");
  });
});
