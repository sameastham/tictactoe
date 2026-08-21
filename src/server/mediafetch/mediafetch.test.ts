import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchFromUrl, MediaFetchError } from "@/server/mediafetch";
import type { YtDlpRunner } from "@/server/mediafetch/runner";

const URL = "https://www.youtube.com/watch?v=abc123";

type RecordedCall = { args: string[]; timeoutMs: number };

/**
 * A fake yt-dlp runner: routes on the shape of the args (mirroring how the
 * real binary would be invoked — `-J` for probe, `--write-subs` for
 * captions, everything else audio-only) and records every call so tests can
 * assert on the exact arg lists `fetchFromUrl` issues. When simulating a
 * successful caption download it also writes the fixture json3 payload to
 * the path passed via `-o`, exactly like real yt-dlp would.
 */
function createMockRunner(opts: {
  probeStdout?: string;
  probeExitCode?: number;
  captionExitCode?: number;
  captionStdoutOnError?: string;
  captionJson3?: unknown;
  audioExitCode?: number;
}): { runner: YtDlpRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: YtDlpRunner = {
    async run(args, { timeoutMs }) {
      calls.push({ args, timeoutMs });

      if (args[0] === "-J") {
        return { stdout: opts.probeStdout ?? "{}", exitCode: opts.probeExitCode ?? 0 };
      }

      if (args.includes("--write-subs")) {
        if ((opts.captionExitCode ?? 0) !== 0) {
          return { stdout: opts.captionStdoutOnError ?? "caption download failed", exitCode: opts.captionExitCode! };
        }
        const oIdx = args.indexOf("-o");
        const prefix = args[oIdx + 1];
        fs.writeFileSync(`${prefix}.es.json3`, JSON.stringify(opts.captionJson3 ?? { events: [] }));
        return { stdout: "", exitCode: 0 };
      }

      // Audio-only download.
      return { stdout: opts.audioExitCode ? "audio download failed" : "", exitCode: opts.audioExitCode ?? 0 };
    },
  };
  return { runner, calls };
}

