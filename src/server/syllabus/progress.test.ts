import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { content as contentTable, events, items, writings } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type { JudgeResult } from "@/lib/contracts";
import { getUnit } from "@/server/syllabus/config";
import {
  getActiveUnit,
  getUnitEvidence,
  recordAdvance,
  tareaTaskPrefix,
  UnknownSyllabusUnitError,
} from "@/server/syllabus/progress";

const LEVEL_ID = "dyh7";
const unit1 = getUnit(LEVEL_ID, "u1")!;
const section1 = unit1.sections[0];
const construction1 = unit1.constructions[0];
const tarea1 = unit1.tareas[0];

function insertDidacticContent(db: Db, syllabusRef: string, text = "Texto de prueba."): string {
  const id = newId();
  db.insert(contentTable)
    .values({
      id,
      userId: DEFAULT_USER_ID,
      source: "upload",
      type: "article",
      title: "test",
      text,
      didactic: true,
      syllabusRef,
      createdAt: new Date(),
    })
    .run();
  return id;
}

describe("getActiveUnit", () => {
  it("returns null when nothing has been ingested and no advance event exists", () => {
    const db = createTestDb();
    expect(getActiveUnit(db)).toBeNull();
  });

  it("falls back to the first unit of the lowest-id level with any ingested content", () => {
    const db = createTestDb();
    insertDidacticContent(db, `${LEVEL_ID}/${unit1.id}/${section1.id}`);
    expect(getActiveUnit(db)).toEqual({ level: LEVEL_ID, unit: unit1.id });
  });

  it("finds a later unit's content when an earlier unit was never ingested", () => {
    const db = createTestDb();
    const unit3 = getUnit(LEVEL_ID, "u3")!;
    insertDidacticContent(db, `${LEVEL_ID}/${unit3.id}/${unit3.sections[0].id}`);
    expect(getActiveUnit(db)).toEqual({ level: LEVEL_ID, unit: unit3.id });
  });

  it("prefers the latest syllabus_advanced event over the ingested-content fallback", () => {
    const db = createTestDb();
    insertDidacticContent(db, `${LEVEL_ID}/${unit1.id}/${section1.id}`);
    const unit2 = getUnit(LEVEL_ID, "u2")!;
    recordAdvance(db, LEVEL_ID, unit2.id);
    expect(getActiveUnit(db)).toEqual({ level: LEVEL_ID, unit: unit2.id });
  });

  it("replays only the MOST RECENT syllabus_advanced event, not the first", () => {
    const db = createTestDb();
    recordAdvance(db, LEVEL_ID, "u1");
    recordAdvance(db, LEVEL_ID, "u2");
    expect(getActiveUnit(db)?.unit).toBe("u2");
  });
});

describe("recordAdvance", () => {
  it("appends a syllabus_advanced event with the level/unit payload", () => {
    const db = createTestDb();
    const { eventId } = recordAdvance(db, LEVEL_ID, "u2");
    const row = db.select().from(events).where(eq(events.id, eventId)).get()!;
    expect(row.type).toBe("syllabus_advanced");
    expect(row.payload).toEqual({ level: LEVEL_ID, unit: "u2" });
  });

  it("throws UnknownSyllabusUnitError and writes nothing for an unknown unit", () => {
    const db = createTestDb();
    expect(() => recordAdvance(db, LEVEL_ID, "u99")).toThrow(UnknownSyllabusUnitError);
    expect(db.select().from(events).all()).toHaveLength(0);
  });

  it("throws UnknownSyllabusUnitError for an unknown level", () => {
    const db = createTestDb();
    expect(() => recordAdvance(db, "not-a-real-level", "u1")).toThrow(UnknownSyllabusUnitError);
  });
});

