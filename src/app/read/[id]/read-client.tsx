"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Candidate, StoredExtraction } from "@/lib/contracts";
import { anchorCandidates, buildParagraphSegments } from "@/lib/anchors";
import { CandidateSheet } from "@/components/CandidateSheet";
import { CandidateDetail } from "@/components/CandidateDetail";
import { useMediaQuery } from "@/lib/useMediaQuery";

export type Decision = "keep" | "discard";

interface ReadClientProps {
  contentId: string;
  title: string | null;
  text: string;
  initialExtraction: StoredExtraction | null;
  initialDecisions: Record<string, Decision>;
}

/** Finds the next undecided candidate after `afterId`, wrapping around the list. */
function findNextUndecided(
  candidates: Candidate[],
  decisions: Record<string, Decision>,
  afterId: string,
): string | null {
  const n = candidates.length;
  const startIndex = candidates.findIndex((c) => c.id === afterId);
  for (let offset = 1; offset <= n; offset++) {
    const candidate = candidates[(startIndex + offset) % n];
    if (!decisions[candidate.id]) return candidate.id;
  }
  return null;
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path d="M15 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Tailwind classes for an inline highlighted chunk, keyed by its current decision state. */
function markClasses(decision: Decision | undefined): string {
  const base = "candidate-mark rounded px-0.5 py-0.5 font-medium transition-colors";
  if (decision === "keep") return `${base} bg-kept-bg text-kept-fg`;
  if (decision === "discard") return `${base} bg-discard-bg text-discard-fg line-through decoration-2`;
  return `${base} bg-amber-bg text-amber-fg underline decoration-2 decoration-amber-border underline-offset-4`;
}

/** Tailwind classes for a pill-shaped "también encontradas" chip, keyed by decision state. */
function chipClasses(decision: Decision | undefined): string {
  const base = "candidate-mark inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium";
  if (decision === "keep") return `${base} border-kept-border bg-kept-bg text-kept-fg`;
  if (decision === "discard") return `${base} border-discard-border bg-discard-bg text-discard-fg line-through`;
  return `${base} border-amber-border bg-amber-bg text-amber-fg`;
}

export function ReadClient({ contentId, title, text, initialExtraction, initialDecisions }: ReadClientProps) {
  const router = useRouter();
  // Decides sheet vs. panel mounting (not just CSS visibility) — see
  // `useMediaQuery`'s doc comment. SSR/first paint always renders the
  // mobile sheet branch; this flips to the desktop panel branch after
  // mount on a `lg:` viewport.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [extraction, setExtraction] = useState(initialExtraction);
  const [decisions, setDecisions] = useState(initialDecisions);
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedExtractRef = useRef(false);

  // Fire-and-forget: record that a read session started on this content.
  useEffect(() => {
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface: "read", contentId }),
    }).catch(() => {});
  }, [contentId]);

  const runExtract = useCallback(() => {
    setExtracting(true);
    setError(null);
    fetch(`/api/content/${contentId}/extract`, { method: "POST" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (!res.ok) {
          const message = typeof body.error === "string" ? body.error : "No se pudo extraer el contenido.";
          throw new Error(message);
        }
        return body as { extraction: StoredExtraction; cached: boolean };
      })
      .then((body) => setExtraction(body.extraction))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setExtracting(false));
  }, [contentId]);

  useEffect(() => {
    if (extraction || startedExtractRef.current) return;
    startedExtractRef.current = true;
    runExtract();
  }, [extraction, runExtract]);

  const candidates = useMemo(() => extraction?.result.candidates ?? [], [extraction]);

  const anchorResult = useMemo(() => {
    if (!extraction) return null;
    return anchorCandidates(text, extraction.result.candidates);
  }, [text, extraction]);

  const paragraphs = useMemo(() => {
    if (!anchorResult) return [];
    return buildParagraphSegments(text, anchorResult.ranges);
  }, [text, anchorResult]);

  const unanchoredCandidates = useMemo(() => {
    if (!anchorResult) return [];
    const ids = new Set(anchorResult.unanchored);
    return candidates.filter((c) => ids.has(c.id));
  }, [anchorResult, candidates]);

  const activeCandidate = candidates.find((c) => c.id === activeCandidateId) ?? null;

  function handleDecide(action: Decision) {
    if (!activeCandidateId) return;
    const decidedId = activeCandidateId;
    const nextDecisions = { ...decisions, [decidedId]: action };
    setDecisions(nextDecisions);
    setActiveCandidateId(null);

    fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentId, candidateId: decidedId, action }),
    })
      .then((res) => {
        // 409 already_decided is treated as success — the decision already
        // exists server-side, which is exactly the state we optimistically set.
        if (!res.ok && res.status !== 409) {
          console.error(`POST /api/decisions failed with ${res.status}`);
        }
      })
      .catch((err) => console.error("POST /api/decisions failed", err));

    window.setTimeout(() => {
      const next = findNextUndecided(candidates, nextDecisions, decidedId);
      if (next) setActiveCandidateId(next);
    }, 250);
  }

  const total = candidates.length;
  const decidedCount = candidates.filter((c) => decisions[c.id]).length;
  const allDecided = total > 0 && decidedCount === total;
  const keptCount = Object.values(decisions).filter((d) => d === "keep").length;
  const discardedCount = Object.values(decisions).filter((d) => d === "discard").length;

  if (!extraction) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-8 text-center">
        <h1 className="text-lg font-semibold text-ink">{title ?? "Artículo"}</h1>
        {error ? (
          <>
            <p className="text-sm text-danger-fg">{error}</p>
            <button
              type="button"
              onClick={runExtract}
              className="flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
            >
              Reintentar
            </button>
          </>
        ) : (
          <>
            <div className="flex gap-1.5" aria-hidden="true">
              <span className="dot-pulse h-2.5 w-2.5 rounded-full bg-accent" style={{ animationDelay: "0ms" }} />
              <span className="dot-pulse h-2.5 w-2.5 rounded-full bg-accent" style={{ animationDelay: "160ms" }} />
              <span className="dot-pulse h-2.5 w-2.5 rounded-full bg-accent" style={{ animationDelay: "320ms" }} />
            </div>
            <p className="text-sm text-ink-muted">
              {extracting ? "Extrayendo lo que vale la pena aprender…" : "Preparando…"}
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-paper/95 px-2 py-2 backdrop-blur lg:px-6 lg:py-3">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Volver"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full active:bg-line/40"
        >
          <ChevronLeftIcon />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink lg:text-base">{title ?? "Artículo"}</h1>
        <span
          data-testid="decision-counter"
          className="mr-1 shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-strong"
        >
          {allDecided ? "¡Listo!" : `${decidedCount}/${total}`}
        </span>
      </header>

      <main className="flex-1 px-5 pb-28 pt-6 lg:flex lg:items-start lg:gap-10 lg:px-10 lg:pb-16 lg:pt-10">
        <div className="lg:min-w-0 lg:flex-1">
          <article className="mx-auto max-w-[65ch] text-[17px] leading-[1.7] text-ink lg:mx-0 lg:max-w-[72ch]">
            {paragraphs.map((segments, i) => (
              <p key={i} className="mb-5">
                {segments.map((seg, j) =>
                  seg.kind === "text" ? (
                    <span key={j}>{seg.text}</span>
                  ) : (
                    <button
                      key={j}
                      type="button"
                      data-testid="candidate-mark"
                      data-state={decisions[seg.candidateId] ?? "undecided"}
                      data-candidate-id={seg.candidateId}
                      className={markClasses(decisions[seg.candidateId])}
                      onClick={() => setActiveCandidateId(seg.candidateId)}
                    >
                      {seg.text}
                    </button>
                  ),
                )}
              </p>
            ))}
          </article>

          {unanchoredCandidates.length > 0 && (
            <section className="mx-auto mt-8 max-w-[65ch] border-t border-line pt-6 lg:mx-0 lg:max-w-[72ch]">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                También encontradas
              </h2>
              <div className="flex flex-wrap gap-2">
                {unanchoredCandidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={chipClasses(decisions[c.id])}
                    onClick={() => setActiveCandidateId(c.id)}
                  >
                    {c.chunk}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/*
          Desktop-only right panel — mounted (not just CSS-hidden) only once
          `isDesktop` flips true post-mount, matching the mobile sheet's own
          `!isDesktop` gate below. `lg:sticky` pins it under the sticky
          header as the article scrolls; content is the same
          `CandidateDetail` the mobile sheet renders, without `onClose` (see
          that component's doc comment for what that changes).
        */}
        {isDesktop && (
          <aside
            data-testid="candidate-panel"
            className="lg:sticky lg:top-20 lg:block lg:w-[360px] lg:shrink-0"
          >
            <div className="rounded-2xl border border-line bg-paper-elevated p-5 shadow-sm">
              {activeCandidate ? (
                <CandidateDetail
                  candidate={activeCandidate}
                  decision={decisions[activeCandidate.id]}
                  onDecide={handleDecide}
                />
              ) : (
                <EmptyPanel decidedCount={decidedCount} total={total} keptCount={keptCount} discardedCount={discardedCount} />
              )}
            </div>
          </aside>
        )}
      </main>

      {!isDesktop && activeCandidate && (
        <CandidateSheet
          candidate={activeCandidate}
          decision={decisions[activeCandidate.id]}
          onClose={() => setActiveCandidateId(null)}
          onDecide={handleDecide}
        />
      )}
    </div>
  );
}

/** "1 guardada" vs "2 guardadas" — Spanish plural agreement on the count noun. */
function agree(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** Desktop panel's resting state: no candidate selected — a quiet hint plus a progress summary. */
function EmptyPanel({
  decidedCount,
  total,
  keptCount,
  discardedCount,
}: {
  decidedCount: number;
  total: number;
  keptCount: number;
  discardedCount: number;
}) {
  return (
    <div data-testid="candidate-panel-empty" className="flex flex-col items-center gap-3 py-6 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M5 5.5A1.5 1.5 0 0 1 6.5 4h9.17a1.5 1.5 0 0 1 1.06.44l2.83 2.83c.28.28.44.66.44 1.06V18.5A1.5 1.5 0 0 1 18.5 20h-12A1.5 1.5 0 0 1 5 18.5v-13Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9 9.5h6M9 13h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm text-ink-muted">Toca una frase resaltada</p>
      <p className="text-xs text-ink-muted">
        {decidedCount}/{total} · {keptCount} {agree(keptCount, "guardada", "guardadas")} ·{" "}
        {discardedCount} {agree(discardedCount, "descartada", "descartadas")}
      </p>
    </div>
  );
}
