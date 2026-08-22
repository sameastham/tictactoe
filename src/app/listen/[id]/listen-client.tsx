"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DictationMiss, DictationMissClass, JudgeResult, JudgedSentence, TranscriptSegment } from "@/lib/contracts";
import type { DictationDiffToken } from "@/lib/dictation";
import {
  MISS_CLASS_LABELS,
  RUNG_CHIP_CLASSES,
  RUNG_EDGE_CLASSES,
  RUNG_LABELS,
  SEVERITY_LABELS,
  TAXONOMY_LABELS,
} from "@/lib/labels";
import { useMediaQuery } from "@/lib/useMediaQuery";

interface ListenClientProps {
  contentId: string;
  title: string | null;
  /** Whether the content row already had a transcript when the page was rendered. */
  initialTranscribed: boolean;
}

type AttemptResult = {
  tokens: DictationDiffToken[];
  misses: DictationMiss[];
  attemptId: string;
};

/** Playback speeds offered by the header's segmented toggle (plan §4.1 "1.25x listening"). */
type PlaybackSpeed = 1 | 1.25;

/**
 * One segment's "Ahora dilo tú" production follow-up state, keyed by segment
 * index in `ListenClient`'s `followUps` record so switching the active
 * segment never loses another segment's last result.
 */
type FollowUpState = {
  text: string;
  submitting: boolean;
  error: string | null;
  result: { writingId: string; judgment: JudgeResult } | null;
  /** True while the textarea is showing; false once a result is displayed (until "Reformular de nuevo"). */
  showForm: boolean;
};

const DEFAULT_FOLLOW_UP: FollowUpState = { text: "", submitting: false, error: null, result: null, showForm: true };

/** Render order for the grouped miss chips below a diff — matches the product spec's listing order. */
const MISS_CLASS_ORDER: DictationMissClass[] = ["lexical", "reduction", "proper_noun", "near_miss"];

