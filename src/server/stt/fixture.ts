import fs from "node:fs";
import path from "node:path";
import type { SttProvider, SttResult } from "@/server/stt/provider";

const FIXTURE_PATH = path.join(process.cwd(), "fixtures", "dictation-es-mx.json");

let cached: SttResult | undefined;

function loadFixture(): SttResult {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as SttResult;
  }
  return cached;
}

/**
 * Deterministic, network-free STT provider used in tests and local dev
 * without a python/faster-whisper setup. Returns the same canned transcript
 * (`fixtures/dictation-es-mx.json`) for ANY input file — it never reads or
 * analyzes the audio at `absPath` at all, mirroring how `FixtureProvider`
 * (`src/server/language/providers/fixture.ts`) never truly calls a model.
 */
export class FixtureSttProvider implements SttProvider {
  readonly name = "fixture";

  async transcribe(_absPath: string): Promise<SttResult> {
    return loadFixture();
  }
}
