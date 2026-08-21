"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FluencyMetrics, TalkTurnMeta } from "@/lib/contracts";

/**
 * State machine for the Talk voice recorder (plan §4.3 week 7):
 *
 *  idle -> requesting -> recording -> transcribing -> idle (success)
 *                     \                            \-> error
 *                      \-> error (mic denied/unavailable)
 *
 * `error` covers both a mic-permission failure and a failed `/api/stt` call
 * — the recorder always returns to a clean `idle` afterward, mic button
 * still present, per the design ("mic button stays").
 */
export type VoiceRecorderStatus = "idle" | "requesting" | "recording" | "transcribing" | "error";

export interface VoiceRecorderResult {
  status: VoiceRecorderStatus;
  /** Milliseconds elapsed since the current recording started; 0 outside "recording". */
  elapsedMs: number;
  /** Inline error copy for the "error" status, else null. */
  errorMessage: string | null;
  /** Requests mic access and starts recording. Safe to call only from "idle"/"error". */
  start: () => void;
  /** Stops recording and kicks off transcription. Safe to call only from "recording". */
  stop: () => void;
  /** Stops recording and discards it — no transcription call. Safe to call only from "recording". */
  cancel: () => void;
}

const MIC_ERROR_MESSAGE = "No se pudo acceder al micrófono.";
const STT_ERROR_MESSAGE = "No se pudo transcribir el audio.";
const NETWORK_ERROR_MESSAGE = "No se pudo conectar con el servidor.";

/** Preference order for `MediaRecorder`'s `mimeType` — first supported wins. */
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** File extension for the recorded blob, matched against `POST /api/stt`'s accepted types. */
function extFromMimeType(mimeType: string | undefined): string {
  const base = (mimeType ?? "audio/webm").split(";")[0];
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  return "webm";
}

/**
 * Owns the `getUserMedia`/`MediaRecorder` lifecycle and the `POST /api/stt`
 * call. Pure state + side effects, no rendering — `talk-client.tsx` renders
 * UI per `status`. `onTranscribed` fires once per successful transcription
 * with the raw text and the {@link TalkTurnMeta} to stash alongside it.
 */
export function useVoiceRecorder(onTranscribed: (text: string, meta: TalkTurnMeta) => void): VoiceRecorderResult {
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const stopTicker = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Belt-and-suspenders cleanup if the component unmounts mid-recording.
  useEffect(
    () => () => {
      stopTicker();
      releaseStream();
    },
    [stopTicker, releaseStream],
  );

  const transcribe = useCallback(
    async (mimeType: string | undefined) => {
      setStatus("transcribing");
      try {
        const blob = new Blob(chunksRef.current, { type: mimeType ?? "audio/webm" });
        const formData = new FormData();
        formData.append("file", blob, `recording.${extFromMimeType(mimeType)}`);

        const res = await fetch("/api/stt", { method: "POST", body: formData });
        if (!res.ok) {
          setStatus("error");
          setErrorMessage(STT_ERROR_MESSAGE);
          return;
        }
        const data = (await res.json()) as { text: string; fluency: FluencyMetrics };
        setStatus("idle");
        setElapsedMs(0);
        onTranscribed(data.text, { kind: "voice", fluency: data.fluency });
      } catch {
        setStatus("error");
        setErrorMessage(NETWORK_ERROR_MESSAGE);
      }
    },
    [onTranscribed],
  );

  const start = useCallback(() => {
    setErrorMessage(null);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setErrorMessage(MIC_ERROR_MESSAGE);
      return;
    }

    setStatus("requesting");
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        cancelledRef.current = false;
        chunksRef.current = [];

        const mimeType = pickMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        recorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          stopTicker();
          releaseStream();
          if (cancelledRef.current) {
            setStatus("idle");
            setElapsedMs(0);
            return;
          }
          void transcribe(mimeType);
        };

        recorder.start();
        startedAtRef.current = Date.now();
        setElapsedMs(0);
        setStatus("recording");
        tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
      })
      .catch(() => {
        setStatus("error");
        setErrorMessage(MIC_ERROR_MESSAGE);
      });
  }, [releaseStream, stopTicker, transcribe]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      cancelledRef.current = false;
      recorder.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      cancelledRef.current = true;
      recorder.stop();
    } else {
      stopTicker();
      releaseStream();
      setStatus("idle");
      setElapsedMs(0);
    }
  }, [releaseStream, stopTicker]);

  return { status, elapsedMs, errorMessage, start, stop, cancel };
}

/** mm:ss for the recording timer. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
