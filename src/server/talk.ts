/**
 * Server-side logic for the Talk surface (text conversation practice with
 * async post-session evaluation — plan §4.3): topic seeding, turn recording,
 * and report derivation. `talk_turns` is append-only like `events`: only
 * inserts are exposed here, no update/delete function exists anywhere.
 *
 * Evaluation never happens mid-conversation — the tutor (`converse`) just
 * talks. Only `endTalk` ever calls `judge`, once, over the learner's whole
 * side of the conversation joined together.
 */
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { content, talkTurns } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type { ConverseInput, FluencyAggregate, JudgeResult, JudgeTargetItem, TalkReport, TalkTurnMeta } from "@/lib/contracts";
import type { TaxonomyTag } from "@/lib/taxonomy";
import { JUDGE_PROMPT_VERSION } from "@/server/language/prompts";
import type { LanguageService } from "@/server/language/service";
import { buildLearnerBlock } from "@/server/learner";
import {
  createSession,
  createWriting,
  endSession,
  getSession,
  getWritingBySessionId,
  recordJudgmentEvents,
  saveJudgment,
  type SessionRow,
} from "@/server/repo";
import { getDueItems } from "@/server/scheduler";
import { getUnit } from "@/server/syllabus/config";
import { getActiveUnit } from "@/server/syllabus/progress";

