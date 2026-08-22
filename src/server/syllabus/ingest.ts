/**
 * Book ingestion pipeline for the syllabus feature — turns Dicho y hecho PDF
 * pages into `content` rows (one per book section) and seeds `items` for
 * each unit's target constructions. `scripts/ingest-book.ts` is a thin CLI
 * over {@link ingestBook}.
 *
 * See this file's section comments below for the pipeline stages and the
 * design notes behind each (page-text extraction choice, watermark
 * stripping, section-boundary detection, apparatus filtering).
 */
import { extractText, getDocumentProxy } from "unpdf";
import type { Db } from "@/db";
import type { SyllabusLevel } from "@/lib/contracts";
import { cleanPdfText } from "@/server/pdf";
import { createContent, getContentBySyllabusRef, getItemsBySyllabusRef, seedConstructionItem } from "@/server/repo";

// -----------------------------------------------------------------------------
// Stage 1: per-page text extraction
// -----------------------------------------------------------------------------
//
// Library/approach choice: `unpdf`'s `extractText(pdf, { mergePages: false })`
// — the SAME library `src/server/pdf.ts`'s `extractPdfText` already uses for
// the Read surface's PDF upload path — called directly here instead of
// shelling out to the `pdftotext` CLI. `extractPdfText` itself isn't reused
// (it merges the whole document into one string, discarding page
// boundaries the section-splitter below needs), but this keeps the same
// pure-JS, no-native-dependency posture the rest of the app already commits
// to for PDF work (see pdf.ts's own "Library choice" note) rather than
// introducing a new binary dependency (poppler-utils) that may not exist on
// every deployment target. Verified interactively against all three real
// Dicho y hecho PDFs: `mergePages: false` reliably preserves the book's
// physical page boundaries, which is exactly what heading-based section
// splitting (Stage 3) needs.

/** Extracts one raw text string per PDF page, in page order, from a whole-PDF buffer. */
async function extractRawPages(buf: Buffer): Promise<string[]> {
  const data = new Uint8Array(buf);
  const pdf = await getDocumentProxy(data);
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return pages;
}

// -----------------------------------------------------------------------------
// Stage 2: watermark stripping
// -----------------------------------------------------------------------------
//
// Every page of the real book carries a diagonal "Prohibida la reproducción
// parcial o total..." copyright watermark. IMPORTANT finding, specific to
// unpdf (not true of every PDF-text tool: a naive pdftotext dump of the same
// pages fragments this same watermark into a scatter of short
// unrelated-looking junk lines, e.g. "Pr" / "od" / "uc" / "ci" -- that shape
// does NOT carry over if re-deriving this against a different extractor):
// unpdf's own extraction renders it cleanly as exactly two lines,
// "Prohibida" then "la reproducción", with no fragmentation at all.
// Verified programmatically against all three real PDFs, every page (190
// pages total): "Prohibida" appears as its own clean line on all 190; "la
// reproducción" appears as its own clean line on 189 of them and, on
// exactly one page (the front-matter table of contents -- already excluded
// from ingestion by the TOC-listing-page rule in Stage 3, so this never
// reaches a section bucket anyway), glues directly onto the next content
// word with no separator ("la reproducciónÍndice") -- unpdf only inserts a
// newline between text runs when their vertical gap crosses its own
// internal threshold, and doesn't always insert one between this specific
// watermark line and whatever happens to follow it. The prefix-strip below
// (rather than a whole-line drop) handles that glued case without losing
// the real word stuck to it.

const WATERMARK_LINE_RE = /^prohibida\s*$/i;
const WATERMARK_PREFIX_RE = /^la\s+reproducci[oó]n\s*/i;

/**
 * Removes the watermark from one page's raw extracted text: drops a
 * standalone "Prohibida" line outright, and strips a leading "la
 * reproducción" prefix from any line (handling both the normal
 * standalone-line case and the rare glued-onto-the-next-word case -- see
 * the note above).
 */
export function stripWatermark(pageText: string): string {
  return pageText
    .split("\n")
    .filter((line) => !WATERMARK_LINE_RE.test(line.trim()))
    .map((line) => line.replace(WATERMARK_PREFIX_RE, ""))
    .join("\n");
}

