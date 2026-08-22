import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "@/db";
import { events, items, sessions, writings } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { Candidate, FluencyMetrics, ProducedErrorPayload, TalkTurnMeta } from "@/lib/contracts";
import { createContent, getSession, recordDecision } from "@/server/repo";
import { createLanguageService } from "@/server/language/service";
import { FixtureProvider } from "@/server/language/providers/fixture";
import { getUnit } from "@/server/syllabus/config";
import { recordAdvance } from "@/server/syllabus/progress";
import {
  endTalk,
  getOpenTalkSession,
  getTalkReport,
  getTalkTurns,
  PRACTICE_NEXT_MAP,
  recordLearnerTurn,
  recordTutorTurn,
  seedTopic,
  startTalk,
  TalkSessionEndedError,
  TalkSessionNotEndedError,
  TalkSessionNotFoundError,
} from "@/server/talk";

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

function languageService() {
  return createLanguageService({ db, provider: new FixtureProvider() });
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

/** Captures a candidate through the real `recordDecision` path, so the resulting item is immediately due. */
function seedDueItem(db: Db, overrides: Partial<Candidate> = {}) {
  const content = createContent(db, {
    source: "paste",
    type: "paste",
    text: "Texto de prueba suficientemente largo para superar la validación de longitud mínima.",
  });
  const candidate = makeCandidate(overrides);
  const { itemId } = recordDecision(db, {
    contentId: content.id,
    candidateId: candidate.id,
    action: "keep",
    candidate,
    promptVersion: "v1",
  });
  return { itemId: itemId!, chunk: candidate.chunk };
}

function makeFluency(overrides: Partial<FluencyMetrics> = {}): FluencyMetrics {
  return {
    durationMs: 4000,
    wordCount: 10,
    wordsPerMin: 150,
    pausesOver800Ms: 1,
    longestPauseMs: 900,
    fillerCount: 2,
    ...overrides,
  };
}

function makeVoiceMeta(overrides: Partial<FluencyMetrics> = {}): TalkTurnMeta {
  return { kind: "voice", fluency: makeFluency(overrides) };
}

describe("seedTopic", () => {
  it("falls back to a generic topic with no due items when there's no content and no items", () => {
    const { topic, dueItems } = seedTopic(db);
    expect(topic).toBe("¿Cómo va tu semana?");
    expect(dueItems).toEqual([]);
  });

  it("uses the latest content's title when there is one", () => {
    createContent(db, {
      source: "paste",
      type: "article",
      title: "El café de especialidad en México",
      text: "Un texto de relleno con longitud suficiente para pasar la validación mínima exigida.",
    });

    const { topic, dueItems } = seedTopic(db);
    expect(topic).toBe("Platiquemos de lo que leíste: El café de especialidad en México…");
    expect(dueItems).toEqual([]);
  });

  it("falls back to the first 8 words of the text when there's no title", () => {
    createContent(db, {
      source: "paste",
      type: "paste",
      text: "Uno dos tres cuatro cinco seis siete ocho nueve diez once doce.",
    });

    const { topic } = seedTopic(db);
    expect(topic).toBe("Platiquemos de lo que leíste: Uno dos tres cuatro cinco seis siete ocho…");
  });

  it("appends up to 2 due-item chunks when there are due items, with content present", () => {
    createContent(db, {
      source: "paste",
      type: "article",
      title: "Un tema cualquiera",
      text: "Un texto de relleno con longitud suficiente para pasar la validación mínima exigida.",
    });
    const itemA = seedDueItem(db, { id: "cA", chunk: "valer la pena" });
    const itemB = seedDueItem(db, { id: "cB", chunk: "tocar madera" });

    const { topic, dueItems } = seedTopic(db);
    expect(dueItems).toHaveLength(2);
    expect(dueItems.map((i) => i.id).sort()).toEqual([itemA.itemId, itemB.itemId].sort());
    expect(topic).toContain("A ver si sale natural usar:");
    expect(topic).toContain("valer la pena");
    expect(topic).toContain("tocar madera");
  });

  it("still returns due chunks (appended to the generic fallback) when there's no content", () => {
    // Inserted directly (not via recordDecision, which always creates its
    // own content row) so `content` stays genuinely empty — items.originContentId
    // is nullable precisely for cases like this.
    const itemId = newId();
    db.insert(items)
      .values({
        id: itemId,
        userId: "u_local",
        chunk: "no tener nada que ver",
        register: "neutral",
        contrastSet: null,
        originContentId: null,
        originSentence: "Eso no tiene nada que ver con el tema.",
        why: "test item",
        taxonomy: null,
        createdAt: new Date(),
      })
      .run();
    db.insert(events)
      .values({
        id: newId(),
        userId: "u_local",
        type: "captured",
        surface: "read",
        itemId,
        contentId: null,
        payload: {},
        createdAt: new Date(),
      })
      .run();

    const { topic, dueItems } = seedTopic(db);
    expect(dueItems.map((i) => i.id)).toEqual([itemId]);
    expect(topic).toBe("¿Cómo va tu semana? A ver si sale natural usar: no tener nada que ver.");
  });

  it("prefers the active unit's theme over recent content when both exist", () => {
    createContent(db, {
      source: "paste",
      type: "article",
      title: "Un tema cualquiera de lectura",
      text: "Un texto de relleno con longitud suficiente para pasar la validación mínima exigida.",
    });
    recordAdvance(db, "dyh7", "u1");
    const unit = getUnit("dyh7", "u1")!;

    const { topic, dueItems } = seedTopic(db);
    expect(topic).toBe(`Platiquemos del tema de tu unidad: ${unit.theme}…`);
    expect(topic).not.toContain("Un tema cualquiera de lectura");
    expect(dueItems).toEqual([]);
  });

  it("still appends due-item chunks when an active unit exists", () => {
    recordAdvance(db, "dyh7", "u1");
    const unit = getUnit("dyh7", "u1")!;
    const item = seedDueItem(db, { id: "cSyllabus", chunk: "vale mucho la pena" });

    const { topic, dueItems } = seedTopic(db);
    expect(dueItems.map((i) => i.id)).toEqual([item.itemId]);
    expect(topic).toBe(`Platiquemos del tema de tu unidad: ${unit.theme}… A ver si sale natural usar: vale mucho la pena.`);
  });

  it("falls back to recent-content behavior when the active unit's id doesn't resolve to a real config unit", () => {
    // Defensive path: an advance event pointing at a level/unit combination
    // that no longer exists in config (e.g. a curriculum edit after the
    // event was logged) — getActiveUnit still replays it, but getUnit
    // returns undefined, so seedTopic must fall through cleanly rather than
    // ever building a topic string around `undefined`.
    createContent(db, {
      source: "paste",
      type: "article",
      title: "Tema de respaldo",
      text: "Un texto de relleno con longitud suficiente para pasar la validación mínima exigida.",
    });
    db.insert(events)
      .values({
        id: newId(),
        userId: "u_local",
        type: "syllabus_advanced",
        surface: "read",
        payload: { level: "dyh7", unit: "u-does-not-exist" },
        createdAt: new Date(),
      })
      .run();

    const { topic } = seedTopic(db);
    expect(topic).toBe("Platiquemos de lo que leíste: Tema de respaldo…");
  });
});

describe("startTalk", () => {
  it("creates a talk session with the seeded topic and a tutor opening turn", async () => {
    createContent(db, {
      source: "paste",
      type: "article",
      title: "Un tema de prueba",
      text: "Un texto de relleno con longitud suficiente para pasar la validación mínima exigida.",
    });

    const { sessionId, topic, opening } = await startTalk(db, languageService());

    expect(topic).toContain("Un tema de prueba");
    expect(opening.length).toBeGreaterThan(0);

    const session = getSession(db, sessionId);
    expect(session?.surface).toBe("talk");
    expect(session?.topic).toBe(topic);
    expect(session?.endedAt).toBeNull();

    const turns = getTalkTurns(db, sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("tutor");
    expect(turns[0].text).toBe(opening);
  });
});

describe("getOpenTalkSession", () => {
  it("throws TalkSessionNotFoundError for an unknown id", () => {
    expect(() => getOpenTalkSession(db, "does-not-exist")).toThrow(TalkSessionNotFoundError);
  });

  it("throws TalkSessionEndedError for an already-ended session", async () => {
    const { sessionId } = await startTalk(db, languageService());
    await endTalk(db, sessionId, languageService());
    expect(() => getOpenTalkSession(db, sessionId)).toThrow(TalkSessionEndedError);
  });

  it("returns the session row when it's open", async () => {
    const { sessionId } = await startTalk(db, languageService());
    const session = getOpenTalkSession(db, sessionId);
    expect(session.id).toBe(sessionId);
  });
});

describe("endTalk", () => {
  it("ends a session with no learner turns: null judgment, no writing, endedAt/durationS set", async () => {
    const { sessionId } = await startTalk(db, languageService());

    const report = await endTalk(db, sessionId, languageService());

    expect(report.judgment).toBeNull();
    expect(report.itemsUsed).toEqual([]);
    expect(report.itemsAvoided).toEqual([]);
    expect(report.practiceNext).toEqual([]);
    expect(report.fluency).toBeNull();

    const session = getSession(db, sessionId);
    expect(session?.endedAt).toBeInstanceOf(Date);
    expect(session?.durationS).toBeGreaterThanOrEqual(0);

    const writingRows = db.select().from(writings).where(eq(writings.sessionId, sessionId)).all();
    expect(writingRows).toHaveLength(0);
  });

  it("judges the joined learner turns, records judgment events, and derives practiceNext", async () => {
    const { sessionId } = await startTalk(db, languageService());
    recordLearnerTurn(db, sessionId, "Para mí eso no hacer sentido, pero está interesante.");
    recordTutorTurn(db, sessionId, "Ah, ¿y por qué dices eso?");
    recordLearnerTurn(db, sessionId, "Porque no le veo la lógica, la verdad.");

    const report = await endTalk(db, sessionId, languageService());

    expect(report.judgment).not.toBeNull();
    expect(report.judgment!.sentences.some((s) => s.rung === "incorrect")).toBe(true);
    expect(report.practiceNext).toContain(PRACTICE_NEXT_MAP.word_choice);
    expect(report.practiceNext.length).toBeGreaterThan(0);
    expect(report.practiceNext.length).toBeLessThanOrEqual(3);

    // The judged text is the learner's turns only, joined — the tutor's turn
    // must not leak into what gets judged.
    const writingRows = db.select().from(writings).where(eq(writings.sessionId, sessionId)).all();
    expect(writingRows).toHaveLength(1);
    expect(writingRows[0].text).toBe(
      "Para mí eso no hacer sentido, pero está interesante.\nPorque no le veo la lógica, la verdad.",
    );
    expect(writingRows[0].task).toMatch(/^talk:/);

    const errorEvents = db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.type, "produced_error"))
      .all();
    const payloads = errorEvents.map((e) => e.payload as ProducedErrorPayload);
    expect(payloads.some((p) => p.tag === "word_choice")).toBe(true);
  });

  it("credits seeded due items as items_used/items_avoided via judge's target_items", async () => {
    createContent(db, {
      source: "paste",
      type: "article",
      title: "Un tema con items",
      text: "Un texto de relleno con longitud suficiente para pasar la validación mínima exigida.",
    });
    const used = seedDueItem(db, { id: "cUsed", chunk: "al mercado" });
    const avoided = seedDueItem(db, { id: "cAvoided", chunk: "hacer la maleta" });

    const { sessionId } = await startTalk(db, languageService());
    const session = getSession(db, sessionId);
    expect(session?.seedItems?.map((i) => i.id).sort()).toEqual([avoided.itemId, used.itemId].sort());

    recordLearnerTurn(db, sessionId, "Fui al mercado ayer y compré fruta fresca.");

    const report = await endTalk(db, sessionId, languageService());
    expect(report.itemsUsed).toContain(used.itemId);
    expect(report.itemsAvoided).toContain(avoided.itemId);
  });

  it("throws TalkSessionEndedError on a second end, without recomputing anything", async () => {
    const { sessionId } = await startTalk(db, languageService());
    recordLearnerTurn(db, sessionId, "Un mensaje cualquiera.");
    await endTalk(db, sessionId, languageService());

    await expect(endTalk(db, sessionId, languageService())).rejects.toThrow(TalkSessionEndedError);

    const writingRows = db.select().from(writings).where(eq(writings.sessionId, sessionId)).all();
    expect(writingRows).toHaveLength(1);
  });

  it("throws TalkSessionNotFoundError for an unknown session id", async () => {
    await expect(endTalk(db, "does-not-exist", languageService())).rejects.toThrow(TalkSessionNotFoundError);
  });

  it("throws TalkSessionNotFoundError for a session on a different surface", async () => {
    const otherSessionId = crypto.randomUUID();
    db.insert(sessions)
      .values({
        id: otherSessionId,
        userId: "u_local",
        surface: "fix",
        contentId: null,
        topic: null,
        seedItems: null,
        startedAt: new Date(),
        endedAt: null,
        durationS: null,
        createdAt: new Date(),
      })
      .run();

    await expect(endTalk(db, otherSessionId, languageService())).rejects.toThrow(TalkSessionNotFoundError);
  });
});

