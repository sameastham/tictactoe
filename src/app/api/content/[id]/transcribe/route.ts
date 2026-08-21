import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSttProvider } from "@/server/stt";
import { SttError } from "@/server/stt/provider";
import { getContent, saveTranscript } from "@/server/repo";

/**
 * POST /api/content/[id]/transcribe — idempotent like extract: a non-null
 * `transcript` is served from cache unless `?force=1`. Transcribes the
 * content row's `mediaPath` via the configured STT provider and persists
 * transcript/wordTimestamps/text onto the row.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = getContent(db, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!row.mediaPath) {
      return NextResponse.json({ error: "no_media" }, { status: 409 });
    }

    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "1";

    if (row.transcript !== null && !force) {
      return NextResponse.json({
        transcript: row.transcript,
        wordTimestamps: row.wordTimestamps ?? [],
        cached: true,
      });
    }

    // Statically scoped to data/media/ (not `path.join(process.cwd(), row.mediaPath)`
    // directly) so Turbopack doesn't trace the whole project for this dynamic
    // filesystem access — mediaPath is always under data/media/ by construction.
    const absPath = path.join(process.cwd(), "data", "media", path.basename(row.mediaPath));
    const { text, words } = await getSttProvider().transcribe(absPath);

    saveTranscript(db, id, { transcript: text, wordTimestamps: words });

    return NextResponse.json({ transcript: text, wordTimestamps: words, cached: false });
  } catch (error) {
    if (error instanceof SttError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/content/[id]/transcribe failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
