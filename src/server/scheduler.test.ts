import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import { events, items } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type { Candidate, ItemAvoidedPayload, ProducedOkPayload, ReviewedPayload } from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";
import { createContent, recordDecision, recordReview, type ItemRow } from "@/server/repo";
import {
  buildCloze,
  deriveItemSchedule,
  getDueItems,
  getQueueCards,
  type SchedulingEvent,
} from "@/server/scheduler";

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Captures a candidate through the real `recordDecision` path — item + captured event both timestamped "now". */
function seedItem(db: Db, overrides: Partial<Candidate> = {}): ItemRow {
  const content = createContent(db, {
    source: "paste",
    type: "paste",
    text: "Texto de prueba suficientemente largo para superar la validación de longitud mínima de contenido.",
  });
  const candidate = makeCandidate(overrides);
  const { itemId } = recordDecision(db, {
    contentId: content.id,
    candidateId: candidate.id,
    action: "keep",
    candidate,
    promptVersion: "v1",
  });
  return db.select().from(items).where(eq(items.id, itemId!)).get()!;
}

/**
 * Directly inserts an item row plus its `captured` event at a caller-chosen
 * timestamp (mirrors what `recordDecision` does internally, minus the
 * content row) — used when a test needs an item captured further in the
 * past than "now" (e.g. to fall outside the 7-day "recent" priority bucket).
 */
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

/** Inserts a bare event row directly — for signals not produced by any repo helper in this test file. */
function insertEvent(
  db: Db,
  type: "produced_error",
  payload: unknown,
  createdAt: Date,
  opts: { itemId?: string | null; taxonomy?: TaxonomyTag | null } = {},
): void {
  db.insert(events)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      type,
      surface: "fix",
      itemId: opts.itemId ?? null,
      taxonomy: opts.taxonomy ?? null,
      payload: payload as never,
      createdAt,
    })
    .run();
}

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

describe("deriveItemSchedule", () => {
  it("a newly captured item is due immediately (card.due === the captured event's time)", () => {
    const item = seedItem(db, { id: "cand_new" });
    const card = deriveItemSchedule(
      [{ type: "captured", payload: {}, createdAt: item.createdAt }],
      item,
      new Date(item.createdAt.getTime() + 1),
    );
    expect(card.due.getTime()).toBeLessThanOrEqual(item.createdAt.getTime() + 1);
  });

  it("a produced_ok review pushes the card's due date into the future", () => {
    const item = seedItem(db, { id: "cand_produced_ok" });
    const reviewAt = new Date(item.createdAt.getTime() + 1000);
    const payload: ProducedOkPayload = {
      itemId: item.id,
      chunk: item.chunk,
      sentence: item.originSentence,
      rung: "natural",
      writingId: "w1",
    };
    const schedulingEvents: SchedulingEvent[] = [
      { type: "captured", payload: {}, createdAt: item.createdAt },
      { type: "produced_ok", payload, createdAt: reviewAt },
    ];

    const card = deriveItemSchedule(schedulingEvents, item, reviewAt);
    expect(card.due.getTime()).toBeGreaterThan(reviewAt.getTime());
  });

  it("a 'reviewed: again' rating leaves the card due sooner than a 'reviewed: good' rating", () => {
    const itemAgain = seedItem(db, { id: "cand_again" });
    const itemGood = seedItem(db, { id: "cand_good" });
    const reviewAt = new Date(Math.max(itemAgain.createdAt.getTime(), itemGood.createdAt.getTime()) + 1000);

    function reviewedEvents(item: ItemRow, rating: ReviewedPayload["rating"]): SchedulingEvent[] {
      const payload: ReviewedPayload = { itemId: item.id, chunk: item.chunk, rating, mode: "card" };
      return [
        { type: "captured", payload: {}, createdAt: item.createdAt },
        { type: "reviewed", payload, createdAt: reviewAt },
      ];
    }

    const cardAgain = deriveItemSchedule(reviewedEvents(itemAgain, "again"), itemAgain, reviewAt);
    const cardGood = deriveItemSchedule(reviewedEvents(itemGood, "good"), itemGood, reviewAt);

    expect(cardAgain.due.getTime()).toBeLessThan(cardGood.due.getTime());
  });

  it("an item_avoided (Hard) signal yields a shorter interval than a produced_ok (Good) signal", () => {
    const itemHard = seedItem(db, { id: "cand_avoided" });
    const itemGood = seedItem(db, { id: "cand_used" });
    const reviewAt = new Date(Math.max(itemHard.createdAt.getTime(), itemGood.createdAt.getTime()) + 1000);

    const avoidedPayload: ItemAvoidedPayload = {
      itemId: itemHard.id,
      chunk: itemHard.chunk,
      writingId: "w1",
      task: null,
    };
    const cardHard = deriveItemSchedule(
      [
        { type: "captured", payload: {}, createdAt: itemHard.createdAt },
        { type: "item_avoided", payload: avoidedPayload, createdAt: reviewAt },
      ],
      itemHard,
      reviewAt,
    );

    const okPayload: ProducedOkPayload = {
      itemId: itemGood.id,
      chunk: itemGood.chunk,
      sentence: itemGood.originSentence,
      rung: "natural",
      writingId: "w1",
    };
    const cardGood = deriveItemSchedule(
      [
        { type: "captured", payload: {}, createdAt: itemGood.createdAt },
        { type: "produced_ok", payload: okPayload, createdAt: reviewAt },
      ],
      itemGood,
      reviewAt,
    );

    expect(cardHard.due.getTime() - reviewAt.getTime()).toBeLessThan(cardGood.due.getTime() - reviewAt.getTime());
  });
});

