import { describe, expect, it } from "vitest";
import { CURATED_SOURCES, urlBelongsToSource, type CuratedSource } from "@/lib/sources";
import { REGISTERS } from "@/lib/taxonomy";

describe("CURATED_SOURCES registry integrity", () => {
  it("has exactly the 6 curated entries", () => {
    expect(CURATED_SOURCES).toHaveLength(6);
  });

  it("has unique ids", () => {
    const ids = CURATED_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a valid http(s) collection URL", () => {
    for (const source of CURATED_SOURCES) {
      const parsed = new URL(source.url);
      expect(["http:", "https:"]).toContain(parsed.protocol);
    }
  });

  it("every entry's registers are a subset of REGISTERS and non-empty", () => {
    for (const source of CURATED_SOURCES) {
      expect(source.registers.length).toBeGreaterThan(0);
      for (const register of source.registers) {
        expect(REGISTERS).toContain(register);
      }
    }
  });

  it("every entry has a non-empty description and ingest hint", () => {
    for (const source of CURATED_SOURCES) {
      expect(source.description.trim().length).toBeGreaterThan(0);
      expect(source.ingestHint.trim().length).toBeGreaterThan(0);
    }
  });

  it("every entry has at least one domain label", () => {
    for (const source of CURATED_SOURCES) {
      expect(source.domains.length).toBeGreaterThan(0);
    }
  });

  it("every entry's kind is one of the four supported kinds", () => {
    for (const source of CURATED_SOURCES) {
      expect(["lectura", "audio", "pdf", "mixto"]).toContain(source.kind);
    }
  });
});

describe("urlBelongsToSource", () => {
  const revista = CURATED_SOURCES.find((s) => s.id === "revista-unam")!;
  const descargaCultura = CURATED_SOURCES.find((s) => s.id === "descarga-cultura")!;

  it("accepts the exact host from the source's own URL", () => {
    expect(urlBelongsToSource("https://www.revistadelauniversidad.mx/articulo-1", revista)).toBe(true);
  });

  it("accepts the bare (www.-stripped) host too", () => {
    expect(urlBelongsToSource("https://revistadelauniversidad.mx/articulo-1", revista)).toBe(true);
  });

  it("accepts a subdomain of the source's host", () => {
    expect(urlBelongsToSource("https://media.descargacultura.unam.mx/audio/1.mp3", descargaCultura)).toBe(true);
    expect(urlBelongsToSource("https://numeros.revistadelauniversidad.mx/algo", revista)).toBe(true);
  });

  it("rejects a URL from an unrelated host", () => {
    expect(urlBelongsToSource("https://www.nytimes.com/es/articulo", revista)).toBe(false);
    expect(urlBelongsToSource("https://example.com", descargaCultura)).toBe(false);
  });

  it("rejects a host that merely contains the base as a substring but isn't a subdomain", () => {
    expect(urlBelongsToSource("https://notrevistadelauniversidad.mx/x", revista)).toBe(false);
  });

  it("rejects an invalid URL", () => {
    expect(urlBelongsToSource("not a url", revista)).toBe(false);
    expect(urlBelongsToSource("", revista)).toBe(false);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(urlBelongsToSource("ftp://www.revistadelauniversidad.mx/x", revista)).toBe(false);
  });

  it("is case-insensitive on the host", () => {
    expect(urlBelongsToSource("https://WWW.RevistaDeLaUniversidad.MX/x", revista)).toBe(true);
  });

  it("returns false for a source whose own url is somehow malformed (defensive)", () => {
    const broken: CuratedSource = {
      id: "broken",
      name: "Broken",
      url: "not-a-url",
      kind: "lectura",
      registers: ["neutral"],
      domains: ["periodismo"],
      description: "x",
      ingestHint: "x",
    };
    expect(urlBelongsToSource("https://example.com", broken)).toBe(false);
  });
});
