import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WordTimestamp } from "@/lib/contracts";
import { SttError, type SttProvider, type SttResult } from "@/server/stt/provider";

const execFileAsync = promisify(execFile);

const TRANSCRIBE_SCRIPT = path.join(process.cwd(), "scripts", "transcribe.py");
// faster-whisper on CPU int8 can take a while for longer audio; generous ceiling.
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MODEL = "small";
const DEFAULT_LANGUAGE = "es";

/** Resolves the python binary to invoke: `STT_PYTHON` env, else the project venv, else bare `python3`. */
export function resolvePythonBin(): string {
  if (process.env.STT_PYTHON) return process.env.STT_PYTHON;
  const venvPython = path.join(process.cwd(), ".venv-stt", "bin", "python3");
  if (fs.existsSync(venvPython)) return venvPython;
  return "python3";
}

type RawWord = { w: string; startMs: number; endMs: number };
type RawResult = { text: string; words: RawWord[] };

/**
 * STT provider backed by a local `faster-whisper` model (CTranslate2, CPU
 * int8), invoked out of process via `scripts/transcribe.py` — see CLAUDE.md
 * Sec.6: the deployment target has no Apple Silicon, so mlx-whisper is not an
 * option here.
 */
export class WhisperSttProvider implements SttProvider {
  readonly name = "whisper";

  constructor(
    private readonly model: string = process.env.STT_MODEL ?? DEFAULT_MODEL,
    private readonly language: string = process.env.STT_LANGUAGE ?? DEFAULT_LANGUAGE,
  ) {}

  async transcribe(absPath: string): Promise<SttResult> {
    const python = resolvePythonBin();
    let stdout: string;
    try {
      const result = await execFileAsync(
        python,
        [TRANSCRIBE_SCRIPT, absPath, "--model", this.model, "--language", this.language],
        { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SttError(`whisper transcription failed (python: ${python}): ${message}`, error);
    }

    let raw: RawResult;
    try {
      raw = JSON.parse(stdout) as RawResult;
    } catch (error) {
      throw new SttError(`whisper transcription returned invalid JSON: ${String(error)}`, error);
    }

    const words: WordTimestamp[] = raw.words.map((w) => ({ w: w.w, startMs: w.startMs, endMs: w.endMs }));
    return { text: raw.text, words };
  }
}
