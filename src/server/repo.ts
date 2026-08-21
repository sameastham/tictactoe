import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { content, events, items, modelCalls, sessions } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type { Candidate, CapturedPayload, DiscardedPayload, StoredExtraction } from "@/lib/contracts";
import type { Surface } from "@/lib/taxonomy";

/** Thrown by {@link recordDecision} when a candidate already has a keep/discard decision. */
export class AlreadyDecidedError extends Error {
  constructor(candidateId: string) {
    super(`Candidate ${candidateId} already has a recorded decision`);
    this.name = "AlreadyDecidedError";
  }
}

export type ContentRow = typeof content.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;

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
