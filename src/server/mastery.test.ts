import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import { events, items, talkTurns, writings } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type {
  AdjudicatedPayload,
  Candidate,
  ItemAvoidedPayload,
  JudgeResult,
  ProducedErrorPayload,
  ProducedOkPayload,
  ReviewedPayload,
} from "@/lib/contracts";
import type { Rung, TaxonomyTag } from "@/lib/taxonomy";
import { createSession, type ItemRow } from "@/server/repo";
import { deriveBlocking, deriveCategoryMastery, deriveItemMastery } from "@/server/mastery";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: overrides.id ?? "cand_1",
    chunk: "a fin de cuentas",
    origin_sentence: "A fin de cuentas, ya quedó resuelto.",
    register: "neutral",
    why: "discourse marker",
    contrast_set: null,
    taxonomy: ["discourse"],
    ...overrides,
  };
}

/** Directly inserts an item row plus its `captured` event at a caller-chosen timestamp — mirrors scheduler.test.ts's `seedItemAt`. */
function seedItemAt(db: Db, createdAt: Date, overrides: Partial<Candidate> = {}): ItemRow {
  const candidate = makeCandidate(overrides);
  const itemId = newId();
  db.insert(items)
    .values({
      id: itemId,
      userId: DEFAULT_USER_ID,
      chunk: candidate.chunk,
      register: candidate.register,
      contrastSet: candidate.contrast_set,
      originContentId: null,
      originSentence: candidate.origin_sentence,
      why: candidate.why,
      taxonomy: candidate.taxonomy,
      createdAt,
    })
    .run();
  db.insert(events)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      type: "captured",
      surface: "read",
      itemId,
      contentId: null,
      payload: { candidateId: candidate.id, candidate, promptVersion: "v1" },
      createdAt,
    })
    .run();
  return db.select().from(items).where(eq(items.id, itemId)).get()!;
}

function insertReviewed(db: Db, item: ItemRow, rating: ReviewedPayload["rating"], createdAt: Date): void {
  const payload: ReviewedPayload = { itemId: item.id, chunk: item.chunk, rating, mode: "card" };
  db.insert(events)
    .values({ id: newId(), userId: DEFAULT_USER_ID, type: "reviewed", surface: "review", itemId: item.id, payload, createdAt })
    .run();
}

function insertProducedOk(db: Db, item: ItemRow, createdAt: Date, writingId = "w_test"): void {
  const payload: ProducedOkPayload = {
    itemId: item.id,
    chunk: item.chunk,
    sentence: item.originSentence,
    rung: "natural",
    writingId,
  };
  db.insert(events)
    .values({ id: newId(), userId: DEFAULT_USER_ID, type: "produced_ok", surface: "fix", itemId: item.id, payload, createdAt })
    .run();
}

function insertItemAvoided(db: Db, item: ItemRow, createdAt: Date, writingId = "w_test"): void {
  const payload: ItemAvoidedPayload = { itemId: item.id, chunk: item.chunk, writingId, task: null };
  db.insert(events)
    .values({ id: newId(), userId: DEFAULT_USER_ID, type: "item_avoided", surface: "fix", itemId: item.id, payload, createdAt })
    .run();
}

function insertAdjudicated(db: Db, sentence: string, learnerRung: Rung, createdAt: Date, modelRung: Rung = "acceptable"): void {
  const payload: AdjudicatedPayload = {
    writingId: "w_adj",
    sentenceIndex: 0,
    sentence,
    modelRung,
    learnerRung,
    note: null,
  };
  db.insert(events)
    .values({ id: newId(), userId: DEFAULT_USER_ID, type: "adjudicated", surface: "fix", payload, createdAt })
    .run();
}

function insertProducedError(
  db: Db,
  tag: TaxonomyTag,
  createdAt: Date,
  overrides: Partial<ProducedErrorPayload> = {},
): void {
  const payload: ProducedErrorPayload = {
    tag,
    severity: "minor",
    span: overrides.span ?? "hacer sentido",
    fix: overrides.fix ?? "tener sentido",
    note: "test",
    sentence: overrides.sentence ?? "Eso no hacer sentido.",
    writingId: overrides.writingId ?? "w_err",
  };
  db.insert(events)
    .values({ id: newId(), userId: DEFAULT_USER_ID, type: "produced_error", surface: "fix", taxonomy: tag, severity: "minor", payload, createdAt })
    .run();
}

