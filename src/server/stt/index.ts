import { execFileSync } from "node:child_process";
import type { SttProvider } from "@/server/stt/provider";
import { FixtureSttProvider } from "@/server/stt/fixture";
import { resolvePythonBin, WhisperSttProvider } from "@/server/stt/whisper";

let cachedProvider: SttProvider | undefined;
let cachedHasFasterWhisper: boolean | undefined;

/** Cheap, cached check: can the resolved python binary `import faster_whisper`? */
function hasFasterWhisper(): boolean {
  if (cachedHasFasterWhisper !== undefined) return cachedHasFasterWhisper;
  try {
    execFileSync(resolvePythonBin(), ["-c", "import faster_whisper"], { stdio: "ignore", timeout: 5000 });
    cachedHasFasterWhisper = true;
  } catch {
    cachedHasFasterWhisper = false;
  }
  return cachedHasFasterWhisper;
}

function selectProvider(): SttProvider {
  const requested = process.env.STT_PROVIDER;
  if (requested === "fixture") return new FixtureSttProvider();
  if (requested === "whisper") return new WhisperSttProvider();
  // Unset: prefer whisper when the resolved python can actually import
  // faster_whisper, else fall back to the deterministic fixture so local
  // dev/tests don't need a python env set up.
  return hasFasterWhisper() ? new WhisperSttProvider() : new FixtureSttProvider();
}

/** Returns the process-wide {@link SttProvider}, selected once and cached. */
export function getSttProvider(): SttProvider {
  if (!cachedProvider) {
    cachedProvider = selectProvider();
  }
  return cachedProvider;
}
