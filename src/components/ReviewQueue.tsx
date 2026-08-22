"use client";

import { useEffect, useState } from "react";
import type { PriorityReason, ReviewRating } from "@/lib/contracts";
import type { Register } from "@/lib/taxonomy";

interface DueCardItem {
  id: string;
  chunk: string;
  register: Register;
  originSentence: string;
  contrastSet: string[] | null;
  due: string;
  priorityReason: PriorityReason;
}

interface QueueCardDto {
  item: DueCardItem;
  cloze: string;
  answer: string;
  contrast: string[] | null;
}

/** UI-only ratings the Repaso card offers — three-tap by design; "hard" is API-only (never shown here). */
type QueueRating = Extract<ReviewRating, "again" | "good" | "easy">;

/** Splits a cloze string on its "____" gap so the gap can get its own styling. */
function renderCloze(cloze: string) {
  const idx = cloze.indexOf("____");
  if (idx === -1) return <>{cloze}</>;
  return (
    <>
      {cloze.slice(0, idx)}
      <span
        data-testid="cloze-gap"
        className="mx-0.5 rounded-md bg-accent-soft px-2 py-0.5 font-semibold tracking-wide text-accent-strong"
      >
        ____
      </span>
      {cloze.slice(idx + 4)}
    </>
  );
}

/**
 * Home-screen "Repaso" section: a small, horizontally swipeable deck of due
 * items (max 10), each rendered as a cloze card in its origin sentence. This
 * is a scheduler surface, not a flashcard mode — every answer feeds straight
 * back into the item's FSRS schedule via `POST /api/reviews`.
 *
 * Fetches its own data client-side (the home route is already
 * `force-dynamic`; fetching here keeps the server component simple and the
 * queue fresh on every visit without threading state through the page).
 *
 * `lg:order-2 lg:px-0 lg:pt-0`: on the home page's `lg:` two-column top
 * region (Plan left, Repaso right), the grid parent already owns spacing —
 * this zeroes its own `px-4 pt-3` there and reorders after `PlanCard`
 * without touching DOM order (mobile keeps Repaso first, above Plan).
 * No-ops below `lg:`.
 */
export function ReviewQueue() {
  const [cards, setCards] = useState<QueueCardDto[] | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/queue")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { cards: QueueCardDto[] }) => setCards(data.cards))
      .catch(() => setCards([]));
  }, []);

  async function submitReview(itemId: string, rating: QueueRating) {
    if (pendingId) return;
    setPendingId(itemId);
    setLeavingIds((prev) => new Set(prev).add(itemId));

    try {
      await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, rating }),
      });
    } catch {
      // Best-effort: the card still leaves the local queue below so the UI
      // doesn't get stuck on a network hiccup — a failed write just means
      // this item's `reviewed` event never landed, so it'll still be due
      // (or due again sooner) the next time /api/queue is fetched.
    }

    window.setTimeout(() => {
      setCards((prev) => (prev ? prev.filter((c) => c.item.id !== itemId) : prev));
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
      setRevealedId((prev) => (prev === itemId ? null : prev));
      setPendingId((prev) => (prev === itemId ? null : prev));
    }, 200);
  }

  if (cards === null || cards.length === 0) return null;

  return (
    <section className="px-4 pt-3 lg:order-2 lg:px-0 lg:pt-0" data-testid="review-queue">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Repaso</h2>
      <div
        data-testid="review-queue-track"
        className="scroll-snap-track -mx-4 flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-4 pb-2"
        style={{ scrollbarWidth: "none" }}
      >
        {cards.map((card) => (
          <ReviewCard
            key={card.item.id}
            card={card}
            revealed={revealedId === card.item.id}
            leaving={leavingIds.has(card.item.id)}
            pending={pendingId === card.item.id}
            onReveal={() => setRevealedId(card.item.id)}
            onRate={(rating) => submitReview(card.item.id, rating)}
          />
        ))}
      </div>
    </section>
  );
}

function ReviewCard({
  card,
  revealed,
  leaving,
  pending,
  onReveal,
  onRate,
}: {
  card: QueueCardDto;
  revealed: boolean;
  leaving: boolean;
  pending: boolean;
  onReveal: () => void;
  onRate: (rating: QueueRating) => void;
}) {
  return (
    <div
      data-testid="review-card"
      data-item-id={card.item.id}
      data-revealed={revealed}
      className={
        "w-[82%] max-w-xs shrink-0 snap-center rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm" +
        (leaving ? " card-slide-away" : "")
      }
    >
      {!revealed ? (
        <button
          type="button"
          data-testid="review-card-prompt"
          onClick={onReveal}
          disabled={pending}
          className="block w-full text-left"
        >
          <p className="text-[15px] leading-relaxed text-ink">{renderCloze(card.cloze)}</p>
          <p className="mt-3 text-xs font-medium text-ink-muted">Toca para revelar</p>
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[15px] leading-relaxed text-ink-muted">{renderCloze(card.cloze)}</p>
          <p data-testid="review-card-answer" className="text-lg font-semibold text-accent-strong">
            {card.answer}
          </p>

          {card.contrast && card.contrast.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="review-card-contrast">
              {card.contrast.map((alt, i) => (
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
          )}

          <div className="mt-1 flex gap-2">
            <button
              type="button"
              data-testid="review-rate-again"
              onClick={() => onRate("again")}
              disabled={pending}
              className="h-11 flex-1 rounded-full border border-line text-sm font-semibold text-ink active:bg-line/40 disabled:opacity-60"
            >
              Otra vez
            </button>
            <button
              type="button"
              data-testid="review-rate-good"
              onClick={() => onRate("good")}
              disabled={pending}
              className="h-11 flex-1 rounded-full bg-accent text-sm font-semibold text-accent-fg active:opacity-90 disabled:opacity-60"
            >
              Bien
            </button>
            <button
              type="button"
              data-testid="review-rate-easy"
              onClick={() => onRate("easy")}
              disabled={pending}
              className="h-11 flex-1 rounded-full border border-accent-strong text-sm font-semibold text-accent-strong active:bg-accent-soft disabled:opacity-60"
            >
              Fácil
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