/** Thrown when a session id doesn't exist, or exists but isn't a "talk" surface session. */
export class TalkSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Talk session ${sessionId} not found`);
    this.name = "TalkSessionNotFoundError";
  }
}

/** Thrown by {@link endTalk} when the session has already been ended once. */
export class TalkSessionEndedError extends Error {
  constructor(sessionId: string) {
    super(`Talk session ${sessionId} has already ended`);
    this.name = "TalkSessionEndedError";
  }
}

/** Thrown by {@link getTalkReport} when the session hasn't been ended yet — there's nothing to report. */
export class TalkSessionNotEndedError extends Error {
  constructor(sessionId: string) {
    super(`Talk session ${sessionId} has not ended yet`);
    this.name = "TalkSessionNotEndedError";
  }
}

export type TalkTurnRow = typeof talkTurns.$inferSelect;

/**
 * Looks up a talk session and asserts it's still open — throws
 * {@link TalkSessionNotFoundError} if it doesn't exist (or isn't a "talk"
 * surface session) and {@link TalkSessionEndedError} if it's already
 * ended. Shared by `POST /api/talk/message` (a message can't be sent into
 * an ended session) and {@link endTalk} (a session can't be ended twice).
 */
export function getOpenTalkSession(db: Db, sessionId: string): SessionRow {
  const session = getSession(db, sessionId);
  if (!session || session.surface !== "talk") {
    throw new TalkSessionNotFoundError(sessionId);
  }
  if (session.endedAt) {
    throw new TalkSessionEndedError(sessionId);
  }
  return session;
}

const DUE_ITEMS_FOR_TOPIC = 2;
const FALLBACK_TOPIC = "¿Cómo va tu semana?";

/**
 * One line of concrete practice advice per taxonomy tag — what `endTalk`'s
 * `practiceNext` draws from. This is a lookup, not a generation: no model
 * call is involved in deriving it. Every {@link TaxonomyTag} has an entry so
 * a real (non-fixture) judge call can never produce a tag this map can't
 * resolve.
 */
export const PRACTICE_NEXT_MAP: Record<TaxonomyTag, string> = {
  grammar: "Repasa conjugación y concordancia: escribe 5 frases variando el tiempo y el modo verbal.",
  preposition: "Practica las preposiciones que rigen tus verbos más usados — anota 5 ejemplos con 'de', 'a', 'en'.",
  word_choice: "Antes de traducir literalmente del inglés, busca el verbo o sustantivo que diría un mexicano aquí.",
  collocation: "Practica colocaciones: anota qué verbos acompañan normalmente a tus sustantivos más usados.",
  register: "Practica ajustar el registro: di la misma idea primero en coloquial_mx y luego en formal.",
  idiomaticity: "Busca cómo lo diría un hablante nativo y compara con tu versión — anota la diferencia.",
  discourse: "Practica conectores de argumentación: 'ahora bien', 'de hecho', 'a fin de cuentas'.",
  redundancy: "Recorta lo que sobra: vuelve a decir la misma idea con menos palabras.",
  word_order: "Repasa el orden de los complementos en oraciones con varios elementos.",
  listening_reduction: "Practica dictado enfocándote en el habla conectada y las elisiones.",
  listening_lexical: "Repasa el vocabulario nuevo que se te escapó al escuchar.",
};

/** First `n` whitespace-delimited words of `text`, joined back with single spaces. */
function firstWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

/**
 * Picks today's Talk topic: when an active syllabus unit exists, its theme
 * ("Platiquemos del tema de tu unidad: <theme>…" — so Talk ties back to the
 * curriculum the learner is actually working through, plan design §4);
 * otherwise the most recently added content with non-empty text (its title
 * if it has one, else its first 8 words), per plan §4.3 ("topics seeded from
 * recent content and due items"). Either way, up to {@link DUE_ITEMS_FOR_TOPIC}
 * due-item chunks are woven in as a soft challenge. Falls back to a generic
 * opener when there's no active unit and no content yet; due chunks (if any)
 * are still appended in that case.
 */
export function seedTopic(db: Db): { topic: string; dueItems: JudgeTargetItem[] } {
  const dueItemRows = getDueItems(db, DUE_ITEMS_FOR_TOPIC);
  const dueItems: JudgeTargetItem[] = dueItemRows.map((item) => ({ id: item.id, chunk: item.chunk }));
  const dueSuffix =
    dueItems.length > 0 ? ` A ver si sale natural usar: ${dueItems.map((item) => item.chunk).join(", ")}.` : "";

  const active = getActiveUnit(db);
  const activeUnit = active ? getUnit(active.level, active.unit) : undefined;
  if (activeUnit) {
    return { topic: `Platiquemos del tema de tu unidad: ${activeUnit.theme}…${dueSuffix}`, dueItems };
  }

  const recentContent = db
    .select()
    .from(content)
    .where(eq(content.userId, DEFAULT_USER_ID))
    .orderBy(desc(content.createdAt))
    .limit(20)
    .all();
  const latest = recentContent.find((row) => row.text.trim().length > 0);

  if (!latest) {
    return { topic: `${FALLBACK_TOPIC}${dueSuffix}`, dueItems };
  }

  const titlePart =
    latest.title && latest.title.trim().length > 0 ? latest.title.trim() : firstWords(latest.text, 8);
  return { topic: `Platiquemos de lo que leíste: ${titlePart}…${dueSuffix}`, dueItems };
}

/** Appends one turn to `talk_turns` — the only write path into that table (insert-only, like `events`). */
function insertTurn(
  db: Db,
  sessionId: string,
  role: "learner" | "tutor",
  text: string,
  meta: TalkTurnMeta | null = null,
): TalkTurnRow {
  const row: typeof talkTurns.$inferInsert = {
    id: newId(),
    userId: DEFAULT_USER_ID,
    sessionId,
    role,
    text,
    meta,
    createdAt: new Date(),
  };
  db.insert(talkTurns).values(row).run();
  return db.select().from(talkTurns).where(eq(talkTurns.id, row.id)).get()!;
}

/**
 * Records one learner-authored turn. `meta` is set when this turn came from
 * the voice recorder (edited or not — editing the transcribed text before
 * sending keeps the fluency meta, since it still describes the spoken
 * attempt); omit it for a typed turn.
 */
export function recordLearnerTurn(db: Db, sessionId: string, text: string, meta?: TalkTurnMeta | null): TalkTurnRow {
  return insertTurn(db, sessionId, "learner", text, meta ?? null);
}

/** Records one tutor-authored turn. Tutor turns never carry `meta`. */
export function recordTutorTurn(db: Db, sessionId: string, text: string): TalkTurnRow {
  return insertTurn(db, sessionId, "tutor", text);
}

/**
 * Aggregates fluency markers across a session's voice-mode learner turns
 * (see `TalkTurnMetaSchema`) — plain stats, no judgment. `avgWordsPerMin`
 * averages each voice turn's own `wordsPerMin` rather than recomputing over
 * a pooled word array, since separate turns' timestamps aren't one
 * continuous timeline. Returns `null` when there are no voice turns.
 */
function aggregateFluency(turns: TalkTurnRow[]): FluencyAggregate | null {
  const voiceTurns = turns
    .filter((turn): turn is TalkTurnRow & { meta: TalkTurnMeta } => turn.role === "learner" && turn.meta !== null)
    .map((turn) => turn.meta);

  if (voiceTurns.length === 0) return null;

  const totalWordsPerMin = voiceTurns.reduce((sum, meta) => sum + meta.fluency.wordsPerMin, 0);
  const totalPausesOver800Ms = voiceTurns.reduce((sum, meta) => sum + meta.fluency.pausesOver800Ms, 0);
  const totalFillers = voiceTurns.reduce((sum, meta) => sum + meta.fluency.fillerCount, 0);

  return {
    voiceTurns: voiceTurns.length,
    avgWordsPerMin: Math.round((totalWordsPerMin / voiceTurns.length) * 10) / 10,
    totalPausesOver800Ms,
    totalFillers,
  };
}

/** All turns for one session, oldest first. */
export function getTalkTurns(db: Db, sessionId: string): TalkTurnRow[] {
  return db
    .select()
    .from(talkTurns)
    .where(eq(talkTurns.sessionId, sessionId))
    .orderBy(asc(talkTurns.createdAt))
    .all();
}

/**
 * Starts a Talk session: seeds today's topic, creates the session row (with
 * `topic`/`seedItems` persisted so {@link endTalk} can pick them back up
 * later without re-deriving them), and asks the tutor for its opening line
 * — an empty-history `converse` call, recorded as the first tutor turn.
 */
export async function startTalk(
  db: Db,
  languageService: LanguageService,
): Promise<{ sessionId: string; topic: string; opening: string }> {
  const { topic, dueItems } = seedTopic(db);
  const session = createSession(db, { surface: "talk", topic, seedItems: dueItems });

  const learner = buildLearnerBlock(db);
  const input: ConverseInput = { topic, messages: [] };
  const { result } = await languageService.converse(input, learner);

  recordTutorTurn(db, session.id, result.reply);
  return { sessionId: session.id, topic, opening: result.reply };
}

/** Top 3 distinct issue tags by frequency across a judgment, mapped to concrete practice lines. */
function derivePracticeNext(judgment: JudgeResult): string[] {
  const counts = new Map<TaxonomyTag, number>();
  for (const sentence of judgment.sentences) {
    for (const issue of sentence.issues) {
      counts.set(issue.tag, (counts.get(issue.tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]) => PRACTICE_NEXT_MAP[tag]);
}

/**
 * Ends a Talk session: stamps `endedAt`/`durationS` (a plain update —
 * `sessions` isn't part of the append-only log), then judges the learner's
 * side of the conversation exactly once, asynchronously, after the fact —
 * never mid-chat.
 *
 * The joined learner turns are persisted as a `writings` row (`task`
 * `"talk:" + topic`, `sessionId` set) so Talk production lands in the same
 * event stream and writings archive as Fix: `judge`'s event-log
 * consequences (`produced_error`/`produced_ok`/`item_avoided` via
 * `recordJudgmentEvents`) and the adjudication/gold-set tooling built for
 * Fix all work here unmodified, with no Talk-specific event types needed.
 *
 * A session with no learner turns still ends, with a null-judgment report
 * and no writing created (there is nothing to judge).
 */
export async function endTalk(db: Db, sessionId: string, languageService: LanguageService): Promise<TalkReport> {
  const session = getOpenTalkSession(db, sessionId);

  const now = new Date();
  const durationS = Math.max(0, Math.round((now.getTime() - session.startedAt.getTime()) / 1000));
  endSession(db, sessionId, now, durationS);

  const turns = getTalkTurns(db, sessionId);
  const learnerTurns = turns.filter((turn) => turn.role === "learner");

  if (learnerTurns.length === 0) {
    return {
      sessionId,
      topic: session.topic,
      judgment: null,
      itemsUsed: [],
      itemsAvoided: [],
      practiceNext: [],
      fluency: aggregateFluency(turns),
    };
  }

  const targetItems: JudgeTargetItem[] = session.seedItems ?? [];
  const joinedText = learnerTurns.map((turn) => turn.text).join("\n");
  const task = `talk:${session.topic ?? ""}`;

  // Created before the judge call so a ProviderError still leaves a
  // persisted (unjudged) writing behind — same posture as POST /api/fix.
  const writing = createWriting(db, { task, text: joinedText, sessionId });
  const learner = buildLearnerBlock(db);
  const { result, model } = await languageService.judge(
    { text: joinedText, task, target_items: targetItems },
    learner,
  );

  saveJudgment(db, writing.id, result, JUDGE_PROMPT_VERSION, model);
  recordJudgmentEvents(db, { writingId: writing.id, judgment: result, targetItems, task, surface: "talk" });

  return {
    sessionId,
    topic: session.topic,
    judgment: result,
    itemsUsed: result.items_used,
    itemsAvoided: result.items_avoided,
    practiceNext: derivePracticeNext(result),
    fluency: aggregateFluency(turns),
  };
}

/**
 * Re-derives a Talk report from a previously-ended session's stored writing
 * — no model call, no event-log writes, safe to call from a `GET`. Backs
 * `GET /api/talk/[sessionId]/report`, the path a learner returning to an
 * already-ended session takes instead of re-running `endTalk`.
 */
export function getTalkReport(db: Db, sessionId: string): TalkReport {
  const session = getSession(db, sessionId);
  if (!session || session.surface !== "talk") {
    throw new TalkSessionNotFoundError(sessionId);
  }
  if (!session.endedAt) {
    throw new TalkSessionNotEndedError(sessionId);
  }

  const writing = getWritingBySessionId(db, sessionId);
  const judgment = writing?.judgment ?? null;
  const turns = getTalkTurns(db, sessionId);

  return {
    sessionId,
    topic: session.topic,
    judgment,
    itemsUsed: judgment?.items_used ?? [],
    itemsAvoided: judgment?.items_avoided ?? [],
    practiceNext: judgment ? derivePracticeNext(judgment) : [],
    fluency: aggregateFluency(turns),
  };
}
