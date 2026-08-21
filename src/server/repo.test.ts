import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import {
  AlreadyDecidedError,
  SentenceIndexOutOfRangeError,
  WritingNotJudgedError,
  createContent,
  createSession,
  createWriting,
  getContent,
  getDecisions,
  getItemsByIds,
  getWriting,
  hasAdjudication,
  listContent,
  listRecentItems,
  recordAdjudication,
  recordDecision,
  recordJudgmentEvents,
  saveExtraction,
  saveJudgment,
} from "@/server/repo";
import { content, events, goldSet, items, writings } from "@/db/schema";
import type { Candidate, JudgeResult, JudgeTargetItem, StoredExtraction } from "@/lib/contracts";

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: overrides.id ?? "cand_1",
    chunk: "a ver si",
    origin_sentence: "A ver si llegamos a tiempo.",
    register: "neutral",
    why: "common discourse marker",
    contrast_set: null,
    taxonomy: ["discourse"],
    ...overrides,
  };
}

/**
 * Directly inserts a minimal items row with a caller-chosen id — `events.item_id`
 * carries a foreign key to `items`, so any test that writes an event with an
 * `itemId` needs a real row for it to reference.
 */
function insertItem(db: Db, id: string, chunk: string): void {
  db.insert(items)
    .values({
      id,
      userId: "u_local",
      chunk,
      register: "neutral",
      contrastSet: null,
      originContentId: null,
      originSentence: `Origen de prueba: ${chunk}.`,
      why: "test item",
      taxonomy: null,
      createdAt: new Date(),
    })
    .run();
}

function makeExtraction(candidates: Candidate[]): StoredExtraction {
  return {
    promptVersion: "v1",
    model: "claude-opus-5",
    provider: "anthropic",
    extractedAt: Date.now(),
    result: {
      difficulty: "B2",
      candidates,
    },
  };
}

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

describe("createContent / getContent", () => {
  it("round-trips a content row", () => {
    const created = createContent(db, {
      source: "paste",
      type: "paste",
      title: "Test article",
      text: "Este es un texto de prueba con suficiente longitud para pasar la validación mínima.",
    });

    expect(created.id).toBeTruthy();
    expect(created.title).toBe("Test article");

    const fetched = getContent(db, created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.text).toBe(created.text);
    expect(fetched?.createdAt).toBeInstanceOf(Date);
  });

  it("returns undefined for a missing id", () => {
    expect(getContent(db, "does-not-exist")).toBeUndefined();
  });
});

describe("recordDecision", () => {
  function seedContent() {
    return createContent(db, {
      source: "paste",
      type: "paste",
      text: "Texto de prueba suficientemente largo para superar la validación de longitud mínima.",
    });
  }

  it("keep creates an items row and a captured event with the right payload", () => {
    const c = seedContent();
    const candidate = makeCandidate({ id: "cand_keep" });

    const result = recordDecision(db, {
      contentId: c.id,
      candidateId: candidate.id,
      action: "keep",
      candidate,
      promptVersion: "v1",
    });

    expect(result.itemId).toBeTruthy();

    const itemRows = db.select().from(items).all();
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0].id).toBe(result.itemId);
    expect(itemRows[0].chunk).toBe(candidate.chunk);
    expect(itemRows[0].originContentId).toBe(c.id);

    const eventRows = db.select().from(events).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].type).toBe("captured");
    expect(eventRows[0].itemId).toBe(result.itemId);
    expect(eventRows[0].contentId).toBe(c.id);
    expect(eventRows[0].payload).toEqual({
      candidateId: candidate.id,
      candidate,
      promptVersion: "v1",
    });
  });

  it("discard creates only a discarded event, no items row", () => {
    const c = seedContent();
    const candidate = makeCandidate({ id: "cand_discard" });

    const result = recordDecision(db, {
      contentId: c.id,
      candidateId: candidate.id,
      action: "discard",
      candidate,
      promptVersion: "v1",
    });

    expect(result.itemId).toBeUndefined();

    const itemRows = db.select().from(items).all();
    expect(itemRows).toHaveLength(0);

    const eventRows = db.select().from(events).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].type).toBe("discarded");
    expect(eventRows[0].itemId).toBeNull();
    expect(eventRows[0].payload).toEqual({
      candidateId: candidate.id,
      candidate,
      promptVersion: "v1",
    });
  });

  it("throws AlreadyDecidedError on a second decision for the same candidate, with no extra rows", () => {
    const c = seedContent();
    const candidate = makeCandidate({ id: "cand_twice" });

    recordDecision(db, {
      contentId: c.id,
      candidateId: candidate.id,
      action: "keep",
      candidate,
      promptVersion: "v1",
    });

    const itemsBefore = db.select().from(items).all();
    const eventsBefore = db.select().from(events).all();

    expect(() =>
      recordDecision(db, {
        contentId: c.id,
        candidateId: candidate.id,
        action: "discard",
        candidate,
        promptVersion: "v1",
      }),
    ).toThrow(AlreadyDecidedError);

    const itemsAfter = db.select().from(items).all();
    const eventsAfter = db.select().from(events).all();
    expect(itemsAfter).toHaveLength(itemsBefore.length);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});

