import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractPdfText, PDF_OCR_MAX_PAGES, PdfExtractError } from "@/server/pdf";

/**
 * OCR-fallback coverage for {@link extractPdfText} — see the "OCR engine
 * choice" doc comment at the bottom of src/server/pdf.ts. Runs against
 * fixtures/escaneo-es-mx.pdf (scripts/make-fixture-scanned-pdf.mjs): a real
 * 2-page PDF with NO text layer, each page a full-bleed PNG raster of
 * fixtures/article-es-mx.txt rendered with @napi-rs/canvas — the same
 * article the text-layer PDF fixture (fixtures/articulo-es-mx.pdf,
 * src/server/pdf.test.ts) uses, so both suites can assert against known
 * prose without duplicating a second fixture article.
 *
 * OCR is genuinely slow on CPU (WASM tesseract.js, no GPU) — each test that
 * runs it gets a generous per-test timeout rather than relying on vitest's
 * default.
 */

const SCANNED_PDF_PATH = path.join(process.cwd(), "fixtures", "escaneo-es-mx.pdf");
const TEXT_LAYER_PDF_PATH = path.join(process.cwd(), "fixtures", "articulo-es-mx.pdf");
const ARTICLE_TXT_PATH = path.join(process.cwd(), "fixtures", "article-es-mx.txt");

const OCR_TEST_TIMEOUT_MS = 60_000;

// 6 distinctive words pulled from fixtures/article-es-mx.txt (the café
// article) — long enough, specific enough to the source text, and varied
// enough (plain, capitalized, accented) to be a meaningful fuzzy check.
// Fuzzy on purpose: OCR is imperfect, so this suite requires most, not all,
// of these to survive a real OCR pass rather than byte-matching the source.
const DISTINCTIVE_WORDS = ["cafeterías", "tostadores", "Guadalajara", "caficultores", "gentrificación", "trazabilidad"];
const DISTINCTIVE_WORDS_MIN_HITS = 4;

describe("extractPdfText OCR fallback", () => {
  it(
    "OCRs a scanned (text-layer-free) PDF: ocr:true, and recovers most of the article's distinctive words",
    async () => {
      const buf = fs.readFileSync(SCANNED_PDF_PATH);
      const { title, text, ocr, truncated } = await extractPdfText(buf);

      expect(ocr).toBe(true);
      expect(truncated).toBe(false);
      expect(title).toBe("Café de especialidad (escaneo de prueba)");

      const lower = text.toLowerCase();
      const hits = DISTINCTIVE_WORDS.filter((word) => lower.includes(word.toLowerCase()));
      expect(hits.length).toBeGreaterThanOrEqual(DISTINCTIVE_WORDS_MIN_HITS);
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    "keeps at least one accented word intact through OCR (á/é/í/ó/ú/ñ survive)",
    async () => {
      const buf = fs.readFileSync(SCANNED_PDF_PATH);
      const { text } = await extractPdfText(buf);

      // Tolerant of which specific accented word survives (OCR is
      // imperfect) — requires that at least one of several accented forms
      // known to appear in the source article comes through with its
      // accent, not just the bare consonant skeleton.
      const accentedCandidates = ["café", "década", "gentrificación", "trazabilidad", "próspero", "público", "climático"];
      const lower = text.toLowerCase();
      const survived = accentedCandidates.some((word) => lower.includes(word));
      expect(survived).toBe(true);
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it(
    "does NOT OCR a normal text-layer PDF — fast path, ocr:false",
    async () => {
      const buf = fs.readFileSync(TEXT_LAYER_PDF_PATH);
      const t0 = Date.now();
      const { ocr, truncated, text } = await extractPdfText(buf);
      const elapsedMs = Date.now() - t0;

      expect(ocr).toBe(false);
      expect(truncated).toBe(false);
      // Byte-for-byte match with the source article (see src/server/pdf.test.ts)
      // — only possible via the text-layer path, never OCR's reconstruction.
      const original = fs.readFileSync(ARTICLE_TXT_PATH, "utf-8").trim();
      expect(text).toBe(original);
      // A real signal that OCR did NOT run: the text-layer path is fast
      // (no rasterization, no WASM recognition pass).
      expect(elapsedMs).toBeLessThan(5000);
    },
    OCR_TEST_TIMEOUT_MS,
  );

  it("{ ocr: false } still throws PdfExtractError on the scanned fixture, without attempting OCR", async () => {
    const buf = fs.readFileSync(SCANNED_PDF_PATH);
    const t0 = Date.now();
    await expect(extractPdfText(buf, { ocr: false })).rejects.toBeInstanceOf(PdfExtractError);
    await expect(extractPdfText(buf, { ocr: false })).rejects.toMatchObject({
      status: 422,
      message: "el PDF no contiene texto extraíble",
    });
    // No OCR pass means this should resolve fast, not take tens of seconds.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("truncates OCR to PDF_OCR_MAX_PAGES and reports truncated:true, via a mocked rasterizer/page-count (no giant fixture)", async () => {
    // Exercises the truncation threshold logic in isolation, per the plan:
    // a 20+-page scanned PDF isn't worth committing as a fixture just to
    // prove a Math.min/boolean comparison. Mocks unpdf and tesseract.js so
    // this test is fast and deterministic rather than a second slow OCR run.
    const totalPages = PDF_OCR_MAX_PAGES + 7;

    vi.resetModules();
    vi.doMock("unpdf", () => ({
      getDocumentProxy: vi.fn(async () => ({ numPages: totalPages })),
      getMeta: vi.fn(async () => ({ info: {} })),
      extractText: vi.fn(async () => ({ text: Array.from({ length: totalPages }, () => "") })),
      renderPageAsImage: vi.fn(async () => new ArrayBuffer(0)),
    }));
    let recognizeCallCount = 0;
    vi.doMock("tesseract.js", () => ({
      OEM: { LSTM_ONLY: 1 },
      createWorker: vi.fn(async () => ({
        recognize: vi.fn(async () => {
          recognizeCallCount += 1;
          // Varies per call so cleanPdfText's repeated-header/footer-line
          // filter (3+ identical lines get dropped as furniture) doesn't
          // strip this synthetic text out from under the test.
          return { data: { text: `línea de texto reconocida por OCR de prueba, página ${recognizeCallCount}.` } };
        }),
        terminate: vi.fn(async () => undefined),
      })),
    }));

    const { extractPdfText: mockedExtractPdfText } = await import("@/server/pdf");
    const { renderPageAsImage } = await import("unpdf");

    const result = await mockedExtractPdfText(Buffer.from("%PDF-fake"));

    expect(result.ocr).toBe(true);
    expect(result.truncated).toBe(true);
    // Only the first PDF_OCR_MAX_PAGES pages should have been rasterized/OCRed.
    expect(vi.mocked(renderPageAsImage).mock.calls.length).toBe(PDF_OCR_MAX_PAGES);

    vi.doUnmock("unpdf");
    vi.doUnmock("tesseract.js");
    vi.resetModules();
  });
});
