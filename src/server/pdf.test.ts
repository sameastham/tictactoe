import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanPdfText, extractPdfText, PdfExtractError } from "@/server/pdf";

const FIXTURE_PDF_PATH = path.join(process.cwd(), "fixtures", "articulo-es-mx.pdf");
const FIXTURE_TXT_PATH = path.join(process.cwd(), "fixtures", "article-es-mx.txt");

describe("extractPdfText", () => {
  it("extracts a usable title and cleaned, de-hyphenated text from the fixture PDF", async () => {
    const buf = fs.readFileSync(FIXTURE_PDF_PATH);
    const { title, text } = await extractPdfText(buf);

    expect(title).toBe("Café de especialidad (PDF de prueba)");

    // Key phrases from the original article, present VERBATIM in the
    // cleaned output — this only holds if de-hyphenation and hard-line-break
    // joining correctly reconstructed the wrapped PDF text.
    expect(text).toContain("ha cobrado fuerza");
    expect(text).toContain("no dan abasto");

    // The fixture generator (scripts/make-fixture-pdf.mjs) deliberately
    // forces one line-wrap hyphenation — confirm it was rejoined (no
    // "word-\nfragment" style artifact survives) rather than merely present.
    expect(text).not.toMatch(/[a-záéíóúüñ]-\s/);

    // The cleaned PDF text should read exactly like the source article: same
    // paragraphs, same wording, no leftover line-wrap artifacts.
    const original = fs.readFileSync(FIXTURE_TXT_PATH, "utf-8").trim();
    expect(text).toBe(original);
  });

  it("throws PdfExtractError on a junk (non-PDF) buffer", async () => {
    const junk = Buffer.from("this is not a pdf, just some ordinary text bytes", "utf-8");
    await expect(extractPdfText(junk)).rejects.toBeInstanceOf(PdfExtractError);
    await expect(extractPdfText(junk)).rejects.toMatchObject({
      status: 422,
      message: "el PDF no contiene texto extraíble",
    });
  });

  it("throws PdfExtractError on an empty buffer", async () => {
    await expect(extractPdfText(Buffer.alloc(0))).rejects.toMatchObject({ status: 422 });
  });
});

describe("cleanPdfText", () => {
  it("de-hyphenates a line-wrap hyphen followed by a lowercase continuation", () => {
    const raw = "Esta es una pal-\nabra dividida por el ajuste de línea del PDF.";
    expect(cleanPdfText(raw)).toBe("Esta es una palabra dividida por el ajuste de línea del PDF.");
  });

  it("does NOT rejoin a real hyphen followed by an uppercase word (e.g. México-Estados Unidos)", () => {
    const raw = "Se habló de la relación México-\nEstados Unidos en la cumbre.";
    // The hyphen is preserved (this isn't a split word); the line break
    // still collapses via the ordinary newline-to-space join.
    expect(cleanPdfText(raw)).toBe("Se habló de la relación México- Estados Unidos en la cumbre.");
  });

  it("joins single newlines within a paragraph into spaces, and preserves blank-line paragraph breaks", () => {
    const raw = [
      "Primer párrafo con",
      "varias líneas que",
      "se deben unir en una sola.",
      "",
      "Segundo párrafo",
      "con otras líneas distintas.",
    ].join("\n");
    expect(cleanPdfText(raw)).toBe(
      "Primer párrafo con varias líneas que se deben unir en una sola.\n\nSegundo párrafo con otras líneas distintas.",
    );
  });

  it("treats a large indent jump as a paragraph break", () => {
    const raw = "Primera línea sin sangría, al margen izquierdo.\n   Segunda línea con sangría marca un nuevo párrafo.";
    expect(cleanPdfText(raw)).toBe(
      "Primera línea sin sangría, al margen izquierdo.\n\nSegunda línea con sangría marca un nuevo párrafo.",
    );
  });

  it("drops isolated page-number lines ('12', 'Página 12', '- 12 -')", () => {
    expect(cleanPdfText("Contenido válido.\n\n12\n\nMás contenido.")).toBe("Contenido válido.\n\nMás contenido.");
    expect(cleanPdfText("Contenido válido.\n\nPágina 12\n\nMás contenido.")).toBe(
      "Contenido válido.\n\nMás contenido.",
    );
    expect(cleanPdfText("Contenido válido.\n\n- 12 -\n\nMás contenido.")).toBe(
      "Contenido válido.\n\nMás contenido.",
    );
  });

  it("drops a running header/footer line that repeats 3+ times, but keeps one that appears only once or twice", () => {
    const raw = [
      "SECRETARÍA DE EDUCACIÓN PÚBLICA",
      "Contenido de la página uno.",
      "",
      "SECRETARÍA DE EDUCACIÓN PÚBLICA",
      "Contenido de la página dos.",
      "",
      "SECRETARÍA DE EDUCACIÓN PÚBLICA",
      "Contenido de la página tres.",
    ].join("\n");
    expect(cleanPdfText(raw)).toBe(
      "Contenido de la página uno.\n\nContenido de la página dos.\n\nContenido de la página tres.",
    );

    const twiceOnly = ["Repetida dos veces.", "", "Cuerpo uno.", "", "Repetida dos veces.", "", "Cuerpo dos."].join(
      "\n",
    );
    expect(cleanPdfText(twiceOnly)).toBe("Repetida dos veces.\n\nCuerpo uno.\n\nRepetida dos veces.\n\nCuerpo dos.");
  });

  it("collapses repeated intra-line whitespace", () => {
    expect(cleanPdfText("Texto   con    espacios     raros.")).toBe("Texto con espacios raros.");
  });

  it("normalizes CRLF line endings the same way as LF input", () => {
    expect(cleanPdfText("Una línea\r\ny otra línea.")).toBe("Una línea y otra línea.");
  });
});
