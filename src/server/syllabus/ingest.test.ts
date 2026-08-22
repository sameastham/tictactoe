import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/db";
import { content, items } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { SyllabusLevel } from "@/lib/contracts";
import {
  bucketPagesBySection,
  buildConstructionContrastSet,
  buildSectionText,
  findConstructionOccurrence,
  ingestBook,
  stripApparatus,
  stripWatermark,
  type SourcedPage,
} from "@/server/syllabus/ingest";

const FIXTURE_PDF_PATH = path.join(process.cwd(), "fixtures", "libro-falso.pdf");

/**
 * A small syllabus level matching `fixtures/libro-falso.pdf`'s shape (2
 * units x 2 sections) — kept inline here rather than in `config/syllabus/`,
 * per the deliverable spec: only real levels live in `config/`, test
 * fixtures don't.
 */
function fakeLevel(): SyllabusLevel {
  return {
    id: "fakebook",
    series: "dicho-y-hecho",
    name: "Fake Book",
    cefr: "B2+",
    units: [
      {
        id: "u1",
        title: "Tema de prueba uno",
        theme: "tema uno",
        sections: [
          { id: "s1", title: "Primera sección de prueba", objectives: ["obj1"] },
          { id: "s2", title: "Segunda sección de prueba", objectives: ["obj2"] },
        ],
        constructions: [
          { id: "c1", chunk: "a menos que", description: "condición negativa", tag: "grammar" },
          { id: "c2", chunk: "por más que", description: "concesión", tag: "discourse" },
          { id: "c3", chunk: "esta frase no existe en el libro falso", description: "unfound test", tag: "grammar" },
        ],
        tareas: [{ id: "t1", prompt: "Escribe algo de prueba usando a menos que.", targetConstructionIds: ["c1"] }],
      },
      {
        id: "u2",
        title: "Tema de prueba dos",
        theme: "tema dos",
        sections: [
          { id: "s1", title: "Tercera sección de prueba", objectives: ["obj3"] },
          { id: "s2", title: "Cuarta sección de prueba", objectives: ["obj4"] },
        ],
        constructions: [],
        tareas: [],
      },
    ],
  };
}

function loadFixtureBuf(): Buffer {
  return fs.readFileSync(FIXTURE_PDF_PATH);
}

// -----------------------------------------------------------------------------
// stripWatermark
// -----------------------------------------------------------------------------

describe("stripWatermark", () => {
  it("drops a standalone 'Prohibida' line", () => {
    expect(stripWatermark("Prohibida\nHola mundo")).toBe("Hola mundo");
  });

  it("strips a leading 'la reproducción' prefix, keeping any glued-on remainder", () => {
    expect(stripWatermark("la reproducciónÍndice")).toBe("Índice");
    expect(stripWatermark("la reproducción")).toBe("");
  });

  it("is case-insensitive", () => {
    expect(stripWatermark("PROHIBIDA\nLA REPRODUCCIÓN algo")).toBe("algo");
  });

  it("leaves ordinary prose untouched", () => {
    const text = "Hola, esto es una prueba.\nSegunda línea normal.";
    expect(stripWatermark(text)).toBe(text);
  });
});

// -----------------------------------------------------------------------------
// stripApparatus
// -----------------------------------------------------------------------------

describe("stripApparatus", () => {
  it("drops the running Unidad/Sección header lines", () => {
    const text = "Unidad 1. Turismo y arqueología maya\nSección 1. Mi México lindo y querido\nTexto real aquí.";
    expect(stripApparatus(text)).toBe("Texto real aquí.");
  });

  it("drops an Autoevaluación heading line", () => {
    expect(stripApparatus("Unidad 1 Autoevaluación\nTexto real.")).toBe("Texto real.");
  });

  it("drops a numbered instruction line led by a stock imperative verb", () => {
    const text = "1. Lee el texto y responde.\nTexto real.";
    expect(stripApparatus(text)).toBe("Texto real.");
  });

  it("keeps a numbered line that isn't led by a stock imperative verb", () => {
    const text = "1. A continuación se describe algo.\nTexto real.";
    expect(stripApparatus(text)).toBe(text);
  });

  it("drops the 'En esta sección vas a:' block up to (not including) the first non-bullet line", () => {
    const text = "En esta sección vas a:\n• Objetivo uno.\n• Objetivo dos.\nTexto real.";
    expect(stripApparatus(text)).toBe("Texto real.");
  });

  it("drops a 'Comenta con tus compañeros' block up to the first non-question line", () => {
    const text = "Comenta con tus compañeros:\n¿Pregunta uno?\n¿Pregunta dos?\nTexto real.";
    expect(stripApparatus(text)).toBe("Texto real.");
  });

  it("stops the Comenta block at the next real (non-question) activity, not swallowing it", () => {
    const text = "5. Comenta con tus compañeros.\n¿Pregunta uno?\n6. Este es el siguiente ejercicio real.";
    expect(stripApparatus(text)).toBe("6. Este es el siguiente ejercicio real.");
  });
});