// -----------------------------------------------------------------------------
// Stage 3: section-boundary detection
// -----------------------------------------------------------------------------
//
// Every content page carries a running header/footer of the form "Unidad N.
// <unit title>" and a "Sección N." heading (sometimes split across two
// lines from its title, e.g. "Sección 1.\n\nMi México lindo y querido").
// Both REQUIRE a literal period right after the digit — this is what a
// content page's running header actually looks like, and it's also what
// naturally excludes two look-alike traps: the book's own front-matter
// table of contents (`Unidad 1\nTurismo y arqueología maya\n...`, no period
// after the unit number) and each unit's lowercase divider/"Contenido"
// intro pages (`unidad 1`, lowercase, no period, no running footer at all —
// verified against the real PDFs). A page carrying 3+ DISTINCT section
// numbers is also treated as a non-content listing page (the table of
// contents lists all of a unit's sections together) and skipped outright.
//
// Titles are deliberately NOT parsed out of the PDF text — they're taken
// straight from the already-authored, human-verified `SyllabusUnit` config
// instead. Only the (unit number, section number) integers are mined from
// the PDF, which is far more robust than trying to regex-match a title that
// may be split, reflowed, or column-interleaved.

const UNIT_HEADING_RE = /Unidad\s+(\d+)\./g;
const SECTION_HEADING_RE = /Secci[oó]n\s+(\d+)\./g;
const AUTOEVAL_RE = /Autoevaluación/;

/** Every distinct capture-group number matched by `re` (global) in `text`, in match order (may repeat). */
function matchNumbers(re: RegExp, text: string): number[] {
  return [...text.matchAll(re)].map((m) => Number(m[1]));
}

/** One book page's raw (watermark-stripped) text, tagged with which PDF it came from — purely for diagnostics/reporting. */
export type SourcedPage = { source: string; text: string };

/** One section's accumulated raw page text, plus which pages (by source file) fed it — for the ingestion report. */
export type SectionPages = {
  unitId: string;
  sectionId: string;
  pages: SourcedPage[];
};

/**
 * Walks every page (across however many PDFs were given, IN THE ORDER
 * PASSED — book part order matters) and buckets each page's raw text under
 * the (unit, section) it belongs to, per the heading rules above. A page
 * with no heading of its own inherits the current (unit, section) from the
 * page before it (`accumulating`); accumulation is deliberately PAUSED
 * (not just left alone) the moment an "Autoevaluación" page with no fresh
 * section heading is seen, and only resumes at the next real "Sección N."
 * heading — this keeps end-of-unit quiz/vocabulary/answer-key apparatus out
 * of the preceding section's bucket, since the same running "Unidad N."
 * footer continues through those pages too. Switching to a new unit number
 * always resets the current section to "unknown" first, so a unit's own
 * divider/intro pages (which carry neither heading) never get merged into
 * the previous unit's last section.
 */
