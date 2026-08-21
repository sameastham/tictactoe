import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { content, events, goldSet, items, modelCalls, sessions, writings } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type {
  AdjudicatedPayload,
  Candidate,
  CapturedPayload,
  DiscardedPayload,
  ItemAvoidedPayload,
  JudgeResult,
  JudgeTargetItem,
  ProducedErrorPayload,
  ProducedOkPayload,
  ReviewedPayload,
  ReviewRating,
  StoredExtraction,
} from "@/lib/contracts";
import type { Rung, Surface } from "@/lib/taxonomy";

/** Thrown by {@link recordDecision} when a candidate already has a keep/discard decision. */
export class AlreadyDecidedError extends Error {
  constructor(candidateId: string) {
    super(`Candidate ${candidateId} already has a recorded decision`);
    this.name = "AlreadyDecidedError";
  }
}

/** Thrown by {@link recordAdjudication} when the writing doesn't exist or hasn't been judged yet. */
export class WritingNotJudgedError extends Error {
  constructor(writingId: string) {
    super(`Writing ${writingId} does not exist or has not been judged yet`);
    this.name = "WritingNotJudgedError";
  }
}

/** Thrown by {@link recordAdjudication} when `sentenceIndex` is out of range for the writing's judgment. */
export class SentenceIndexOutOfRangeError extends Error {
  constructor(writingId: string, sentenceIndex: number) {
    super(`Writing ${writingId} has no judged sentence at index ${sentenceIndex}`);
    this.name = "SentenceIndexOutOfRangeError";
  }
}

export type ContentRow = typeof content.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type WritingRow = typeof writings.$inferSelect;
export type GoldSetRow = typeof goldSet.$inferSelect;

// -----------------------------------------------------------------------------
// content
// -----------------------------------------------------------------------------

export type CreateContentInput = {
  source: "url" | "paste";
  sourceUrl?: string | null;
  type: "article" | "paste" | "audio" | "video";
  title?: string | null;
  text: string;
};

/** Inserts a new piece of content and returns the persisted row. */
export function createContent(db: Db, data: CreateContentInput): ContentRow {
  const row: typeof content.$inferInsert = {
    id: newId(),
    userId: DEFAULT_USER_ID,
    source: data.source,
    sourceUrl: data.sourceUrl ?? null,
    type: data.type,
    title: data.title ?? null,
    text: data.text,
    createdAt: new Date(),
  };
  db.insert(content).values(row).run();
  return getContent(db, row.id)!;
}

/** Fetches a single content row by id, or undefined if it doesn't exist. */
export function getContent(db: Db, id: string): ContentRow | undefined {
  return db.select().from(content).where(eq(content.id, id)).get();
}

export type ContentListItem = ContentRow & {
  /** Number of candidates from this content's extraction that have a keep/discard decision. */
  decidedCount: number;
  /** Number of candidates in this content's stored extraction (0 if not yet extracted). */
  candidateCount: number;
};

/** Lists the most recently created content, annotated with decision/candidate counts. */
export function listContent(db: Db, limit = 20): ContentListItem[] {
  const rows = db.select().from(content).orderBy(desc(content.createdAt)).limit(limit).all();
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const decisionEvents = db
    .select({ contentId: events.contentId })
    .from(events)
    .where(and(inArray(events.contentId, ids), inArray(events.type, ["captured", "discarded"])))
    .all();

  const decidedCounts = new Map<string, number>();
  for (const { contentId } of decisionEvents) {
    if (!contentId) continue;
    decidedCounts.set(contentId, (decidedCounts.get(contentId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    ...row,
    decidedCount: decidedCounts.get(row.id) ?? 0,
    candidateCount: row.extraction?.result.candidates.length ?? 0,
  }));
}

/** Persists a model extraction result onto a content row, updating its difficulty rating. */
export function saveExtraction(db: Db, contentId: string, extraction: StoredExtraction): void {
  db.update(content)
    .set({ extraction, difficulty: extraction.result.difficulty })
    .where(eq(content.id, contentId))
    .run();
}

// -----------------------------------------------------------------------------
// items (read helpers)
// -----------------------------------------------------------------------------

/** Fetches item rows by id. Unknown ids are silently dropped, not errors. */
export function getItemsByIds(db: Db, ids: string[]): ItemRow[] {
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids)).all();
}