describe("fetchFromUrl", () => {
  let mediaDir: string;

  beforeEach(() => {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediafetch-test-media-"));
  });

  afterEach(() => {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });

  it("rejects a non-http(s) URL with 400, before ever calling the runner", async () => {
    const { runner, calls } = createMockRunner({});
    await expect(fetchFromUrl("not a url", { runner, mediaDir })).rejects.toMatchObject({ status: 400 });
    await expect(fetchFromUrl("ftp://example.com/x", { runner, mediaDir })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  describe("human captions present", () => {
    const probeJson = JSON.stringify({
      title: "Título de prueba",
      duration: 300,
      subtitles: { es: [{ ext: "json3" }], en: [{ ext: "json3" }] },
      automatic_captions: {},
    });
    const captionDoc = {
      events: [{ tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "Hola mundo" }] }],
    };

    it("downloads captions then audio, and returns the parsed transcript with source \"captions\"", async () => {
      const { runner, calls } = createMockRunner({ probeStdout: probeJson, captionJson3: captionDoc });

      const result = await fetchFromUrl(URL, { runner, mediaDir });

      expect(result.source).toBe("captions");
      expect(result.title).toBe("Título de prueba");
      expect(result.transcript).not.toBeNull();
      expect(result.transcript?.text).toBe("Hola mundo");
      expect(result.transcript?.words.map((w) => w.w)).toEqual(["Hola", "mundo"]);
      expect(result.audioPath).toMatch(/\.m4a$/);
      expect(result.audioPath).toContain(mediaDir);

      // Exactly 3 yt-dlp calls: probe, caption download, audio download.
      expect(calls).toHaveLength(3);

      // 1. Probe.
      expect(calls[0].args).toEqual(["-J", "--no-download", URL]);
      expect(calls[0].timeoutMs).toBe(30_000);

      // 2. Caption download — the "es" key picked from `subtitles`.
      const capArgs = calls[1].args;
      expect(capArgs.slice(0, 6)).toEqual([
        "--skip-download",
        "--write-subs",
        "--sub-langs",
        "es",
        "--sub-format",
        "json3",
      ]);
      expect(capArgs[6]).toBe("-o");
      expect(typeof capArgs[7]).toBe("string");
      expect(capArgs[8]).toBe(URL);

      // 3. Audio download — bestaudio m4a, output path is exactly what was returned.
      expect(calls[2].args).toEqual([
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "-x",
        "--audio-format",
        "m4a",
        "-o",
        result.audioPath,
        URL,
      ]);
    });

    it("picks a regional es-XX variant when no exact \"es\" key exists", async () => {
      const probe = JSON.stringify({
        title: "T",
        duration: 60,
        subtitles: { "es-419": [{ ext: "json3" }] },
        automatic_captions: {},
      });
      const { runner, calls } = createMockRunner({ probeStdout: probe, captionJson3: captionDoc });

      await fetchFromUrl(URL, { runner, mediaDir });

      expect(calls[1].args[3]).toBe("es-419");
    });

    it("propagates a caption-download failure as 502", async () => {
      const { runner } = createMockRunner({
        probeStdout: probeJson,
        captionExitCode: 1,
        captionStdoutOnError: "ERROR: no such format",
      });
      await expect(fetchFromUrl(URL, { runner, mediaDir })).rejects.toMatchObject({ status: 502 });
    });

    it("propagates an audio-download failure (after captions succeed) as 502", async () => {
      const { runner } = createMockRunner({ probeStdout: probeJson, captionJson3: captionDoc, audioExitCode: 1 });
      await expect(fetchFromUrl(URL, { runner, mediaDir })).rejects.toMatchObject({ status: 502 });
    });
  });

  it("auto-captions-only (no human subtitles): falls back to audio-only, source \"audio\", transcript null", async () => {
    const probeJson = JSON.stringify({
      title: "T",
      duration: 100,
      subtitles: {},
      automatic_captions: { es: [{ ext: "json3" }] },
    });
    const { runner, calls } = createMockRunner({ probeStdout: probeJson });

    const result = await fetchFromUrl(URL, { runner, mediaDir });

    expect(result.source).toBe("audio");
    expect(result.transcript).toBeNull();
    expect(result.audioPath).toMatch(/\.m4a$/);

    // Only 2 calls: probe + audio download — no caption call at all.
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "-x",
      "--audio-format",
      "m4a",
      "-o",
      result.audioPath,
      URL,
    ]);
  });

  it("no subtitles field at all behaves the same as empty subtitles", async () => {
    const probeJson = JSON.stringify({ title: "T", duration: 10 });
    const { runner, calls } = createMockRunner({ probeStdout: probeJson });
    const result = await fetchFromUrl(URL, { runner, mediaDir });
    expect(result.source).toBe("audio");
    expect(calls).toHaveLength(2);
  });

  it("rejects videos longer than 30 minutes with 422 \"demasiado largo\", before downloading anything", async () => {
    const probeJson = JSON.stringify({ title: "Long", duration: 31 * 60, subtitles: {}, automatic_captions: {} });
    const { runner, calls } = createMockRunner({ probeStdout: probeJson });

    let caught: unknown;
    try {
      await fetchFromUrl(URL, { runner, mediaDir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MediaFetchError);
    expect((caught as MediaFetchError).status).toBe(422);
    expect((caught as MediaFetchError).message).toContain("demasiado largo");
    expect(calls).toHaveLength(1); // probed only, never downloaded
  });

  it("a non-video URL (probe itself fails) surfaces as 502 with the stderr tail in the message", async () => {
    const { runner } = createMockRunner({ probeExitCode: 1, probeStdout: "ERROR: Unsupported URL: example.com" });

    let caught: unknown;
    try {
      await fetchFromUrl("https://example.com/not-a-video", { runner, mediaDir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MediaFetchError);
    expect((caught as MediaFetchError).status).toBe(502);
    expect((caught as MediaFetchError).message).toContain("ERROR: Unsupported URL");
  });

  it("a probe timeout (runner reports a non-zero exit for a timeout kill) surfaces as 502", async () => {
    const { runner } = createMockRunner({ probeExitCode: 124, probeStdout: "yt-dlp timed out after 30000ms" });
    await expect(fetchFromUrl(URL, { runner, mediaDir })).rejects.toMatchObject({ status: 502 });
  });

  it("a probe that returns unparsable JSON surfaces as 502", async () => {
    const { runner } = createMockRunner({ probeStdout: "not json" });
    await expect(fetchFromUrl(URL, { runner, mediaDir })).rejects.toMatchObject({ status: 502 });
  });
});
