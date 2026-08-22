/**
 * The Plan page (`/plan`): the learner's syllabus progress — level header,
 * the active unit's sections/constructions/tareas with evidence, and the
 * "Avanzar a la siguiente unidad" flow. Pure read/derive over
 * `src/server/syllabus/{config,progress}.ts`, same "surfaces are interfaces
 * over the log" posture as every other top-level page — see
 * CLAUDE.md's design doc §1.
 */
import Link from "next/link";
import { getDb, type Db } from "@/db";
import { getLevel, getNextUnit, getUnit } from "@/server/syllabus/config";
import { getActiveUnit, getUnitEvidence, type UnitEvidence } from "@/server/syllabus/progress";
import { MASTERY_BAND_CHIP_CLASSES, MASTERY_BAND_LABELS } from "@/lib/labels";
import type { MasteryBand } from "@/lib/taxonomy";
import { AdvanceUnitButton } from "@/app/plan/AdvanceUnitButton";

export const dynamic = "force-dynamic";

const PROMPT_PREVIEW_LENGTH = 90;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function bandOf(band: MasteryBand | null): MasteryBand {
  return band ?? "fragil";
}

function evidenceFooter(evidence: UnitEvidence): string {
  const solidCount = evidence.constructions.filter((c) => c.band === "en_progreso" || c.band === "solido").length;
  const writtenTareas = evidence.tareas.filter((t) => t.writingsCount > 0).length;
  return `${solidCount} de ${evidence.constructions.length} construcciones en progreso o sólidas · ${writtenTareas} de ${evidence.tareas.length} tareas escritas`;
}