describe("getUnitEvidence", () => {
  it("returns null for an unknown level/unit", () => {
    const db = createTestDb();
    expect(getUnitEvidence(db, "not-a-real-level", "u1")).toBeNull();
    expect(getUnitEvidence(db, LEVEL_ID, "u99")).toBeNull();
  });

  it("returns one construction entry per config construction, band null when never seeded", () => {
    const db = createTestDb();
    const evidence = getUnitEvidence(db, LEVEL_ID, unit1.id)!;
    expect(evidence.constructions).toHaveLength(unit1.constructions.length);
    for (const c of evidence.constructions) {
      expect(c.itemId).toBeNull();
      expect(c.band).toBeNull();
    }
  });

  it("surfaces a seeded construction's item and mastery band", () => {
    const db = createTestDb();
    const itemId = newId();
    db.insert(items)
      .values({
        id: itemId,
        userId: DEFAULT_USER_ID,
        chunk: construction1.chunk,
        register: "neutral",
        contrastSet: null,
        originContentId: null,
        originSentence: construction1.chunk,
        why: construction1.description,
        taxonomy: [construction1.tag],
        syllabusRef: `${LEVEL_ID}/${unit1.id}`,
        createdAt: new Date(),
      })
      .run();

    const evidence = getUnitEvidence(db, LEVEL_ID, unit1.id)!;
    const entry = evidence.constructions.find((c) => c.constructionId === construction1.id)!;
    expect(entry.itemId).toBe(itemId);
    // No signals yet -> "fragil" (see src/server/mastery.ts's consistency gate), never null once an item exists.
    expect(entry.band).toBe("fragil");
  });

  it("counts writings whose task starts with the tarea's id-prefix convention, and tallies rung distribution", () => {
    const db = createTestDb();
    const judgment: JudgeResult = {
      sentences: [
        { sentence: "Una frase.", rung: "natural", issues: [], better_version: null, better_version_attested: false },
        { sentence: "Otra frase.", rung: "acceptable", issues: [], better_version: null, better_version_attested: false },
      ],
      items_used: [],
      items_avoided: [],
    };

    db.insert(writings)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        task: `${tareaTaskPrefix(LEVEL_ID, unit1.id, tarea1.id)} ${tarea1.prompt}`,
        text: "Una frase. Otra frase.",
        judgment,
        promptVersion: "test",
        model: "test",
        sessionId: null,
        createdAt: new Date(),
      })
      .run();
    // A writing for a DIFFERENT tarea must not be counted here.
    db.insert(writings)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        task: "syllabus:dyh7/u1/t-not-this-one: algo distinto",
        text: "Texto irrelevante.",
        judgment: null,
        promptVersion: null,
        model: null,
        sessionId: null,
        createdAt: new Date(),
      })
      .run();

    const evidence = getUnitEvidence(db, LEVEL_ID, unit1.id)!;
    const entry = evidence.tareas.find((t) => t.tareaId === tarea1.id)!;
    expect(entry.writingsCount).toBe(1);
    expect(entry.rungDistribution.natural).toBe(1);
    expect(entry.rungDistribution.acceptable).toBe(1);
    expect(entry.rungDistribution.incorrect).toBe(0);
  });

  it("surfaces a section's content row and decided-candidate count", () => {
    const db = createTestDb();
    const contentId = insertDidacticContent(db, `${LEVEL_ID}/${unit1.id}/${section1.id}`);

    db.insert(events)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        type: "captured",
        surface: "read",
        contentId,
        payload: { candidateId: "c1", candidate: {} as never, promptVersion: "test" },
        createdAt: new Date(),
      })
      .run();

    const evidence = getUnitEvidence(db, LEVEL_ID, unit1.id)!;
    const entry = evidence.sections.find((s) => s.sectionId === section1.id)!;
    expect(entry.contentId).toBe(contentId);
    expect(entry.decidedCount).toBe(1);
  });

  it("reports null contentId and zero counts for a section never ingested", () => {
    const db = createTestDb();
    const evidence = getUnitEvidence(db, LEVEL_ID, unit1.id)!;
    for (const s of evidence.sections) {
      expect(s.contentId).toBeNull();
      expect(s.decidedCount).toBe(0);
      expect(s.candidateCount).toBe(0);
    }
  });
});
