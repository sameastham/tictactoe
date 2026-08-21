import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { events } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import { LearnerBlockSchema, type Candidate } from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";
import { buildLearnerBlock, loadLearnerConfig } from "@/server/learner";
import { createContent, recordDecision } from "@/server/repo";

function insertEvent(db: Db, type: "produced_error", payload: unknown, createdAt: Date) {
  db.insert(events)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      type,
      surface: "talk",
      payload: payload as never,
      createdAt,
    })
    .run();
}

/** Inserts a `produced_error` event carrying a real `taxonomy` column (what `deriveRecentErrorTagCounts` reads), unlike `insertEvent`'s payload-only rows. */
function insertTaggedError(db: Db, tag: TaxonomyTag, createdAt: Date) {
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

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: overrides.id ?? "cand_1",
    chunk: "a ver si",
    origin_sentence: "A ver si llegamos a tiempo hoy.",
    register: "neutral",
    why: "common discourse marker",
    contrast_set: null,
    taxonomy: ["discourse"],
    ...overrides,
  };
}

describe("buildLearnerBlock", () => {
  it("returns a schema-valid block with variant Mexican Spanish and no due_items on an empty db", () => {
    const db = createTestDb();
    const block = buildLearnerBlock(db);

    expect(() => LearnerBlockSchema.parse(block)).not.toThrow();
    expect(block.variant).toBe("Mexican Spanish");
    expect(block.due_items).toEqual([]);
    expect(block.recent_errors).toEqual([]);
    expect(block.level).toBeTruthy();
    expect(block.goal).toBeTruthy();
    // Below the 5-event derivation threshold: falls back to the static config.
    expect(block.weak_categories).toEqual(loadLearnerConfig().weak_categories);
  });

  it("derives weak_categories from produced_error events once >=5 exist in the last 30 days", () => {
    const db = createTestDb();
    const now = new Date();
    // 4 word_choice, 3 grammar, 2 preposition, 1 collocation = 10 total (>=5).
    for (let i = 0; i < 4; i++) insertTaggedError(db, "word_choice", now);
    for (let i = 0; i < 3; i++) insertTaggedError(db, "grammar", now);
    for (let i = 0; i < 2; i++) insertTaggedError(db, "preposition", now);
    insertTaggedError(db, "collocation", now);

    const block = buildLearnerBlock(db);

    // Top 3 by frequency, most frequent first — collocation (count 1) excluded.
    expect(block.weak_categories).toEqual(["word_choice", "grammar", "preposition"]);
  });

  it("stays on the config fallback when fewer than 5 produced_error events exist in the last 30 days", () => {
    const db = createTestDb();
    const now = new Date();
    insertTaggedError(db, "word_choice", now);
    insertTaggedError(db, "word_choice", now);
    insertTaggedError(db, "word_choice", now);
    insertTaggedError(db, "word_choice", now); // 4 total — below the threshold of 5.

    const block = buildLearnerBlock(db);

    expect(block.weak_categories).toEqual(loadLearnerConfig().weak_categories);
  });

  it("due_items reflects items due after a capture", () => {
    const db = createTestDb();
    const content = createContent(db, {
      source: "paste",
      type: "paste",
      text: "Texto de prueba suficientemente largo para superar la validación de longitud mínima de contenido.",
    });
    const candidate = makeCandidate();
    recordDecision(db, {
      contentId: content.id,
      candidateId: candidate.id,
      action: "keep",
      candidate,
      promptVersion: "v1",
    });

    const block = buildLearnerBlock(db);

    // A freshly captured item's FSRS card is born due — see src/server/scheduler.ts.
    expect(block.due_items).toContain("a ver si");
  });

  it("pulls the 5 most recent produced_error events, most recent first", () => {
    const db = createTestDb();
    const base = Date.now();
    for (let i = 0; i < 7; i++) {
      insertEvent(
        db,
        "produced_error",
        { tag: "collocation", example: `error ejemplo ${i}` },
        new Date(base + i * 1000),
      );
    }

    const block = buildLearnerBlock(db);

    expect(block.recent_errors).toHaveLength(5);
    // Most recent (i=6) first, down through i=2 — the two oldest are excluded.
    expect(block.recent_errors.map((e) => e.example)).toEqual([
      "error ejemplo 6",
      "error ejemplo 5",
      "error ejemplo 4",
      "error ejemplo 3",
      "error ejemplo 2",
    ]);
  });

  it("skips malformed produced_error payloads defensively instead of throwing", () => {
    const db = createTestDb();
    insertEvent(db, "produced_error", { tag: "not_a_real_tag", example: "bad tag" }, new Date());
    insertEvent(db, "produced_error", { tag: "register" }, new Date());
    insertEvent(db, "produced_error", "not even an object", new Date());
    insertEvent(db, "produced_error", { tag: "grammar", example: "buen ejemplo" }, new Date());

    const block = buildLearnerBlock(db);

    expect(block.recent_errors).toEqual([{ tag: "grammar", example: "buen ejemplo" }]);
  });
});