/** Minimal valid `JudgeResult` for a writing row: one already-natural sentence, plus the given target-item outcomes. */
function makeJudgment(text: string, itemsUsed: string[] = [], itemsAvoided: string[] = []): JudgeResult {
  return {
    sentences: [{ sentence: text, rung: "natural", issues: [], better_version: null, better_version_attested: false }],
    items_used: itemsUsed,
    items_avoided: itemsAvoided,
  };
}

/** Inserts a `writings` row directly (no model call), optionally carrying a judgment (targeted item outcomes). */
function insertWriting(
  db: Db,
  input: { text: string; createdAt: Date; itemsUsed?: string[]; itemsAvoided?: string[]; sessionId?: string | null },
): void {
  const judgment = makeJudgment(input.text, input.itemsUsed ?? [], input.itemsAvoided ?? []);
  db.insert(writings)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      task: null,
      text: input.text,
      judgment,
      promptVersion: "v1",
      model: "fixture",
      sessionId: input.sessionId ?? null,
      createdAt: input.createdAt,
    })
    .run();
}

function insertTalkTurn(db: Db, sessionId: string, text: string, createdAt: Date): void {
  db.insert(talkTurns)
    .values({ id: newId(), userId: DEFAULT_USER_ID, sessionId, role: "learner", text, meta: null, createdAt })
    .run();
}

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

describe("deriveItemMastery — consistency rule", () => {
  it("two strong positive signals are not enough to leave 'fragil'", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 10 * DAY_MS), { id: "cand_two_strong" });
    // Two prompted productions (+2 each, fresh) = raw score 4 — inside the
    // en_progreso range by score alone, but only 2 positive signals.
    insertProducedOk(db, item, new Date(now.getTime() - 5 * DAY_MS), "w1");
    insertProducedOk(db, item, new Date(now.getTime() - 3 * DAY_MS), "w2");

    const [result] = deriveItemMastery(db, now);
    expect(result.signals.positive).toBe(2);
    expect(result.band).toBe("fragil");
  });

  it("three modest positive signals can leave 'fragil'", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 10 * DAY_MS), { id: "cand_three_modest" });
    insertReviewed(db, item, "good", new Date(now.getTime() - 6 * DAY_MS));
    insertReviewed(db, item, "good", new Date(now.getTime() - 4 * DAY_MS));
    insertReviewed(db, item, "good", new Date(now.getTime() - 2 * DAY_MS));

    const [result] = deriveItemMastery(db, now);
    expect(result.signals.positive).toBe(3);
    expect(result.band).not.toBe("fragil");
  });
});

describe("deriveItemMastery — decay", () => {
  it("the same signals dated further in the past score lower, and can drop a band", () => {
    const now = new Date();
    const freshItem = seedItemAt(db, new Date(now.getTime() - 65 * DAY_MS), { id: "cand_fresh" });
    const staleItem = seedItemAt(db, new Date(now.getTime() - 65 * DAY_MS), { id: "cand_stale" });

    for (let i = 0; i < 3; i++) {
      insertProducedOk(db, freshItem, new Date(now.getTime() - i * DAY_MS), `w_fresh_${i}`);
      insertProducedOk(db, staleItem, new Date(now.getTime() - 60 * DAY_MS - i * DAY_MS), `w_stale_${i}`);
    }

    const results = deriveItemMastery(db, now);
    const fresh = results.find((r) => r.item.id === freshItem.id)!;
    const stale = results.find((r) => r.item.id === staleItem.id)!;

    expect(stale.score).toBeLessThan(fresh.score);
    expect(fresh.band).toBe("solido"); // 3 * 2 = 6 raw, barely decayed.
    expect(stale.band).not.toBe("solido"); // same raw weight, heavily decayed.
  });
});

