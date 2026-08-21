import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getContent } from "@/server/repo";

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

/** Parses a single-range `Range: bytes=start-end` header against a known file size. Returns null if absent/unparseable. */
function parseRange(rangeHeader: string | null, fileSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffixLength = Number(endStr);
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? fileSize - 1 : Number(endStr);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

/**
 * GET /api/media/[id] — streams the audio file backing a content row, with
 * HTTP Range support (206 partial content) so `<audio>` seeking works.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = getContent(db, id);
    if (!row || !row.mediaPath) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Statically scoped to data/media/ (not `path.join(process.cwd(), row.mediaPath)`
    // directly) so Turbopack doesn't trace the whole project for this dynamic
    // filesystem access — mediaPath is always under data/media/ by construction.
    const absPath = path.join(process.cwd(), "data", "media", path.basename(row.mediaPath));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const fileSize = stat.size;
    const ext = path.extname(absPath).slice(1).toLowerCase();
    const contentType = EXT_TO_CONTENT_TYPE[ext] ?? "application/octet-stream";

    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      const range = parseRange(rangeHeader, fileSize);
      if (!range || range.start >= fileSize) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileSize}`, "Accept-Ranges": "bytes" },
        });
      }

      const { start, end } = range;
      const chunkSize = end - start + 1;
      const nodeStream = fs.createReadStream(absPath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

      return new NextResponse(webStream, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const nodeStream = fs.createReadStream(absPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    console.error("GET /api/media/[id] failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
