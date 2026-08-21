import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 32 MB — yt-dlp's `-J` probe JSON for a long playlist/video can be sizeable. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Resolves the yt-dlp binary to invoke: `YTDLP_BIN` env, else the project
 * venv (`.venv-stt/bin/yt-dlp`, installed alongside faster-whisper — see
 * README.md), else bare `yt-dlp` on PATH. Mirrors `resolvePythonBin` in
 * `src/server/stt/whisper.ts`.
 */
export function resolveYtDlpBin(): string {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  const venvYtDlp = path.join(process.cwd(), ".venv-stt", "bin", "yt-dlp");
  if (fs.existsSync(venvYtDlp)) return venvYtDlp;
  return "yt-dlp";
}

/**
 * Runs one yt-dlp invocation. The injectable seam for tests — production
 * code uses {@link execFileYtDlpRunner}; unit tests supply a mock that never
 * shells out.
 */
export interface YtDlpRunner {
  run(args: string[], opts: { timeoutMs: number }): Promise<{ stdout: string; exitCode: number }>;
}

/** Shape `promisify(execFile)` rejects with — Node attaches these to the error (verified: stdout/stderr/killed/signal/code all present). */
type ExecFileRejection = NodeJS.ErrnoException & {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string | null;
  code?: number;
};

/**
 * Real yt-dlp runner: shells out via `promisify(execFile)`, same idiom as
 * `WhisperSttProvider` in `src/server/stt/whisper.ts` (both for consistency
 * and because Turbopack's dynamic-filesystem-access tracer flags a bare,
 * unwrapped `execFile` call using a runtime-resolved binary path — see
 * `resolveYtDlpBin`/`resolvePythonBin` — but not one behind `promisify`).
 * On success, `exitCode` is always 0 and `stdout` is yt-dlp's stdout. On
 * failure (non-zero exit or a timeout kill), `stdout` carries the stderr
 * tail (or a timeout note) instead — there's nowhere else in this narrow
 * interface to put it, and yt-dlp itself writes its error text to stderr,
 * not stdout, so this never collides with real output.
 */
export const execFileYtDlpRunner: YtDlpRunner = {
  async run(args, { timeoutMs }) {
    try {
      const { stdout } = await execFileAsync(resolveYtDlpBin(), args, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      return { stdout, exitCode: 0 };
    } catch (error) {
      const err = error as ExecFileRejection;
      if (err.killed || err.signal) {
        return { stdout: `yt-dlp timed out after ${timeoutMs}ms`, exitCode: 124 };
      }
      const tail = (err.stderr || err.message || "").trim();
      return { stdout: tail, exitCode: typeof err.code === "number" ? err.code : 1 };
    }
  },
};