/** Lists the most recently captured items — used to offer target items before the FSRS scheduler exists. */
export function listRecentItems(db: Db, limit = 20): ItemRow[] {
  return db.select().from(items).orderBy(desc(items.createdAt)).limit(limit).all();
}

// -----------------------------------------------------------------------------
// decisions (keep/discard on extracted candidates)
// -----------------------------------------------------------------------------

export type Decision = "keep" | "discard";

/**
 * Derives the current keep/discard decision for each candidate of a content
 * item from the event log (captured -> keep, discarded -> discard, latest wins).
 */
export function getDecisions(db: Db, contentId: string): Record<string, Decision> {
  const rows = db
    .select({ type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.contentId, contentId), inArray(events.type, ["captured", "discarded"])))
    .orderBy(asc(events.createdAt))
    .all();

  const decisions: Record<string, Decision> = {};
  for (const row of rows) {
    const { candidateId } = row.payload as CapturedPayload | DiscardedPayload;
    decisions[candidateId] = row.type === "captured" ? "keep" : "discard";
  }
  return decisions;
}

export type RecordDecisionInput = {
  contentId: string;
  candidateId: string;
  action: Decision;
  candidate: Candidate;
  promptVersion: string;
};

/**
 * Records a keep/discard decision on an extracted candidate, in a single
 * transaction. "keep" creates an item row plus a `captured` event; "discard"
 * creates only a `discarded` event. Throws {@link AlreadyDecidedError} (and
 * writes nothing) if this candidate already has a decision.
 */
export function recordDecision(db: Db, input: RecordDecisionInput): { itemId?: string } {
  const { contentId, candidateId, action, candidate, promptVersion } = input;

  return db.transaction((tx) => {
    const existing = tx
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.contentId, contentId), inArray(events.type, ["captured", "discarded"])))
      .all();
    const alreadyDecided = existing.some(
      (row) => (row.payload as CapturedPayload | DiscardedPayload).candidateId === candidateId,
    );
    if (alreadyDecided) {
      throw new AlreadyDecidedError(candidateId);
    }

    const now = new Date();

    if (action === "discard") {
      const payload: DiscardedPayload = { candidateId, candidate, promptVersion };
      tx.insert(events)
        .values({
          id: newId(),
          userId: DEFAULT_USER_ID,
          type: "discarded",
          surface: "read",
          contentId,
          payload,
          createdAt: now,
        })
        .run();
      return {};
    }

    const itemId = newId();
    tx.insert(items)
      .values({
        id: itemId,
        userId: DEFAULT_USER_ID,
        chunk: candidate.chunk,
        register: candidate.register,
        contrastSet: candidate.contrast_set,
        originContentId: contentId,
        originSentence: candidate.origin_sentence,
        why: candidate.why,
        taxonomy: candidate.taxonomy,
        createdAt: now,
      })
      .run();

    const payload: CapturedPayload = { candidateId, candidate, promptVersion };
    tx.insert(events)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        type: "captured",
        surface: "read",
        itemId,
        contentId,
        payload,
        createdAt: now,
      })
      .run();

    return { itemId };
  });
}

// -----------------------------------------------------------------------------
// sessions
// -----------------------------------------------------------------------------

export type CreateSessionInput = {
  surface: Surface;
  contentId?: string | null;
};

/** Starts a new practice session and returns the persisted row. */
export function createSession(db: Db, data: CreateSessionInput): SessionRow {
  const now = new Date();
  const row: typeof sessions.$inferInsert = {
    id: newId(),
    userId: DEFAULT_USER_ID,
    surface: data.surface,
    contentId: data.contentId ?? null,
    startedAt: now,
    endedAt: null,
    durationS: null,
    createdAt: now,
  };
  db.insert(sessions).values(row).run();
  return db.select().from(sessions).where(eq(sessions.id, row.id)).get()!;
}

// -----------------------------------------------------------------------------
// writings (Fix surface)
// -----------------------------------------------------------------------------

export type CreateWritingInput = {
  task?: string | null;
  text: string;
  sessionId?: string | null;
};

