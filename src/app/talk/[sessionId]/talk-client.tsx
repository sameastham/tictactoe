"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { JudgeIssue, JudgedSentence, TalkReport } from "@/lib/contracts";
import { RUNG_CHIP_CLASSES, RUNG_EDGE_CLASSES, RUNG_LABELS, SEVERITY_LABELS, TAXONOMY_LABELS } from "@/lib/labels";

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
    setText("");
    setSendError(null);
    setTurns((prev) => [...prev, { role: "learner", text: trimmed, createdAt: new Date().toISOString() }]);
    setPending(true);
    try {
      const res = await fetch("/api/talk/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text: trimmed }),
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
        />
      ) : (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4" data-testid="talk-transcript">
            <div className="flex flex-col gap-3">
              {turns.map((turn, i) => (
                <Bubble key={i} turn={turn} />
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
            <div className="flex items-end gap-2">
              <textarea
                data-testid="talk-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={textareaRows(text)}
                placeholder="Escribe en español…"
                disabled={pending}
                className="min-h-11 flex-1 resize-none rounded-2xl border border-line bg-paper-elevated px-4 py-2.5 text-base leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
              />
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
          </footer>
        </>
      )}
    </div>
  );
}

function Bubble({ turn }: { turn: TalkTurnDto }) {
  const isTutor = turn.role === "tutor";
  return (
    <div
      className={isTutor ? "flex justify-start" : "flex justify-end"}
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
}: {
  report: TalkReport | null;
  topic: string | null;
  turns: TalkTurnDto[];
  chunksById: Record<string, string>;
  showTranscript: boolean;
  onToggleTranscript: () => void;
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
            <Bubble key={i} turn={turn} />
          ))}
        </div>
      )}
    </main>
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