// -----------------------------------------------------------------------------
// bucketPagesBySection
// -----------------------------------------------------------------------------

describe("bucketPagesBySection", () => {
  it("skips a table-of-contents-style page with 3+ distinct section headings", () => {
    const toc: SourcedPage = {
      source: "f",
      text: "Sección 1. Uno\nSección 2. Dos\nSección 3. Tres",
    };
    const content1: SourcedPage = { source: "f", text: "Unidad 1. Tema\nSección 1. Uno\nTexto real." };
    const buckets = bucketPagesBySection([toc, content1]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].unitId).toBe("u1");
    expect(buckets[0].sectionId).toBe("s1");
    expect(buckets[0].pages).toHaveLength(1);
  });

  it("ignores the front-matter-style 'Unidad N' (no period) and lowercase 'unidad n' dividers", () => {
    const divider: SourcedPage = { source: "f", text: "unidad 1Tema de prueba" };
    const toc: SourcedPage = { source: "f", text: "Unidad 1\nTema\nSección 1. Uno\nSección 2. Dos\nSección 3. Tres" };
    const buckets = bucketPagesBySection([divider, toc]);
    expect(buckets).toHaveLength(0);
  });

  it("forward-fills a page with no heading of its own into the current section", () => {
    const p1: SourcedPage = { source: "f", text: "Unidad 1. Tema\nSección 1. Uno\nPrimera parte." };
    const p2: SourcedPage = { source: "f", text: "Segunda parte, sin encabezado." };
    const buckets = bucketPagesBySection([p1, p2]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].pages).toHaveLength(2);
  });

  it("halts accumulation at an Autoevaluación page and does not resume until a fresh Sección heading", () => {
    const p1: SourcedPage = { source: "f", text: "Unidad 1. Tema\nSección 1. Uno\nContenido real." };
    const autoeval: SourcedPage = { source: "f", text: "Unidad 1. Tema\nAutoevaluación\nPreguntas de repaso." };
    const dividerLikeGap: SourcedPage = { source: "f", text: "Material intermedio sin encabezado." };
    const p2: SourcedPage = { source: "f", text: "Unidad 1. Tema\nSección 2. Dos\nMás contenido." };
    const buckets = bucketPagesBySection([p1, autoeval, dividerLikeGap, p2]);

    const s1 = buckets.find((b) => b.sectionId === "s1")!;
    const s2 = buckets.find((b) => b.sectionId === "s2")!;
    expect(s1.pages).toHaveLength(1); // only p1 — autoeval and the gap page are excluded.
    expect(s2.pages).toHaveLength(1);
  });

  it("resets to 'no current section' when the unit number changes, so a new unit's own intro/divider page (no heading at all) never leaks into either unit's bucket", () => {
    const u1s2: SourcedPage = { source: "f", text: "Unidad 1. Tema uno\nSección 2. Dos\nContenido." };
    // Real books always run an Autoevaluación page (still same unit number)
    // between a unit's last section and the next unit's divider — that's
    // what actually halts accumulation before the headerless divider page
    // is ever reached; see this file's other Autoevaluación test.
    const autoeval: SourcedPage = { source: "f", text: "Unidad 1. Tema uno\nAutoevaluación\nPreguntas de repaso." };
    const introGap: SourcedPage = { source: "f", text: "Página introductoria de la unidad 2, sin encabezado real." };
    const u2s1: SourcedPage = { source: "f", text: "Unidad 2. Tema dos\nSección 1. Uno\nContenido nuevo." };
    const buckets = bucketPagesBySection([u1s2, autoeval, introGap, u2s1]);

    const u1 = buckets.find((b) => b.unitId === "u1" && b.sectionId === "s2")!;
    const u2 = buckets.find((b) => b.unitId === "u2" && b.sectionId === "s1")!;
    expect(u1.pages).toHaveLength(1); // introGap must NOT leak into unit 1's last section.
    expect(u2.pages).toHaveLength(1); // introGap must NOT leak into unit 2's first section either (never sighted a section heading while unit==2 until u2s1).
  });
});