describe("recordReview -> getDueItems wiring", () => {
  it("a reviewed event recorded through the repo is picked up by the scheduler", () => {
    const item = seedItem(db, { id: "cand_wire" });
    recordReview(db, { item, rating: "easy" });

    // "Easy" on a brand-new card schedules it well into the future — no
    // longer due right now, proving the persisted `reviewed` event actually
    // fed back into the derived schedule (not just written and ignored).
    const due = getDueItems(db, 20, new Date());
    expect(due.find((d) => d.id === item.id)).toBeUndefined();
  });
});

describe("getDueItems priority ordering", () => {
  it("prioritizes an item whose tag has 3+ recent produced_error events over a standard due item", () => {
    // `now` is captured *after* seeding — both items' `captured` events (and
    // the produced_error events below) must land at or before it, or
    // `deriveItemSchedule` treats them as "from the future" and the item
    // never becomes due (see its `createdAt <= now` filter).
    const recurringItem = seedItem(db, { id: "cand_recurring", taxonomy: ["collocation"] });
    const standardItem = seedItemAt(db, new Date(Date.now() - 8 * DAY_MS), {
      id: "cand_standard",
      taxonomy: ["word_order"],
    });
    const now = new Date();

    for (let i = 0; i < 3; i++) {
      insertEvent(
        db,
        "produced_error",
        {
          tag: "collocation",
          severity: "minor",
          span: "x",
          fix: "y",
          note: "n",
          sentence: "s",
          writingId: "w",
        },
        new Date(now.getTime() - (i + 1) * 1000),
        { taxonomy: "collocation" },
      );
    }

    const due = getDueItems(db, 20, now);
    const ids = due.map((d) => d.id);
    expect(ids).toContain(recurringItem.id);
    expect(ids).toContain(standardItem.id);
    expect(ids.indexOf(recurringItem.id)).toBeLessThan(ids.indexOf(standardItem.id));

    expect(due.find((d) => d.id === recurringItem.id)?.priorityReason).toBe("recurring_error");
    expect(due.find((d) => d.id === standardItem.id)?.priorityReason).toBe("standard");
  });

  it("is deterministic for a fixed now (repeat calls with the same input return the same output)", () => {
    seedItem(db, { id: "cand_det_1" });
    seedItem(db, { id: "cand_det_2" });
    const now = new Date();

    const first = getDueItems(db, 20, now);
    const second = getDueItems(db, 20, now);
    expect(second).toEqual(first);
  });
});

describe("buildCloze", () => {
  it("replaces the first occurrence of the chunk with a blank", () => {
    expect(buildCloze("Vamos a ver si llegamos a tiempo hoy.", "a ver si")).toBe(
      "Vamos ____ llegamos a tiempo hoy.",
    );
  });

  it("falls back to the bare chunk when it isn't found in the sentence (defensive)", () => {
    expect(buildCloze("Una oración distinta por completo.", "no está aquí")).toBe("no está aquí");
  });
});

describe("getQueueCards", () => {
  it("maps a due item to cloze/answer/contrast card data", () => {
    const item = seedItem(db, {
      id: "cand_cloze",
      chunk: "a ver si",
      origin_sentence: "Vamos a ver si llegamos a tiempo hoy.",
      contrast_set: ["a ver si", "vamos a ver"],
    });

    const cards = getQueueCards(db, 10, new Date());
    const card = cards.find((c) => c.item.id === item.id);

    expect(card).toBeDefined();
    expect(card!.cloze).toBe("Vamos ____ llegamos a tiempo hoy.");
    expect(card!.answer).toBe("a ver si");
    expect(card!.contrast).toEqual(["a ver si", "vamos a ver"]);
  });

  it("caps the queue at max", () => {
    for (let i = 0; i < 4; i++) {
      seedItem(db, { id: `cand_cap_${i}` });
    }
    const cards = getQueueCards(db, 2, new Date());
    expect(cards).toHaveLength(2);
  });
});
