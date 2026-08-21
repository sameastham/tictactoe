import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import {
  AlreadyDecidedError,
  createContent,
  createSession,
  getContent,
  getDecisions,
  listContent,
  recordDecision,
  saveExtraction,
} from "@/server/repo";
import { content, events, items } from "@/db/schema";
import type { Candidate, StoredExtraction } from "@/lib/contracts";

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

// Sanity check that content table starts empty per test (fresh :memory: db).
describe("createTestDb isolation", () => {
  it("starts with no content rows", () => {
    expect(db.select().from(content).all()).toHaveLength(0);
  });
});
