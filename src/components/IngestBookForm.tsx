"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IngestReport } from "@/lib/contracts";

/** One syllabus level as the ingest form needs to know it — see `isLevelIngested` in `src/server/syllabus/progress.ts`. */
export type IngestLevelOption = { id: string; name: string; ingested: boolean };

const MAX_FILES = 4;
const MAX_FILE_MB = 25;
const MAX_TOTAL_MB = 60;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Best-effort message for a failed POST /api/syllabus/ingest, matching the route's documented error shapes. */
async function readIngestErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 422) {
    return typeof error === "string" && error.length > 0 ? error : "Ese PDF no corresponde a este nivel.";
  }
  if (res.status === 413) {
    return `Los PDFs pesan demasiado (máx. ${MAX_FILE_MB} MB cada uno, ${MAX_TOTAL_MB} MB en total).`;
  }
  if (error === "unsupported_media_type") {
    return "Solo se aceptan archivos PDF.";
  }
  if (error === "missing_files") {
    return "Selecciona uno o más PDFs del libro.";
  }
  if (error === "too_many_files") {
    return `Selecciona hasta ${MAX_FILES} PDFs.`;
  }
  if (error === "missing_level" || error === "unknown_level") {
    return "Selecciona un nivel válido.";
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Algo salió mal. Intenta de nuevo.";
}

interface IngestBookFormProps {
  levels: IngestLevelOption[];
  /** Preselect a level, e.g. from the "Niveles" block's per-level "Ingerir"/"Reingerir" affordance. */
  preselectedLevelId?: string;
  /** Called after "Ver plan" is clicked and the page has been refreshed — lets an inline (Niveles-block) caller also collapse itself. */
  onViewPlan?: () => void;
}

/**
 * The Plan page's UI-driven book ingestion form: pick a configured syllabus
 * level, attach its PDF part(s), and run the same `ingestBook` pipeline
 * `npm run ingest-book` uses (`POST /api/syllabus/ingest`). Renders the
 * returned per-unit report inline on success, with a "Ver plan" button that
 * refreshes the page into the active state.
 */
export function IngestBookForm({ levels, preselectedLevelId, onViewPlan }: IngestBookFormProps) {
  const router = useRouter();
  const [levelId, setLevelId] = useState(preselectedLevelId ?? levels[0]?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<IngestReport | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);

    if (!levelId) {
      setError("Selecciona un nivel.");
      return;
    }
    if (files.length === 0) {
      setError("Selecciona uno o más PDFs del libro.");
      return;
    }

    setPending(true);
    const formData = new FormData();
    formData.set("level", levelId);
    for (const file of files) formData.append("files", file);

    try {
      const res = await fetch("/api/syllabus/ingest", { method: "POST", body: formData });
      if (!res.ok) {
        setError(await readIngestErrorMessage(res));
        setPending(false);
        return;
      }
      const data = (await res.json()) as { report: IngestReport };
      setReport(data.report);
      setPending(false);
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPending(false);
    }
  }

  if (report) {
    return (
      <IngestReportView
        report={report}
        onViewPlan={() => {
          router.refresh();
          onViewPlan?.();
        }}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} data-testid="ingest-book-form" className="flex flex-col gap-5 lg:max-w-xl">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ingest-level" className="text-sm font-medium text-ink">
          Nivel
        </label>
        <select
          id="ingest-level"
          name="level"
          data-testid="ingest-level-select"
          value={levelId}
          onChange={(e) => setLevelId(e.target.value)}
          disabled={pending}
          className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        >
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
              {level.ingested ? " — ya ingerido" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="ingest-files" className="text-sm font-medium text-ink">
          PDFs del libro
        </label>
        <input
          id="ingest-files"
          name="files"
          type="file"
          accept="application/pdf"
          multiple
          data-testid="ingest-files-input"
          disabled={pending}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="rounded-xl border border-line bg-paper-elevated px-3 py-3 text-sm text-ink outline-none file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-accent-fg focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
        <p className="text-xs text-ink-muted">
          1 a {MAX_FILES} PDFs, hasta {MAX_FILE_MB} MB cada uno ({MAX_TOTAL_MB} MB en total).
        </p>
        {files.length > 0 && (
          <ul data-testid="ingest-files-list" className="mt-1 flex flex-col gap-1">
            {files.map((file) => (
              <li key={file.name} className="text-xs text-ink-muted">
                {file.name} — {formatMb(file.size)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div
          data-testid="ingest-error"
          className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        data-testid="ingest-submit"
        disabled={pending}
        className="flex h-12 items-center justify-center gap-2 rounded-full bg-accent text-base font-semibold text-accent-fg transition-opacity active:opacity-90 disabled:opacity-60"
      >
        {pending && (
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
        )}
        {pending ? "Extrayendo y organizando el libro… puede tardar un momento" : "Ingerir libro"}
      </button>
    </form>
  );
}

function IngestReportView({ report, onViewPlan }: { report: IngestReport; onViewPlan: () => void }) {
  return (
    <div data-testid="ingest-report" className="flex flex-col gap-4 lg:max-w-xl">
      <ul className="flex flex-col gap-2">
        {report.units.map((unit) => {
          const unfound = unit.constructions.filter((c) => c.status === "unfound").length;
          return (
            <li
              key={unit.unitId}
              data-testid="ingest-report-unit-row"
              className="rounded-xl border border-line bg-paper px-3 py-2.5"
            >
              <p className="text-sm font-semibold text-ink">{unit.title}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {unit.sections.length} {unit.sections.length === 1 ? "sección" : "secciones"},{" "}
                {unit.constructions.length} {unit.constructions.length === 1 ? "construcción" : "construcciones"} (
                {unfound} sin encontrar)
              </p>
            </li>
          );
        })}
      </ul>

      {report.missingSections.length > 0 && (
        <p data-testid="ingest-report-missing" className="text-xs text-ink-muted">
          Secciones no encontradas en los PDFs: {report.missingSections.join(", ")}
        </p>
      )}

      <button
        type="button"
        data-testid="ingest-view-plan"
        onClick={onViewPlan}
        className="h-12 w-full rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90"
      >
        Ver plan
      </button>
    </div>
  );
}

/**
 * One level row in the Plan page's "Niveles" block: name + estado on the
 * left, an "Ingerir"/"Reingerir" toggle on the right that expands into
 * {@link IngestBookForm} (preselected to this level) spanning the row's full
 * width below, and collapses again once the learner reaches "Ver plan".
 */
export function LevelRow({
  level,
  levels,
  estado,
  estadoLabel,
}: {
  level: IngestLevelOption;
  levels: IngestLevelOption[];
  estado: "activo" | "ingerido" | "sin ingerir";
  estadoLabel: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      data-testid="level-row"
      data-level-id={level.id}
      data-estado={estado}
      className="rounded-xl border border-line bg-paper px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{level.name}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{estadoLabel}</p>
        </div>
        <button
          type="button"
          data-testid="level-ingest-toggle"
          data-level-id={level.id}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink active:bg-line/40"
        >
          {open ? "Cerrar" : level.ingested ? "Reingerir (no duplica)" : "Ingerir"}
        </button>
      </div>

      {open && (
        <div data-testid="level-ingest-panel" className="mt-3 rounded-xl border border-line bg-paper-elevated p-3">
          <IngestBookForm levels={levels} preselectedLevelId={level.id} onViewPlan={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