/** Slack applied when pausing playback at a segment's end, so a `timeupdate` tick landing just past it still stops in time. */
const PLAY_EPSILON_S = 0.12;

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon({ small = false }: { small?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={small ? "h-3.5 w-3.5" : "h-5 w-5"} aria-hidden="true">
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

/** mm:ss from a millisecond duration. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function missCountLabel(n: number): string {
  return n === 1 ? "1 error" : `${n} errores`;
}

/** Full-screen centered status (loading dots or an error + retry) — shared shape for the transcribe/segments gates. */
function StatusScreen({
  title,
  children,
}: {
  title?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-8 text-center">
      {title !== undefined && <h1 className="text-lg font-semibold text-ink">{title ?? "Audio"}</h1>}
      {children}
    </div>
  );
}

function LoadingDots() {
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      <span className="dot-pulse h-2.5 w-2.5 rounded-full bg-accent" style={{ animationDelay: "0ms" }} />
      <span className="dot-pulse h-2.5 w-2.5 rounded-full bg-accent" style={{ animationDelay: "160ms" }} />
      <span className="dot-pulse h-2.5 w-2.5 rounded-full bg-accent" style={{ animationDelay: "320ms" }} />
    </div>
  );
}

export function ListenClient({ contentId, title, initialTranscribed }: ListenClientProps) {
  const router = useRouter();
  // Decides accordion vs. two-pane mounting (not just CSS visibility) — same
  // structural-mount idiom as Read's sheet/panel gate (`useMediaQuery`'s doc
  // comment): the desktop pane keeps its own segment selection permanently
  // visible instead of expanding/collapsing inline, so it's a different
  // component tree, not just a CSS rearrangement.
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  // --- transcription gate ---
  const [transcribed, setTranscribed] = useState(initialTranscribed);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const startedTranscribeRef = useRef(false);

  // --- segments ---
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);

  // --- active dictation card ---
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [typedText, setTypedText] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Record<number, AttemptResult>>({});

  // --- capture ---
  const [capturedKeys, setCapturedKeys] = useState<Set<string>>(new Set());
  const [capturingKey, setCapturingKey] = useState<string | null>(null);

  // --- production follow-up ("Ahora dilo tú") ---
  const [followUps, setFollowUps] = useState<Record<number, FollowUpState>>({});

  // --- playback speed (page-session only, plan §4.1 "1.25x listening") ---
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  // --- audio ---
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeUpdateHandlerRef = useRef<(() => void) | null>(null);

  // Fire-and-forget: record that a listen session started on this content.
  useEffect(() => {
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface: "listen", contentId }),
    }).catch(() => {});
  }, [contentId]);

  const runTranscribe = useCallback(() => {
    setTranscribing(true);
    setTranscribeError(null);
    fetch(`/api/content/${contentId}/transcribe`, { method: "POST" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (!res.ok) {
          const message = typeof body.error === "string" ? body.error : "No se pudo transcribir el audio.";
          throw new Error(message);
        }
        return body;
      })
      .then(() => setTranscribed(true))
      .catch((err) => setTranscribeError(err instanceof Error ? err.message : String(err)))
      .finally(() => setTranscribing(false));
  }, [contentId]);

  useEffect(() => {
    if (transcribed || startedTranscribeRef.current) return;
    startedTranscribeRef.current = true;
    runTranscribe();
  }, [transcribed, runTranscribe]);

  useEffect(() => {
    if (!transcribed) return;
    let cancelled = false;
    fetch(`/api/content/${contentId}/segments`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { segments: TranscriptSegment[] }) => {
        if (cancelled) return;
        setSegments(data.segments);
        setSegmentsError(null);
      })
      .catch(() => {
        if (!cancelled) setSegmentsError("No se pudieron cargar los fragmentos.");
      });
    return () => {
      cancelled = true;
    };
  }, [transcribed, contentId]);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio && timeUpdateHandlerRef.current) {
      audio.removeEventListener("timeupdate", timeUpdateHandlerRef.current);
      timeUpdateHandlerRef.current = null;
    }
  }, []);

  useEffect(() => stopPlayback, [stopPlayback]);

  const playSegment = useCallback(
    (segment: TranscriptSegment) => {
      const audio = audioRef.current;
      if (!audio) return;
      stopPlayback();
      audio.playbackRate = speed;
      const endSeconds = segment.endMs / 1000;
      const onTimeUpdate = () => {
        if (audio.currentTime >= endSeconds - PLAY_EPSILON_S) {
          audio.pause();
          stopPlayback();
        }
      };
      timeUpdateHandlerRef.current = onTimeUpdate;
      audio.addEventListener("timeupdate", onTimeUpdate);
      audio.currentTime = segment.startMs / 1000;
      audio.play().catch(() => {});
    },
    [stopPlayback, speed],
  );

  /** Sets both the toggle's state and the live `<audio>` element's `playbackRate` — takes effect immediately, even mid-playback. */
  const setPlaybackSpeed = useCallback((next: PlaybackSpeed) => {
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, []);

  function openSegment(index: number) {
    stopPlayback();
    setActiveIndex((prev) => (prev === index ? null : index));
    setTypedText("");
    setSubmitError(null);
    setRetrying(false);
  }

  function handleRetryAttempt() {
    setTypedText("");
    setSubmitError(null);
    setRetrying(true);
  }

  async function handleCompare() {
    if (activeIndex === null || submitting) return;
    const segmentIndex = activeIndex;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/dictation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId, segmentIndex, typed: typedText }),
      });
      if (!res.ok) {
        throw new Error("No se pudo comparar. Intenta de nuevo.");
      }
      const data = (await res.json()) as { attemptId: string; tokens: DictationDiffToken[]; misses: DictationMiss[] };
      setAttempts((prev) => ({
        ...prev,
        [segmentIndex]: { tokens: data.tokens, misses: data.misses, attemptId: data.attemptId },
      }));
      setRetrying(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Algo salió mal.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCapture(segmentIndex: number, missIndex: number, expected: string) {
    const key = `${segmentIndex}:${missIndex}`;
    if (capturingKey || capturedKeys.has(key)) return;
    setCapturingKey(key);
    try {
      const res = await fetch("/api/dictation/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId, segmentIndex, chunk: expected }),
      });
      if (res.ok) {
        setCapturedKeys((prev) => new Set(prev).add(key));
      }
    } catch {
      // Best-effort — leave uncaptured, the chip stays actionable for a retry.
    } finally {
      setCapturingKey((prev) => (prev === key ? null : prev));
    }
  }

  function getFollowUp(segmentIndex: number): FollowUpState {
    return followUps[segmentIndex] ?? DEFAULT_FOLLOW_UP;
  }

  function setFollowUpText(segmentIndex: number, text: string) {
    setFollowUps((prev) => ({ ...prev, [segmentIndex]: { ...(prev[segmentIndex] ?? DEFAULT_FOLLOW_UP), text, error: null } }));
  }

  /** "Reformular de nuevo": re-shows an empty textarea, hiding (not discarding) the previous result until a new one replaces it. */
  function handleFollowUpAgain(segmentIndex: number) {
    setFollowUps((prev) => ({
      ...prev,
      [segmentIndex]: { ...(prev[segmentIndex] ?? DEFAULT_FOLLOW_UP), text: "", showForm: true, error: null },
    }));
  }

  async function handleFollowUpSubmit(segmentIndex: number) {
    const current = getFollowUp(segmentIndex);
    const text = current.text.trim();
    if (!text || current.submitting) return;
    setFollowUps((prev) => ({
      ...prev,
      [segmentIndex]: { ...(prev[segmentIndex] ?? DEFAULT_FOLLOW_UP), submitting: true, error: null },
    }));
    try {
      const res = await fetch("/api/listen/produce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId, segmentIndex, text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        const message = typeof body.error === "string" ? body.error : "No se pudo calificar. Intenta de nuevo.";
        throw new Error(message);
      }
      const data = (await res.json()) as { writingId: string; judgment: JudgeResult };
      setFollowUps((prev) => ({
        ...prev,
        [segmentIndex]: {
          text,
          submitting: false,
          error: null,
          result: { writingId: data.writingId, judgment: data.judgment },
          showForm: false,
        },
      }));
    } catch (err) {
      setFollowUps((prev) => ({
        ...prev,
        [segmentIndex]: {
          ...(prev[segmentIndex] ?? DEFAULT_FOLLOW_UP),
          submitting: false,
          error: err instanceof Error ? err.message : "Algo salió mal.",
        },
      }));
    }
  }

  // --- render: transcription gate ---
  if (!transcribed) {
    return (
      <StatusScreen title={title}>
        {transcribeError ? (
          <>
            <p className="text-sm text-danger-fg" data-testid="transcribe-error">
              {transcribeError}
            </p>
            <button
              type="button"
              data-testid="retry-transcribe"
              onClick={runTranscribe}
              className="flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
            >
              Reintentar
            </button>
          </>
        ) : (
          <>
            <LoadingDots />
            <p className="text-sm text-ink-muted">
              {transcribing ? "Transcribiendo… esto puede tardar varios minutos con audio real." : "Preparando…"}
            </p>
          </>
        )}
      </StatusScreen>
    );
  }

  // --- render: segments gate ---
  if (segmentsError) {
    return (
      <StatusScreen>
        <p className="text-sm text-danger-fg">{segmentsError}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
        >
          Reintentar
        </button>
      </StatusScreen>
    );
  }

  if (!segments) {
    return (
      <StatusScreen>
        <LoadingDots />
        <p className="text-sm text-ink-muted">Cargando fragmentos…</p>
      </StatusScreen>
    );
  }

  // --- render: main ---
  return (
    <div className="flex min-h-dvh flex-col">
      <audio ref={audioRef} src={`/api/media/${contentId}`} preload="metadata" />

      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-paper/95 px-2 py-2 backdrop-blur lg:px-6 lg:py-3">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Volver"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full active:bg-line/40"
        >
          <ChevronLeftIcon />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title ?? "Audio"}</h1>
        <SpeedToggle speed={speed} onChange={setPlaybackSpeed} />
      </header>

      {/*
        Structural fork (not just CSS), same reasoning as the doc comment on
        `isDesktop` above: desktop keeps a left column of compact rows and a
        permanently-visible right-hand workspace pane for whichever segment is
        selected; mobile keeps its inline accordion, completely untouched
        below (`!isDesktop`), so SSR/first paint (`isDesktop` always false
        pre-hydration) always renders the exact same mobile tree it always
        has.
      */}
      {isDesktop ? (
        <main className="flex-1 lg:flex lg:items-start lg:gap-8 lg:px-10 lg:pb-16 lg:pt-8">
          <aside data-testid="segment-list-panel" className="lg:sticky lg:top-20 lg:w-[320px] lg:shrink-0">
            <ul className="flex flex-col gap-2" data-testid="segment-list">
              {segments.map((segment, index) => (
                <DesktopSegmentRow
                  key={segment.index}
                  segment={segment}
                  index={index}
                  active={activeIndex === index}
                  attempt={attempts[index]}
                  onSelect={() => openSegment(index)}
                  onPlay={() => playSegment(segment)}
                />
              ))}
            </ul>
          </aside>

          <div className="lg:min-w-0 lg:flex-1">
            {activeIndex !== null ? (
              <div
                key={activeIndex}
                data-testid="dictation-panel"
                className="rounded-2xl border border-line bg-paper-elevated p-5 shadow-sm"
              >
                <h2 className="text-sm font-semibold text-ink">Fragmento {activeIndex + 1}</h2>
                <div className="mt-4">
                  <SegmentWorkspace
                    index={activeIndex}
                    attempt={attempts[activeIndex]}
                    retrying={retrying}
                    typedText={typedText}
                    onTypedTextChange={setTypedText}
                    submitting={submitting}
                    submitError={submitError}
                    onCompare={handleCompare}
                    onReplay={() => playSegment(segments[activeIndex])}
                    capturedKeys={capturedKeys}
                    capturingKey={capturingKey}
                    onCapture={handleCapture}
                    onRetryAttempt={handleRetryAttempt}
                    followUp={getFollowUp(activeIndex)}
                    onFollowUpChangeText={(text) => setFollowUpText(activeIndex, text)}
                    onFollowUpSubmit={() => handleFollowUpSubmit(activeIndex)}
                    onFollowUpAgain={() => handleFollowUpAgain(activeIndex)}
                  />
                </div>
              </div>
            ) : (
              <div data-testid="dictation-panel-empty" className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
                  <PlayIcon />
                </div>
                <p className="text-sm text-ink-muted">Elige un fragmento para dictar</p>
              </div>
            )}
          </div>
        </main>
      ) : (
        <main className="flex-1 px-4 pb-28 pt-5">
          <ul className="flex flex-col gap-3" data-testid="segment-list">
            {segments.map((segment, index) => {
              const attempt = attempts[index];
              const active = activeIndex === index;

              return (
                <li
                  key={segment.index}
                  data-testid="segment-card"
                  data-segment-index={index}
                  data-state={attempt ? "attempted" : "sin-intentar"}
                  className="rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      data-testid="segment-play"
                      aria-label={`Reproducir fragmento ${index + 1}`}
                      onClick={() => playSegment(segment)}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong active:opacity-80"
                    >
                      <PlayIcon />
                    </button>
                    <button
                      type="button"
                      data-testid="segment-open"
                      onClick={() => openSegment(index)}
                      className="flex min-w-0 flex-1 flex-col items-start text-left"
                    >
                      <span className="text-sm font-semibold text-ink">Fragmento {index + 1}</span>
                      <span className="text-xs text-ink-muted">{formatDuration(segment.endMs - segment.startMs)}</span>
                    </button>
                    <span
                      data-testid="segment-state-badge"
                      className={
                        attempt
                          ? attempt.misses.length === 0
                            ? "rounded-full bg-kept-bg px-2.5 py-1 text-xs font-semibold text-kept-fg"
                            : "rounded-full bg-amber-bg px-2.5 py-1 text-xs font-semibold text-amber-fg"
                          : "rounded-full bg-paper px-2.5 py-1 text-xs font-medium text-ink-muted"
                      }
                    >
                      {attempt ? (attempt.misses.length === 0 ? "Perfecto" : missCountLabel(attempt.misses.length)) : "Sin intentar"}
                    </span>
                  </div>

                  {active && (
                    <div className="mt-4 border-t border-line pt-4">
                      <SegmentWorkspace
                        index={index}
                        attempt={attempt}
                        retrying={retrying}
                        typedText={typedText}
                        onTypedTextChange={setTypedText}
                        submitting={submitting}
                        submitError={submitError}
                        onCompare={handleCompare}
                        onReplay={() => playSegment(segment)}
                        capturedKeys={capturedKeys}
                        capturingKey={capturingKey}
                        onCapture={handleCapture}
                        onRetryAttempt={handleRetryAttempt}
                        followUp={getFollowUp(index)}
                        onFollowUpChangeText={(text) => setFollowUpText(index, text)}
                        onFollowUpSubmit={() => handleFollowUpSubmit(index)}
                        onFollowUpAgain={() => handleFollowUpAgain(index)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </main>
      )}
    </div>
  );
}

/**
 * The active segment's dictation workspace — the dictation form, or (once an
 * attempt exists and isn't being retried) the diff + capture chips +
 * "Ahora dilo tú" follow-up. Shared verbatim between the mobile accordion
 * (rendered inline under the open `segment-card`) and the desktop right-hand
 * pane (rendered once for whichever row is selected) — same markup either
 * way, only the surrounding container differs, so this is the one place that
 * markup exists.
 */
function SegmentWorkspace({
  index,
  attempt,
  retrying,
  typedText,
  onTypedTextChange,
  submitting,
  submitError,
  onCompare,
  onReplay,
  capturedKeys,
  capturingKey,
  onCapture,
  onRetryAttempt,
  followUp,
  onFollowUpChangeText,
  onFollowUpSubmit,
  onFollowUpAgain,
}: {
  index: number;
  attempt: AttemptResult | undefined;
  retrying: boolean;
  typedText: string;
  onTypedTextChange: (text: string) => void;
  submitting: boolean;
  submitError: string | null;
  onCompare: () => void;
  onReplay: () => void;
  capturedKeys: Set<string>;
  capturingKey: string | null;
  onCapture: (segmentIndex: number, missIndex: number, expected: string) => void;
  onRetryAttempt: () => void;
  followUp: FollowUpState;
  onFollowUpChangeText: (text: string) => void;
  onFollowUpSubmit: () => void;
  onFollowUpAgain: () => void;
}) {
  const showForm = !attempt || retrying;
  const showDiff = attempt && !retrying;

  return (
    <>
      {showForm && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            data-testid="segment-replay"
            onClick={onReplay}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink active:bg-line/30"
          >
            <PlayIcon small /> Escuchar de nuevo
          </button>
          <textarea
            data-testid="dictation-textarea"
            value={typedText}
            onChange={(e) => onTypedTextChange(e.target.value)}
            placeholder="Escribe lo que oíste…"
            className="min-h-24 rounded-xl border border-line bg-paper px-4 py-3 text-base leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          {submitError && <p className="text-sm text-danger-fg">{submitError}</p>}
          <button
            type="button"
            data-testid="dictation-submit"
            onClick={onCompare}
            disabled={submitting || typedText.trim().length === 0}
            className="flex h-11 items-center justify-center gap-2 rounded-full bg-accent text-sm font-semibold text-accent-fg active:opacity-90 disabled:opacity-60"
          >
            {submitting && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
            )}
            {submitting ? "Comparando…" : "Comparar"}
          </button>
        </div>
      )}

      {showDiff && attempt && (
        <>
          <DiffPanel
            segmentIndex={index}
            attempt={attempt}
            capturedKeys={capturedKeys}
            capturingKey={capturingKey}
            onCapture={onCapture}
            onRetry={onRetryAttempt}
          />
          <ProductionFollowUp
            segmentIndex={index}
            state={followUp}
            onChangeText={onFollowUpChangeText}
            onSubmit={onFollowUpSubmit}
            onAgain={onFollowUpAgain}
          />
        </>
      )}
    </>
  );
}

/**
 * One compact row in the desktop left-hand segment list (~320px, sticky) —
 * play button, fragment label/duration, state badge, same visual vocabulary
 * as the mobile `segment-card` row but denser, and selecting it (rather than
 * expanding an accordion) drives the right-hand `SegmentWorkspace` pane.
 */
function DesktopSegmentRow({
  segment,
  index,
  active,
  attempt,
  onSelect,
  onPlay,
}: {
  segment: TranscriptSegment;
  index: number;
  active: boolean;
  attempt: AttemptResult | undefined;
  onSelect: () => void;
  onPlay: () => void;
}) {
  return (
    <li
      data-testid="segment-row"
      data-segment-index={index}
      data-active={active}
      data-state={attempt ? "attempted" : "sin-intentar"}
      className={
        active
          ? "flex items-center gap-2.5 rounded-xl border border-accent bg-accent-soft px-3 py-2.5"
          : "flex items-center gap-2.5 rounded-xl border border-line bg-paper-elevated px-3 py-2.5 transition-colors hover:bg-line/20"
      }
    >
      <button
        type="button"
        data-testid="segment-play"
        aria-label={`Reproducir fragmento ${index + 1}`}
        onClick={onPlay}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong active:opacity-80"
      >
        <PlayIcon small />
      </button>
      <button
        type="button"
        data-testid="segment-open"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="text-sm font-semibold text-ink">Fragmento {index + 1}</span>
        <span className="text-xs text-ink-muted">{formatDuration(segment.endMs - segment.startMs)}</span>
      </button>
      <span
        data-testid="segment-state-badge"
        className={
          attempt
            ? attempt.misses.length === 0
              ? "shrink-0 rounded-full bg-kept-bg px-2 py-0.5 text-[11px] font-semibold text-kept-fg"
              : "shrink-0 rounded-full bg-amber-bg px-2 py-0.5 text-[11px] font-semibold text-amber-fg"
            : "shrink-0 rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-ink-muted"
        }
      >
        {attempt ? (attempt.misses.length === 0 ? "Perfecto" : missCountLabel(attempt.misses.length)) : "Sin intentar"}
      </span>
    </li>
  );
}

function DiffPanel({
  segmentIndex,
  attempt,
  capturedKeys,
  capturingKey,
  onCapture,
  onRetry,
}: {
  segmentIndex: number;
  attempt: AttemptResult;
  capturedKeys: Set<string>;
  capturingKey: string | null;
  onCapture: (segmentIndex: number, missIndex: number, expected: string) => void;
  onRetry: () => void;
}) {
  const missesByClass = new Map<DictationMissClass, { miss: DictationMiss; index: number }[]>();
  attempt.misses.forEach((miss, index) => {
    const list = missesByClass.get(miss.class) ?? [];
    list.push({ miss, index });
    missesByClass.set(miss.class, list);
  });

  return (
    <div className="flex flex-col gap-4">
      <div data-testid="diff-tokens" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-2 text-[15px] leading-relaxed">
        {attempt.tokens.map((token, i) => (
          <DiffToken key={i} token={token} />
        ))}
      </div>

      {attempt.misses.length > 0 ? (
        <div className="flex flex-col gap-3" data-testid="miss-groups">
          {MISS_CLASS_ORDER.filter((cls) => missesByClass.has(cls)).map((cls) => (
            <div key={cls}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {MISS_CLASS_LABELS[cls]}
              </h3>
              <div className="flex flex-wrap gap-2">
                {missesByClass.get(cls)!.map(({ miss, index }) => {
                  const key = `${segmentIndex}:${index}`;
                  const captured = capturedKeys.has(key);
                  const capturing = capturingKey === key;
                  return (
                    <span
                      key={key}
                      data-testid="miss-chip"
                      data-class={cls}
                      data-expected={miss.expected}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-sm text-ink"
                    >
                      {miss.expected}
                      {cls === "lexical" && (
                        <button
                          type="button"
                          data-testid="capture-button"
                          data-captured={captured}
                          disabled={captured || capturing}
                          onClick={() => onCapture(segmentIndex, index, miss.expected)}
                          className={
                            captured
                              ? "rounded-full bg-kept-bg px-2 py-0.5 text-xs font-semibold text-kept-fg"
                              : "rounded-full border border-accent px-2 py-0.5 text-xs font-semibold text-accent-strong active:bg-accent-soft disabled:opacity-60"
                          }
                        >
                          {captured ? "Guardada ✓" : capturing ? "Guardando…" : "+ Guardar"}
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p data-testid="diff-perfect" className="text-sm font-semibold text-accent-strong">
          ¡Perfecto! Sin errores.
        </p>
      )}

      <button
        type="button"
        data-testid="retry-attempt"
        onClick={onRetry}
        className="flex h-10 w-fit items-center rounded-full border border-line px-4 text-sm font-semibold text-ink active:bg-line/30"
      >
        Intentar de nuevo
      </button>
    </div>
  );
}

function DiffToken({ token }: { token: DictationDiffToken }) {
  if (token.kind === "match") {
    return (
      <span data-testid="diff-token" data-kind="match" className="text-ink">
        {token.expected ?? ""}
      </span>
    );
  }
  if (token.kind === "miss") {
    return (
      <span
        data-testid="diff-token"
        data-kind="miss"
        className="rounded px-1 py-0.5 font-medium bg-rung-incorrect-bg text-rung-incorrect-fg"
      >
        {token.expected ?? ""}
        {token.heard && <span className="ml-1 text-xs opacity-70 line-through">{token.heard}</span>}
      </span>
    );
  }
  return (
    <span data-testid="diff-token" data-kind="extra" className="rounded px-1 py-0.5 text-ink-muted line-through opacity-70">
      {token.heard ?? ""}
    </span>
  );
}

/** Header's compact "1x"/"1.25x" segmented playback-speed control (page-session only — see `speed` state above). */
function SpeedToggle({ speed, onChange }: { speed: PlaybackSpeed; onChange: (next: PlaybackSpeed) => void }) {
  const inactiveClasses = "rounded-full px-2.5 py-1 text-xs font-medium text-ink-muted active:bg-line/30";
  const activeClasses = "rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg";
  return (
    <div
      data-testid="speed-toggle"
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-paper p-0.5"
    >
      <button
        type="button"
        data-testid="speed-1x"
        aria-pressed={speed === 1}
        onClick={() => onChange(1)}
        className={speed === 1 ? activeClasses : inactiveClasses}
      >
        1×
      </button>
      <button
        type="button"
        data-testid="speed-125x"
        aria-pressed={speed === 1.25}
        onClick={() => onChange(1.25)}
        className={speed === 1.25 ? activeClasses : inactiveClasses}
      >
        1.25×
      </button>
    </div>
  );
}

/**
 * The listening->production bridge under a segment's diff: "Ahora dilo tú" —
 * the learner reformulates what they heard in their own words, judged via
 * `POST /api/listen/produce` (same `judge` call/ladder as Fix, surface
 * "listen"). Textarea and judged result are mutually exclusive, same
 * form/diff toggling idiom as the segment's own dictation card above.
 */
function ProductionFollowUp({
  segmentIndex,
  state,
  onChangeText,
  onSubmit,
  onAgain,
}: {
  segmentIndex: number;
  state: FollowUpState;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onAgain: () => void;
}) {
  return (
    <div className="mt-4 border-t border-line pt-4" data-testid="followup-block" data-segment-index={segmentIndex}>
      <h3 className="text-sm font-semibold text-ink">Ahora dilo tú</h3>
      <p className="mt-1 text-xs text-ink-muted">Reformula lo que oíste con tus propias palabras.</p>

      {state.showForm ? (
        <div className="mt-3 flex flex-col gap-3">
          <textarea
            data-testid="followup-textarea"
            value={state.text}
            onChange={(e) => onChangeText(e.target.value)}
            placeholder="Escribe tu propia versión…"
            className="min-h-20 rounded-xl border border-line bg-paper px-4 py-3 text-base leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          {state.error && <p className="text-sm text-danger-fg">{state.error}</p>}
          <button
            type="button"
            data-testid="followup-submit"
            onClick={onSubmit}
            disabled={state.submitting || state.text.trim().length === 0}
            className="flex h-11 items-center justify-center gap-2 rounded-full bg-accent text-sm font-semibold text-accent-fg active:opacity-90 disabled:opacity-60"
          >
            {state.submitting && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
            )}
            {state.submitting ? "Calificando…" : "Calificar"}
          </button>
        </div>
      ) : (
        state.result && (
          <div className="mt-3 flex flex-col gap-3" data-testid="followup-result">
            <FollowUpJudgment judgment={state.result.judgment} />
            <button
              type="button"
              data-testid="followup-again"
              onClick={onAgain}
              className="flex h-10 w-fit items-center rounded-full border border-line px-4 text-sm font-semibold text-ink active:bg-line/30"
            >
              Reformular de nuevo
            </button>
          </div>
        )
      )}
    </div>
  );
}

/**
 * Slim version of `/fix/[id]`'s judged-sentence ladder (rung chip + colored
 * edge, expandable issues, better_version with attestation badge) — same
 * design tokens (`RUNG_CHIP_CLASSES`/`RUNG_EDGE_CLASSES`/`TAXONOMY_LABELS`),
 * no sentence-override control (that's a Fix-page-only affordance) and no
 * inline issue-span highlighting, to stay compact on this dense screen.
 */
function FollowUpJudgment({ judgment }: { judgment: JudgeResult }) {
  return (
    <ul className="flex flex-col gap-2" data-testid="followup-sentence-list">
      {judgment.sentences.map((sentence, i) => (
        <FollowUpSentenceCard key={i} sentence={sentence} />
      ))}
    </ul>
  );
}

function FollowUpSentenceCard({ sentence }: { sentence: JudgedSentence }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      data-testid="followup-sentence"
      data-rung={sentence.rung}
      className={`rounded-xl border border-line ${RUNG_EDGE_CLASSES[sentence.rung]} border-l-4 bg-paper p-3`}
    >
      <span
        data-testid="followup-rung-badge"
        className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${RUNG_CHIP_CLASSES[sentence.rung]}`}
      >
        {RUNG_LABELS[sentence.rung]}
      </span>

      <p className="mt-2 text-sm leading-relaxed text-ink">{sentence.sentence}</p>

      {sentence.issues.length > 0 && (
        <button
          type="button"
          data-testid="followup-issues-toggle"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs font-medium text-ink-muted underline decoration-line underline-offset-2 active:text-ink"
        >
          {expanded ? "Ocultar detalles" : sentence.issues.length === 1 ? "1 problema" : `${sentence.issues.length} problemas`}
        </button>
      )}

      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          {sentence.issues.map((issue, j) => (
            <div
              key={j}
              data-testid="followup-issue"
              data-tag={issue.tag}
              className="rounded-lg border border-line bg-paper-elevated px-3 py-2 text-xs"
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                  {TAXONOMY_LABELS[issue.tag]}
                </span>
                <span className="text-[10px] font-medium text-ink-muted">{SEVERITY_LABELS[issue.severity]}</span>
              </div>
              <p className="text-ink">
                <span className="text-ink-muted line-through">{issue.span}</span>
                <span className="mx-1 text-ink-muted">→</span>
                <strong className="font-semibold text-accent-strong">{issue.fix}</strong>
              </p>
              <p className="mt-1 text-ink-muted">{issue.note}</p>
            </div>
          ))}
        </div>
      )}

      {sentence.better_version && (
        <div
          className="mt-2 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2 text-xs text-ink"
          data-testid="followup-better-version"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-semibold text-accent-strong">Versión mejorada</span>
            {sentence.better_version_attested ? (
              <span className="text-xs font-semibold text-accent-strong" data-testid="followup-attested-badge">
                ✓ verificada
              </span>
            ) : (
              <span
                className="rounded-full border border-line bg-paper px-2 py-0.5 text-[10px] font-medium text-ink-muted"
                data-testid="followup-unverified-badge"
              >
                no verificada
              </span>
            )}
          </div>
          <p>{sentence.better_version}</p>
        </div>
      )}
    </li>
  );
}
