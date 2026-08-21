import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { events } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import { LearnerBlockSchema } from "@/lib/contracts";
import { buildLearnerBlock } from "@/server/learner";

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
    expect(block.weak_categories.length).toBeGreaterThan(0);
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