describe("getDecisions", () => {
  it("reflects keep and discard decisions for two candidates", () => {
    const c = createContent(db, {
      source: "paste",
      type: "paste",
      text: "Otro texto de prueba con longitud suficiente para pasar la validación mínima exigida.",
    });
    const kept = makeCandidate({ id: "cand_a" });
    const discarded = makeCandidate({ id: "cand_b" });

    recordDecision(db, {
      contentId: c.id,
      candidateId: kept.id,
      action: "keep",
      candidate: kept,
      promptVersion: "v1",
    });
    recordDecision(db, {
      contentId: c.id,
      candidateId: discarded.id,
      action: "discard",
      candidate: discarded,
      promptVersion: "v1",
    });

    const decisions = getDecisions(db, c.id);
    expect(decisions).toEqual({
      cand_a: "keep",
      cand_b: "discard",
    });
  });
});

describe("listContent", () => {
  it("returns decidedCount/candidateCount after saveExtraction and a decision", () => {
    const c = createContent(db, {
      source: "paste",
      type: "paste",
      text: "Texto de prueba con longitud suficiente para superar la validación mínima requerida.",
    });

    const candidateA = makeCandidate({ id: "cand_list_a" });
    const candidateB = makeCandidate({ id: "cand_list_b" });
    saveExtraction(db, c.id, makeExtraction([candidateA, candidateB]));

    recordDecision(db, {
      contentId: c.id,
      candidateId: candidateA.id,
      action: "keep",
      candidate: candidateA,
      promptVersion: "v1",
    });

    const list = listContent(db);
    const row = list.find((r) => r.id === c.id);
    expect(row).toBeDefined();
    expect(row?.candidateCount).toBe(2);
    expect(row?.decidedCount).toBe(1);
  });
});

describe("saveExtraction", () => {
  it("sets difficulty on the content row", () => {
    const c = createContent(db, {
      source: "paste",
      type: "paste",
      text: "Un texto más de prueba con longitud suficiente para superar la validación mínima.",
    });
    expect(c.difficulty).toBeNull();

    saveExtraction(db, c.id, makeExtraction([makeCandidate()]));

    const updated = getContent(db, c.id);
    expect(updated?.difficulty).toBe("B2");
    expect(updated?.extraction?.result.candidates).toHaveLength(1);
  });
});

describe("createSession", () => {
  it("creates a session row", () => {
    const session = createSession(db, { surface: "read" });
    expect(session.id).toBeTruthy();
    expect(session.surface).toBe("read");
    expect(session.startedAt).toBeInstanceOf(Date);
  });
});

// -----------------------------------------------------------------------------
// writings / judgment events / adjudication (Fix surface)
// -----------------------------------------------------------------------------

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    sentences: [
      {
        sentence: "Esto no puede hacer sentido.",
        rung: "incorrect",
        issues: [
          {
            tag: "word_choice",
            severity: "major",
            span: "hacer sentido",
            fix: "tener sentido",
            note: "calco del inglés",
          },
          {
            tag: "redundancy",
            severity: "minor",
            span: "no puede",
            fix: "no",
            note: "innecesario",
          },
        ],
        better_version: "Esto no tiene sentido.",
        better_version_attested: false,
      },
      {
        sentence: "Voy al mercado los sábados.",
        rung: "natural",
        issues: [],
        better_version: null,
        better_version_attested: false,
      },
    ],
    items_used: [],
    items_avoided: [],
    ...overrides,
  };
}

describe("createWriting / getWriting / saveJudgment", () => {
  it("round-trips a writing and persists a saved judgment", () => {
    const w = createWriting(db, { task: "Describe tu rutina.", text: "Voy al mercado los sábados." });
    expect(w.id).toBeTruthy();
    expect(w.judgment).toBeNull();

    const judgment = makeJudgeResult();
    saveJudgment(db, w.id, judgment, "v1", "fixture");

    const fetched = getWriting(db, w.id);
    expect(fetched?.judgment).toEqual(judgment);
    expect(fetched?.promptVersion).toBe("v1");
    expect(fetched?.model).toBe("fixture");
  });
});