describe("getTalkReport", () => {
  it("throws TalkSessionNotEndedError while the session is still open", async () => {
    const { sessionId } = await startTalk(db, languageService());
    expect(() => getTalkReport(db, sessionId)).toThrow(TalkSessionNotEndedError);
  });

  it("throws TalkSessionNotFoundError for an unknown session id", () => {
    expect(() => getTalkReport(db, "does-not-exist")).toThrow(TalkSessionNotFoundError);
  });

  it("re-derives the same report endTalk returned, without another judge call", async () => {
    const { sessionId } = await startTalk(db, languageService());
    recordLearnerTurn(db, sessionId, "Para mí eso no hacer sentido, pero está interesante.");

    const endedReport = await endTalk(db, sessionId, languageService());
    const rederived = getTalkReport(db, sessionId);

    expect(rederived).toEqual(endedReport);
  });
});

describe("recordLearnerTurn meta (voice mode)", () => {
  it("persists null meta by default (a typed turn)", async () => {
    const { sessionId } = await startTalk(db, languageService());
    const turn = recordLearnerTurn(db, sessionId, "Un mensaje escrito.");
    expect(turn.meta).toBeNull();
  });

  it("persists the passed voice meta on the learner turn", async () => {
    const { sessionId } = await startTalk(db, languageService());
    const meta = makeVoiceMeta({ wordsPerMin: 180, pausesOver800Ms: 2, fillerCount: 3 });
    const turn = recordLearnerTurn(db, sessionId, "Hablé esto en voz alta.", meta);

    expect(turn.meta).toEqual(meta);
    const stored = getTalkTurns(db, sessionId).find((t) => t.id === turn.id);
    expect(stored?.meta).toEqual(meta);
  });

  it("never sets meta on a tutor turn (recordTutorTurn takes no meta argument)", async () => {
    const { sessionId } = await startTalk(db, languageService());
    const turn = recordTutorTurn(db, sessionId, "Órale, cuéntame más.");
    expect(turn.meta).toBeNull();
  });
});

