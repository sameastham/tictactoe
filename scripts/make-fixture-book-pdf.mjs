// Writes fixtures/libro-falso.pdf: a small FAKE textbook (2 units x 2
// sections) shaped like the real Dicho y hecho book — same running-header
// format ("Unidad N. <title>" / "Sección N.\n\n<title>"), the same
// "En esta sección vas a:" objectives block (bulleted with "• ", matching
// how unpdf actually extracts the real book's two-column bullet list —
// each bullet glyph stays attached to its own line), numbered
// activity-instruction lines, a "Comenta con tus compañeros" block, a
// front-matter table of contents (to exercise the "skip listing pages with
// 3+ distinct sections" rule), an end-of-unit "Autoevaluación" page (to
// exercise the accumulation-halt rule), and the same two-line watermark
// interleaved throughout ("Prohibida" / "la reproducción" — see
// src/server/syllabus/ingest.ts's stripWatermark, and its doc comment for
// why this is the real, unpdf-verified shape rather than the fragmented
// shape a naive pdftotext dump of the same PDF would show).
//
// The two reading passages are ORIGINAL text written for this fixture
// (never copied from the real book — see CLAUDE.md's copyright rule), each
// containing one config-like construction ("a menos que" / "por más que")
// so src/server/syllabus/ingest.test.ts can exercise construction-seeding
// end to end without ever touching real book text.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "fixtures", "libro-falso.pdf");

const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const WRAP_WIDTH = 78;

const WATERMARK_LINES = ["Prohibida", "la reproducción"];

