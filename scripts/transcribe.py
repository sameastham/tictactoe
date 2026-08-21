#!/usr/bin/env python3
"""Transcribes one audio file with faster-whisper, word-level timestamps, JSON on stdout.

Runs on CPU with int8 quantization (CTranslate2) — see CLAUDE.md Sec.6: the
deployment target is a 2019 Intel MacBook Pro with no Apple Silicon, so
mlx-whisper is not an option here; faster-whisper (or a hosted STT API) is
the only viable local transcription path.

Usage:
    python3 scripts/transcribe.py <audio_path> [--model small] [--language es]

Prints `{"text": ..., "words": [{"w": ..., "startMs": ..., "endMs": ...}, ...]}`
to stdout on success. On failure, prints `{"error": "..."}` to stderr and
exits non-zero — the caller (src/server/stt/whisper.ts) treats any non-zero
exit or unparsable stdout as an SttError.
"""
import argparse
import json
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="es")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        args.audio_path,
        language=args.language,
        word_timestamps=True,
    )

    words = []
    text_parts = []
    for segment in segments:
        stripped = segment.text.strip()
        if stripped:
            text_parts.append(stripped)
        if segment.words:
            for word in segment.words:
                w = word.word.strip()
                if not w:
                    continue
                words.append(
                    {
                        "w": w,
                        "startMs": round(word.start * 1000),
                        "endMs": round(word.end * 1000),
                    }
                )

    result = {"text": " ".join(text_parts), "words": words}
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - surface any failure as JSON on stderr for the caller
        json.dump({"error": str(exc)}, sys.stderr)
        sys.exit(1)