export function bucketPagesBySection(sourcedPages: SourcedPage[]): SectionPages[] {
  const buckets = new Map<string, SectionPages>();
  let currentUnit: number | null = null;
  let currentSection: number | null = null;
  let accumulating = false;

  for (const page of sourcedPages) {
    const sectionNums = matchNumbers(SECTION_HEADING_RE, page.text);
    if (new Set(sectionNums).size >= 3) {
      // Table-of-contents-style listing page — not real section content.
      continue;
    }

    const unitNums = matchNumbers(UNIT_HEADING_RE, page.text);
    if (unitNums.length > 0) {
      const unit = unitNums[unitNums.length - 1];
      if (unit !== currentUnit) {
        currentUnit = unit;
        currentSection = null;
        accumulating = false;
      }
    }

    if (AUTOEVAL_RE.test(page.text) && sectionNums.length === 0) {
      accumulating = false;
      continue;
    }

    if (sectionNums.length > 0) {
      currentSection = sectionNums[sectionNums.length - 1];
      accumulating = true;
    }

    if (accumulating && currentUnit !== null && currentSection !== null) {
      const unitId = `u${currentUnit}`;
      const sectionId = `s${currentSection}`;
      const key = `${unitId}/${sectionId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { unitId, sectionId, pages: [] };
        buckets.set(key, bucket);
      }
      bucket.pages.push(page);
    }
  }

  return [...buckets.values()];
}

// -----------------------------------------------------------------------------
// Stage 4: apparatus filtering + paragraph reconstruction
// -----------------------------------------------------------------------------
//
// Light, honest filtering: this drops the activity-instruction scaffolding
// that surrounds a section's actual reading passages, not every non-prose
// line the book contains -- perfection isn't the bar, "the reading passages
// come through clean" is (verified against the real Unidad 4 Sección 2 text
// -- see the ingestion report for a before/after sample). Four patterns are
// dropped, all tuned against unpdf's ACTUAL per-line output on the real
// PDFs (see Stage 2's note on why that matters -- a naive pdftotext dump of
// the same pages looks meaningfully different):
//
//   1. The running "Unidad N. <title>" / "Sección N. <title>" header/footer
//      itself. Unlike ordinary repeated furniture, `cleanPdfText`'s
//      repeated-line dropper can't catch the "Unidad N." one reliably: the
//      book page number rides along on the SAME line, glued on with no
//      separator and in a varying position ("Unidad 1. Turismo y
//      arqueología maya 11" on one page, "12 Unidad 1. Turismo y
//      arqueología maya" on the next) -- so the line is almost never
//      byte-identical twice, and never hits `cleanPdfText`'s 3-repeats
//      threshold. Dropped directly here instead, by the same heading
//      regexes Stage 3 uses to detect section boundaries in the first
//      place. Also covers the "Autoevaluación" end-of-unit heading.
//   2. A numbered activity-instruction line ("1.", "2a.", ...) immediately
//      followed by one of the book's stock imperative verbs (Lee, Escribe,
//      Comenta, Escucha, Observa, Completa, Subraya, Relaciona, Responde).
//   3. The "En esta sección vas a:" objectives block: the heading plus the
//      contiguous run of "• ..." bullet lines right after it (unpdf keeps
//      each bullet's glyph attached to its own text on one line, unlike a
//      naive pdftotext dump, which tears the two-column bullet layout
//      apart -- so a clean bullet-prefix stopping rule is both correct and
//      simple here).
//   4. A "Comenta con tus compañeros" discussion-prompt block: the heading
//      (optionally itself numbered, e.g. "5. Comenta con tus
//      compañeros.") plus the contiguous run of question lines right after
//      it (any line containing "¿" -- covers both a restarted-numbering
//      question list and a single inline question; stops at the first
//      following line that ISN'T itself a question, e.g. the next real
//      numbered activity).
//
// None of these rely on blank lines as a boundary signal -- verified that
// unpdf's per-page extraction of the real book essentially never produces
// one (a whole page comes back as one dense run of non-blank lines), unlike
// a naive pdftotext dump, which inserts them liberally. `cleanPdfText`
// (`src/server/pdf.ts`) is still reused as-is for what it's actually good
// for here: de-hyphenating line wraps and joining hard line breaks.

const UNIT_OR_SECTION_HEADING_LINE_RE = /(Unidad\s+\d+\.|Secci[oó]n\s+\d+\.)/;
/** A running-header line is short -- well under a real prose line's length -- this length cap keeps a genuine sentence that happens to mention "Unidad 3." from ever being dropped. */
const HEADING_LINE_MAX_LENGTH = 100;
const AUTOEVAL_HEADING_LINE_RE = /^(Unidad\s+\d+\s+)?Autoevaluación(\s+Unidad\s+\d+)?$/i;
/** A standalone skill-icon caption ("Txt" = reading/text activity) that occasionally lands as its own line near a section opening — rare (6 occurrences across all 190 real pages) but cheap and safe to drop outright. */
const ICON_CAPTION_LINE_RE = /^Txt$/;

const NUMBERED_INSTRUCTION_RE =
  /^\d+[a-z]?\.\s*(Lee|Escribe|Comenta|Escucha|Observa|Completa|Subraya|Relaciona|Responde)\b/i;
const VAS_A_HEADING_RE = /^En esta sección vas a:?$/i;
const BULLET_LINE_RE = /^[•]/;
const COMENTA_COMPANEROS_RE = /^(?:\d+[a-z]?\.\s*)?Comenta con tus compañeros/i;

/**
 * Drops a block starting at `startIndex` (a heading line already matched by
 * the caller) plus every immediately-following line that satisfies
 * `isContinuation`. Returns the index of the first line NOT consumed, so
 * the caller can continue scanning from there.
 */
function dropBlock(lines: string[], startIndex: number, keep: boolean[], isContinuation: (line: string) => boolean): number {
  keep[startIndex] = false;
  let i = startIndex + 1;
  while (i < lines.length && isContinuation(lines[i].trim())) {
    keep[i] = false;
    i++;
  }
  return i;
}

/**
 * Drops activity-instruction scaffolding and running-header noise from raw
 * section text (see the four patterns documented above). Operates
 * line-by-line on the NOT-yet-paragraph-joined text -- apparatus lines are
 * single-purpose instruction lines, easiest to identify before
 * `cleanPdfText` merges everything into flowing paragraphs.
 */
export function stripApparatus(rawText: string): string {
  const lines = rawText.split("\n");
  const keep = lines.map(() => true);

  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    const line = lines[i];
    const trimmed = line.trim();

    if (AUTOEVAL_HEADING_LINE_RE.test(trimmed) || ICON_CAPTION_LINE_RE.test(trimmed)) {
      keep[i] = false;
      continue;
    }
    if (trimmed.length <= HEADING_LINE_MAX_LENGTH && UNIT_OR_SECTION_HEADING_LINE_RE.test(trimmed)) {
      keep[i] = false;
      continue;
    }
    // Checked BEFORE the generic numbered-instruction rule: "Comenta" is
    // also one of that rule's stock imperative verbs, so a numbered
    // "N. Comenta con tus compañeros." heading would otherwise match THAT
    // rule first and only drop the heading line itself, leaving the block's
    // question lines behind uncollected.
    if (COMENTA_COMPANEROS_RE.test(trimmed)) {
      i = dropBlock(lines, i, keep, (l) => l.includes("¿")) - 1; // -1: the for-loop's own i++ advances past the block's end.
      continue;
    }
    if (NUMBERED_INSTRUCTION_RE.test(trimmed)) {
      keep[i] = false;
      continue;
    }
    if (VAS_A_HEADING_RE.test(trimmed)) {
      i = dropBlock(lines, i, keep, (l) => BULLET_LINE_RE.test(l)) - 1;
      continue;
    }
  }

  return lines.filter((_, i) => keep[i]).join("\n");
}

/**
 * Drops any line that's an exact (whitespace/case-insensitive) match for
 * `title` — the section's own title line (e.g. "Segunda sección de
 * prueba"), which appears verbatim once per section as its own text line.
 * Since titles come straight from the human-verified config rather than
 * being parsed out of the PDF (see Stage 3's note), this is a precise,
 * false-positive-free drop, not a heuristic — and it matters because there
 * are no blank lines in `unpdf`'s extraction to otherwise keep this title
 * from gluing onto the section's first real sentence once `cleanPdfText`
 * joins everything into a paragraph.
 */
function stripTitleLine(text: string, title: string): string {
  const normalizedTitle = title.trim().toLowerCase();
  return text
    .split("\n")
    .filter((line) => line.trim().toLowerCase() !== normalizedTitle)
    .join("\n");
}

/**
 * Builds one section's final cleaned prose from its accumulated raw pages:
 * watermark already stripped per-page, its own title line and the unit's
 * title line dropped (see {@link stripTitleLine}), apparatus-filter, then
 * `cleanPdfText`.
 */
export function buildSectionText(pages: SourcedPage[], sectionTitle: string, unitTitle: string): string {
  let joined = pages.map((p) => p.text).join("\n\n");
  joined = stripTitleLine(joined, sectionTitle);
  joined = stripTitleLine(joined, unitTitle);
  return cleanPdfText(stripApparatus(joined));
}

// -----------------------------------------------------------------------------
// Stage 5: construction -> origin-sentence lookup
// -----------------------------------------------------------------------------

/** Same sentence splitter as `src/server/goldset/build.ts`'s `splitSentences` — kept local (tiny, and that one isn't exported) rather than reaching across modules for four lines. */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A construction's chunk located in real ingested text: the sentence it occurs in, and the chunk's ACTUAL surface casing there (see {@link findConstructionOccurrence}). */
export type ConstructionOccurrence = { sentence: string; matchedChunk: string };

/**
 * The first sentence of `text` that contains `chunk`, case-insensitively —
 * a config chunk is always authored lowercase (matching how it normally
 * appears mid-sentence), but a grammar-box EXAMPLE sentence very often puts
 * the target construction first, capitalized ("Anda pensando en volver a
 * emigrar.") — verified empirically: every one of Dicho y hecho 7 Unidad
 * 6's periphrasis-of-participle constructions only occurs in the real text
 * sentence-initial. Matching case-insensitively and returning the ACTUAL
 * substring found (`matchedChunk`, real casing and accents intact) — rather
 * than always the config's lowercase form — is what upholds the hard rule
 * every item needs: `chunk` must be a verbatim substring of `origin_sentence`,
 * not merely equal to it case-insensitively. Returns null if no sentence
 * contains `chunk` in any casing.
 */
export function findConstructionOccurrence(text: string, chunk: string): ConstructionOccurrence | null {
  const chunkLower = chunk.toLowerCase();
  for (const sentence of splitIntoSentences(text)) {
    const sentenceLower = sentence.toLowerCase();
    const index = sentenceLower.indexOf(chunkLower);
    if (index !== -1) {
      return { sentence, matchedChunk: sentence.slice(index, index + chunk.length) };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Stage 6: orchestration — the ingestion run itself
// -----------------------------------------------------------------------------
//
// Idempotent by `syllabusRef`: a content row is skipped (not re-inserted)
// when one already exists for a given "{level}/{unit}/{section}"; a
// construction is skipped once an item already carries its unit's
// `syllabusRef` and that exact `chunk`. Re-running this against the same DB
// state always converges to the same end state without duplicating rows.
//
// Deliberate deviation from a literal "one DB transaction per section":
// each individual write (`createContent`, each `seedConstructionItem` call)
// is already atomic on its own (`seedConstructionItem` wraps its
// item-plus-event pair in one transaction internally — see
// `src/server/repo.ts`), and the whole run is idempotent, so a crash
// mid-section just leaves some of that section's writes already done —
// re-running the ingestion finishes the rest without creating duplicates or
// requiring any cleanup. True nested-transaction atomicity (wrapping a
// section's content-row insert and its constructions in one single SQLite
// transaction) would need every repo.ts write helper to accept either the
// plain `Db` handle or a transaction handle, which none of them do today;
// idempotent recovery gets the same practical guarantee (a botched run is
// always safely resumable) without that invasive a change.

/** One section's ingestion outcome. */
export type SectionIngestResult = {
  unitId: string;
  sectionId: string;
  syllabusRef: string;
  title: string;
  contentId: string;
  textLength: number;
  alreadyExisted: boolean;
};

/** One construction's ingestion outcome. */
export type ConstructionIngestResult = {
  constructionId: string;
  chunk: string;
  status: "found" | "unfound" | "already_seeded";
  /** The section id the chunk's first occurrence was found in — only set when `status === "found"`. */
  foundInSectionId?: string;
};

/** One unit's full ingestion outcome — the shape `scripts/ingest-book.ts` renders as the per-unit report table. */
export type UnitIngestResult = {
  unitId: string;
  title: string;
  sections: SectionIngestResult[];
  constructions: ConstructionIngestResult[];
};

/** Full ingestion run outcome. */
export type IngestReport = {
  levelId: string;
  units: UnitIngestResult[];
  /** Config sections for which NO page of any given PDF was found (heading never matched) — a real mismatch worth investigating, not just an empty section. */
  missingSections: string[];
};

/** One whole-PDF input to {@link ingestBook}: a human-readable source label (for diagnostics) and its raw bytes. */
export type IngestPdfInput = { source: string; buf: Buffer };

/**
 * Runs the full book -> content/items ingestion pipeline for one syllabus
 * level, against however many PDF parts make it up — PASSED IN BOOK ORDER
 * (e.g. pt_1.1, then pt_1.2, then pt_2), since pages accumulate into section
 * buckets in the order given and a section can legitimately span a PDF part
 * boundary (verified against the real files: no page-content overlap exists
 * at either pt_1.1/pt_1.2 or pt_1.2/pt_2's boundary — the split is
 * contiguous, not overlapping — so straight concatenation in part order is
 * correct here; a future level whose PDFs DO overlap would need a
 * dedup pass this function doesn't implement).
 */
export async function ingestBook(db: Db, level: SyllabusLevel, pdfs: IngestPdfInput[]): Promise<IngestReport> {
  const sourcedPages: SourcedPage[] = [];
  for (const pdf of pdfs) {
    const rawPages = await extractRawPages(pdf.buf);
    for (const pageText of rawPages) {
      sourcedPages.push({ source: pdf.source, text: stripWatermark(pageText) });
    }
  }

  const sectionBuckets = bucketPagesBySection(sourcedPages);
  const bucketByKey = new Map(sectionBuckets.map((b) => [`${b.unitId}/${b.sectionId}`, b]));

  const units: UnitIngestResult[] = [];
  const missingSections: string[] = [];

  for (const unit of level.units) {
    const sectionResults: SectionIngestResult[] = [];
    /** This unit's sections, in config order, with their final text and content row id — the search space for construction lookup below. */
    const ingestedSections: { sectionId: string; contentId: string; text: string }[] = [];

    for (const section of unit.sections) {
      const syllabusRef = `${level.id}/${unit.id}/${section.id}`;
      const bucket = bucketByKey.get(`${unit.id}/${section.id}`);

      if (!bucket || bucket.pages.length === 0) {
        missingSections.push(syllabusRef);
        continue;
      }

      const text = buildSectionText(bucket.pages, section.title, unit.title);

      const existing = getContentBySyllabusRef(db, syllabusRef);
      const contentRow =
        existing ??
        createContent(db, {
          source: "upload",
          type: "article",
          title: `${unit.title} — ${section.title}`,
          text,
          didactic: true,
          syllabusRef,
        });

      ingestedSections.push({ sectionId: section.id, contentId: contentRow.id, text: existing ? existing.text : text });
      sectionResults.push({
        unitId: unit.id,
        sectionId: section.id,
        syllabusRef,
        title: section.title,
        contentId: contentRow.id,
        textLength: (existing ? existing.text : text).length,
        alreadyExisted: existing !== undefined,
      });
    }

    const unitSyllabusRef = `${level.id}/${unit.id}`;
    // Case-insensitive: `seedConstructionItem` may store the ACTUAL casing
    // found in the text (see `findConstructionOccurrence`) rather than the
    // config's lowercase `chunk`, so idempotency has to compare
    // case-insensitively too, or a re-run would seed a "new" duplicate item
    // every time for any construction whose only real occurrence was
    // sentence-initial/capitalized.
    const alreadySeededChunksLower = new Set(
      getItemsBySyllabusRef(db, unitSyllabusRef).map((item) => item.chunk.toLowerCase()),
    );
    const constructionResults: ConstructionIngestResult[] = [];

    for (const construction of unit.constructions) {
      if (alreadySeededChunksLower.has(construction.chunk.toLowerCase())) {
        constructionResults.push({ constructionId: construction.id, chunk: construction.chunk, status: "already_seeded" });
        continue;
      }

      let found: { sectionId: string; contentId: string; occurrence: ConstructionOccurrence } | undefined;
      for (const ingested of ingestedSections) {
        const occurrence = findConstructionOccurrence(ingested.text, construction.chunk);
        if (occurrence) {
          found = { sectionId: ingested.sectionId, contentId: ingested.contentId, occurrence };
          break;
        }
      }

      if (found) {
        seedConstructionItem(db, {
          chunk: found.occurrence.matchedChunk,
          originContentId: found.contentId,
          originSentence: found.occurrence.sentence,
          why: construction.description,
          tag: construction.tag,
          syllabusRef: unitSyllabusRef,
        });
        constructionResults.push({
          constructionId: construction.id,
          chunk: construction.chunk,
          status: "found",
          foundInSectionId: found.sectionId,
        });
      } else {
        // Not found anywhere in this run's ingested text — seed it anyway so
        // it schedules/drills like any other item, but with no real origin
        // to point back to. originContentId: null, originSentence: the
        // chunk itself (never an invented example sentence — see the
        // deliverable spec: no fabricated "origin" prose). Backfilling a
        // real origin once the phrase IS found in some future ingested
        // content is left as v2.
        seedConstructionItem(db, {
          chunk: construction.chunk,
          originContentId: null,
          originSentence: construction.chunk,
          why: construction.description,
          tag: construction.tag,
          syllabusRef: unitSyllabusRef,
        });
        constructionResults.push({ constructionId: construction.id, chunk: construction.chunk, status: "unfound" });
      }
    }

    units.push({ unitId: unit.id, title: unit.title, sections: sectionResults, constructions: constructionResults });
  }

  return { levelId: level.id, units, missingSections };
}