describe("recordJudgmentEvents", () => {
  it("writes one produced_error event per issue on an incorrect sentence, in one transaction", () => {
    const w = createWriting(db, { task: null, text: "Esto no puede hacer sentido. Voy al mercado los sábados." });
    const judgment = makeJudgeResult();

    const counts = recordJudgmentEvents(db, { writingId: w.id, judgment, targetItems: [] });

    expect(counts.producedError).toBe(2);
    const errorEvents = db.select().from(events).where(eq(events.type, "produced_error")).all();
    expect(errorEvents).toHaveLength(2);
    expect(errorEvents.map((e) => e.taxonomy).sort()).toEqual(["redundancy", "word_choice"]);
    for (const e of errorEvents) {
      expect(e.surface).toBe("fix");
      expect((e.payload as { writingId: string }).writingId).toBe(w.id);
    }
  });

  it("writes a produced_ok event with itemId for each used target item", () => {
    const w = createWriting(db, { task: null, text: "Esto no puede hacer sentido. Voy al mercado los sábados." });
    insertItem(db, "it_used", "al mercado");
    const targetItems: JudgeTargetItem[] = [{ id: "it_used", chunk: "al mercado" }];
    const judgment = makeJudgeResult({ items_used: ["it_used"], items_avoided: [] });

    const counts = recordJudgmentEvents(db, { writingId: w.id, judgment, targetItems });

    expect(counts.producedOk).toBe(1);
    const okEvents = db.select().from(events).where(eq(events.type, "produced_ok")).all();
    expect(okEvents).toHaveLength(1);
    expect(okEvents[0].itemId).toBe("it_used");
    expect(okEvents[0].payload).toMatchObject({
      itemId: "it_used",
      chunk: "al mercado",
      sentence: "Voy al mercado los sábados.",
      rung: "natural",
      writingId: w.id,
    });
  });

  it("writes an item_avoided event for each avoided target item", () => {
    const w = createWriting(db, { task: "tarea de prueba", text: "Esto no puede hacer sentido." });
    insertItem(db, "it_avoided", "hacer la maleta");
    const targetItems: JudgeTargetItem[] = [{ id: "it_avoided", chunk: "hacer la maleta" }];
    const judgment = makeJudgeResult({ items_used: [], items_avoided: ["it_avoided"] });

    const counts = recordJudgmentEvents(db, { writingId: w.id, judgment, targetItems, task: "tarea de prueba" });

    expect(counts.itemAvoided).toBe(1);
    const avoidedEvents = db.select().from(events).where(eq(events.type, "item_avoided")).all();
    expect(avoidedEvents).toHaveLength(1);
    expect(avoidedEvents[0].itemId).toBe("it_avoided");
    expect(avoidedEvents[0].payload).toEqual({
      itemId: "it_avoided",
      chunk: "hacer la maleta",
      writingId: w.id,
      task: "tarea de prueba",
    });
  });
});

describe("recordAdjudication", () => {
  it("writes an adjudicated event and a gold_set row", () => {
    const w = createWriting(db, { task: null, text: "Esto no puede hacer sentido. Voy al mercado los sábados." });
    saveJudgment(db, w.id, makeJudgeResult(), "v1", "fixture");

    const { goldSetId } = recordAdjudication(db, {
      writingId: w.id,
      sentenceIndex: 0,
      learnerRung: "acceptable",
      note: "creo que sí se entiende",
    });

    expect(goldSetId).toBeTruthy();

    const adjEvents = db.select().from(events).where(eq(events.type, "adjudicated")).all();
    expect(adjEvents).toHaveLength(1);
    expect(adjEvents[0].payload).toEqual({
      writingId: w.id,
      sentenceIndex: 0,
      sentence: "Esto no puede hacer sentido.",
      modelRung: "incorrect",
      learnerRung: "acceptable",
      note: "creo que sí se entiende",
    });

    const goldRows = db.select().from(goldSet).where(eq(goldSet.id, goldSetId)).all();
    expect(goldRows).toHaveLength(1);
    expect(goldRows[0].sentence).toBe("Esto no puede hacer sentido.");
    expect(goldRows[0].set).toBe("adjudicated");
    expect(goldRows[0].expectedRung).toBe("acceptable");
    expect(goldRows[0].origin).toBe(`fix_override:${w.id}`);
  });

  it("throws WritingNotJudgedError for a writing with no judgment", () => {
    const w = createWriting(db, { task: null, text: "Sin juzgar todavía." });
    expect(() => recordAdjudication(db, { writingId: w.id, sentenceIndex: 0, learnerRung: "natural" })).toThrow(
      WritingNotJudgedError,
    );
  });

  it("throws WritingNotJudgedError for a missing writing", () => {
    expect(() =>
      recordAdjudication(db, { writingId: "does-not-exist", sentenceIndex: 0, learnerRung: "natural" }),
    ).toThrow(WritingNotJudgedError);
  });

  it("throws SentenceIndexOutOfRangeError for an out-of-bounds sentenceIndex", () => {
    const w = createWriting(db, { task: null, text: "Esto no puede hacer sentido. Voy al mercado los sábados." });
    saveJudgment(db, w.id, makeJudgeResult(), "v1", "fixture");

    expect(() => recordAdjudication(db, { writingId: w.id, sentenceIndex: 5, learnerRung: "natural" })).toThrow(
      SentenceIndexOutOfRangeError,
    );
  });
});

