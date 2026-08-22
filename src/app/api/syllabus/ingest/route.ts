import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getLevel } from "@/server/syllabus/config";
import { ingestBook, type IngestPdfInput } from "@/server/syllabus/ingest";

/** Per-file cap. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Whole-upload cap (all files combined). */
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 4;

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** True when `buf` starts with the `%PDF-` signature every PDF file begins with — same check `src/server/article.ts`'s `looksLikePdf` uses for the URL-fetch PDF path, re-verified here since a multipart upload's declared `Content-Type` is caller-supplied and easy to spoof. */
function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * POST /api/syllabus/ingest — the UI-driven counterpart to `npm run
 * ingest-book`: uploads 1-4 PDF parts (`files`, multipart) for one syllabus
 * level (`level`, resolved via `getLevel` — includes any
 * `SYLLABUS_EXTRA_CONFIG_DIR` level), saves each one to
 * `data/books/<levelId>-<index>.pdf` (mkdir recursive; OVERWRITES any prior
 * upload at that same path — re-ingesting a level is safe/idempotent either
 * way, see `ingestBook`, but a previous upload with MORE parts than the new
 * one leaves its extra `<levelId>-N.pdf` files stranded on disk, unused by
 * this run), then runs the exact same `ingestBook` pipeline
 * `scripts/ingest-book.ts`'s CLI uses — no forked logic, same report shape.
 *
 * Validates `Content-Type: application/pdf` AND the `%PDF-` magic bytes for
 * every file (mirrors `src/server/article.ts`'s `looksLikePdf` check on the
 * URL-fetch PDF path) before ever touching disk or the ingestion pipeline.
 *
 * Ingestion is synchronous (house pattern — text-layer extraction plus a
 * handful of db writes, not a model call): the response only comes back once
 * the whole report is ready. A report with zero ingested sections across
 * every unit (`totalSections === 0`) is a 422 — almost always the wrong book
 * uploaded for the selected level, not a real "nothing to ingest" state.
 */
export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const levelIdRaw = formData.get("level");
  if (typeof levelIdRaw !== "string" || levelIdRaw.trim().length === 0) {
    return NextResponse.json({ error: "missing_level" }, { status: 400 });
  }
  const level = getLevel(levelIdRaw.trim());
  if (!level) {
    return NextResponse.json({ error: "unknown_level" }, { status: 400 });
  }

  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "missing_files" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: "too_many_files", maxFiles: MAX_FILES }, { status: 400 });
  }

  const buffers: Buffer[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: "unsupported_media_type", contentType: file.type }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file_too_large", scope: "file", maxBytes: MAX_FILE_BYTES }, { status: 413 });
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "file_too_large", scope: "total", maxBytes: MAX_TOTAL_BYTES }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (!looksLikePdf(buf)) {
      return NextResponse.json({ error: "unsupported_media_type", contentType: file.type }, { status: 400 });
    }
    buffers.push(buf);
  }

  try {
    const booksDir = path.join(process.cwd(), "data", "books");
    fs.mkdirSync(booksDir, { recursive: true });

    const pdfs: IngestPdfInput[] = buffers.map((buf, index) => {
      const filename = `${level.id}-${index + 1}.pdf`;
      fs.writeFileSync(path.join(booksDir, filename), buf);
      return { source: filename, buf };
    });

    const db = getDb();
    const report = await ingestBook(db, level, pdfs);

    const totalSections = report.units.reduce((sum, unit) => sum + unit.sections.length, 0);
    if (totalSections === 0) {
      return NextResponse.json(
        { error: "ninguna sección del nivel se encontró en los PDFs", report },
        { status: 422 },
      );
    }

    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    console.error("POST /api/syllabus/ingest failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