describe("fluency aggregation (endTalk / getTalkReport)", () => {
  it("is null when the session has no voice-mode learner turns", async () => {
    const { sessionId } = await startTalk(db, languageService());
    recordLearnerTurn(db, sessionId, "Un mensaje escrito, sin voz.");

    const report = await endTalk(db, sessionId, languageService());
    expect(report.fluency).toBeNull();
  });

  it("aggregates a single voice turn's fluency into the report", async () => {
    const { sessionId } = await startTalk(db, languageService());
    const meta = makeVoiceMeta({ wordsPerMin: 140, pausesOver800Ms: 2, fillerCount: 3 });
    recordLearnerTurn(db, sessionId, "Para mí eso no hacer sentido, pero está interesante.", meta);

    const report = await endTalk(db, sessionId, languageService());
    expect(report.fluency).toEqual({
      voiceTurns: 1,
      avgWordsPerMin: 140,
      totalPausesOver800Ms: 2,
      totalFillers: 3,
    });
  });

  it("averages wordsPerMin and sums pauses/fillers across multiple voice turns, ignoring typed turns", async () => {
    const { sessionId } = await startTalk(db, languageService());
    recordLearnerTurn(db, sessionId, "Un turno escrito que no cuenta para la fluidez.");
    recordLearnerTurn(
      db,
      sessionId,
      "Primer turno de voz.",
      makeVoiceMeta({ wordsPerMin: 100, pausesOver800Ms: 1, fillerCount: 2 }),
    );
    recordLearnerTurn(
      db,
      sessionId,
      "Segundo turno de voz.",
      makeVoiceMeta({ wordsPerMin: 160, pausesOver800Ms: 3, fillerCount: 4 }),
    );

    const report = await endTalk(db, sessionId, languageService());
    expect(report.fluency).toEqual({
      voiceTurns: 2,
      avgWordsPerMin: 130, // (100 + 160) / 2
      totalPausesOver800Ms: 4, // 1 + 3
      totalFillers: 6, // 2 + 4
    });
  });

  it("re-derives the same non-null fluency via getTalkReport, without recomputing anything", async () => {
    const { sessionId } = await startTalk(db, languageService());
    recordLearnerTurn(
      db,
      sessionId,
      "Para mí eso no hacer sentido, pero está interesante.",
      makeVoiceMeta({ wordsPerMin: 120 }),
    );

    const endedReport = await endTalk(db, sessionId, languageService());
    expect(endedReport.fluency).not.toBeNull();

    const rederived = getTalkReport(db, sessionId);
    expect(rederived.fluency).toEqual(endedReport.fluency);
  });
});
