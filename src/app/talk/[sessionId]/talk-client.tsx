"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { JudgeIssue, JudgedSentence, TalkReport, TalkTurnMeta } from "@/lib/contracts";
import { RUNG_CHIP_CLASSES, RUNG_EDGE_CLASSES, RUNG_LABELS, SEVERITY_LABELS, TAXONOMY_LABELS } from "@/lib/labels";
import { formatElapsed, useVoiceRecorder } from "@/components/VoiceRecorder";
import { getBrowserTts } from "@/lib/tts";

export interface TalkTurnDto {
  role: "learner" | "tutor";
  text: string;
  createdAt: string;
}

interface TalkClientProps {
  sessionId: string;
  topic: string | null;
  initialTurns: TalkTurnDto[];
  initialEnded: boolean;
  initialReport: TalkReport | null;
  /** Item id -> chunk text, resolved server-side as of initial page load — see the `chunksById` state below for why it can go stale. */
  chunksById: Record<string, string>;
}

const MAX_TEXTAREA_ROWS = 3;

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M4 12l16-8-6 8 6 8-16-8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 19v2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M4 9.5v5h3.2L12 18V6L7.2 9.5H4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M15.5 9a3.5 3.5 0 0 1 0 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M4 9.5v5h3.2L12 18V6L7.2 9.5H4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M15.5 10.2l3.5 3.6M19 10.2l-3.5 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One piece of a judged sentence's rendering. Mirrors `buildSentenceSegments`
 * in `src/app/fix/[id]/result-client.tsx`, duplicated here — small, pure,
 * self-contained — rather than exported cross-surface, since the Talk report
 * mirrors the Fix result styling without pulling in Fix's interactive
 * override control (Talk's report is read-only; see {@link TalkSentenceCard}).
 */
type SentSegment = { kind: "text"; text: string } | { kind: "mark"; text: string; issueIndex: number };

function buildSentenceSegments(sentence: string, issues: JudgeIssue[]): SentSegment[] {
  type Match = { start: number; end: number; issueIndex: number };
  const matches: Match[] = [];
  for (let i = 0; i < issues.length; i++) {
    const span = issues[i].span;
    if (!span) continue;
    const start = sentence.indexOf(span);
    if (start === -1) continue;
    matches.push({ start, end: start + span.length, issueIndex: i });
  }
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  const kept: Match[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start < lastEnd) continue;
    kept.push(m);
    lastEnd = m.end;
  }

  const segments: SentSegment[] = [];
  let pos = 0;
  for (const m of kept) {
    if (m.start > pos) segments.push({ kind: "text", text: sentence.slice(pos, m.start) });
    segments.push({ kind: "mark", text: sentence.slice(m.start, m.end), issueIndex: m.issueIndex });
    pos = m.end;
  }
  if (pos < sentence.length) segments.push({ kind: "text", text: sentence.slice(pos) });
  if (segments.length === 0) segments.push({ kind: "text", text: sentence });
  return segments;
}

/** Rows for the auto-growing message textarea, clamped to 1–3 by line count. */
function textareaRows(text: string): number {
  const lines = text.length === 0 ? 1 : text.split("\n").length;
  return Math.min(MAX_TEXTAREA_ROWS, Math.max(1, lines));
}