describe("hasAdjudication", () => {
  it("is false before adjudication and true after, scoped to the exact (writingId, sentenceIndex) pair", () => {
    const w = createWriting(db, { task: null, text: "Esto no puede hacer sentido. Voy al mercado los sábados." });
    saveJudgment(db, w.id, makeJudgeResult(), "v1", "fixture");

    expect(hasAdjudication(db, w.id, 0)).toBe(false);

    recordAdjudication(db, { writingId: w.id, sentenceIndex: 0, learnerRung: "acceptable" });

    expect(hasAdjudication(db, w.id, 0)).toBe(true);
    expect(hasAdjudication(db, w.id, 1)).toBe(false);
  });
});

describe("getItemsByIds / listRecentItems", () => {
  it("getItemsByIds fetches known ids and silently drops unknown ones", () => {
    const c = createContent(db, {
      source: "paste",
      type: "paste",
      text: "Un texto de prueba con longitud suficiente para superar la validación mínima requerida.",
    });
    const candidate: Candidate = {
      id: "cand_items",
      chunk: "a ver si",
      origin_sentence: "A ver si llegamos a tiempo.",
      register: "neutral",
      why: "common discourse marker",
      contrast_set: null,
      taxonomy: ["discourse"],
    };
    const { itemId } = recordDecision(db, {
      contentId: c.id,
      candidateId: candidate.id,
      action: "keep",
      candidate,
      promptVersion: "v1",
    });

    const found = getItemsByIds(db, [itemId!, "does-not-exist"]);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(itemId);
  });

  it("listRecentItems returns items ordered most-recent-first", () => {
    const c = createContent(db, {
      source: "paste",
      type: "paste",
      text: "Otro texto de prueba con longitud suficiente para superar la validación mínima requerida.",
    });
    const candidateA: Candidate = {
      id: "cand_a",
      chunk: "a ver si",
      origin_sentence: "A ver si llegamos a tiempo.",
      register: "neutral",
      why: "why a",
      contrast_set: null,
      taxonomy: null,
    };
    const candidateB: Candidate = {
      id: "cand_b",
      chunk: "de plano",
      origin_sentence: "De plano no voy a poder.",
      register: "coloquial_mx",
      why: "why b",
      contrast_set: null,
      taxonomy: null,
    };
    recordDecision(db, { contentId: c.id, candidateId: candidateA.id, action: "keep", candidate: candidateA, promptVersion: "v1" });
    recordDecision(db, { contentId: c.id, candidateId: candidateB.id, action: "keep", candidate: candidateB, promptVersion: "v1" });

    const recent = listRecentItems(db, 10);
    expect(recent.map((r) => r.chunk).sort()).toEqual(["a ver si", "de plano"]);
  });
});

// -----------------------------------------------------------------------------
// migration coverage: the new writings table + the item_avoided event type
// -----------------------------------------------------------------------------

describe("migration 0001 (writings table, item_avoided event type)", () => {
  it("writings table is usable via createTestDb's applied migrations", () => {
    const w = createWriting(db, { task: null, text: "Texto de prueba para la migración." });
    expect(db.select().from(writings).where(eq(writings.id, w.id)).all()).toHaveLength(1);
  });

  it("events accepts type 'item_avoided'", () => {
    const w = createWriting(db, { task: null, text: "Texto de prueba para la migración." });
    insertItem(db, "it_x", "hacer la maleta");
    saveJudgment(db, w.id, makeJudgeResult({ items_used: [], items_avoided: ["it_x"] }), "v1", "fixture");
    recordJudgmentEvents(db, {
      writingId: w.id,
      judgment: makeJudgeResult({ items_used: [], items_avoided: ["it_x"] }),
      targetItems: [{ id: "it_x", chunk: "hacer la maleta" }],
    });
    const rows = db.select().from(events).where(eq(events.type, "item_avoided")).all();
    expect(rows).toHaveLength(1);
  });
});

// Sanity check that content table starts empty per test (fresh :memory: db).
describe("createTestDb isolation", () => {
  it("starts with no content rows", () => {
    expect(db.select().from(content).all()).toHaveLength(0);
  });
});
