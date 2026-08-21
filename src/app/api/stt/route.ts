import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { computeFluency } from "@/lib/fluency";
import { newId } from "@/lib/ids";
import { getSttProvider } from "@/server/stt";
import { SttError } from "@/server/stt/provider";

/**
 * Accepted upload MIME types (base type, ignoring any `;codecs=...`
 * parameter `MediaRecorder` tacks on, e.g. "audio/webm;codecs=opus") -> the
 * file extension used for the temp file.
 */
const ALLOWED_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
};

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Strips a `;codecs=...`/`;charset=...` parameter off a MIME type. */
function baseMimeType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/** Directory temp recordings are written to for the duration of one transcribe call. */
const TMP_DIR = path.join(os.tmpdir(), "espanol-coach-stt");

/**
 * POST /api/stt — one-shot speech-to-text for the Talk surface's voice
 * recorder (plan §4.3 week 7). Multipart `file` (webm/ogg/wav/m4a, ≤ 20 MB):
 * saved to a uniquely-named temp file, transcribed via the configured STT
 * provider (`getSttProvider` — with `STT_PROVIDER=fixture`, ANY audio
 * returns the same canned transcript, which is what makes e2e coverage
 * deterministic), and fluency markers are computed server-side from the
 * resulting word timestamps (`computeFluency`). Nothing is persisted here —
 * no content row, no session tie; this endpoint only transcribes.
 *
 * The temp file is ALWAYS deleted afterward (success or `SttError`) via the
 * `finally` block below.
 */
export async function POST(request: NextRequest) {
  let tempPath: string | null = null;
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

    const ext = ALLOWED_TYPES[baseMimeType(file.type)];
    if (!ext) {
      return NextResponse.json({ error: "unsupported_media_type", contentType: file.type }, { status: 400 });
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: "file_too_large", maxBytes: MAX_SIZE_BYTES }, { status: 400 });
    }

    fs.mkdirSync(TMP_DIR, { recursive: true });
    tempPath = path.join(TMP_DIR, `${newId()}.${ext}`);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);

    const { text, words } = await getSttProvider().transcribe(tempPath);
    const fluency = computeFluency(words);

    return NextResponse.json({ text, words, fluency }, { status: 200 });
  } catch (error) {
    if (error instanceof SttError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/stt failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    if (tempPath) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}