/** Inserts a new, not-yet-judged writing and returns the persisted row. */
export function createWriting(db: Db, data: CreateWritingInput): WritingRow {
  const row: typeof writings.$inferInsert = {
    id: newId(),
    userId: DEFAULT_USER_ID,
    task: data.task ?? null,
    text: data.text,
    judgment: null,
    promptVersion: null,
    model: null,
    sessionId: data.sessionId ?? null,
    createdAt: new Date(),
  };
  db.insert(writings).values(row).run();
  return getWriting(db, row.id)!;
}

/** Fetches a single writing row by id, or undefined if it doesn't exist. */
export function getWriting(db: Db, id: string): WritingRow | undefined {
  return db.select().from(writings).where(eq(writings.id, id)).get();
}

/** Lists the most recently created writings. */
export function listWritings(db: Db, limit = 20): WritingRow[] {
  return db.select().from(writings).orderBy(desc(writings.createdAt)).limit(limit).all();
}

/**
 * Persists a model judgment onto a writing row. `writings` is not part of
 * the append-only event log, so updating it in place is fine — the
 * corresponding `produced_ok`/`produced_error`/`item_avoided` events (see
 * {@link recordJudgmentEvents}) are what make the judgment durable history.
 */
export function saveJudgment(
  db: Db,
  writingId: string,
  judgment: JudgeResult,
  promptVersion: string,
  model: string,
): void {
  db.update(writings).set({ judgment, promptVersion, model }).where(eq(writings.id, writingId)).run();
}

export type RecordJudgmentEventsInput = {
  writingId: string;
  judgment: JudgeResult;
  targetItems: JudgeTargetItem[];
  /** The writing's task, echoed onto `item_avoided` payloads. */
  task?: string | null;
};

export type RecordJudgmentEventsCounts = {
  producedOk: number;
  producedError: number;
  itemAvoided: number;
};

/**
 * Records the event-log consequences of one judgment, in a single
 * transaction: one `produced_error` event per issue on an `incorrect`
 * sentence, one `produced_ok` event per used target item, one `item_avoided`
 * event per avoided target item.
 */
export function recordJudgmentEvents(db: Db, input: RecordJudgmentEventsInput): RecordJudgmentEventsCounts {
  const { writingId, judgment, targetItems, task = null } = input;
  const chunkById = new Map(targetItems.map((item) => [item.id, item.chunk]));

  return db.transaction((tx) => {
    const now = new Date();
    let producedOk = 0;
    let producedError = 0;
    let itemAvoided = 0;

    for (const sentence of judgment.sentences) {
      if (sentence.rung !== "incorrect") continue;
      for (const issue of sentence.issues) {
        const payload: ProducedErrorPayload = {
          tag: issue.tag,
          severity: issue.severity,
          span: issue.span,
          fix: issue.fix,
          note: issue.note,
          sentence: sentence.sentence,
          writingId,
        };
        tx.insert(events)
          .values({
            id: newId(),
            userId: DEFAULT_USER_ID,
            type: "produced_error",
            surface: "fix",
            taxonomy: issue.tag,
            severity: issue.severity,
            payload,
            createdAt: now,
          })
          .run();
        producedError++;
      }
    }

    for (const itemId of judgment.items_used) {
      const chunk = chunkById.get(itemId) ?? null;
      const sentenceRow = chunk !== null ? judgment.sentences.find((s) => s.sentence.includes(chunk)) : undefined;
      const payload: ProducedOkPayload = {
        itemId,
        chunk,
        sentence: sentenceRow?.sentence ?? "",
        rung: sentenceRow?.rung ?? "natural",
        writingId,
      };
      tx.insert(events)
        .values({
          id: newId(),
          userId: DEFAULT_USER_ID,
          type: "produced_ok",
          surface: "fix",
          itemId,
          payload,
          createdAt: now,
        })
        .run();
      producedOk++;
    }

    for (const itemId of judgment.items_avoided) {
      const payload: ItemAvoidedPayload = {
        itemId,
        chunk: chunkById.get(itemId) ?? "",
        writingId,
        task,
      };
      tx.insert(events)
        .values({
          id: newId(),
          userId: DEFAULT_USER_ID,
          type: "item_avoided",
          surface: "fix",
          itemId,
          payload,
          createdAt: now,
        })
        .run();
      itemAvoided++;
    }

    return { producedOk, producedError, itemAvoided };
  });
}

