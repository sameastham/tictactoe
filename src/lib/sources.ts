/**
 * Curated source directory ("Fuentes") — a hand-picked registry of authentic
 * Mexican sources (UNAM + SEP/gob.mx) the learner can browse and bring a
 * specific piece in from. Client-safe: no `fs`, no db, no fetch logic — this
 * module is pure data plus one pure validation helper. The app never crawls
 * or generates content; the learner always picks the exact piece and hands
 * it to the existing Read/Listen ingestion endpoints (`POST /api/content`,
 * `POST /api/media`) themselves.
 */
import type { Register } from "@/lib/taxonomy";

/** What you typically bring in from a source. */
export const SOURCE_KINDS = ["lectura", "audio", "pdf", "mixto"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface CuratedSource {
  id: string;
  name: string;
  /** The source's own collection/landing page — opens externally, never fetched by the app itself. */
  url: string;
  kind: SourceKind;
  registers: Register[];
  /** Spanish subject-domain labels (e.g. "ensayo", "periodismo") — not to be confused with the URL's hostname, see {@link urlBelongsToSource}. */
  domains: string[];
  description: string;
  /** One line: how to bring a piece in from this source. */
  ingestHint: string;
}

export const CURATED_SOURCES: CuratedSource[] = [
  {
    id: "revista-unam",
    name: "Revista de la Universidad de México",
    url: "https://www.revistadelauniversidad.mx/",
    kind: "lectura",
    registers: ["formal", "neutral"],
    domains: ["ensayo", "cultura"],
    description:
      "La revista cultural insignia de la UNAM: ensayos literarios y culturales de fondo, con una prosa " +
      "cuidada que es justo el objetivo de lectura en C1.",
    ingestHint: "Copia la URL de un ensayo y pégala aquí.",
  },
  {
    id: "gaceta-unam",
    name: "Gaceta UNAM",
    url: "https://www.gaceta.unam.mx/",
    kind: "lectura",
    registers: ["neutral"],
    domains: ["periodismo", "académico"],
    description:
      "El periódico oficial de la UNAM: noticias universitarias en un registro periodístico claro y " +
      "neutro, ideal para practicar lectura sin la densidad de un ensayo largo.",
    ingestHint: "Copia la URL de una nota y pégala aquí.",
  },
  {
    id: "descarga-cultura",
    name: "Descarga Cultura UNAM",
    url: "https://descargacultura.unam.mx/",
    kind: "audio",
    registers: ["formal", "neutral"],
    domains: ["cultura", "académico"],
    description: "Audio auténtico: cátedras y literatura en voz alta, de libre descarga y sin locución artificial.",
    ingestHint: "Copia la URL del audio y tráelo a Escuchar (o descárgalo y súbelo ahí).",
  },
  {
    id: "unam-global",
    name: "UNAM Global",
    url: "https://unamglobal.unam.mx/",
    kind: "lectura",
    registers: ["neutral"],
    domains: ["periodismo", "académico"],
    description:
      "Divulgación científica y cultural de la UNAM escrita para un público amplio — accesible sin dejar " +
      "de ser rigurosa.",
    ingestHint: "Copia la URL de un artículo y pégala aquí.",
  },
  {
    id: "sep-documentos",
    name: "SEP — Documentos y publicaciones",
    url: "https://www.gob.mx/sep/archivo/documentos",
    kind: "pdf",
    registers: ["formal"],
    domains: ["política pública"],
    description:
      "El archivo de documentos institucionales de la SEP: casi todo en PDF, el corpus de registro " +
      "formal por excelencia — lenguaje de política pública, sin coloquialismos.",
    ingestHint: "Copia la URL del PDF y pégala aquí — la extracción de PDF ya está integrada.",
  },
  {
    id: "gob-mx-blog",
    name: "gob.mx — Publicaciones SEP",
    url: "https://www.gob.mx/sep",
    kind: "mixto",
    registers: ["formal", "neutral"],
    domains: ["política pública", "periodismo"],
    description:
      "Comunicados y artículos de la SEP en gob.mx: registro institucional, mezcla de nota informativa y " +
      "documento oficial.",
    ingestHint: "Copia la URL de un artículo o PDF y pégala aquí.",
  },
];

/**
 * The hostname a source's own `url` resolves to, with a leading "www."
 * stripped — the base a pasted URL's host is compared against.
 */
function sourceBaseHost(source: CuratedSource): string | null {
  try {
    const host = new URL(source.url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * True when `url`'s hostname belongs to `source` — the exact host, its
 * "www." variant, or any subdomain of it (e.g. `media.descargacultura.unam.mx`
 * belongs to `descargacultura.unam.mx`). Used by the Fuentes inline
 * ingest row to reject a pasted URL that isn't actually from the card's
 * source before it ever reaches the ingestion API. Pure — no network.
 */
export function urlBelongsToSource(url: string, source: CuratedSource): boolean {
  const base = sourceBaseHost(source);
  if (!base) return false;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;

  const host = target.hostname.toLowerCase();
  return host === base || host === `www.${base}` || host.endsWith(`.${base}`);
}
