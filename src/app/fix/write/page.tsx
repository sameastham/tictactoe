import Link from "next/link";
import { getDb } from "@/db";
import { FixComposer, type TareaPreset } from "@/components/FixComposer";
import { getItemsByIds } from "@/server/repo";
import { getUnit } from "@/server/syllabus/config";
import { getUnitEvidence, tareaTaskPrefix } from "@/server/syllabus/progress";

/**
 * Resolves `?tarea=<level>/<unit>/<tareaId>` into a `TareaPreset` for
 * `FixComposer`: the tarea's prompt plus its target construction items,
 * resolved via `getUnitEvidence` (which itself resolves constructions ->
 * items through `getItemsBySyllabusRef` — reused here rather than
 * re-derived, so there's exactly one place that mapping happens). Returns
 * null for a malformed param, an unknown level/unit/tarea, or one with no
 * resolvable target items — every case just falls back to the ordinary Fix
 * composer rather than erroring on a bad query string.
 */
function resolveTarea(ref: string): TareaPreset | null {
  const parts = ref.split("/");
  if (parts.length !== 3) return null;
  const [level, unit, tareaId] = parts;

  const unitConfig = getUnit(level, unit);
  const tarea = unitConfig?.tareas.find((t) => t.id === tareaId);
  if (!unitConfig || !tarea) return null;

  const db = getDb();
  const evidence = getUnitEvidence(db, level, unit);
  const itemIdByConstructionId = new Map((evidence?.constructions ?? []).map((c) => [c.constructionId, c.itemId]));
  const itemIds = tarea.targetConstructionIds
    .map((id) => itemIdByConstructionId.get(id))
    .filter((id): id is string => !!id);

  const items = getItemsByIds(db, itemIds).map((item) => ({
    id: item.id,
    chunk: item.chunk,
    register: item.register,
  }));

  return {
    // The exact convention getUnitEvidence's tarea-evidence lookup expects
    // (src/server/syllabus/progress.ts) — reused directly rather than
    // reassembled, so this can never drift out of sync with it.
    task: `${tareaTaskPrefix(level, unit, tareaId)} ${tarea.prompt}`,
    promptDisplay: tarea.prompt,
    items,
  };
}

export default async function FixWritePage({
  searchParams,
}: {
  searchParams: Promise<{ tarea?: string }>;
}) {
  const { tarea: tareaRef } = await searchParams;
  const tareaPreset = tareaRef ? resolveTarea(tareaRef) : null;

  return (
    <div className="min-h-dvh px-4 pb-28 pt-6 lg:mx-auto lg:max-w-3xl lg:px-10 lg:pt-10">
      <header className="mb-6 flex items-center gap-3">
        <Link
          href="/fix"
          aria-label="Volver"
          className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full active:bg-line/40"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
            <path
              d="M15 19l-7-7 7-7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
        <h1 className="text-xl font-bold tracking-tight">Escribir</h1>
      </header>

      <FixComposer tarea={tareaPreset ?? undefined} />
    </div>
  );
}
