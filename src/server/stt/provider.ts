import type { WordTimestamp } from "@/lib/contracts";

/** Result of transcribing a single audio file: full text plus word-level timestamps. */
export interface SttResult {
  text: string;
  words: WordTimestamp[];
}

/**
 * A speech-to-text provider capable of transcribing an audio file on disk.
 * `LanguageService`'s sibling for audio — the Listen surface's only gateway
 * to transcription; nothing else should shell out to whisper or call an STT
 * API directly.
 */
export interface SttProvider {
  readonly name: string;
  transcribe(absPath: string): Promise<SttResult>;
}

/** Raised by an `SttProvider` when a transcription call fails. */
export class SttError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SttError";
  }
}
