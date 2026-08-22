import Link from "next/link";
import { getDb } from "@/db";
import { listSessionsBySurface } from "@/server/repo";
import { timeAgo } from "@/lib/time";
import { StartTalkButton } from "@/components/StartTalkButton";

// Same reasoning as the Fix/Listen lists: this list changes every time a
// Talk session is started or ended, so it must never be frozen into the
// build-time static shell.
export const dynamic = "force-dynamic";

/** mm:ss from a whole-second duration, or null when the session hasn't ended yet. */
function formatDuration(durationS: number | null): string | null {
  if (durationS === null) return null;
  const minutes = Math.floor(durationS / 60);
  const seconds = durationS % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function displayTopic(topic: string | null): string {
  if (!topic || topic.trim().length === 0) return "Plática sin tema";
  return topic.length > 90 ? `${topic.slice(0, 90)}…` : topic;
}

export default function TalkPage() {
  const db = getDb();
  const sessionRows = listSessionsBySurface(db, "talk", 20);

  return (
    <div className="min-h-dvh">
      <header className="px-4 pt-6 pb-2 lg:mx-auto lg:max-w-3xl lg:px-10 lg:pt-8">
        <h1 className="text-2xl font-bold tracking-tight">Hablar</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Conversación libre — sin correcciones a media plática</p>
      </header>

      <main className="px-4 pb-28 pt-4 lg:mx-auto lg:max-w-3xl lg:px-10 lg:pb-16 lg:pt-2">
        <StartTalkButton />

        {sessionRows.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="mt-6 flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4" data-testid="talk-sessions-list">
            {sessionRows.map((row) => {
              const duration = formatDuration(row.durationS);
              return (
                <li key={row.id}>
                  <Link
                    href={`/talk/${row.id}`}
                    data-testid="talk-session-card"
                    className="block rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm transition-colors active:bg-line/30"
                  >
                    <h2 className="line-clamp-2 text-base font-semibold leading-snug text-ink">
                      {displayTopic(row.topic)}
                    </h2>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {row.endedAt ? (
                        <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-strong">
                          Ver reporte
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-bg px-2.5 py-1 text-xs font-semibold text-amber-fg">
                          Sin terminar
                        </span>
                      )}
                      {duration && <Badge>{duration}</Badge>}
                      <span className="ml-auto text-xs text-ink-muted">{timeAgo(row.startedAt)}</span>
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

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-paper px-2.5 py-1 text-xs font-medium text-ink-muted">{children}</span>;
}

function EmptyState() {
  return (
    <div className="mt-6 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
          <path
            d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <p className="text-sm text-ink-muted">Aún no has platicado — empieza tu primera plática</p>
    </div>
  );
}
