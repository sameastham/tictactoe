import Link from "next/link";
import { getDb, type Db } from "@/db";
import { listContent } from "@/server/repo";
import { SOURCE_LABELS } from "@/lib/labels";
import { timeAgo } from "@/lib/time";
import { ReviewQueue } from "@/components/ReviewQueue";
import { getLevel, getUnit } from "@/server/syllabus/config";
import { getActiveUnit, getUnitEvidence } from "@/server/syllabus/progress";

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
  const planCard = buildPlanCard(db);

  return (
    <div className="min-h-dvh">
      <header className="flex items-start justify-between gap-3 px-4 pt-6 pb-2 lg:mx-auto lg:max-w-5xl lg:px-10 lg:pt-8">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Español Coach</h1>
          <p className="mt-0.5 text-sm text-ink-muted">Tu entrenador de español mexicano</p>
        </div>
        <Link
          href="/add"
          data-testid="home-add-desktop"
          className="hidden shrink-0 rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg active:opacity-90 lg:flex lg:h-11 lg:items-center"
        >
          Agregar contenido
        </Link>
      </header>

      {/*
        At `lg:` Plan (left) and Repaso (right) sit side by side; below
        that `lg:`, this wrapper div carries no classes of its own, so
        `ReviewQueue`/`PlanCard` render as the exact same two siblings,
        with the exact same own `px-4 pt-3`, stacking exactly as before.
      */}
      <div className="lg:mx-auto lg:grid lg:max-w-5xl lg:grid-cols-2 lg:items-start lg:gap-5 lg:px-10 lg:pt-3">
        <ReviewQueue />
        {planCard && <PlanCard card={planCard} />}
      </div>

      <main className="px-4 pb-28 pt-4 lg:mx-auto lg:max-w-5xl lg:px-10 lg:pb-16 lg:pt-2">
        {contents.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4">
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

const PLAN_CARD_PROMPT_PREVIEW_LENGTH = 60;

type PlanCardData = {
  unitLabel: string;
  unitTitle: string;
  nextActionLabel: string;
  nextActionHref: string;
  evidenceLine: string;
};

function truncatePlanText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Derives the home page's compact Plan card: the active unit's headline plus
 * the first unfinished thing to do — an unread section, else an unwritten
 * tarea, else a nudge to review constructions on `/plan`. Null when there's
 * no active syllabus unit (nothing ingested yet), which hides the card
 * entirely.
 */
function buildPlanCard(db: Db): PlanCardData | null {
  const active = getActiveUnit(db);
  if (!active) return null;

  const level = getLevel(active.level);
  const unitConfig = getUnit(active.level, active.unit);
  const evidence = getUnitEvidence(db, active.level, active.unit);
  if (!level || !unitConfig || !evidence) return null;

  const unitIndex = level.units.findIndex((u) => u.id === active.unit);
  const unitLabel = unitIndex >= 0 ? `Unidad ${unitIndex + 1}` : "Unidad";

  const unreadSection = evidence.sections.find((s) => s.contentId !== null && s.decidedCount === 0);
  const unwrittenTarea = evidence.tareas.find((t) => t.writingsCount === 0);

  let nextActionLabel: string;
  let nextActionHref: string;
  if (unreadSection) {
    nextActionLabel = `Lee "${unreadSection.title}"`;
    nextActionHref = `/read/${unreadSection.contentId}`;
  } else if (unwrittenTarea) {
    nextActionLabel = `Escribe: ${truncatePlanText(unwrittenTarea.prompt, PLAN_CARD_PROMPT_PREVIEW_LENGTH)}`;
    nextActionHref = `/fix/write?tarea=${active.level}/${active.unit}/${unwrittenTarea.tareaId}`;
  } else {
    nextActionLabel = "Repasa tus construcciones";
    nextActionHref = "/plan";
  }

  const solidCount = evidence.constructions.filter((c) => c.band === "en_progreso" || c.band === "solido").length;
  const writtenTareas = evidence.tareas.filter((t) => t.writingsCount > 0).length;
  const evidenceLine = `${solidCount}/${evidence.constructions.length} construcciones · ${writtenTareas}/${evidence.tareas.length} tareas`;

  return { unitLabel, unitTitle: unitConfig.title, nextActionLabel, nextActionHref, evidenceLine };
}

/** `lg:order-1 lg:px-0 lg:pt-0`: mirrors `ReviewQueue`'s own note — reorders ahead of Repaso in the `lg:` grid without touching mobile DOM order (Plan already renders second on mobile, below Repaso). */
function PlanCard({ card }: { card: PlanCardData }) {
  return (
    <section className="px-4 pt-3 lg:order-1 lg:px-0 lg:pt-0">
      <Link
        href={card.nextActionHref}
        data-testid="home-plan-card"
        className="block rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm transition-colors active:bg-line/30"
      >
        <h2 className="text-sm font-semibold text-ink">
          Plan — {card.unitLabel}: {card.unitTitle}
        </h2>
        <p className="mt-1.5 text-[15px] leading-snug text-ink">{card.nextActionLabel}</p>
        <p className="mt-2 text-xs text-ink-muted">{card.evidenceLine}</p>
      </Link>
    </section>
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
      <Link href="/fuentes" data-testid="link-to-fuentes" className="text-sm font-semibold text-accent">
        ¿No sabes qué leer? Explora fuentes →
      </Link>
    </div>
  );
}

/**
 * The "+" FAB. Rendered inside a full-viewport-width fixed wrapper (escaping
 * the phone-column max-w-md ancestor) so its safe-area math is correct on
 * mobile, then re-centered to a max-w-md inner column so it lands at the
 * bottom-right of the *reading column* rather than the physical screen edge
 * on wide desktop viewports. The extra 4rem of bottom padding clears the
 * fixed `TabBar` (h-16 = 4rem) rendered underneath it in the root layout.
 *
 * `lg:hidden`: at `lg:` this is replaced by the plain "Agregar contenido"
 * button in the page header above — the FAB stays a mobile-only affordance.
 */
function FabWrapper() {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center lg:hidden"
      style={{ paddingBottom: "calc(4rem + env(safe-area-inset-bottom))" }}
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
