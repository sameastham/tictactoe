import Link from "next/link";
import { getDb } from "@/db";
import { listContent } from "@/server/repo";
import { timeAgo } from "@/lib/time";

// Same reasoning as the home and Fix pages: this list changes every time
// audio is uploaded or transcribed, so it must never be frozen into the
// build-time shell.
export const dynamic = "force-dynamic";

/** mm:ss from a millisecond duration. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function displayTitle(title: string | null): string {
  return title && title.trim().length > 0 ? title : "Audio sin título";
}

export default function ListenPage() {
  const db = getDb();
  // `listContent` has no type filter of its own — Listen only cares about
  // "audio" rows, so the article/paste rows from Read are dropped here.
  const audioContents = listContent(db, 50).filter((row) => row.type === "audio");

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between gap-3 px-4 pt-6 pb-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Escuchar</h1>
          <p className="mt-0.5 text-sm text-ink-muted">Dictado a partir de audio real</p>
        </div>
        <Link
          href="/listen/add"
          data-testid="listen-entry"
          className="flex h-11 shrink-0 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
        >
          Subir audio
        </Link>
      </header>

      <main className="px-4 pb-28 pt-4">
        {audioContents.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="listen-list">
            {audioContents.map((row) => {
              const lastWord = row.wordTimestamps?.at(-1);
              const duration = lastWord ? formatDuration(lastWord.endMs) : null;
              const transcribed = row.transcript !== null;
              return (
                <li key={row.id}>
                  <Link
                    href={`/listen/${row.id}`}
                    data-testid="listen-content-card"
                    className="block rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm transition-colors active:bg-line/30"
                  >
                    <h2 className="line-clamp-2 text-base font-semibold leading-snug text-ink">
                      {displayTitle(row.title)}
                    </h2>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {duration && <Badge>{duration}</Badge>}
                      <Badge accent={transcribed}>{transcribed ? "Transcrito" : "Sin transcribir"}</Badge>
                      <span className="ml-auto text-xs text-ink-muted">{timeAgo(row.createdAt)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
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
            d="M4.5 14V12a7.5 7.5 0 0 1 15 0v2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <rect x="3.25" y="13.25" width="4" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
          <rect x="16.75" y="13.25" width="4" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </div>
      <p className="text-sm text-ink-muted">Sin audio todavía — sube una grabación para practicar dictado</p>
      <Link
        href="/listen/add"
        className="mt-1 inline-flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90"
      >
        Subir audio
      </Link>
    </div>
  );
}
