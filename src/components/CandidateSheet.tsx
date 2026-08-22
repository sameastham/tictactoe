"use client";

import { useEffect } from "react";
import type { Candidate } from "@/lib/contracts";
import type { Decision } from "@/app/read/[id]/read-client";
import { CandidateDetail } from "@/components/CandidateDetail";

interface CandidateSheetProps {
  candidate: Candidate;
  decision: Decision | undefined;
  onClose: () => void;
  onDecide: (action: Decision) => void;
}

/**
 * Mobile bottom sheet chrome (scrim, slide-up panel, drag handle) around
 * the shared `CandidateDetail` body — see that component's doc comment for
 * why the content itself isn't duplicated here. Mounted only below `lg:`
 * (see `read-client.tsx`'s `useMediaQuery` gate) — the desktop-width
 * equivalent is a persistent sticky panel, not a modal, so it never mounts
 * this component at all.
 */
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

          <CandidateDetail candidate={candidate} decision={decision} onDecide={onDecide} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
