"use client";

import type { Candidate } from "@/lib/contracts";
import { REGISTER_CHIP_CLASSES, REGISTER_LABELS, TAXONOMY_LABELS } from "@/lib/labels";
import type { Decision } from "@/app/read/[id]/read-client";

interface CandidateDetailProps {
  candidate: Candidate;
  decision: Decision | undefined;
  onDecide: (action: Decision) => void;
  /**
   * Present only for the mobile `CandidateSheet`, a dismissible modal: once
   * `decision` is set it swaps the Guardar/Descartar row for a single
   * "Cerrar" button. The desktop read panel (no `onClose` — it's a
   * persistent, non-modal surface embedded in the page, not something you
   * dismiss) renders no action row at all once decided: the decision badge
   * above already says so, and auto-advance moves the panel on to the next
   * undecided candidate on its own.
   */
  onClose?: () => void;
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

/**
 * The candidate detail body shared by the mobile `CandidateSheet` (a
 * scrim + slide-up bottom sheet) and the desktop `/read/[id]` right-hand
 * panel (a plain sticky card in normal flow). Renders only the inner
 * content — chunk, register chip, decision badge, origin sentence with the
 * chunk bolded, why, contrast pills, taxonomy tags, and the decide/close
 * action row — never the surrounding chrome, so the two callers can't drift
 * out of sync with each other.
 */
export function CandidateDetail({ candidate, decision, onDecide, onClose }: CandidateDetailProps) {
  return (
    <>
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

      {(!decision || onClose) && (
        <div className="mt-6 flex gap-3">
          {decision
            ? onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="h-12 flex-1 rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90"
                >
                  Cerrar
                </button>
              )
            : (
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
      )}
    </>
  );
}