// -----------------------------------------------------------------------------
// findConstructionOccurrence
// -----------------------------------------------------------------------------

describe("findConstructionOccurrence", () => {
  it("finds a mid-sentence, exact-case occurrence", () => {
    const text = "Primera oración. No voy a menos que confirmes. Otra más.";
    const result = findConstructionOccurrence(text, "a menos que");
    expect(result?.sentence).toBe("No voy a menos que confirmes.");
    expect(result?.matchedChunk).toBe("a menos que");
  });

  it("finds a sentence-initial, capitalized occurrence and returns the ACTUAL casing found", () => {
    const text = "Algo antes. A menos que confirmes, no voy.";
    const result = findConstructionOccurrence(text, "a menos que");
    expect(result?.sentence).toBe("A menos que confirmes, no voy.");
    expect(result?.matchedChunk).toBe("A menos que");
  });

  it("returns null when the chunk occurs nowhere", () => {
    expect(findConstructionOccurrence("Ninguna coincidencia aquí.", "a menos que")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// ingestBook — end to end against the fake-book fixture
// -----------------------------------------------------------------------------

describe("ingestBook (fixture)", () => {
  it("ingests every config section, seeds found/unfound constructions, and reports none missing", async () => {
    const db = createTestDb();
    const buf = loadFixtureBuf();
    const report = await ingestBook(db, fakeLevel(), [{ source: "libro-falso.pdf", buf }]);

    expect(report.missingSections).toEqual([]);
    expect(report.units).toHaveLength(2);

    const u1 = report.units.find((u) => u.unitId === "u1")!;
    expect(u1.sections.map((s) => s.sectionId)).toEqual(["s1", "s2"]);
    expect(u1.sections.every((s) => !s.alreadyExisted)).toBe(true);
    expect(u1.sections.every((s) => s.textLength > 0)).toBe(true);

    const byId = Object.fromEntries(u1.constructions.map((c) => [c.constructionId, c]));
    expect(byId.c1.status).toBe("found");
    expect(byId.c1.foundInSectionId).toBe("s1");
    expect(byId.c2.status).toBe("found");
    expect(byId.c2.foundInSectionId).toBe("s2");
    expect(byId.c3.status).toBe("unfound");
  });

  it("writes clean section prose free of watermark/apparatus noise, and containing the authored passages", async () => {
    const db = createTestDb();
    const buf = loadFixtureBuf();
    await ingestBook(db, fakeLevel(), [{ source: "libro-falso.pdf", buf }]);

    const row = db.select().from(content).where(eq(content.syllabusRef, "fakebook/u1/s1")).get()!;
    expect(row.didactic).toBe(true);
    expect(row.text).toContain("a menos que todos confirmen");
    expect(row.text).not.toContain("Prohibida");
    expect(row.text).not.toContain("la reproducción");
    expect(row.text).not.toContain("En esta sección vas a");
    expect(row.text).not.toContain("Lee el siguiente texto");
    expect(row.text).not.toContain("Unidad 1. Tema de prueba uno");
  });

  it("seeds an item per found construction with a verbatim origin_sentence containing the chunk", async () => {
    const db = createTestDb();
    const buf = loadFixtureBuf();
    await ingestBook(db, fakeLevel(), [{ source: "libro-falso.pdf", buf }]);

    const seeded = db.select().from(items).where(eq(items.syllabusRef, "fakebook/u1")).all();
    expect(seeded).toHaveLength(3);

    const found = seeded.find((i) => i.chunk === "a menos que")!;
    expect(found.originSentence).toContain(found.chunk);
    expect(found.originContentId).not.toBeNull();
    expect(found.taxonomy).toEqual(["grammar"]);
    // Chunk first, then the same-tag sibling (c3, grammar), then the rest (c2).
    expect(found.contrastSet).toEqual(["a menos que", "esta frase no existe en el libro falso", "por más que"]);

    const unfound = seeded.find((i) => i.chunk === "esta frase no existe en el libro falso")!;
    expect(unfound.originContentId).toBeNull();
    expect(unfound.originSentence).toBe(unfound.chunk);
    expect(unfound.contrastSet).toEqual(["esta frase no existe en el libro falso", "a menos que", "por más que"]);

    // No same-tag sibling (c2 is the only discourse construction): rivals are the rest in config order.
    const discourse = seeded.find((i) => i.chunk === "por más que")!;
    expect(discourse.contrastSet).toEqual(["por más que", "a menos que", "esta frase no existe en el libro falso"]);
  });

  it("backfills a null contrast set on an already-seeded item when re-run, without touching existing sets", async () => {
    const db = createTestDb();
    const buf = loadFixtureBuf();
    const level = fakeLevel();
    await ingestBook(db, level, [{ source: "libro-falso.pdf", buf }]);

    // Simulate an item seeded before contrast sets existed.
    db.update(items).set({ contrastSet: null }).where(eq(items.chunk, "a menos que")).run();
    const untouchedBefore = db.select().from(items).where(eq(items.chunk, "por más que")).get()!.contrastSet;

    const report = await ingestBook(db, level, [{ source: "libro-falso.pdf", buf }]);

    const backfilled = db.select().from(items).where(eq(items.chunk, "a menos que")).get()!;
    expect(backfilled.contrastSet).toEqual(["a menos que", "esta frase no existe en el libro falso", "por más que"]);
    expect(db.select().from(items).where(eq(items.chunk, "por más que")).get()!.contrastSet).toEqual(untouchedBefore);
    expect(report.units[0].constructions.every((c) => c.status === "already_seeded")).toBe(true);
  });

  it("is idempotent: re-running against the same DB inserts nothing new", async () => {
    const db = createTestDb();
    const buf = loadFixtureBuf();
    const level = fakeLevel();

    await ingestBook(db, level, [{ source: "libro-falso.pdf", buf }]);
    const contentCountAfterFirst = db.select().from(content).all().length;
    const itemCountAfterFirst = db.select().from(items).all().length;

    const secondReport = await ingestBook(db, level, [{ source: "libro-falso.pdf", buf }]);

    expect(db.select().from(content).all()).toHaveLength(contentCountAfterFirst);
    expect(db.select().from(items).all()).toHaveLength(itemCountAfterFirst);
    expect(secondReport.units.flatMap((u) => u.sections).every((s) => s.alreadyExisted)).toBe(true);
    expect(
      secondReport.units
        .flatMap((u) => u.constructions)
        .filter((c) => c.status !== undefined)
        .every((c) => c.status === "already_seeded"),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// buildSectionText
// -----------------------------------------------------------------------------

describe("buildSectionText", () => {
  it("drops the section's own and the unit's own title lines so they don't glue onto the first sentence", () => {
    const pages: SourcedPage[] = [
      { source: "f", text: "Unidad de prueba\nSección de prueba\nContenido real de la sección." },
    ];
    const text = buildSectionText(pages, "Sección de prueba", "Unidad de prueba");
    expect(text).toBe("Contenido real de la sección.");
  });
});

describe("buildConstructionContrastSet", () => {
  const unit = fakeLevel().units[0];

  it("puts the (actual-casing) chunk first, same-tag siblings next, then the rest", () => {
    const c1 = unit.constructions[0]; // grammar
    expect(buildConstructionContrastSet(unit, c1, "A menos que")).toEqual([
      "A menos que",
      "esta frase no existe en el libro falso",
      "por más que",
    ]);
  });

  it("caps rivals at three", () => {
    const big = {
      ...unit,
      constructions: Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        chunk: `frase ${i}`,
        description: "d",
        tag: "grammar" as const,
      })),
    };
    const set = buildConstructionContrastSet(big, big.constructions[0]);
    expect(set).toEqual(["frase 0", "frase 1", "frase 2", "frase 3"]);
  });

  it("returns null when the unit has no other construction to contrast against", () => {
    const lone = { ...unit, constructions: [unit.constructions[0]] };
    expect(buildConstructionContrastSet(lone, lone.constructions[0])).toBeNull();
  });
});
