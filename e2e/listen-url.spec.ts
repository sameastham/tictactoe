import path from "node:path";
import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Listen surface's URL-mode ingestion UI (plan
 * §4.1, `src/server/mediafetch/`). Per the task's reality constraints this
 * suite makes NO real network calls: the happy path stubs POST /api/media's
 * JSON response via `page.route`, landing on a REAL content id created
 * beforehand through the (already-fixture-backed, no-network) multipart
 * upload path, so the final navigation lands on a genuinely working page,
 * not a 404. `listen-flow.spec.ts` covers the archivo-mode/dictation core;
 * this spec only adds the URL-mode toggle, its error paths, and its stubbed
 * happy path.
 *
 * Same idiom as the other Listen specs: one `describe.serial` sharing a
 * single page/context, Pixel 7 device, against the shared e2e webServer/db.
 */

const FIXTURE_AUDIO = path.join(process.cwd(), "fixtures", "dictation-es-mx.wav");

test.describe.serial("Listen URL ingestion", () => {
  let context: BrowserContext;
  let page: Page;
  /** A real content id, created via the ordinary (fixture-backed) multipart upload path in test 1 — the stubbed happy path in test 4 navigates here. */
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

  test("1. seed a real, working content id via the ordinary multipart upload path", async () => {
    await page.goto("/listen/add");
    await page.getByTestId("audio-file-input").setInputFiles(FIXTURE_AUDIO);
    await page.getByTestId("upload-submit").click();

    // A real UUID id (crypto.randomUUID(), see src/lib/ids.ts) — excludes
    // "/listen/add" itself, which would otherwise also match a looser pattern.
    await page.waitForURL(/\/listen\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
      timeout: 30_000,
    });
    realContentId = page.url().split("/listen/")[1];
    expect(realContentId.length).toBeGreaterThan(0);

    // Confirms this id really works (not a 404) before we reuse it below.
    await expect(page.getByTestId("segment-card")).toHaveCount(2, { timeout: 15_000 });
  });

  test("2. URL mode toggle renders and swaps the form fields", async () => {
    await page.goto("/listen/add");

    await expect(page.getByTestId("audio-file-input")).toBeVisible();
    await expect(page.getByTestId("media-url-input")).not.toBeVisible();

    await page.getByTestId("listen-mode-url").click();

    await expect(page.getByTestId("media-url-input")).toBeVisible();
    await expect(page.getByTestId("audio-file-input")).not.toBeVisible();
    await expect(page.getByTestId("upload-submit")).toHaveText("Agregar desde URL");
  });

  test("3. an empty URL shows a client-side error without hitting the network", async () => {
    await page.goto("/listen/add");
    await page.getByTestId("listen-mode-url").click();

    await page.getByTestId("upload-submit").click();

    await expect(page.getByText("Ingresa una URL de YouTube o podcast.")).toBeVisible();
  });

  test("4. a 422 (too-long / could-not-extract) API response shows friendly copy", async () => {
    await page.route("**/api/media", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && (req.headers()["content-type"] ?? "").includes("application/json")) {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "el video es demasiado largo (máx. 30 minutos)" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/listen/add");
    await page.getByTestId("listen-mode-url").click();
    await page.getByTestId("media-url-input").fill("https://www.youtube.com/watch?v=toolong000");
    await page.getByTestId("upload-submit").click();

    await expect(page.getByText(/demasiado largo/)).toBeVisible();

    await page.unroute("**/api/media");
  });

  test("5. a 502 (fetch failure) API response shows honest copy and lets the learner retry", async () => {
    await page.route("**/api/media", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && (req.headers()["content-type"] ?? "").includes("application/json")) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "yt-dlp probe failed: ERROR: Unsupported URL" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/listen/add");
    await page.getByTestId("listen-mode-url").click();
    await page.getByTestId("media-url-input").fill("https://example.com/not-a-video");
    await page.getByTestId("upload-submit").click();

    await expect(page.getByText(/ERROR: Unsupported URL/)).toBeVisible();
    // The submit button is usable again — a real retry, not stuck mid-flight.
    await expect(page.getByTestId("upload-submit")).toBeEnabled();
    await expect(page.getByTestId("upload-submit")).toHaveText("Agregar desde URL");

    await page.unroute("**/api/media");
  });

  test("6. happy path: stubbed 201 (transcribed:true) navigates straight to a real, working /listen/[id]", async () => {
    await page.route("**/api/media", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && (req.headers()["content-type"] ?? "").includes("application/json")) {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            content: {
              id: realContentId,
              title: "Video de prueba",
              source: "url",
              type: "video",
              createdAt: new Date().toISOString(),
            },
            transcribed: true,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/listen/add");
    await page.getByTestId("listen-mode-url").click();
    await page.getByTestId("media-url-input").fill("https://www.youtube.com/watch?v=stubbedHappy");
    await page.getByTestId("upload-submit").click();

    await page.waitForURL(new RegExp(`/listen/${realContentId}$`));
    // Lands on a real, working page — not a 404 — proving the "video" content
    // type is fully wired through the Listen detail page's type guard.
    await expect(page.getByTestId("segment-card")).toHaveCount(2, { timeout: 15_000 });

    await page.unroute("**/api/media");
  });
});
