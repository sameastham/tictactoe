import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { evalRuns, events, items, writings } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import { missClassToTaxonomy } from "@/lib/dictation";
import type { DictationMissClass } from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";
import { buildWeeklyReport } from "@/server/report";

const DAY_MS = 24 * 60 * 60 * 1000;

function insertItemRow(db: Db, overrides: Partial<typeof items.$inferInsert> = {}): string {
  const id = (overrides.id as string | undefined) ?? newId();
  db.insert(items)
    .values({
      id,
      userId: DEFAULT_USER_ID,
      chunk: "a fin de cuentas",
      register: "neutral",
      contrastSet: null,
      originContentId: null,
      originSentence: "A fin de cuentas, ya quedó resuelto.",
      why: "test item",
      taxonomy: null,
      createdAt: new Date(),
      ...overrides,
    })
    .run();
  return id;
}

function insertWritingRow(db: Db, text: string, createdAt: Date): void {
  db.insert(writings)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      task: null,
      text,
      judgment: null,
      promptVersion: null,
      model: null,
      sessionId: null,
      createdAt,
    })
    .run();
}

function insertErrorEvent(db: Db, tag: TaxonomyTag, createdAt: Date): void {
  db.insert(events)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      type: "produced_error",
      surface: "fix",
      taxonomy: tag,
      severity: "minor",
      payload: { tag, severity: "minor", span: "x", fix: "y", note: "z", sentence: "s", writingId: "w" },
      createdAt,
    })
    .run();
}

function insertDictationMissEvent(db: Db, missClass: DictationMissClass, createdAt: Date): void {
  db.insert(events)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      type: "dictation_miss",
      surface: "listen",
      taxonomy: missClassToTaxonomy(missClass),
      contentId: null,
      payload: {
        contentId: "c1",
        segmentIndex: 0,
        segmentText: "s",
        expected: "e",
        heard: null,
        missClass,
        attemptId: "a1",
      },
      createdAt,
    })
    .run();
}

function insertEvalRun(db: Db, overrides: Partial<typeof evalRuns.$inferInsert>): void {
  db.insert(evalRuns)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      promptName: "judge",
      promptVersion: "v1",
      model: "fixture",
      agreement: {},
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      notes: null,
      createdAt: new Date(),
      ...overrides,
    })
    .run();
}

describe("buildWeeklyReport", () => {
  it("transfer requires a >=1-day gap between capture and appearance", () => {
    const db = createTestDb();
    const now = new Date("2026-08-21T12:00:00.000Z");
    const captureAt = new Date(now.getTime() - 5 * DAY_MS);
    insertItemRow(db, { id: "item1", chunk: "a fin de cuentas", createdAt: captureAt });

    // Only 12h later — same-day appearance must NOT count.
    insertWritingRow(db, "Pues a fin de cuentas no importa tanto.", new Date(captureAt.getTime() + 12 * 60 * 60 * 1000));
    expect(buildWeeklyReport(db, now).transfer).toEqual({ count: 0, chunks: [] });

    // >=1 day later, whitespace/case-different — must count.
    insertWritingRow(db, "  A FIN   DE cuentas, ya quedó resuelto.  ", new Date(captureAt.getTime() + 25 * 60 * 60 * 1000));
    expect(buildWeeklyReport(db, now).transfer).toEqual({ count: 1, chunks: ["a fin de cuentas"] });
  });

  it("recurrence splits last-30d counts from the previous 30d window", () => {
    const db = createTestDb();
    const now = new Date("2026-08-21T12:00:00.000Z");

    // 3 grammar errors in the last 30 days.
    for (let i = 0; i < 3; i++) insertErrorEvent(db, "grammar", new Date(now.getTime() - (i + 1) * DAY_MS));
    // 5 grammar errors in the 30-60 day window before that.
    for (let i = 0; i < 5; i++) insertErrorEvent(db, "grammar", new Date(now.getTime() - (35 + i) * DAY_MS));
    // 1 preposition error, current window only.
    insertErrorEvent(db, "preposition", new Date(now.getTime() - 2 * DAY_MS));

    const report = buildWeeklyReport(db, now);

    expect(report.recurrence.find((r) => r.tag === "grammar")).toEqual({ tag: "grammar", count: 3, prevCount: 5 });
    expect(report.recurrence.find((r) => r.tag === "preposition")).toEqual({
      tag: "preposition",
      count: 1,
      prevCount: 0,
    });
    // Sorted by current count desc.
    expect(report.recurrence[0].tag).toBe("grammar");
  });

  it("counts dictation misses by class in the last 30 days, sorted desc, excluding older ones", () => {
    const db = createTestDb();
    const now = new Date("2026-08-21T12:00:00.000Z");
    insertDictationMissEvent(db, "lexical", new Date(now.getTime() - 2 * DAY_MS));
    insertDictationMissEvent(db, "lexical", new Date(now.getTime() - 3 * DAY_MS));
    insertDictationMissEvent(db, "reduction", new Date(now.getTime() - 1 * DAY_MS));
    insertDictationMissEvent(db, "lexical", new Date(now.getTime() - 40 * DAY_MS)); // outside the 30d window

    const report = buildWeeklyReport(db, now);

    expect(report.dictation).toEqual([
      { missClass: "lexical", count: 2 },
      { missClass: "reduction", count: 1 },
    ]);
  });

  it("daysUsedLast7/activeDays count distinct UTC days with any event in the trailing week", () => {
    const db = createTestDb();
    const now = new Date("2026-08-21T12:00:00.000Z");
    insertErrorEvent(db, "grammar", now);
    insertErrorEvent(db, "grammar", new Date(now.getTime() - DAY_MS)); // a different day
    insertErrorEvent(db, "grammar", new Date(now.getTime() - DAY_MS - 60_000)); // same day as the one above
    insertErrorEvent(db, "grammar", new Date(now.getTime() - 10 * DAY_MS)); // outside the trailing week

    const report = buildWeeklyReport(db, now);

    expect(report.daysUsedLast7).toBe(2);
    expect(report.activeDays).toEqual(["2026-08-20", "2026-08-21"]);
  });

  it("itemsCapturedLast7 counts only captured events in the trailing week", () => {
    const db = createTestDb();
    const now = new Date("2026-08-21T12:00:00.000Z");
    db.insert(events)
      .values([
        {
          id: newId(),
          userId: DEFAULT_USER_ID,
          type: "captured",
          surface: "read",
          payload: {},
          createdAt: new Date(now.getTime() - DAY_MS),
        },
        {
          id: newId(),
          userId: DEFAULT_USER_ID,
          type: "captured",
          surface: "read",
          payload: {},
          createdAt: new Date(now.getTime() - 10 * DAY_MS), // outside the window
        },
        {
          id: newId(),
          userId: DEFAULT_USER_ID,
          type: "discarded",
          surface: "read",
          payload: {},
          createdAt: new Date(now.getTime() - DAY_MS),
        },
      ])
      .run();

    expect(buildWeeklyReport(db, now).itemsCapturedLast7).toBe(1);
  });

  it("latestEval is null with no eval_runs, and reflects the newest row otherwise", () => {
    const db = createTestDb();
    expect(buildWeeklyReport(db).latestEval).toBeNull();

    insertEvalRun(db, { model: "fixture", createdAt: new Date(Date.now() - 60_000) });
    insertEvalRun(db, { model: "claude-opus-5", agreement: { catch_rate: 0.9 }, createdAt: new Date() });

    const report = buildWeeklyReport(db);
    expect(report.latestEval?.model).toBe("claude-opus-5");
    expect(report.latestEval?.agreement).toEqual({ catch_rate: 0.9 });
  });
});
