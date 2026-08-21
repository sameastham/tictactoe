import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { MediaUrlBodySchema } from "@/lib/contracts";
import { newId } from "@/lib/ids";
import { fetchFromUrl, MediaFetchError } from "@/server/mediafetch";
import { execFileYtDlpRunner } from "@/server/mediafetch/runner";
import { createContent, saveTranscript, type ContentRow } from "@/server/repo";

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

/** True when the request looks like a YouTube URL — used only to pick `content.type` ("video" vs "audio"). */
function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("youtube.com") || host.includes("youtu.be");
  } catch {
    return false;
  }
}

/**
 * Handles the multipart branch of `POST /api/media`: uploads an audio file
 * for the Listen surface, saving it to `data/media/<newId>.<ext>` and
 * creating a `content` row (source "upload", type "audio", text "" —
 * transcription is a separate step, see POST /api/content/[id]/transcribe).
 */
async function handleUpload(request: NextRequest): Promise<NextResponse> {
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
}

/**
 * Handles the JSON branch of `POST /api/media` — the Listen surface's
 * YouTube/podcast ingestion path (plan §4.1): fetches `body.url` via
 * `fetchFromUrl` (`src/server/mediafetch/`), creates a `content` row (source
 * "url", type "video" for a youtube.com/youtu.be URL else "audio", text ""),
 * and — when `fetchFromUrl` already found human-made captions — persists
 * that transcript immediately, so the client only needs to call
 * POST /api/content/[id]/transcribe when `transcribed` comes back false.
 */
async function handleUrlIngest(request: NextRequest): Promise<NextResponse> {
  const parsed = MediaUrlBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
  }
  const { url, title: titleOverride } = parsed.data;

  const mediaDir = path.join(process.cwd(), "data", "media");
  const result = await fetchFromUrl(url, { runner: execFileYtDlpRunner, mediaDir });

  // `fetchFromUrl` always downloads into `mediaDir` directly (it doesn't
  // know about the repo-relative "data/media/" convention `content.mediaPath`
  // uses elsewhere) — re-derive the repo-relative path from the basename,
  // same as the multipart branch above.
  const mediaPath = result.audioPath ? path.join("data", "media", path.basename(result.audioPath)) : null;

  const db = getDb();
  const created = createContent(db, {
    source: "url",
    sourceUrl: url,
    type: isYoutubeUrl(url) ? "video" : "audio",
    title: titleOverride ?? result.title,
    text: "",
    mediaPath,
  });

  let transcribed = false;
  if (result.transcript) {
    saveTranscript(db, created.id, { transcript: result.transcript.text, wordTimestamps: result.transcript.words });
    transcribed = true;
  }

  return NextResponse.json({ content: toSummaryDto(created), transcribed }, { status: 201 });
}

/**
 * POST /api/media — either uploads an audio file (multipart, unchanged) or
 * ingests a YouTube/podcast URL (`application/json`), branching on the
 * request's content-type. See {@link handleUpload}/{@link handleUrlIngest}.
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await handleUrlIngest(request);
    }
    return await handleUpload(request);
  } catch (error) {
    if (error instanceof MediaFetchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("POST /api/media failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