/** Greedy word-wrap: breaks only at spaces, never mid-word — mirrors make-fixture-pdf.mjs's helper. */
function wrapParagraph(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Expands a page "script" (a mix of plain strings and wrapped paragraphs)
 * into a flat array of literal lines to draw top to bottom, with the
 * two-line watermark ("Prohibida" / "la reproducción") prepended first —
 * matching where it actually lands in the real book's own per-page
 * extraction (see this file's header comment).
 */
function buildPageLines(blocks) {
  const lines = [...WATERMARK_LINES];

  for (const block of blocks) {
    if (block === "") {
      lines.push("");
      continue;
    }
    for (const line of wrapParagraph(block, WRAP_WIDTH)) {
      lines.push(line);
    }
  }
  return lines;
}

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle("Libro falso (fixture de prueba)");
  doc.setLanguage("es-MX");
  doc.setAuthor("Español Coach fixtures");
  const font = await doc.embedFont(StandardFonts.Helvetica);

  function addPage(blocks) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const lines = buildPageLines(blocks);
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of lines) {
      if (y < MARGIN) {
        throw new Error(`make-fixture-book-pdf: page overflowed — trim content. Overflowing line: "${line}"`);
      }
      if (line.length > 0) {
        page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
        y -= LINE_HEIGHT;
      } else {
        // A blank marker needs a Y-jump noticeably bigger than ordinary
        // line spacing — PDF.js's text extraction only emits a blank line
        // for a real vertical gap, not merely an unwritten line at the same
        // cadence as its neighbors (verified empirically against this
        // fixture: uniform spacing produced NO blank lines in extraction at
        // all, unlike the real book's genuinely paragraph-spaced layout).
        y -= LINE_HEIGHT * 2;
      }
    }
  }

  // --- Front-matter table of contents ---------------------------------
  // No period after "Unidad N" here (matches the real book's TOC shape) —
  // this is what makes the unit-heading regex correctly ignore it. Four
  // DISTINCT "Sección N." matches on one page is what triggers the
  // TOC-listing-page skip rule.
  addPage([
    "Índice",
    "",
    "Unidad 1",
    "Tema de prueba uno",
    "Sección 1. Primera sección de prueba",
    "Sección 2. Segunda sección de prueba",
    "",
    "Unidad 2",
    "Tema de prueba dos",
    "Sección 1. Tercera sección de prueba",
    "Sección 2. Cuarta sección de prueba",
  ]);

  // --- Unidad 1, Sección 1 ---------------------------------------------
  addPage([
    "Unidad 1. Tema de prueba uno",
    "Sección 1.",
    "",
    "Primera sección de prueba",
    "",
    "En esta sección vas a:",
    "• Aprender vocabulario de prueba sobre viajes.",
    "• Practicar una condición negativa con a menos que.",
    "",
    "1. Lee el siguiente texto y responde las preguntas.",
    "",
    "Marisol lleva meses planeando un viaje a Oaxaca con sus primos, pero todavía no compra los boletos de autobús. Ella dice que no va a comprometerse con las fechas a menos que todos confirmen sus vacaciones del trabajo. Sus primos, mientras tanto, ya armaron una lista de mercados y restaurantes que quieren conocer. Si logran ponerse de acuerdo esta semana, podrían salir desde la Ciudad de México el próximo viernes.",
    "",
    "2. Escribe un resumen breve del texto anterior.",
    "",
    "Unidad 1. Tema de prueba uno",
  ]);

  // --- Unidad 1, Sección 2 ---------------------------------------------
  addPage([
    "Unidad 1. Tema de prueba uno",
    "Sección 2.",
    "",
    "Segunda sección de prueba",
    "",
    "En esta sección vas a:",
    "• Repasar una locución concesiva con por más que.",
    "• Comentar tus experiencias con tus compañeros.",
    "",
    "3. Escucha el audio y completa las oraciones.",
    "",
    "Don Ernesto sigue manejando su taxi todos los días, por más que sus hijos le insisten en que ya se jubile. Él responde que el tráfico de la ciudad lo mantiene despierto y que extrañaría a sus clientes de siempre. Para él, cada viaje es una oportunidad de platicar con alguien nuevo. Sus hijos ya no discuten tanto, aunque siguen preocupados por su salud.",
    "",
    "Comenta con tus compañeros:",
    "¿Qué opinas del tema? ¿Has vivido algo similar en tu familia?",
    "",
    "Unidad 1. Tema de prueba uno",
  ]);

  // --- Unidad 1, Autoevaluación (should HALT accumulation for u1/s2) --
  addPage([
    "Unidad 1. Tema de prueba uno",
    "Autoevaluación",
    "1. Responde las siguientes preguntas de repaso.",
    "Clave de respuestas",
    "1. b  2. c  3. a",
  ]);

  // --- Unidad 2, Sección 1 ----------------------------------------------
  addPage([
    "Unidad 2. Tema de prueba dos",
    "Sección 1.",
    "",
    "Tercera sección de prueba",
    "",
    "En esta sección vas a:",
    "• Repasar vocabulario nuevo sobre mercados.",
    "• Observar un texto modelo.",
    "",
    "4. Observa las imágenes y describe lo que ves.",
    "",
    "En este mercado de prueba se venden frutas, verduras y artesanías todos los sábados. Los comerciantes llegan desde temprano para acomodar sus puestos antes de que lleguen los primeros clientes.",
    "",
    "Unidad 2. Tema de prueba dos",
  ]);

  // --- Unidad 2, Sección 2 ----------------------------------------------
  addPage([
    "Unidad 2. Tema de prueba dos",
    "Sección 2.",
    "",
    "Cuarta sección de prueba",
    "",
    "En esta sección vas a:",
    "• Practicar la argumentación escrita.",
    "",
    "5. Completa el siguiente diálogo.",
    "",
    "El equipo de prueba se reúne cada semana para revisar los avances del proyecto. Al final de cada sesión, alguien resume las tareas pendientes para la próxima reunión.",
    "",
    "Unidad 2. Tema de prueba dos",
  ]);

  const bytes = await doc.save();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, bytes);
  console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)} — ${bytes.length} bytes, ${doc.getPageCount()} pages`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