export default function PlanPage() {
  const db = getDb();
  const active = getActiveUnit(db);

  return (
    <div className="min-h-dvh">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-2xl font-bold tracking-tight">Plan</h1>
        <p className="mt-0.5 text-sm text-ink-muted">Tu plan de estudios</p>
      </header>

      <main className="flex flex-col gap-4 px-4 pb-28 pt-4">
        {active ? <ActivePlan db={db} level={active.level} unitId={active.unit} /> : <EmptyState />}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      data-testid="plan-empty-state"
      className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line px-6 py-16 text-center"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
          <path
            d="M4 5.5C4 4.67 4.67 4 5.5 4H11a2 2 0 0 1 2 2v13.5a1.5 1.5 0 0 0-1.5-1.5H4V5.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M20 5.5c0-.83-.67-1.5-1.5-1.5H13a2 2 0 0 0-2 2v13.5a1.5 1.5 0 0 1 1.5-1.5H20V5.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-ink">Tu plan de estudios vive aquí</h2>
      <p className="text-sm text-ink-muted">
        Copia los PDFs del libro a <code className="rounded bg-paper px-1 py-0.5 text-xs">data/books/</code> y corre
        <br />
        <code className="mt-1 inline-block rounded bg-paper px-1.5 py-1 text-xs">
          npm run ingest-book data/books/*.pdf --level dyh7
        </code>
      </p>
      <p className="text-xs text-ink-muted">Los niveles aparecen aquí automáticamente en cuanto los ingieras.</p>
    </div>
  );
}

function ActivePlan({ db, level, unitId }: { db: Db; level: string; unitId: string }) {
  const levelConfig = getLevel(level);
  const unitConfig = getUnit(level, unitId);
  const evidence = getUnitEvidence(db, level, unitId);
  if (!levelConfig || !unitConfig || !evidence) return <EmptyState />;

  const nextUnit = getNextUnit(level, unitId);
  const nextUnitTitle = nextUnit ? (getUnit(nextUnit.level, nextUnit.unit)?.title ?? null) : null;
  const weak = evidence.constructions
    .filter((c) => c.band === null || c.band === "fragil")
    .map((c) => ({ chunk: c.chunk, band: c.band }));

  const activeIndex = levelConfig.units.findIndex((u) => u.id === unitId);
  const otherUnits = levelConfig.units.filter((_, i) => i !== activeIndex);

  return (
    <>
      <section className="flex items-center gap-2">
        <h2 className="text-lg font-bold text-ink">{levelConfig.name}</h2>
        <span className="rounded-full bg-paper-elevated px-2.5 py-1 text-xs font-semibold text-ink-muted">
          {levelConfig.cefr}
        </span>
      </section>

      <section
        data-testid="active-unit-hero"
        data-unit-id={unitId}
        className="rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-accent-strong">
          Unidad activa {activeIndex + 1} de {levelConfig.units.length}
        </span>
        <h3 className="mt-1 text-xl font-bold leading-snug text-ink">{unitConfig.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{unitConfig.theme}</p>

        <SectionsList evidence={evidence} />
        <ConstructionChips evidence={evidence} />
        <TareaList level={level} unitId={unitId} evidence={evidence} />

        <p data-testid="unit-evidence-footer" className="mt-4 text-xs text-ink-muted">
          {evidenceFooter(evidence)}
        </p>

        <div className="mt-5">
          <AdvanceUnitButton nextUnit={nextUnit} nextUnitTitle={nextUnitTitle} weak={weak} />
        </div>
      </section>

      {otherUnits.length > 0 && (
        <section data-testid="other-units" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Otras unidades</h3>
          {otherUnits.map((unit) => {
            const unitIndex = levelConfig.units.findIndex((u) => u.id === unit.id);
            const done = unitIndex < activeIndex;
            return (
              <OtherUnitRow
                key={unit.id}
                db={db}
                level={level}
                unitId={unit.id}
                title={unit.title}
                done={done}
              />
            );
          })}
        </section>
      )}
    </>
  );
}

function SectionsList({ evidence }: { evidence: UnitEvidence }) {
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {evidence.sections.map((section) => (
        <li key={section.sectionId} data-testid="unit-section-row" data-section-id={section.sectionId}>
          {section.contentId ? (
            <Link
              href={`/read/${section.contentId}`}
              className="flex items-center justify-between gap-2 rounded-xl border border-line bg-paper px-3 py-2.5 text-sm active:bg-line/30"
            >
              <span className="text-ink">{section.title}</span>
              {section.candidateCount > 0 ? (
                <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-strong">
                  {section.decidedCount} de {section.candidateCount}
                </span>
              ) : (
                <span className="shrink-0 text-xs text-ink-muted">Sin extraer</span>
              )}
            </Link>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-sm text-ink-muted">
              <span>{section.title}</span>
              <span className="shrink-0 text-xs">No ingerida</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConstructionChips({ evidence }: { evidence: UnitEvidence }) {
  if (evidence.constructions.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Construcciones</h4>
      <div className="flex flex-wrap gap-2">
        {evidence.constructions.map((c) => {
          const band = bandOf(c.band);
          return (
            <span
              key={c.constructionId}
              data-testid="construction-chip"
              data-chunk={c.chunk}
              data-band={band}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${MASTERY_BAND_CHIP_CLASSES[band]}`}
            >
              {c.chunk}
              <span className="opacity-70">· {MASTERY_BAND_LABELS[band]}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TareaList({ level, unitId, evidence }: { level: string; unitId: string; evidence: UnitEvidence }) {
  if (evidence.tareas.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Tareas</h4>
      <ul className="flex flex-col gap-2">
        {evidence.tareas.map((tarea) => (
          <li
            key={tarea.tareaId}
            data-testid="tarea-row"
            data-tarea-id={tarea.tareaId}
            className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{truncate(tarea.prompt, PROMPT_PREVIEW_LENGTH)}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {tarea.writingsCount === 0
                  ? "Sin escribir"
                  : `${tarea.writingsCount} ${tarea.writingsCount === 1 ? "escrito" : "escritos"}`}
              </p>
            </div>
            <Link
              href={`/fix/write?tarea=${level}/${unitId}/${tarea.tareaId}`}
              data-testid="tarea-write-link"
              className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-sm font-semibold text-accent-fg active:opacity-90"
            >
              Escribir
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OtherUnitRow({
  db,
  level,
  unitId,
  title,
  done,
}: {
  db: Db;
  level: string;
  unitId: string;
  title: string;
  done: boolean;
}) {
  const summary = done ? evidenceFooter(getUnitEvidence(db, level, unitId)!) : null;
  return (
    <div
      data-testid="other-unit-row"
      data-unit-id={unitId}
      data-status={done ? "done" : "upcoming"}
      className={
        done
          ? "rounded-xl border border-line bg-paper px-3 py-2.5"
          : "rounded-xl border border-dashed border-line px-3 py-2.5 opacity-70"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{title}</span>
        {done ? (
          <span className="shrink-0 rounded-full bg-kept-bg px-2 py-0.5 text-[11px] font-semibold text-kept-fg">
            Completada
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-paper-elevated px-2 py-0.5 text-[11px] font-semibold text-ink-muted">
            Próxima
          </span>
        )}
      </div>
      {summary && <p className="mt-1 text-xs text-ink-muted">{summary}</p>}
    </div>
  );
}
