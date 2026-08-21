import { test, expect, devices, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the Fix surface: capture two items (via API — the
 * capture loop itself is already covered by read-flow.spec.ts), open the
 * Reto composer, target one of those items, write text containing a known
 * fixture error ("hacer sentido"), submit, and verify the judged result page
 * (span-highlighted issue, credit strip, unattested better_version) plus the
 * override ("¿No estás de acuerdo?") control end to end, including that the
 * judgment survives a reload.
 *
 * Structured as one `describe.serial` sharing a single page/context, same
 * idiom as read-flow.spec.ts, for the same reason: a failure at any step
 * reports exactly which part of the flow broke.
 */

/** Four unrelated 6+ word sentences, mirroring read-flow's ADD_FLOW_TEXT shape
 * — enough for the fixture provider's synthetic (non-canned) extraction path
 * to yield real, order-preserved candidates (<=10 sentences -> no reordering). */
const CONTENT_TEXT = [
  "Todos los estudiantes practican nuevas palabras cada mañana temprano.",
  "Muchas personas disfrutan mucho la música latina en la radio.",
  "Casi siempre llueve bastante fuerte durante el otoño mexicano.",
  "Cada semana intentamos escribir varias cartas largas para practicar.",
].join(" ");

test.describe.serial("Fix flow", () => {
  let context: BrowserContext;
  let page: Page;
  let itemAId: string;
  let itemAChunk: string;
  let itemBId: string;
  let itemBChunk: string;
  let writingId: string;
  let fixText: string;

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

    // Composed here (not before itemAChunk is known): one sentence uses the
    // targeted chunk verbatim (natural — for the sentence-0 override later),
    // one trips the fixture's "hacer sentido" -> incorrect rule, two are
    // plain filler. Deliberately avoids any phrase containing "sentido" so
    // the judge's better_version ("tener sentido") cannot accidentally be
    // attested against *this* content (see step 4's attestation check).
    fixText = [
      `Hoy ${itemAChunk} mucho antes del examen.`,
      "Para mí, eso no hacer sentido en absoluto.",
      "Vamos a comer tacos mañana por la tarde con amigos.",
      "El clima estuvo agradable durante todo el fin de semana.",
    ].join(" ");
  });

  test("2. /fix/write's Reto mode shows chips for the captured items", async () => {
    await page.goto("/fix/write");
    await page.getByTestId("mode-reto").click();

    const chipA = page.locator(`[data-testid="item-chip"][data-item-id="${itemAId}"]`);
    const chipB = page.locator(`[data-testid="item-chip"][data-item-id="${itemBId}"]`);
    await expect(chipA).toBeVisible();
    await expect(chipB).toBeVisible();
    await expect(chipA).toHaveText(itemAChunk);
    await expect(chipB).toHaveText(itemBChunk);
  });

  test("3. selecting only one chip, writing an erroneous sentence, and submitting judges the writing", async () => {
    // Deselect every chip except itemA (the composer preselects the most
    // recent 3 by default, which — with only these two items existing —
    // would otherwise select both).
    const chips = page.locator('[data-testid="item-chip"]');
    const count = await chips.count();
    for (let i = 0; i < count; i++) {
      const chip = chips.nth(i);
      const id = await chip.getAttribute("data-item-id");
      const selected = (await chip.getAttribute("data-selected")) === "true";
      if (id === itemAId && !selected) await chip.click();
      if (id !== itemAId && selected) await chip.click();
    }
    await expect(page.locator(`[data-testid="item-chip"][data-item-id="${itemAId}"]`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.locator(`[data-testid="item-chip"][data-item-id="${itemBId}"]`)).toHaveAttribute(
      "data-selected",
      "false",
    );

    await page.getByTestId("fix-textarea").fill(fixText);
    await page.getByTestId("fix-submit").click();

    // Ids are UUIDs (`crypto.randomUUID()`) — matched explicitly rather than
    // with a generic `/\/fix\/[^/]+$/`, which would also match the *current*
    // "/fix/write" URL and resolve before the actual navigation happens.
    await page.waitForURL(/\/fix\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    writingId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;
    expect(writingId).toBeTruthy();

    await expect(page.getByTestId("sentence-list")).toBeVisible();
    await expect(page.locator('[data-testid="sentence-card"]')).toHaveCount(4);
  });

  test("4. the incorrect sentence highlights its span and shows an unverified better version", async () => {
    const incorrectCard = page.locator('[data-testid="sentence-card"][data-rung="incorrect"]');
    await expect(incorrectCard).toHaveCount(1);
    await expect(incorrectCard.getByTestId("sentence-rung-badge")).toHaveText("Incorrecta");

    const issueMark = incorrectCard.getByTestId("issue-mark");
    await expect(issueMark).toHaveCount(1);
    await expect(issueMark).toHaveText("hacer sentido");

    // Tapping the highlighted span expands the fix + note + tag chip.
    await issueMark.click();
    const detail = incorrectCard.getByTestId("issue-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("tener sentido");

    const betterVersion = incorrectCard.getByTestId("better-version");
    await expect(betterVersion).toBeVisible();
    await expect(betterVersion).toContainText("tener sentido");
    // Neither this content's text nor the seeded café article contains
    // "tener sentido" verbatim, so the judge's attestation check
    // (`isAttested` against the whole content store) must come back false —
    // deterministic regardless of the other e2e spec's run order.
    await expect(betterVersion.getByTestId("unverified-badge")).toBeVisible();
    await expect(betterVersion.getByTestId("attested-badge")).toHaveCount(0);
  });

  test("5. the credit strip shows the used chunk and not the avoided one", async () => {
    const strip = page.getByTestId("credit-strip");
    await expect(strip).toBeVisible();

    const usedChips = strip.getByTestId("credit-used-chip");
    await expect(usedChips).toHaveCount(1);
    await expect(usedChips.first()).toHaveText(itemAChunk);

    // itemB was never selected as a target, so it can't appear as used *or*
    // avoided (the judge only ever reports on the target_items it was sent) —
    // the "absent" half of "absent-or-in-avoided".
    await expect(strip.getByTestId("credit-avoided-chip")).toHaveCount(0);
    await expect(page.getByText(itemBChunk, { exact: false })).toHaveCount(0);
  });

  test("6. overriding sentence 0 registers the verdict and locks the control", async () => {
    const firstCard = page.locator('[data-testid="sentence-card"]').first();
    await expect(firstCard).toHaveAttribute("data-rung", "natural");

    await firstCard.getByTestId("override-trigger").click();
    await expect(firstCard.getByTestId("override-picker")).toBeVisible();

    await firstCard.getByTestId("override-rung-acceptable").click();
    await firstCard.getByTestId("override-submit").click();

    await expect(firstCard.getByTestId("override-confirmation")).toHaveText("Registrado — tu veredicto manda.");
    await expect(firstCard.getByTestId("override-picker")).toHaveCount(0);
    await expect(firstCard.getByTestId("override-trigger")).toHaveCount(0);
  });

  test("7. reloading the result page still shows the persisted judgment", async () => {
    await page.reload();
    await expect(page.getByTestId("sentence-list")).toBeVisible();
    await expect(page.locator('[data-testid="sentence-card"]')).toHaveCount(4);
    await expect(page.locator('[data-testid="sentence-card"][data-rung="incorrect"]')).toHaveCount(1);
    await expect(page.getByTestId("credit-strip")).toBeVisible();
  });
});
