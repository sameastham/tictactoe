import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { newId } from "@/lib/ids";
import { createContent, type ContentRow } from "@/server/repo";

/** Accepted upload MIME types -> the file extension we persist under data/media/. */
const ALLOWED_TYPES: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/ogg": "ogg",
};

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Narrow DTO returned for a freshly created content row. */
function toSummaryDto(row: ContentRow) {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * POST /api/media — uploads an audio file for the Listen surface: saves it
 * to `data/media/<newId>.<ext>` and creates a `content` row (source
 * "upload", type "audio", text "" — transcription is a separate step, see
 * POST /api/content/[id]/transcribe).
 */
export async function POST(request: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }

    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return NextResponse.json({ error: "unsupported_media_type", contentType: file.type }, { status: 400 });
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: "file_too_large", maxBytes: MAX_SIZE_BYTES }, { status: 413 });
    }

    const titleRaw = formData.get("title");
    const title = typeof titleRaw === "string" && titleRaw.trim().length > 0 ? titleRaw.trim() : null;

    const mediaId = newId();
    const relPath = path.join("data", "media", `${mediaId}.${ext}`);
    const absPath = path.join(process.cwd(), relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(absPath, buffer);

    const db = getDb();
    const created = createContent(db, {
      source: "upload",
      type: "audio",
      title,
      text: "",
      mediaPath: relPath,
    });

    return NextResponse.json({ content: toSummaryDto(created) }, { status: 201 });
  } catch (error) {
    console.error("POST /api/media failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
