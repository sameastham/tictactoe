/**
 * Client-safe TTS interface over the browser's `speechSynthesis` API — plan
 * §4.3 week 7 ("any TTS behind an interface"). No `fs`, no db, no
 * server-only import: this module is imported from `talk-client.tsx`
 * directly, same posture as the rest of `src/lib/`.
 *
 * Deliberately thin: one engine, one interface, no queueing beyond what the
 * browser already does. A future engine (a hosted TTS API, say) implements
 * the same {@link TtsEngine} shape without touching call sites.
 */

export interface TtsEngine {
  /** Speaks `text`, replacing whatever this engine is currently speaking. */
  speak(text: string): void;
  /** Stops any speech this engine is currently producing. A no-op if idle. */
  stop(): void;
  /** False when no `speechSynthesis` (SSR, or a browser/engine without an es-* voice) is available. */
  readonly available: boolean;
}

const UNAVAILABLE_TTS: TtsEngine = {
  speak: () => {},
  stop: () => {},
  available: false,
};

/**
 * Picks the best available Spanish voice: the first voice whose `lang`
 * starts with "es-MX" (Mexican Spanish, matching the app's variant
 * throughout), else the first "es-US", else any "es" voice, else `null`.
 */
function pickSpanishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const mx = voices.find((v) => v.lang.startsWith("es-MX"));
  if (mx) return mx;
  const us = voices.find((v) => v.lang.startsWith("es-US"));
  if (us) return us;
  const anyEs = voices.find((v) => v.lang.startsWith("es"));
  return anyEs ?? null;
}

/**
 * Builds a {@link TtsEngine} backed by `window.speechSynthesis`. SSR-guarded
 * (returns the unavailable stub when `window` doesn't exist) and re-checks
 * voice availability lazily on every `speak` call, since Chrome loads voices
 * asynchronously after the `speechSynthesis` object itself already exists —
 * a voice list that's empty at call time isn't necessarily permanent.
 */
export function getBrowserTts(): TtsEngine {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    return UNAVAILABLE_TTS;
  }
  const synth = window.speechSynthesis;

  function currentVoice(): SpeechSynthesisVoice | null {
    return pickSpanishVoice(synth.getVoices());
  }

  return {
    get available() {
      return currentVoice() !== null;
    },
    speak(text: string) {
      const voice = currentVoice();
      if (!voice) return;
      synth.cancel(); // stop whatever is currently speaking first — no overlap.
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      synth.speak(utterance);
    },
    stop() {
      synth.cancel();
    },
  };
}
