import Link from "next/link";
import { getDb } from "@/db";
import { listContent } from "@/server/repo";
import { SOURCE_LABELS } from "@/lib/labels";
import { timeAgo } from "@/lib/time";

// This page reads the content list straight from sqlite (a synchronous,
// predictable read Next can't tell is per-request). Without forcing dynamic
// rendering it would be frozen into the build-time static shell and never
// show content added afterwards.
export const dynamic = "force-dynamic";

/** Falls back to the first 60 characters of the article body when there's no title. */
function displayTitle(title: string | null, text: string): string {
  if (title && title.trim().length > 0) return title;
  const trimmed = text.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

export default function Home() {
  const db = getDb();
  const contents = listContent(db, 20);

  return (
    <div className="min-h-dvh">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-2xl font-bold tracking-tight">Español Coach</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Tu entrenador de español mexicano</p>
      </header>

      <main className="px-4 pb-28 pt-4">
        {contents.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3">
            {contents.map((row) => {
              const total = row.candidateCount;
              const hasExtraction = row.extraction !== null;
              return (
                <li key={row.id}>
                  <Link
                    href={`/read/${row.id}`}
                    className="block rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm transition-colors active:bg-line/30"
                  >
                    <h2 className="line-clamp-2 text-base font-semibold leading-snug text-ink">
                      {displayTitle(row.title, row.text)}
                    </h2>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <Badge>{SOURCE_LABELS[row.source]}</Badge>
                      {row.difficulty && <Badge>{row.difficulty}</Badge>}
                      {hasExtraction && (
                        <Badge accent>
                          {row.decidedCount} de {total}
                        </Badge>
                      )}
                      <span className="ml-auto text-xs text-ink-muted">
                        {timeAgo(row.createdAt)}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <FabWrapper />
    </div>
  );
}

function Badge({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={
        accent
          ? "rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-strong"
          : "rounded-full bg-paper px-2.5 py-1 text-xs font-medium text-ink-muted"
      }
    >
      {children}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
          <path
            d="M5 4.5A1.5 1.5 0 0 1 6.5 3H15l4.5 4.5v12A1.5 1.5 0 0 1 18 21H6.5A1.5 1.5 0 0 1 5 19.5v-15Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M14.5 3v4.5H19" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M8.5 13h7M8.5 16.5h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm text-ink-muted">
        Sin contenido todavía — agrega tu primer artículo
      </p>
      <Link
        href="/add"
        className="mt-1 inline-flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
      >
        Agregar contenido
      </Link>
    </div>
  );
}

/**
 * The "+" FAB. Rendered inside a full-viewport-width fixed wrapper (escaping
 * the phone-column max-w-md ancestor) so its safe-area math is correct on
 * mobile, then re-centered to a max-w-md inner column so it lands at the
 * bottom-right of the *reading column* rather than the physical screen edge
 * on wide desktop viewports.
 */
function FabWrapper() {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="relative w-full max-w-md">
        <Link
          href="/add"
          aria-label="Agregar contenido"
          className="pointer-events-auto absolute bottom-5 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg shadow-black/20 transition-transform active:scale-95"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