/**
 * True if `writingId`/`sentenceIndex` already has an `adjudicated` event —
 * derived by scanning payloads (append-only log, so "any match" is enough;
 * we never need "the latest one").
 */
export function hasAdjudication(db: Db, writingId: string, sentenceIndex: number): boolean {
  const rows = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.userId, DEFAULT_USER_ID), eq(events.type, "adjudicated")))
    .all();
  return rows.some((row) => {
    const payload = row.payload as AdjudicatedPayload;
    return payload.writingId === writingId && payload.sentenceIndex === sentenceIndex;
  });
}

export type RecordAdjudicationInput = {
  writingId: string;
  sentenceIndex: number;
  learnerRung: Rung;
  note?: string | null;
};

/**
 * Records the learner's override of the model's rung for one judged
 * sentence, in a single transaction: an `adjudicated` event plus a
 * `gold_set` row. Throws {@link WritingNotJudgedError} if the writing
 * doesn't exist or hasn't been judged yet, {@link SentenceIndexOutOfRangeError}
 * if `sentenceIndex` is out of range.
 */
export function recordAdjudication(db: Db, input: RecordAdjudicationInput): { goldSetId: string } {
  const { writingId, sentenceIndex, learnerRung, note = null } = input;

  return db.transaction((tx) => {
    const writing = tx.select().from(writings).where(eq(writings.id, writingId)).get();
    if (!writing || !writing.judgment) {
      throw new WritingNotJudgedError(writingId);
    }

    const sentence = writing.judgment.sentences[sentenceIndex];
    if (!sentence) {
      throw new SentenceIndexOutOfRangeError(writingId, sentenceIndex);
    }

    const now = new Date();
    const payload: AdjudicatedPayload = {
      writingId,
      sentenceIndex,
      sentence: sentence.sentence,
      modelRung: sentence.rung,
      learnerRung,
      note,
    };
    tx.insert(events)
      .values({
        id: newId(),
        userId: DEFAULT_USER_ID,
        type: "adjudicated",
        surface: "fix",
        payload,
        createdAt: now,
      })
      .run();

    const goldSetId = newId();
    tx.insert(goldSet)
      .values({
        id: goldSetId,
        userId: DEFAULT_USER_ID,
        sentence: sentence.sentence,
        set: "adjudicated",
        expectedRung: learnerRung,
        expectedTags: [],
        origin: `fix_override:${writingId}`,
        createdAt: now,
      })
      .run();

    return { goldSetId };
  });
}

// -----------------------------------------------------------------------------
// reviews (Review scheduler's home-screen Repaso queue)
// -----------------------------------------------------------------------------

export type RecordReviewInput = {
  item: ItemRow;
  rating: ReviewRating;
};

/**
 * Appends one `reviewed` event for a Repaso card answer — a single insert,
 * no read-modify-write, keeping with the append-only log (scheduling state
 * itself is never stored; see `src/server/scheduler.ts`, which replays this
 * event back into an FSRS grade the next time the item's schedule is derived).
 */
export function recordReview(db: Db, input: RecordReviewInput): { eventId: string } {
  const { item, rating } = input;
  const eventId = newId();
  const payload: ReviewedPayload = { itemId: item.id, chunk: item.chunk, rating, mode: "card" };
  db.insert(events)
    .values({
      id: eventId,
      userId: DEFAULT_USER_ID,
      type: "reviewed",
      surface: "review",
      itemId: item.id,
      payload,
      createdAt: new Date(),
    })
    .run();
  return { eventId };
}

// -----------------------------------------------------------------------------
// model calls
// -----------------------------------------------------------------------------

export type LogModelCallInput = Omit<typeof modelCalls.$inferInsert, "id" | "userId" | "createdAt">;

/** Logs a single model API call (cost/latency/error tracking). */
export function logModelCall(db: Db, data: LogModelCallInput): void {
  db.insert(modelCalls)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      createdAt: new Date(),
      ...data,
    })
    .run();
}

// -----------------------------------------------------------------------------
// NOTE: this module intentionally exposes no update/delete for `events` —
// the append-only invariant of the event log lives here.
// -----------------------------------------------------------------------------