describe("deriveItemMastery — unprompted vs. prompted production", () => {
  it("an unprompted appearance outweighs a single targeted produced_ok at the same moment", () => {
    const now = new Date();
    const captureAt = new Date(now.getTime() - 10 * DAY_MS);
    const unpromptedItem = seedItemAt(db, captureAt, { id: "cand_unprompted", chunk: "a fin de cuentas" });
    const promptedItem = seedItemAt(db, captureAt, { id: "cand_prompted", chunk: "a fin de cuentas 2" });

    const productionAt = new Date(captureAt.getTime() + 3 * DAY_MS);
    // Unprompted: the chunk shows up in a writing where this item was never a target.
    insertWriting(db, {
      text: `Pues, a fin de cuentas, ya se resolvió todo.`,
      createdAt: productionAt,
      itemsUsed: [],
      itemsAvoided: [],
    });
    // Prompted: a produced_ok event for the other item at the same instant.
    insertProducedOk(db, promptedItem, productionAt, "w_prompted");

    const results = deriveItemMastery(db, now);
    const unprompted = results.find((r) => r.item.id === unpromptedItem.id)!;
    const prompted = results.find((r) => r.item.id === promptedItem.id)!;

    expect(unprompted.score).toBeGreaterThan(prompted.score);
  });

  it("an unprompted appearance is also detected from a learner talk turn, capped once per session group", () => {
    const now = new Date();
    const captureAt = new Date(now.getTime() - 10 * DAY_MS);
    const item = seedItemAt(db, captureAt, { id: "cand_talk_unprompted", chunk: "a fin de cuentas" });
    const session = createSession(db, { surface: "talk" });

    const turnAt = new Date(captureAt.getTime() + 2 * DAY_MS);
    insertTalkTurn(db, session.id, "Sí, a fin de cuentas todo salió bien.", turnAt);
    insertTalkTurn(db, session.id, "y a fin de cuentas otra vez, para probar el tope.", new Date(turnAt.getTime() + 1000));

    const [result] = deriveItemMastery(db, now);
    // Two matching turns in the same (un-ended) session collapse to one signal.
    expect(result.signals.positive).toBe(1);
  });

  it("does NOT credit unprompted production when the item was a judged target of that writing", () => {
    const now = new Date();
    const captureAt = new Date(now.getTime() - 10 * DAY_MS);
    const item = seedItemAt(db, captureAt, { id: "cand_targeted", chunk: "a fin de cuentas" });

    insertWriting(db, {
      text: "Pues, a fin de cuentas, ya se resolvió todo.",
      createdAt: new Date(captureAt.getTime() + 3 * DAY_MS),
      itemsUsed: [item.id],
      itemsAvoided: [],
    });

    const [result] = deriveItemMastery(db, now);
    // No standalone produced_ok event was ever recorded for this item either
    // (the writing row alone doesn't write events) — score should be 0.
    expect(result.score).toBe(0);
    expect(result.signals.positive).toBe(0);
  });
});

describe("deriveItemMastery — reviewed ratings and item_avoided", () => {
  it("a 'reviewed: again' event drags an item's score down", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 10 * DAY_MS), { id: "cand_again" });
    insertProducedOk(db, item, new Date(now.getTime() - 5 * DAY_MS), "w1");
    insertProducedOk(db, item, new Date(now.getTime() - 4 * DAY_MS), "w2");
    insertProducedOk(db, item, new Date(now.getTime() - 3 * DAY_MS), "w3");
    const [beforeAgain] = deriveItemMastery(db, now);

    insertReviewed(db, item, "again", new Date(now.getTime() - 1 * DAY_MS));
    const [afterAgain] = deriveItemMastery(db, now);

    expect(afterAgain.score).toBeLessThan(beforeAgain.score);
    expect(afterAgain.signals.negative).toBe(1);
  });

  it("an item_avoided event contributes a negative signal", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 5 * DAY_MS), { id: "cand_avoided" });
    insertItemAvoided(db, item, new Date(now.getTime() - 1 * DAY_MS));

    const [result] = deriveItemMastery(db, now);
    expect(result.signals.negative).toBe(1);
    expect(result.score).toBeLessThan(0);
    expect(result.band).toBe("fragil");
  });
});

describe("deriveItemMastery — adjudicated verdicts", () => {
  it("an adjudicated 'natural' verdict on a sentence containing the item's chunk credits it", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 5 * DAY_MS), {
      id: "cand_adjudicated",
      chunk: "a fin de cuentas",
      origin_sentence: "A fin de cuentas, ya quedó resuelto.",
    });
    insertAdjudicated(db, "Pues a fin de cuentas todo bien.", "natural", new Date(now.getTime() - 1 * DAY_MS));

    const [result] = deriveItemMastery(db, now);
    expect(result.signals.positive).toBe(1);
    expect(result.score).toBeGreaterThan(0);
  });

  it("an adjudicated verdict below 'natural' does NOT credit the item", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 5 * DAY_MS), {
      id: "cand_adjudicated_low",
      chunk: "a fin de cuentas",
    });
    insertAdjudicated(db, "Pues a fin de cuentas todo bien.", "acceptable", new Date(now.getTime() - 1 * DAY_MS));

    const [result] = deriveItemMastery(db, now);
    expect(result.item.id).toBe(item.id);
    expect(result.signals.positive).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe("deriveItemMastery — determinism", () => {
  it("two calls with the same db/now deep-equal", () => {
    const now = new Date();
    const item = seedItemAt(db, new Date(now.getTime() - 10 * DAY_MS), { id: "cand_det" });
    insertProducedOk(db, item, new Date(now.getTime() - 5 * DAY_MS), "w1");
    insertReviewed(db, item, "good", new Date(now.getTime() - 2 * DAY_MS));

    expect(deriveItemMastery(db, now)).toEqual(deriveItemMastery(db, now));
  });
});

