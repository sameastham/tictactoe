/**
 * The learner mastery profile (`/profile`): "Qué te está frenando" (the
 * founding plan's "what is blocking C1 this month"), the weakest captured
 * items, and a full per-category band list — all derived read-only from
 * `src/server/mastery.ts`, same "surfaces are interfaces over the log"
 * posture as `/report`. Deliberately qualitative throughout: bands, counts,
 * and one concrete example per blocking category — never a percentage or
 * the underlying numeric score.
 */
import Link from "next/link";
import { getDb } from "@/db";
import { deriveBlocking, deriveCategoryMastery, deriveItemMastery, type BlockingCategory, type ItemMastery } from "@/server/mastery";
import {
  MASTERY_BAND_CHIP_CLASSES,
  MASTERY_BAND_LABELS,
  REGISTER_CHIP_CLASSES,
  REGISTER_LABELS,
  TAXONOMY_LABELS,
} from "@/lib/labels";
import type { MasteryBand } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";

/** "Ítems más frágiles" shows at most this many items — the weakest first, `deriveItemMastery` is already sorted that way. */
const WEAKEST_ITEMS_LIMIT = 8;
/** Signal dots cap — a fragile item's positive-signal count is shown, not spelled out as a number, up to this many. */
const SIGNAL_DOTS_MAX = 5;

export default function ProfilePage() {
  const db = getDb();
  const blocking = deriveBlocking(db);
  const weakestItems = deriveItemMastery(db).slice(0, WEAKEST_ITEMS_LIMIT);
  const categories = deriveCategoryMastery(db);

  return (
    <div className="min-h-dvh">
      <header className="px-4 pt-6 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Perfil</h1>
            <p className="mt-0.5 text-sm text-ink-muted">Lo que ya domina tu español, y lo que todavía no</p>
          </div>
          <Link href="/report" data-testid="link-to-report" className="shrink-0 pt-1 text-sm font-semibold text-accent">
            Reporte →
          </Link>
        </div>
      </header>

      <main className="flex flex-col gap-4 px-4 pb-28 pt-4">
        <Section title="Qué te está frenando" testId="profile-blocking">
          {blocking.length === 0 ? (
            <p className="text-sm text-ink-muted">Aún no hay suficientes datos — escribe y platica más.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {blocking.map((entry) => (
                <BlockingCard key={entry.tag} entry={entry} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Ítems más frágiles" testId="profile-weakest-items">
          {weakestItems.length === 0 ? (
            <p className="text-sm text-ink-muted">Todavía no has capturado ningún ítem.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {weakestItems.map((entry) => (
                <WeakItemRow key={entry.item.id} entry={entry} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Por categoría" testId="profile-categories">
          <ul className="flex flex-col gap-2.5">
            {categories.map((entry) => (
              <li
                key={entry.tag}
                data-testid="category-row"
                data-tag={entry.tag}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-ink">{TAXONOMY_LABELS[entry.tag]}</span>
                <span className="flex items-center gap-2">
                  {entry.trend && <TrendArrow trend={entry.trend} />}
                  <BandChip band={entry.band} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} className="rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-ink-muted">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function BandChip({ band }: { band: MasteryBand }) {
  return (
    <span
      data-testid="band-chip"
      data-band={band}
      className={`inline-block shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${MASTERY_BAND_CHIP_CLASSES[band]}`}
    >
      {MASTERY_BAND_LABELS[band]}
    </span>
  );
}

/**
 * Up/down/flat arrow for a category's error-count trend — same symbol/color
 * presentation as `/report`'s `TrendBadge` (an increase in errors is bad,
 * hence the danger color; a decrease is good, hence kept), reused here so
 * the two pages read as one consistent vocabulary rather than two.
 */
function TrendArrow({ trend }: { trend: "up" | "down" | "flat" }) {
  const symbol = trend === "up" ? "↑" : trend === "down" ? "↓" : "=";
  const cls = trend === "up" ? "text-danger-fg" : trend === "down" ? "text-kept-fg" : "text-ink-muted";
  return (
    <span data-testid="trend-arrow" className={`text-xs font-semibold ${cls}`}>
      {symbol}
    </span>
  );
}

function BlockingCard({ entry }: { entry: BlockingCategory }) {
  return (
    <div data-testid="blocking-card" data-tag={entry.tag} className="rounded-xl border border-line bg-paper p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">{TAXONOMY_LABELS[entry.tag]}</span>
        <BandChip band={entry.band} />
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        {entry.errorCount30d} {entry.errorCount30d === 1 ? "error" : "errores"} en 30 días
      </p>

      {entry.example && (
        <p data-testid="blocking-example" className="mt-2.5 text-sm">
          <span className="text-danger-fg line-through decoration-2">{entry.example.span}</span>
          <span className="px-1.5 text-ink-muted">→</span>
          <span className="font-semibold text-kept-fg">{entry.example.fix}</span>
        </p>
      )}

      {entry.weakestItems.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {entry.weakestItems.map((weak) => (
            <span
              key={weak.item.id}
              data-testid="blocking-weak-chunk"
              className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-strong"
            >
              {weak.item.chunk}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Subtle dot row: one dot per positive signal, up to `SIGNAL_DOTS_MAX` — deliberately not a number ("consistency, not a score"). */
function SignalDots({ positive }: { positive: number }) {
  const count = Math.min(positive, SIGNAL_DOTS_MAX);
  if (count === 0) return null;
  return (
    <span
      data-testid="signal-dots"
      data-count={count}
      className="flex items-center gap-0.5"
      aria-label={`${positive} ${positive === 1 ? "señal positiva" : "señales positivas"}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-ink-muted/50" />
      ))}
    </span>
  );
}

function WeakItemRow({ entry }: { entry: ItemMastery }) {
  return (
    <li
      data-testid="weak-item-row"
      data-item-id={entry.item.id}
      className="flex items-center justify-between gap-2 rounded-xl border border-line bg-paper p-3"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{entry.item.chunk}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REGISTER_CHIP_CLASSES[entry.item.register]}`}
          >
            {REGISTER_LABELS[entry.item.register]}
          </span>
          <SignalDots positive={entry.signals.positive} />
        </div>
      </div>
      <BandChip band={entry.band} />
    </li>
  );
}
