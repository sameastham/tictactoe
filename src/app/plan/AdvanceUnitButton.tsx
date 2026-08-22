"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MASTERY_BAND_CHIP_CLASSES, MASTERY_BAND_LABELS } from "@/lib/labels";
import type { MasteryBand } from "@/lib/taxonomy";

interface WeakConstruction {
  chunk: string;
  band: MasteryBand | null;
}

interface AdvanceUnitButtonProps {
  /** The unit to advance to, or null when the current unit is the last unit of the last level — nothing left to advance to. */
  nextUnit: { level: string; unit: string } | null;
  nextUnitTitle: string | null;
  /** The current unit's not-yet-"en_progreso"/"solido" constructions, shown in the confirm dialog. */
  weak: WeakConstruction[];
}

/**
 * "Avanzar a la siguiente unidad": opens a confirm dialog naming what's
 * still weak in the current unit, then POSTs the advance and refreshes the
 * page so the server component re-renders with the new active unit. When
 * there's no next unit (last unit of the last level), renders a "Nivel
 * completado" state instead of a button — same sheet/scrim modal idiom as
 * `CandidateSheet`.
 */
export function AdvanceUnitButton({ nextUnit, nextUnitTitle, weak }: AdvanceUnitButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!nextUnit) {
    return (
      <div
        data-testid="level-completed-badge"
        className="rounded-xl border border-accent-strong bg-accent-soft px-4 py-3 text-center text-sm font-semibold text-accent-strong"
      >
        🎉 Nivel completado
      </div>
    );
  }

  async function confirmAdvance() {
    if (pending || !nextUnit) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/syllabus/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: nextUnit.level, unit: nextUnit.unit }),
      });
      if (!res.ok) {
        setError("No se pudo avanzar. Intenta de nuevo.");
        setPending(false);
        return;
      }
      setOpen(false);
      setPending(false);
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="advance-unit-button"
        onClick={() => setOpen(true)}
        className="h-12 w-full rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90"
      >
        Avanzar a la siguiente unidad
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <div className="scrim absolute inset-0 bg-black/45" onClick={() => !pending && setOpen(false)} />

          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
            <div
              data-testid="advance-confirm-dialog"
              className="sheet-panel pointer-events-auto flex max-h-[85dvh] w-full max-w-md flex-col overflow-y-auto rounded-t-3xl border-t border-line bg-paper-elevated px-5 pt-2.5 shadow-2xl"
              style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
              role="dialog"
              aria-modal="true"
            >
              <div className="mx-auto mb-4 h-1.5 w-10 shrink-0 rounded-full bg-line" />

              <h2 className="text-lg font-semibold leading-snug text-ink">¿Avanzar a la siguiente unidad?</h2>
              {nextUnitTitle && <p className="mt-1 text-sm text-ink-muted">Siguiente: {nextUnitTitle}</p>}

              {weak.length > 0 ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    Todavía frágiles en esta unidad
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {weak.map((w) => (
                      <span
                        key={w.chunk}
                        data-testid="advance-weak-chip"
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${MASTERY_BAND_CHIP_CLASSES[w.band ?? "fragil"]}`}
                      >
                        {w.chunk}
                        <span className="opacity-70">· {MASTERY_BAND_LABELS[w.band ?? "fragil"]}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-ink-muted">Todas tus construcciones van en progreso o sólidas.</p>
              )}

              {error && (
                <div className="mt-4 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
                  {error}
                </div>
              )}

              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  className="h-12 flex-1 rounded-full border border-line text-base font-semibold text-ink active:bg-line/40 disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  data-testid="advance-confirm-submit"
                  onClick={confirmAdvance}
                  disabled={pending}
                  className="h-12 flex-1 rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90 disabled:opacity-60"
                >
                  {pending ? "Avanzando…" : "Avanzar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