export function TalkClient({
  sessionId,
  topic,
  initialTurns,
  initialEnded,
  initialReport,
  chunksById: initialChunksById,
}: TalkClientProps) {
  const router = useRouter();
  const [turns, setTurns] = useState<TalkTurnDto[]>(initialTurns);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [ended, setEnded] = useState(initialEnded);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [report, setReport] = useState<TalkReport | null>(initialReport);
  const [chunksById, setChunksById] = useState<Record<string, string>>(initialChunksById);
  const [showTranscript, setShowTranscript] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Voice mode (plan §4.3 week 7): a transcribed recording lands in `text`,
  // editable, with its fluency meta stashed here until the learner actually
  // sends it — see `handleTranscribed`/`sendMessage`/`handleMicTap` below.
  const [voiceMeta, setVoiceMeta] = useState<TalkTurnMeta | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const tts = useMemo(() => getBrowserTts(), []);

  function handleTranscribed(transcribedText: string, meta: TalkTurnMeta) {
    setText(transcribedText);
    setVoiceMeta(meta);
  }
  const recorder = useVoiceRecorder(handleTranscribed);

  function handleMicTap() {
    // Starting a new recording drops whatever was previously stashed — it
    // describes an attempt the learner is now discarding in favor of a new one.
    setVoiceMeta(null);
    recorder.start();
  }

  function handleTextChange(value: string) {
    setText(value);
    if (value.length === 0) {
      // Manually clearing the input drops the stashed meta (design §5) —
      // editing it otherwise keeps it, since it still describes the spoken attempt.
      setVoiceMeta(null);
    }
  }

  function handleToggleSpeak(index: number, turnText: string) {
    if (speakingIndex === index) {
      tts.stop();
      setSpeakingIndex(null);
      return;
    }
    tts.stop();
    tts.speak(turnText);
    setSpeakingIndex(index);
  }

  // Cosmetic only: resets the speaker icon back to "play" once the browser
  // finishes an utterance on its own (no `onend` on the `TtsEngine`
  // interface by design — this reads `speechSynthesis.speaking` directly,
  // never controls it).
  useEffect(() => {
    if (speakingIndex === null || typeof window === "undefined" || !window.speechSynthesis) return;
    const interval = setInterval(() => {
      if (!window.speechSynthesis.speaking) setSpeakingIndex(null);
    }, 250);
    return () => clearInterval(interval);
  }, [speakingIndex]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, pending]);

  // `chunksById` is only resolved server-side as of the initial page load
  // (when the session might not even have ended yet). Ending a session
  // happens client-side, without a navigation, so a freshly-received
  // report's item ids can be missing from that initial map — backfill any
  // gap here rather than showing raw ids in the credit chips.
  useEffect(() => {
    if (!report) return;
    const ids = [...report.itemsUsed, ...report.itemsAvoided];
    const missing = ids.filter((id) => !(id in chunksById));
    if (missing.length === 0) return;

    let cancelled = false;
    fetch(`/api/items/by-ids?ids=${encodeURIComponent(missing.join(","))}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { items: { id: string; chunk: string }[] }) => {
        if (cancelled) return;
        setChunksById((prev) => {
          const next = { ...prev };
          for (const item of data.items) next[item.id] = item.chunk;
          return next;
        });
      })
      .catch(() => {
        // Best-effort — the chip falls back to the raw id, still readable.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the report identity + already-known ids, not the whole (recreated-per-render) chunksById object
  }, [report]);

  async function sendMessage() {
    const trimmed = text.trim();
    if (!trimmed || pending || ended) return;
    // The stashed meta describes this exact text (edited or not) — captured
    // before clearing state below, and sent whether or not this turn's
    // text still matches the raw transcript verbatim.
    const meta = voiceMeta;
    setText("");
    setVoiceMeta(null);
    setSendError(null);
    setTurns((prev) => [...prev, { role: "learner", text: trimmed, createdAt: new Date().toISOString() }]);
    setPending(true);
    try {
      const res = await fetch("/api/talk/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text: trimmed, ...(meta ? { meta } : {}) }),
      });
      if (!res.ok) {
        setSendError("No se pudo enviar tu mensaje. Intenta de nuevo.");
        return;
      }
      const data = (await res.json()) as { reply: string };
      setTurns((prev) => [...prev, { role: "tutor", text: data.reply, createdAt: new Date().toISOString() }]);
    } catch {
      setSendError("No se pudo conectar con el servidor.");
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function handleEnd() {
    if (ending || ended) return;
    setEnding(true);
    setEndError(null);
    try {
      const res = await fetch("/api/talk/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (res.status === 409) {
        // Already ended (e.g. a retried tap) — recover by re-fetching the
        // stored report instead of treating this as a failure.
        const reportRes = await fetch(`/api/talk/${sessionId}/report`);
        if (reportRes.ok) {
          const data = (await reportRes.json()) as { report: TalkReport };
          setReport(data.report);
          setEnded(true);
        } else {
          setEndError("No se pudo terminar la plática.");
        }
        return;
      }
      if (!res.ok) {
        setEndError("No se pudo terminar la plática. Intenta de nuevo.");
        return;
      }
      const data = (await res.json()) as { report: TalkReport };
      setReport(data.report);
      setEnded(true);
    } catch {
      setEndError("No se pudo conectar con el servidor.");
    } finally {
      setEnding(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-paper/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => router.push("/talk")}
          aria-label="Volver"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full active:bg-line/40"
        >
          <ChevronLeftIcon />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {ended ? "Reporte" : (topic ?? "Plática")}
        </h1>
        {!ended && (
          <button
            type="button"
            data-testid="talk-end"
            onClick={handleEnd}
            disabled={ending}
            className="flex h-9 shrink-0 items-center rounded-full border border-line px-3 text-sm font-semibold text-ink active:bg-line/30 disabled:opacity-60"
          >
            {ending ? "Terminando…" : "Terminar"}
          </button>
        )}
      </header>

      {ended ? (
        <ReportView
          report={report}
          topic={topic}
          turns={turns}
          chunksById={chunksById}
          showTranscript={showTranscript}
          onToggleTranscript={() => setShowTranscript((v) => !v)}
          ttsAvailable={tts.available}
          speakingIndex={speakingIndex}
          onToggleSpeak={handleToggleSpeak}
        />
      ) : (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4" data-testid="talk-transcript">
            <div className="flex flex-col gap-3">
              {turns.map((turn, i) => (
                <Bubble
                  key={i}
                  turn={turn}
                  index={i}
                  ttsAvailable={tts.available}
                  speaking={speakingIndex === i}
                  onToggleSpeak={handleToggleSpeak}
                />
              ))}
              {pending && <TypingBubble />}
              <div ref={bottomRef} />
            </div>
          </main>

          <footer
            className="sticky bottom-0 border-t border-line bg-paper/95 px-3 pt-3 backdrop-blur"
            style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
          >
            {sendError && <p className="mb-2 text-sm text-danger-fg">{sendError}</p>}
            {endError && <p className="mb-2 text-sm text-danger-fg">{endError}</p>}

            {recorder.status === "recording" ? (
              <RecordingBar elapsedMs={recorder.elapsedMs} onStop={recorder.stop} onCancel={recorder.cancel} />
            ) : recorder.status === "transcribing" ? (
              <div
                data-testid="voice-transcribing"
                className="flex h-11 items-center gap-3 rounded-2xl border border-line bg-paper-elevated px-4 text-sm text-ink-muted"
              >
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
                Transcribiendo…
              </div>
            ) : (
              <>
                {recorder.status === "error" && recorder.errorMessage && (
                  <p className="mb-2 text-sm text-danger-fg" data-testid="voice-error">
                    {recorder.errorMessage}
                  </p>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    data-testid="talk-input"
                    value={text}
                    onChange={(e) => handleTextChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={textareaRows(text)}
                    placeholder="Escribe en español…"
                    disabled={pending}
                    className="min-h-11 flex-1 resize-none rounded-2xl border border-line bg-paper-elevated px-4 py-2.5 text-base leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    data-testid="voice-mic-button"
                    onClick={handleMicTap}
                    disabled={pending || recorder.status === "requesting"}
                    aria-label="Grabar en voz alta"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-ink active:bg-line/30 disabled:opacity-60"
                  >
                    <MicIcon />
                  </button>
                  <button
                    type="button"
                    data-testid="talk-send"
                    onClick={sendMessage}
                    disabled={pending || text.trim().length === 0}
                    aria-label="Enviar"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg active:opacity-90 disabled:opacity-60"
                  >
                    <SendIcon />
                  </button>
                </div>
              </>
            )}
          </footer>
        </>
      )}
    </div>
  );
}

function Bubble({
  turn,
  index,
  ttsAvailable,
  speaking,
  onToggleSpeak,
}: {
  turn: TalkTurnDto;
  /** This turn's position within `turns` — required (with the three props below) to show a TTS button. */
  index?: number;
  /** `getBrowserTts().available` — no es-* voice means no button, ever. */
  ttsAvailable?: boolean;
  speaking?: boolean;
  onToggleSpeak?: (index: number, text: string) => void;
}) {
  const isTutor = turn.role === "tutor";
  const showTts = isTutor && ttsAvailable && index !== undefined && onToggleSpeak !== undefined;

  return (
    <div
      className={isTutor ? "flex items-end justify-start gap-1.5" : "flex justify-end"}
      data-testid="talk-bubble"
      data-role={turn.role}
    >
      <div
        className={
          isTutor
            ? "max-w-[80%] rounded-2xl rounded-bl-sm border border-line bg-paper-elevated px-4 py-2.5 text-[15px] leading-relaxed text-ink shadow-sm"
            : "max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-[15px] leading-relaxed text-accent-fg shadow-sm"
        }
      >
        {turn.text}
      </div>
      {showTts && (
        <button
          type="button"
          data-testid="talk-tts-button"
          aria-label={speaking ? "Detener lectura" : "Escuchar"}
          onClick={() => onToggleSpeak(index, turn.text)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-muted active:bg-line/40"
        >
          {speaking ? <SpeakerOffIcon /> : <SpeakerIcon />}
        </button>
      )}
    </div>
  );
}

/** Replaces the input row while a voice recording is in progress — pulsing dot, elapsed timer, Detener/Cancelar. */
function RecordingBar({
  elapsedMs,
  onStop,
  onCancel,
}: {
  elapsedMs: number;
  onStop: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-testid="voice-recording-bar"
      className="flex h-11 items-center gap-3 rounded-2xl border border-danger-border bg-danger-bg px-4"
    >
      <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger-border" aria-hidden="true" />
      <span data-testid="voice-timer" className="flex-1 text-sm font-medium tabular-nums text-danger-fg">
        {formatElapsed(elapsedMs)}
      </span>
      <button
        type="button"
        data-testid="voice-cancel"
        onClick={onCancel}
        className="rounded-full px-3 py-1.5 text-sm font-semibold text-danger-fg active:bg-danger-border/20"
      >
        Cancelar
      </button>
      <button
        type="button"
        data-testid="voice-stop"
        onClick={onStop}
        className="rounded-full bg-danger-border px-3 py-1.5 text-sm font-semibold text-white active:opacity-90"
      >
        Detener
      </button>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start" data-testid="talk-typing">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-line bg-paper-elevated px-4 py-3 shadow-sm">
        <span className="dot-pulse h-2 w-2 rounded-full bg-ink-muted" style={{ animationDelay: "0ms" }} />
        <span className="dot-pulse h-2 w-2 rounded-full bg-ink-muted" style={{ animationDelay: "160ms" }} />
        <span className="dot-pulse h-2 w-2 rounded-full bg-ink-muted" style={{ animationDelay: "320ms" }} />
      </div>
    </div>
  );
}

function ReportView({
  report,
  topic,
  turns,
  chunksById,
  showTranscript,
  onToggleTranscript,
  ttsAvailable,
  speakingIndex,
  onToggleSpeak,
}: {
  report: TalkReport | null;
  topic: string | null;
  turns: TalkTurnDto[];
  chunksById: Record<string, string>;
  showTranscript: boolean;
  onToggleTranscript: () => void;
  ttsAvailable: boolean;
  speakingIndex: number | null;
  onToggleSpeak: (index: number, text: string) => void;
}) {
  const learnerTurnCount = turns.filter((t) => t.role === "learner").length;

  return (
    <main className="flex-1 px-4 pb-16 pt-5" data-testid="talk-report">
      {topic && (
        <p className="mb-4 rounded-xl border border-line bg-paper-elevated px-4 py-3 text-sm text-ink-muted">
          <span className="font-semibold text-ink">Tema: </span>
          {topic}
        </p>
      )}

      {report?.fluency && <FluencySection fluency={report.fluency} />}

      {!report || !report.judgment ? (
        <p className="text-sm text-ink-muted" data-testid="talk-report-unjudged">
          {learnerTurnCount === 0
            ? "No dijiste nada esta vez — inténtalo otra vez cuando quieras platicar."
            : "Esta plática se guardó, pero el modelo no pudo calificarla todavía."}
        </p>
      ) : (
        <>
          <CreditChips report={report} chunksById={chunksById} />

          <ul className="flex flex-col gap-3" data-testid="talk-sentence-list">
            {report.judgment.sentences.map((sentence, i) => (
              <TalkSentenceCard key={i} sentence={sentence} />
            ))}
          </ul>

          {report.practiceNext.length > 0 && (
            <section className="mt-6" data-testid="practice-next">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Para practicar</h2>
              <ul className="flex flex-col gap-2">
                {report.practiceNext.map((line, i) => (
                  <li
                    key={i}
                    data-testid="practice-next-item"
                    className="rounded-xl border border-line bg-paper-elevated px-4 py-3 text-sm text-ink"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <button
        type="button"
        data-testid="toggle-transcript"
        onClick={onToggleTranscript}
        className="mt-6 text-sm font-medium text-ink-muted underline decoration-line underline-offset-2 active:text-ink"
      >
        {showTranscript ? "Ocultar plática" : "Ver plática"}
      </button>

      {showTranscript && (
        <div className="mt-3 flex flex-col gap-2" data-testid="talk-transcript-review">
          {turns.map((turn, i) => (
            <Bubble
              key={i}
              turn={turn}
              index={i}
              ttsAvailable={ttsAvailable}
              speaking={speakingIndex === i}
              onToggleSpeak={onToggleSpeak}
            />
          ))}
        </div>
      )}
    </main>
  );
}

/**
 * "Fluidez" — plain stats read off the session's voice-mode learner turns
 * (see `FluencyAggregateSchema`), no naturalness judgment attached. Only
 * rendered when the session had at least one voice turn.
 */
function FluencySection({ fluency }: { fluency: NonNullable<TalkReport["fluency"]> }) {
  return (
    <section
      className="mb-5 rounded-xl border border-line bg-paper-elevated px-4 py-3.5"
      data-testid="talk-fluency"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Fluidez</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <FluencyStat testId="fluency-voice-turns" label="turnos hablados" value={String(fluency.voiceTurns)} />
        <FluencyStat
          testId="fluency-words-per-min"
          label="ritmo"
          value={`${fluency.avgWordsPerMin} ppm`}
        />
        <FluencyStat
          testId="fluency-pauses"
          label="pausas largas"
          value={String(fluency.totalPausesOver800Ms)}
        />
        <FluencyStat testId="fluency-fillers" label="muletillas" value={String(fluency.totalFillers)} />
      </div>
    </section>
  );
}

function FluencyStat({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div data-testid={testId} className="rounded-lg bg-paper px-3 py-2.5">
      <div className="text-lg font-semibold text-ink" data-testid={`${testId}-value`}>
        {value}
      </div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function CreditChips({ report, chunksById }: { report: TalkReport; chunksById: Record<string, string> }) {
  if (report.itemsUsed.length === 0 && report.itemsAvoided.length === 0) return null;

  return (
    <section className="mb-5 flex flex-col gap-2" data-testid="talk-credit-strip">
      {report.itemsUsed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Usaste:</span>
          {report.itemsUsed.map((id) => (
            <span
              key={id}
              data-testid="talk-credit-used-chip"
              className="rounded-full border border-kept-border bg-kept-bg px-2.5 py-1 text-xs font-medium text-kept-fg"
            >
              {chunksById[id] ?? id}
            </span>
          ))}
        </div>
      )}
      {report.itemsAvoided.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Evitaste:</span>
          {report.itemsAvoided.map((id) => (
            <span
              key={id}
              data-testid="talk-credit-avoided-chip"
              className="rounded-full border border-discard-border bg-discard-bg px-2.5 py-1 text-xs font-medium text-discard-fg"
            >
              {chunksById[id] ?? id}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Mirrors `SentenceCard` in `src/app/fix/[id]/result-client.tsx` (rung
 * badge, issue-mark spans, better-version box) minus the interactive
 * override control — the Talk report is a read-only summary, and Talk
 * never invites correction, mid-conversation or on its own report.
 */
function TalkSentenceCard({ sentence }: { sentence: JudgedSentence }) {
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  const segments = buildSentenceSegments(sentence.sentence, sentence.issues);

  return (
    <li
      data-testid="sentence-card"
      data-rung={sentence.rung}
      className={`rounded-2xl border border-line ${RUNG_EDGE_CLASSES[sentence.rung]} border-l-4 bg-paper-elevated p-4 shadow-sm`}
    >
      <span
        data-testid="sentence-rung-badge"
        className={`inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${RUNG_CHIP_CLASSES[sentence.rung]}`}
      >
        {RUNG_LABELS[sentence.rung]}
      </span>

      <p className="mt-2.5 text-[15px] leading-relaxed text-ink">
        {segments.map((seg, j) =>
          seg.kind === "text" ? (
            <span key={j}>{seg.text}</span>
          ) : (
            <button
              key={j}
              type="button"
              data-testid="issue-mark"
              onClick={() => setExpandedIssue(expandedIssue === seg.issueIndex ? null : seg.issueIndex)}
              className={
                sentence.issues[seg.issueIndex].severity === "major"
                  ? "candidate-mark rounded px-0.5 py-0.5 font-medium underline decoration-2 decoration-rung-incorrect-border underline-offset-4 bg-rung-incorrect-bg text-rung-incorrect-fg"
                  : "candidate-mark rounded px-0.5 py-0.5 font-medium underline decoration-2 decoration-rung-acceptable-border underline-offset-4 bg-rung-acceptable-bg text-rung-acceptable-fg"
              }
            >
              {seg.text}
            </button>
          ),
        )}
      </p>

      {expandedIssue !== null && sentence.issues[expandedIssue] && (
        <div className="mt-3 rounded-lg border border-line bg-paper px-3 py-2.5 text-sm" data-testid="issue-detail">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted">
              {TAXONOMY_LABELS[sentence.issues[expandedIssue].tag]}
            </span>
            <span className="text-[11px] font-medium text-ink-muted">
              {SEVERITY_LABELS[sentence.issues[expandedIssue].severity]}
            </span>
          </div>
          <p className="text-ink">
            <span className="text-ink-muted line-through">{sentence.issues[expandedIssue].span}</span>
            <span className="mx-1.5 text-ink-muted">→</span>
            <strong className="font-semibold text-accent-strong">{sentence.issues[expandedIssue].fix}</strong>
          </p>
          <p className="mt-1.5 text-ink-muted">{sentence.issues[expandedIssue].note}</p>
        </div>
      )}

      {sentence.better_version && (
        <div
          className="mt-3 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 text-sm text-ink"
          data-testid="better-version"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-semibold text-accent-strong">Versión mejorada</span>
            {sentence.better_version_attested ? (
              <span className="text-xs font-semibold text-accent-strong" data-testid="attested-badge">
                ✓ verificada
              </span>
            ) : (
              <span
                className="rounded-full border border-line bg-paper px-2 py-0.5 text-[10px] font-medium text-ink-muted"
                data-testid="unverified-badge"
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
