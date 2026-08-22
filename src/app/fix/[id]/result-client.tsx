"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { JudgeIssue, JudgedSentence, JudgeResult } from "@/lib/contracts";
import { RUNGS, type Rung } from "@/lib/taxonomy";
import { RUNG_CHIP_CLASSES, RUNG_EDGE_CLASSES, RUNG_LABELS, SEVERITY_LABELS, TAXONOMY_LABELS } from "@/lib/labels";

interface ResultClientProps {
  writingId: string;
  task: string | null;
  text: string;
  judgment: JudgeResult | null;
  chunksById: Record<string, string>;
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One piece of a judged sentence's rendering: plain text, or a highlighted issue span. */
type SentSegment = { kind: "text"; text: string } | { kind: "mark"; text: string; issueIndex: number };

/**
 * Locates each issue's `span` inside `sentence` (first occurrence, in issue
 * order), drops any that can't be found or that overlap an already-placed
 * span, and returns the alternating text/mark segments that reconstruct the
 * sentence exactly — same non-overlapping-ranges approach as
 * `buildParagraphSegments` in `src/lib/anchors.ts`, scoped to one sentence
 * instead of a whole article.
 */
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

export function ResultClient({ writingId, task, text, judgment, chunksById }: ResultClientProps) {
  if (!judgment) {
    return <UnjudgedState task={task} text={text} />;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-paper/95 px-2 py-2 backdrop-blur lg:px-6 lg:py-3">
        <Link
          href="/fix"
          aria-label="Volver"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full active:bg-line/40"
        >
          <ChevronLeftIcon />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">Resultado</h1>
      </header>

      <main className="flex-1 px-4 pb-28 pt-5 lg:mx-auto lg:max-w-3xl lg:px-10 lg:pb-16 lg:pt-8">
        {task && (
          <p className="mb-4 rounded-xl border border-line bg-paper-elevated px-4 py-3 text-sm text-ink-muted">
            <span className="font-semibold text-ink">Reto: </span>
            {task}
          </p>
        )}

        <CreditStrip judgment={judgment} chunksById={chunksById} />

        <ul className="flex flex-col gap-3" data-testid="sentence-list">
          {judgment.sentences.map((sentence, i) => (
            <SentenceCard key={i} sentence={sentence} index={i} writingId={writingId} />
          ))}
        </ul>
      </main>
    </div>
  );
}

function CreditStrip({ judgment, chunksById }: { judgment: JudgeResult; chunksById: Record<string, string> }) {
  if (judgment.items_used.length === 0 && judgment.items_avoided.length === 0) return null;

  return (
    <section className="mb-5 flex flex-col gap-2" data-testid="credit-strip">
      {judgment.items_used.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Usaste:</span>
          {judgment.items_used.map((id) => (
            <span
              key={id}
              data-testid="credit-used-chip"
              className="rounded-full border border-kept-border bg-kept-bg px-2.5 py-1 text-xs font-medium text-kept-fg"
            >
              {chunksById[id] ?? id}
            </span>
          ))}
        </div>
      )}
      {judgment.items_avoided.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Evitaste:</span>
          {judgment.items_avoided.map((id) => (
            <span
              key={id}
              data-testid="credit-avoided-chip"
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

function SentenceCard({
  sentence,
  index,
  writingId,
}: {
  sentence: JudgedSentence;
  index: number;
  writingId: string;
}) {
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  const segments = useMemo(
    () => buildSentenceSegments(sentence.sentence, sentence.issues),
    [sentence.sentence, sentence.issues],
  );

  return (
    <li
      data-testid="sentence-card"
      data-rung={sentence.rung}
      className={`rounded-2xl border border-line ${RUNG_EDGE_CLASSES[sentence.rung]} border-l-4 bg-paper-elevated p-4 shadow-sm lg:p-5`}
    >
      <span
        data-testid="sentence-rung-badge"
        className={`inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${RUNG_CHIP_CLASSES[sentence.rung]}`}
      >
        {RUNG_LABELS[sentence.rung]}
      </span>

      {/*
        At `lg:`, when there's a `better_version`, this becomes a 2-column
        grid — original left, better version right, same top edge
        (`lg:items-start`) — with the issue detail (when expanded) placed as
        its own full-width row below (`lg:col-span-2 lg:row-start-2`) via
        explicit grid placement, not DOM reordering: the three children below
        keep the exact same source order (sentence, issue detail, better
        version) as the mobile-only markup this replaced, so mobile output —
        no `lg:grid` on this wrapper below `lg:`, and grid-placement classes
        that are no-ops without a grid ancestor — is byte-for-byte unchanged.
      */}
      <div className={sentence.better_version ? "mt-2.5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-6" : "mt-2.5"}>
        <p className="text-[15px] leading-relaxed text-ink lg:col-start-1 lg:row-start-1">
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
          <IssueDetail issue={sentence.issues[expandedIssue]} className="lg:col-span-2 lg:row-start-2" />
        )}

        {sentence.better_version && <BetterVersion sentence={sentence} />}
      </div>

      <SentenceOverride writingId={writingId} sentenceIndex={index} />
    </li>
  );
}

function IssueDetail({ issue, className = "" }: { issue: JudgeIssue; className?: string }) {
  return (
    <div className={`mt-3 rounded-lg border border-line bg-paper px-3 py-2.5 text-sm ${className}`} data-testid="issue-detail">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          {TAXONOMY_LABELS[issue.tag]}
        </span>
        <span className="text-[11px] font-medium text-ink-muted">{SEVERITY_LABELS[issue.severity]}</span>
      </div>
      <p className="text-ink">
        <span className="text-ink-muted line-through">{issue.span}</span>
        <span className="mx-1.5 text-ink-muted">→</span>
        <strong className="font-semibold text-accent-strong">{issue.fix}</strong>
      </p>
      <p className="mt-1.5 text-ink-muted">{issue.note}</p>
    </div>
  );
}

function BetterVersion({ sentence }: { sentence: JudgedSentence }) {
  if (!sentence.better_version) return null;
  return (
    <div
      className="mt-3 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 text-sm text-ink lg:col-start-2 lg:row-start-1 lg:mt-0"
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
  );
}

type OverridePhase = "idle" | "picking" | "submitting" | "done" | "error";

/**
 * The learner's override of the model's rung for one sentence. Self-contained
 * (owns its own network call): "¿No estás de acuerdo?" -> rung picker + note
 * -> POST /api/adjudications -> locked confirmation. A 409 (already
 * adjudicated — e.g. a retried submit) is treated identically to a 201, per
 * the API's documented contract.
 */
function SentenceOverride({ writingId, sentenceIndex }: { writingId: string; sentenceIndex: number }) {
  const [phase, setPhase] = useState<OverridePhase>("idle");
  const [rung, setRung] = useState<Rung | null>(null);
  const [note, setNote] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit() {
    if (!rung) return;
    setPhase("submitting");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/adjudications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          writingId,
          sentenceIndex,
          learnerRung: rung,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (res.status === 201 || res.status === 409) {
        setPhase("done");
        return;
      }
      const body = await res.json().catch(() => null);
      const message = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
      setErrorMessage(typeof message === "string" && message.length > 0 ? message : "No se pudo registrar tu veredicto.");
      setPhase("error");
    } catch {
      setErrorMessage("No se pudo conectar con el servidor.");
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <p data-testid="override-confirmation" className="mt-3 text-sm font-semibold text-accent-strong">
        Registrado — tu veredicto manda.
      </p>
    );
  }

  if (phase === "idle") {
    return (
      <button
        type="button"
        data-testid="override-trigger"
        onClick={() => setPhase("picking")}
        className="mt-3 text-sm font-medium text-ink-muted underline decoration-line underline-offset-2 active:text-ink"
      >
        ¿No estás de acuerdo?
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-line bg-paper px-3 py-3" data-testid="override-picker">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Tu veredicto</p>
      <div className="flex flex-wrap gap-1.5">
        {RUNGS.map((r) => (
          <button
            key={r}
            type="button"
            data-testid={`override-rung-${r}`}
            onClick={() => setRung(r)}
            disabled={phase === "submitting"}
            className={
              rung === r
                ? `rounded-full border px-3 py-1.5 text-sm font-semibold ${RUNG_CHIP_CLASSES[r]}`
                : "rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink-muted active:bg-line/30"
            }
          >
            {RUNG_LABELS[r]}
          </button>
        ))}
      </div>
      <input
        type="text"
        data-testid="override-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nota (opcional)"
        disabled={phase === "submitting"}
        className="mt-2.5 h-10 w-full rounded-lg border border-line bg-paper-elevated px-3 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
      />
      {phase === "error" && errorMessage && <p className="mt-2 text-xs text-danger-fg">{errorMessage}</p>}
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => {
            setPhase("idle");
            setRung(null);
            setNote("");
            setErrorMessage(null);
          }}
          disabled={phase === "submitting"}
          className="h-9 flex-1 rounded-full border border-line text-sm font-semibold text-ink active:bg-line/30 disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          data-testid="override-submit"
          onClick={submit}
          disabled={!rung || phase === "submitting"}
          className="h-9 flex-1 rounded-full bg-accent text-sm font-semibold text-accent-fg active:opacity-90 disabled:opacity-50"
        >
          {phase === "submitting" ? "Enviando…" : "Enviar"}
        </button>
      </div>
    </div>
  );
}

/**
 * A writing whose model call failed (`judgment === null`, persisted anyway —
 * see `POST /api/fix`'s 502 contract). "Calificar de nuevo" is deliberately
 * labeled honestly: it re-POSTs the same text/task, which creates a *new*
 * writing row rather than retrying in place — acceptable v0 behavior.
 */
function UnjudgedState({ task, text }: { task: string | null; text: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...(task ? { task } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
        setError(typeof message === "string" && message.length > 0 ? message : "No se pudo calificar. Intenta de nuevo.");
        setPending(false);
        return;
      }
      const data = (await res.json()) as { writingId: string };
      router.push(`/fix/${data.writingId}`);
    } catch {
      setError("No se pudo conectar con el servidor.");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-bg text-amber-fg">
        <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
          <path d="M12 8v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 16.5h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </div>
      <p className="text-sm text-ink-muted" data-testid="unjudged-message">
        Esta escritura se guardó, pero el modelo no pudo calificarla todavía.
      </p>
      {error && <p className="text-sm text-danger-fg">{error}</p>}
      <button
        type="button"
        data-testid="retry-judge"
        onClick={retry}
        disabled={pending}
        className="flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90 disabled:opacity-60"
      >
        {pending ? "Calificando…" : "Calificar de nuevo"}
      </button>
    </div>
  );
}