describe("deriveCategoryMastery", () => {
  it("returns all 11 taxonomy tags, even with zero evidence", () => {
    const result = deriveCategoryMastery(db, new Date());
    expect(result).toHaveLength(11);
    expect(result.every((r) => r.band === "fragil")).toBe(true);
  });

  it("accumulates negative evidence from produced_error events for that tag", () => {
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      insertProducedError(db, "word_choice", new Date(now.getTime() - i * DAY_MS));
    }

    const result = deriveCategoryMastery(db, now);
    const wordChoice = result.find((r) => r.tag === "word_choice")!;
    const grammar = result.find((r) => r.tag === "grammar")!;

    expect(wordChoice.band).toBe("fragil");
    expect(wordChoice.errorCount30d).toBe(4);
    expect(grammar.errorCount30d).toBe(0);
  });

  it("is deterministic for a fixed now", () => {
    const now = new Date();
    insertProducedError(db, "grammar", new Date(now.getTime() - 1 * DAY_MS));
    expect(deriveCategoryMastery(db, now)).toEqual(deriveCategoryMastery(db, now));
  });
});

describe("deriveBlocking", () => {
  it("ranks the tag with more recent errors ahead of one with only older errors", () => {
    const now = new Date();
    // word_choice: recent errors (barely decayed).
    for (let i = 0; i < 3; i++) insertProducedError(db, "word_choice", new Date(now.getTime() - i * DAY_MS));
    // grammar: same count, but all 80 days old (heavily decayed).
    for (let i = 0; i < 3; i++) insertProducedError(db, "grammar", new Date(now.getTime() - (80 + i) * DAY_MS));

    const blocking = deriveBlocking(db, now);
    const tags = blocking.map((b) => b.tag);
    expect(tags.indexOf("word_choice")).toBeLessThan(tags.indexOf("grammar"));
  });

  it("carries the most recent produced_error's span -> fix as the example", () => {
    const now = new Date();
    insertProducedError(db, "preposition", new Date(now.getTime() - 5 * DAY_MS), { span: "depender que", fix: "depender de que" });
    insertProducedError(db, "preposition", new Date(now.getTime() - 1 * DAY_MS), { span: "sonar como", fix: "sonar a" });

    const blocking = deriveBlocking(db, now);
    const preposition = blocking.find((b) => b.tag === "preposition")!;
    expect(preposition.example).toEqual({ span: "sonar como", fix: "sonar a" });
    expect(preposition.band).toBe("fragil");
  });

  it("carries up to 2 weakest not-yet-solido items carrying that tag", () => {
    const now = new Date();
    const captureAt = new Date(now.getTime() - 20 * DAY_MS);
    const weak1 = seedItemAt(db, captureAt, { id: "cand_weak_1", chunk: "chunk uno", taxonomy: ["collocation"] });
    const weak2 = seedItemAt(db, captureAt, { id: "cand_weak_2", chunk: "chunk dos", taxonomy: ["collocation"] });
    const strong = seedItemAt(db, captureAt, { id: "cand_strong", chunk: "chunk tres", taxonomy: ["collocation"] });
    for (let i = 0; i < 4; i++) {
      insertProducedOk(db, strong, new Date(now.getTime() - i * DAY_MS), `w_strong_${i}`);
    }
    for (let i = 0; i < 3; i++) {
      insertProducedError(db, "collocation", new Date(now.getTime() - i * DAY_MS));
    }

    const blocking = deriveBlocking(db, now);
    const collocation = blocking.find((b) => b.tag === "collocation")!;
    const weakestIds = collocation.weakestItems.map((w) => w.item.id);

    expect(weakestIds).toContain(weak1.id);
    expect(weakestIds).toContain(weak2.id);
    expect(weakestIds).not.toContain(strong.id);
    expect(collocation.weakestItems.length).toBeLessThanOrEqual(2);
  });

  it("returns an empty list when there is no produced_error evidence at all", () => {
    expect(deriveBlocking(db, new Date())).toEqual([]);
  });

  it("is deterministic for a fixed now", () => {
    const now = new Date();
    insertProducedError(db, "word_choice", new Date(now.getTime() - 1 * DAY_MS));
    expect(deriveBlocking(db, now)).toEqual(deriveBlocking(db, now));
  });
});
