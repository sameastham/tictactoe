import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Talk surface: start a session from the "Hablar"
 * tab, confirm the tutor's opening line renders before anything is sent,
 * exchange two learner messages (the first deliberately trips the fixture
 * judge's "hacer sentido" -> incorrect rule, mirroring fix-flow.spec.ts's own
 * use of that literal string), end the session, verify the post-session
 * report (judged sentence ladder, "Para practicar" list, transcript toggle),
 * then leave and come back via the session list to confirm the report
 * re-renders from the `GET /api/talk/[sessionId]/report` path rather than
 * being recomputed.
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as the other *-flow specs, for the same reason: a failure at any
 * step reports exactly which part of the flow broke.
 */

const FIRST_MESSAGE = "Para mí eso no hacer sentido, pero está interesante.";
const SECOND_MESSAGE = "Aun así, creo que vale la pena seguir platicando del tema.";

test.describe.serial("Talk flow", () => {
  let context: BrowserContext;
  let page: Page;
  let sessionId: string;

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

  test("0. GET /api/items/by-ids resolves item ids to chunk text (backs the live credit chips after ending)", async () => {
    const contentRes = await page.request.post("/api/content", {
      data: {
        text: [
          "Todos los estudiantes practican nuevas palabras cada mañana temprano.",
          "Muchas personas disfrutan mucho la música latina en la radio.",
        ].join(" "),
      },
    });
    const contentId = ((await contentRes.json()) as { content: { id: string } }).content.id;
    const extractRes = await page.request.post(`/api/content/${contentId}/extract`);
    const candidate = (
      (await extractRes.json()) as { extraction: { result: { candidates: { id: string; chunk: string }[] } } }
    ).extraction.result.candidates[0];
    const decisionRes = await page.request.post("/api/decisions", {
      data: { contentId, candidateId: candidate.id, action: "keep" },
    });
    const itemId = ((await decisionRes.json()) as { itemId: string }).itemId;

    const res = await page.request.get(`/api/items/by-ids?ids=${itemId},does-not-exist`);
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: { id: string; chunk: string }[] };
    expect(data.items).toEqual([{ id: itemId, chunk: candidate.chunk }]);
  });

  test("1. the Hablar tab opens the Talk list with a prominent start button", async () => {
    await page.goto("/");
    await page.getByTestId("tab-hablar").click();
    await expect(page).toHaveURL(/\/talk$/);
    await expect(page.getByTestId("start-talk")).toBeVisible();
  });

  test("2. starting a talk drops into the chat view with the tutor's opening bubble, tab bar hidden", async () => {
    await page.getByTestId("start-talk").click();
    await page.waitForURL(/\/talk\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    sessionId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;
    expect(sessionId).toBeTruthy();

    await expect(page.getByTestId("talk-transcript")).toBeVisible();
    const tutorBubbles = page.locator('[data-testid="talk-bubble"][data-role="tutor"]');
    await expect(tutorBubbles).toHaveCount(1);
    await expect(page.locator('[data-testid="talk-bubble"][data-role="learner"]')).toHaveCount(0);

    // Immersive chat view: the bottom tab bar is hidden, same as /read/[id] and /fix/[id].
    await expect(page.getByTestId("tab-hablar")).toHaveCount(0);
  });

  test("3. sending a message (with a known fixture trigger) appends a learner bubble and a tutor reply", async () => {
    await page.getByTestId("talk-input").fill(FIRST_MESSAGE);
    await page.getByTestId("talk-send").click();

    const learnerBubbles = page.locator('[data-testid="talk-bubble"][data-role="learner"]');
    await expect(learnerBubbles).toHaveCount(1);
    await expect(learnerBubbles.first()).toHaveText(FIRST_MESSAGE);

    const tutorBubbles = page.locator('[data-testid="talk-bubble"][data-role="tutor"]');
    await expect(tutorBubbles).toHaveCount(2, { timeout: 10_000 });
    await expect(tutorBubbles.nth(1)).toHaveText(
      "Órale, qué interesante lo que dices. ¿Y tú por qué crees que pasa así?",
    );

    // No mid-conversation correction of any kind — the fixture reply never
    // mentions the learner's Spanish, and nothing on the page marks the
    // learner bubble as wrong.
    await expect(page.getByTestId("issue-mark")).toHaveCount(0);
  });

  test("4. sending a second message appends another exchange", async () => {
    await page.getByTestId("talk-input").fill(SECOND_MESSAGE);
    await page.getByTestId("talk-send").click();

    await expect(page.locator('[data-testid="talk-bubble"][data-role="learner"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="talk-bubble"][data-role="tutor"]')).toHaveCount(3, { timeout: 10_000 });
  });

  test("5. ending the session shows the post-session report", async () => {
    await page.getByTestId("talk-end").click();
    await expect(page.getByTestId("talk-report")).toBeVisible({ timeout: 15_000 });

    const incorrectCards = page.locator('[data-testid="sentence-card"][data-rung="incorrect"]');
    await expect(incorrectCards).toHaveCount(1);
    await expect(incorrectCards.getByTestId("sentence-rung-badge")).toHaveText("Incorrecta");
    await expect(incorrectCards.getByTestId("issue-mark")).toHaveText("hacer sentido");

    await expect(page.getByTestId("practice-next")).toBeVisible();
    await expect(page.getByTestId("practice-next-item").first()).not.toHaveText("");
  });

  test("6. the transcript toggle shows and hides the reviewed chat", async () => {
    await expect(page.getByTestId("talk-transcript-review")).toHaveCount(0);
    await page.getByTestId("toggle-transcript").click();
    await expect(page.getByTestId("talk-transcript-review")).toBeVisible();
    await expect(page.locator('[data-testid="talk-transcript-review"] [data-testid="talk-bubble"]')).toHaveCount(5);
    await page.getByTestId("toggle-transcript").click();
    await expect(page.getByTestId("talk-transcript-review")).toHaveCount(0);
  });

  test("7. back on /talk, the ended session is listed with 'Ver reporte'", async () => {
    await page.goto("/talk");
    const card = page.locator(`[data-testid="talk-session-card"][href="/talk/${sessionId}"]`);
    await expect(card).toContainText("Ver reporte");
  });

  test("8. opening the session again renders the report directly via the GET report path", async () => {
    await page.goto(`/talk/${sessionId}`);
    await expect(page.getByTestId("talk-report")).toBeVisible();
    await expect(page.locator('[data-testid="sentence-card"][data-rung="incorrect"]')).toHaveCount(1);
    await expect(page.getByTestId("practice-next")).toBeVisible();
  });
});
