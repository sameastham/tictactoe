import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WordTimestamp } from "@/lib/contracts";
import { newId } from "@/lib/ids";
import { parseJson3 } from "@/server/mediafetch/json3";
import type { YtDlpRunner } from "@/server/mediafetch/runner";

export { parseJson3 } from "@/server/mediafetch/json3";
export { execFileYtDlpRunner, resolveYtDlpBin, type YtDlpRunner } from "@/server/mediafetch/runner";

/** Thrown by {@link fetchFromUrl} for any failure; `status` is the HTTP status the caller should respond with. */
export class MediaFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MediaFetchError";
  }
}

export interface FetchFromUrlResult {
  title: string | null;
  /** Absolute filesystem path to the downloaded audio (m4a), or null if nothing was downloaded. */
  audioPath: string | null;
  /** Non-null only when human-made Spanish captions were found (source "captions"). */
  transcript: { text: string; words: WordTimestamp[] } | null;
  source: "captions" | "audio";
}

const PROBE_TIMEOUT_MS = 30_000;
// Downloads (captions or audio) get a longer ceiling than the probe — same
// order of magnitude as WhisperSttProvider's transcription timeout
// (src/server/stt/whisper.ts), since a slow connection can make even a
// modest audio-only download take a while.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DURATION_S = 30 * 60;

interface YtDlpProbeResult {
  title?: string | null;
  duration?: number | null;
  subtitles?: Record<string, unknown> | null;
  automatic_captions?: Record<string, unknown> | null;
}

/** Parses `url`, returning it only if it's a valid http(s) URL. */
function parseHttpUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

/** The last chunk of a possibly-long stderr-ish blob — enough to be useful in an error message, not a wall of text. */
function tail(text: string, maxChars = 500): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

/**
 * Picks the human-caption track to use: an exact "es" key if present, else
 * the first "es-XX" regional variant (e.g. "es-419", "es-MX"), else null.
 * Only inspects `subtitles` (human-made) — `automatic_captions` (ASR-generated)
 * never counts, per plan §4.1: fall through to STT for those.
 */
function pickSpanishCaptionKey(subtitles: Record<string, unknown> | null | undefined): string | null {
  if (!subtitles) return null;
  const keys = Object.keys(subtitles);
  if (keys.includes("es")) return "es";
  return keys.find((k) => k.startsWith("es")) ?? null;
}

async function runYtDlp(
  runner: YtDlpRunner,
  args: string[],
  timeoutMs: number,
  failureContext: string,
): Promise<string> {
  const { stdout, exitCode } = await runner.run(args, { timeoutMs });
  if (exitCode !== 0) {
    throw new MediaFetchError(`${failureContext}: ${tail(stdout) || `yt-dlp exited ${exitCode}`}`, 502);
  }
  return stdout;
}

/**
 * Fetches a video/podcast URL for the Listen surface (plan §4.1): probes it
 * with yt-dlp, and either pulls human-made Spanish captions (plus audio, for
 * playback) or falls back to audio-only (the caller then runs it through STT
 * — see `src/server/stt/`). Never touches the network directly — all
 * yt-dlp invocations go through the injected `runner`, the seam mocked in
 * `mediafetch.test.ts`.
 */
export async function fetchFromUrl(
  url: string,
  { runner, mediaDir }: { runner: YtDlpRunner; mediaDir: string },
): Promise<FetchFromUrlResult> {
  if (!parseHttpUrl(url)) {
    throw new MediaFetchError(`invalid URL: ${url}`, 400);
  }

  const probeStdout = await runYtDlp(runner, ["-J", "--no-download", url], PROBE_TIMEOUT_MS, "yt-dlp probe failed");

  let meta: YtDlpProbeResult;
  try {
    meta = JSON.parse(probeStdout) as YtDlpProbeResult;
  } catch (error) {
    throw new MediaFetchError(`yt-dlp probe returned invalid JSON: ${String(error)}`, 502);
  }

  if (typeof meta.duration === "number" && meta.duration > MAX_DURATION_S) {
    throw new MediaFetchError("el video es demasiado largo (máx. 30 minutos)", 422);
  }

  fs.mkdirSync(mediaDir, { recursive: true });
  const id = newId();
  const title = meta.title ?? null;
  const audioOutPath = path.join(mediaDir, `${id}.m4a`);
  const audioArgs = ["-f", "bestaudio[ext=m4a]/bestaudio", "-x", "--audio-format", "m4a", "-o", audioOutPath, url];

  const captionKey = pickSpanishCaptionKey(meta.subtitles);

  if (captionKey) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-cap-"));
    try {
      const capPrefix = path.join(tmpDir, "cap");
      await runYtDlp(
        runner,
        ["--skip-download", "--write-subs", "--sub-langs", captionKey, "--sub-format", "json3", "-o", capPrefix, url],
        DOWNLOAD_TIMEOUT_MS,
        "yt-dlp caption download failed",
      );

      const capFile = fs.readdirSync(tmpDir).find((f) => f.endsWith(".json3"));
      if (!capFile) {
        throw new MediaFetchError("yt-dlp reported human captions but did not write a caption file", 502);
      }
      const raw = fs.readFileSync(path.join(tmpDir, capFile), "utf-8");
      const transcript = parseJson3(JSON.parse(raw));

      // Captions without audio are useless for dictation — download it too.
      await runYtDlp(runner, audioArgs, DOWNLOAD_TIMEOUT_MS, "yt-dlp audio download failed");

      return { title, audioPath: audioOutPath, transcript, source: "captions" };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  await runYtDlp(runner, audioArgs, DOWNLOAD_TIMEOUT_MS, "yt-dlp audio download failed");
  return { title, audioPath: audioOutPath, transcript: null, source: "audio" };
}
