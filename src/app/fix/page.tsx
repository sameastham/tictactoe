import Link from "next/link";
import { getDb } from "@/db";
import { listWritings, type WritingRow } from "@/server/repo";
import { RUNG_CHIP_CLASSES, RUNG_LABELS } from "@/lib/labels";
import { RUNGS, type Rung } from "@/lib/taxonomy";
import { timeAgo } from "@/lib/time";

// Same reasoning as the home page: this list changes every time a writing is
// submitted or judged, so it must never be frozen into the build-time shell.
export const dynamic = "force-dynamic";

/** Falls back to the first 80 characters of the writing when there's no task line. */
function displayTitle(task: string | null, text: string): string {
  if (task && task.trim().length > 0) return task;
  const trimmed = text.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/** Counts judged sentences by rung, in ladder order. */
function rungCounts(row: WritingRow): Array<[Rung, number]> {
  if (!row.judgment) return [];
  const counts: Partial<Record<Rung, number>> = {};
  for (const sentence of row.judgment.sentences) {
    counts[sentence.rung] = (counts[sentence.rung] ?? 0) + 1;
  }
  return RUNGS.filter((r) => counts[r]).map((r) => [r, counts[r]!]);
}

export default function FixPage() {
  const db = getDb();
  const writings = listWritings(db, 20);

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between gap-3 px-4 pt-6 pb-2 lg:mx-auto lg:max-w-3xl lg:px-10 lg:pt-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Fix</h1>
          <p className="mt-0.5 text-sm text-ink-muted">Escribe y recibe tu veredicto</p>
        </div>
        <Link
          href="/fix/write"
          data-testid="fix-entry"
          className="flex h-11 shrink-0 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
        >
          Escribir
        </Link>
      </header>

      <main className="px-4 pb-28 pt-4 lg:mx-auto lg:max-w-3xl lg:px-10 lg:pb-16 lg:pt-2">
        {writings.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4" data-testid="writings-list">
            {writings.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/fix/${row.id}`}
                  className="block rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm transition-colors active:bg-line/30"
                >
                  <h2 className="line-clamp-2 text-base font-semibold leading-snug text-ink">
                    {displayTitle(row.task, row.text)}
                  </h2>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {row.judgment ? (
                      rungCounts(row).map(([rung, count]) => (
                        <span
                          key={rung}
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${RUNG_CHIP_CLASSES[rung]}`}
                        >
                          {count} {RUNG_LABELS[rung]}
                        </span>
                      ))
                    ) : (
                      <span className="rounded-full bg-amber-bg px-2.5 py-1 text-xs font-semibold text-amber-fg">
                        Sin calificar
                      </span>
                    )}
                    <span className="ml-auto text-xs text-ink-muted">{timeAgo(row.createdAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
          <path
            d="M14.5 5.5 18.5 9.5 8 20H4v-4L14.5 5.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M12.5 7.5 16.5 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm text-ink-muted">Aún no has escrito nada — practica lo que leíste</p>
      <Link
        href="/fix/write"
        className="mt-1 inline-flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
      >
        Escribir
      </Link>
    </div>
  );
}
