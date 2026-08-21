"use client";

import { useEffect } from "react";
import type { Candidate } from "@/lib/contracts";
import { REGISTER_CHIP_CLASSES, REGISTER_LABELS, TAXONOMY_LABELS } from "@/lib/labels";
import type { Decision } from "@/app/read/[id]/read-client";

interface CandidateSheetProps {
  candidate: Candidate;
  decision: Decision | undefined;
  onClose: () => void;
  onDecide: (action: Decision) => void;
}

/** Renders `sentence` with the first verbatim occurrence of `chunk` bolded. */
function OriginSentence({ sentence, chunk }: { sentence: string; chunk: string }) {
  const idx = sentence.indexOf(chunk);
  if (idx === -1) return <>{sentence}</>;
  return (
    <>
      {sentence.slice(0, idx)}
      <strong className="font-semibold text-ink">{chunk}</strong>
      {sentence.slice(idx + chunk.length)}
    </>
  );
}

export function CandidateSheet({ candidate, decision, onClose, onDecide }: CandidateSheetProps) {
  // Lock background scroll while the sheet is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50">
      <div className="scrim absolute inset-0 bg-black/45" onClick={onClose} />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
        <div
          data-testid="candidate-sheet"
          data-candidate-id={candidate.id}
          className="sheet-panel pointer-events-auto flex max-h-[85dvh] w-full max-w-md flex-col overflow-y-auto rounded-t-3xl border-t border-line bg-paper-elevated px-5 pt-2.5 shadow-2xl"
          style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          role="dialog"
          aria-modal="true"
        >
          <div className="mx-auto mb-4 h-1.5 w-10 shrink-0 rounded-full bg-line" />

          <h2 className="text-xl font-semibold leading-snug text-ink">{candidate.chunk}</h2>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span
              data-testid="candidate-register"
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${REGISTER_CHIP_CLASSES[candidate.register]}`}
            >
              {REGISTER_LABELS[candidate.register]}
            </span>
            {decision === "keep" && (
              <span className="rounded-full bg-kept-bg px-2.5 py-1 text-xs font-semibold text-kept-fg">
                Guardado
              </span>
            )}
            {decision === "discard" && (
              <span className="rounded-full bg-discard-bg px-2.5 py-1 text-xs font-semibold text-discard-fg">
                Descartado
              </span>
            )}
          </div>

          <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">
            <OriginSentence sentence={candidate.origin_sentence} chunk={candidate.chunk} />
          </p>

          <p data-testid="candidate-why" className="mt-4 text-sm leading-relaxed text-ink">
            {candidate.why}
          </p>

          {candidate.contrast_set && candidate.contrast_set.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Alternativas</h3>
              <div className="flex flex-wrap gap-2">
                {candidate.contrast_set.map((alt, i) => (
                  <span
                    key={alt}
                    className={
                      i === 0
                        ? "rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg"
                        : "rounded-full border border-line px-3 py-1.5 text-sm text-ink-muted"
                    }
                  >
                    {alt}
                  </span>
                ))}
              </div>
            </div>
          )}

          {candidate.taxonomy && candidate.taxonomy.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {candidate.taxonomy.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted"
                >
                  {TAXONOMY_LABELS[tag]}
                </span>
              ))}
            </div>
          )}

          <div className="mt-6 flex gap-3">
            {decision ? (
              <button
                type="button"
                onClick={onClose}
                className="h-12 flex-1 rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90"
              >
                Cerrar
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onDecide("discard")}
                  className="h-12 flex-1 rounded-full border border-line text-base font-semibold text-ink active:bg-line/40"
                >
                  Descartar
                </button>
                <button
                  type="button"
                  onClick={() => onDecide("keep")}
                  className="h-12 flex-1 rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90"
                >
                  Guardar
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
