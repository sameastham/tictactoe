"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Register } from "@/lib/taxonomy";

type Mode = "libre" | "reto";

interface RecentItem {
  id: string;
  chunk: string;
  register: Register;
  createdAt: string;
}

interface DueItemDto {
  id: string;
  chunk: string;
  register: Register;
}

/** A Reto chip's source item, plus whether the scheduler currently has it due. */
interface RetoItem {
  id: string;
  chunk: string;
  register: Register;
  due: boolean;
}

/** Minimal shape read from `GET /api/syllabus`'s `evidence` — just enough to pull construction item ids. */
interface SyllabusEvidenceDto {
  constructions: { itemId: string | null }[];
}

interface ByIdsItem {
  id: string;
  chunk: string;
  register: Register;
}

/** One tarea's target item, resolved server-side (see `/fix/write`'s `resolveTarea`). */
export interface TareaTargetItem {
  id: string;
  chunk: string;
  register: Register;
}

/**
 * Preset passed by `/fix/write?tarea=<level>/<unit>/<tareaId>`: locks the
 * composer into Reto mode against one syllabus tarea instead of the usual
 * due/recent item pool. `task` is the exact string to submit (already
 * carrying the `syllabus:<level>/<unit>/<tareaId>:` prefix
 * `tareaTaskPrefix` — src/server/syllabus/progress.ts — expects for tarea
 * evidence); `promptDisplay` is the clean prompt text shown in the panel.
 */
export interface TareaPreset {
  task: string;
  promptDisplay: string;
  items: TareaTargetItem[];
}

const PRESELECT_COUNT = 3;
const RETO_CHIP_COUNT = 6;
const TOP_UP_THRESHOLD = 3;

/** Auto-composed task line for Reto mode: names the challenge and, when chunks are picked, what to use. */
function buildTask(chunks: string[]): string {
  if (chunks.length === 0) return "Escribe 5–8 frases sobre lo que leíste hoy.";
  return `Escribe 5–8 frases sobre lo que leíste hoy. Usa: ${chunks.join(", ")}.`;
}

/** Best-effort message for a failed POST /api/fix, matching the API's documented error shapes. */
async function readErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 502) {
    return typeof error === "string" && error.length > 0
      ? error
      : "El modelo no pudo calificar el texto. Intenta de nuevo.";
  }
  if (res.status === 400) {
    return "Revisa el texto e intenta de nuevo.";
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Algo salió mal. Intenta de nuevo.";
}

/** A tarea preset's target items, shaped as Reto chips (never "due" — the tarea assigns them, not the scheduler). */
function itemsFromTarea(tarea: TareaPreset): RetoItem[] {
  return tarea.items.map((item) => ({ ...item, due: false }));
}

export function FixComposer({ tarea }: { tarea?: TareaPreset } = {}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(tarea ? "reto" : "libre");
  const [text, setText] = useState("");
  // A tarea preset's items are known synchronously from props — set as the
  // initial state directly (no effect needed for that case, and no effect
  // may synchronously setState from data already available at render time).
  const [items, setItems] = useState<RetoItem[] | null>(() => (tarea ? itemsFromTarea(tarea) : null));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(tarea ? tarea.items.map((item) => item.id) : []),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preselectedRef = useRef(tarea !== undefined);

  // Reto's target-item chips. With a tarea preset, the panel is scoped to
  // exactly that tarea's target construction items (all preselected, set as
  // initial state above) — no due/recent/syllabus fetch at all. Otherwise:
  // due items first (the scheduler's Fix-prompt delivery preference), then
  // the active syllabus unit's construction items (if any), topped up with
  // the most recent captures when the learner still doesn't have >= 3
  // chips, so the panel never looks sparse for a fresh learner. Due items
  // are marked so their chip can show a due badge.
  useEffect(() => {
    if (tarea) return;

    async function load() {
      let due: RetoItem[] = [];
      try {
        const res = await fetch(`/api/items/due?limit=${RETO_CHIP_COUNT}`);
        if (res.ok) {
          const data = (await res.json()) as { items: DueItemDto[] };
          due = data.items.map((item) => ({ id: item.id, chunk: item.chunk, register: item.register, due: true }));
        }
      } catch {
        // fall through to the rest of the pool below
      }

      let merged = due;

      // Active syllabus unit's construction items join the pool next (still
      // ahead of the recent-items top-up) — see /fix/write §3 of the Plan
      // design.
      try {
        const res = await fetch("/api/syllabus");
        if (res.ok) {
          const data = (await res.json()) as { evidence: SyllabusEvidenceDto | null };
          const seen = new Set(merged.map((item) => item.id));
          const newIds = (data.evidence?.constructions ?? [])
            .map((c) => c.itemId)
            .filter((id): id is string => id !== null && !seen.has(id));
          if (newIds.length > 0) {
            const idsRes = await fetch(`/api/items/by-ids?ids=${newIds.join(",")}`);
            if (idsRes.ok) {
              const idsData = (await idsRes.json()) as { items: ByIdsItem[] };
              for (const item of idsData.items) {
                if (seen.has(item.id) || merged.length >= RETO_CHIP_COUNT) continue;
                seen.add(item.id);
                merged = [...merged, { id: item.id, chunk: item.chunk, register: item.register, due: false }];
              }
            }
          }
        }
      } catch {
        // syllabus items are a nice-to-have, not required
      }

      if (merged.length < TOP_UP_THRESHOLD) {
        try {
          const res = await fetch(`/api/items/recent?limit=${RETO_CHIP_COUNT}`);
          if (res.ok) {
            const data = (await res.json()) as { items: RecentItem[] };
            const seen = new Set(merged.map((item) => item.id));
            for (const item of data.items) {
              if (seen.has(item.id) || merged.length >= RETO_CHIP_COUNT) continue;
              seen.add(item.id);
              merged = [...merged, { id: item.id, chunk: item.chunk, register: item.register, due: false }];
            }
          }
        } catch {
          // keep whatever items we already have
        }
      }

      setItems(merged);
      if (!preselectedRef.current) {
        preselectedRef.current = true;
        setSelectedIds(new Set(merged.slice(0, PRESELECT_COUNT).map((item) => item.id)));
      }
    }
    load().catch(() => setItems([]));
  }, [tarea]);

  function toggleChip(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedChunks = (items ?? []).filter((item) => selectedIds.has(item.id)).map((item) => item.chunk);
  // A tarea's task is a fixed, assigned prompt — it doesn't get rebuilt from
  // whichever chips happen to be selected the way the generic Reto task does.
  const taskPreview = tarea ? tarea.promptDisplay : buildTask(selectedChunks);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError("Escribe algo primero.");
      return;
    }
    if (trimmed.length > 4000) {
      setError("El texto es demasiado largo (máx. 4000 caracteres).");
      return;
    }
    setError(null);

    const body: { text: string; task?: string; targetItemIds?: string[] } = { text: trimmed };
    if (mode === "reto") {
      // The submitted task string carries the "syllabus:<ref>:" prefix in
      // tarea mode (see TareaPreset's doc comment) — taskPreview only ever
      // shows the clean, prefix-free prompt.
      body.task = tarea ? tarea.task : taskPreview;
      body.targetItemIds = Array.from(selectedIds);
    }

    setPending(true);
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        setPending(false);
        return;
      }
      const data = (await res.json()) as { writingId: string };
      router.push(`/fix/${data.writingId}`);
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} data-testid="fix-composer" className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-1 rounded-full border border-line bg-paper-elevated p-1">
        <SegmentButton testId="mode-libre" active={mode === "libre"} onClick={() => setMode("libre")}>
          Libre
        </SegmentButton>
        <SegmentButton testId="mode-reto" active={mode === "reto"} onClick={() => setMode("reto")}>
          Reto
        </SegmentButton>
      </div>

      {mode === "reto" && (
        <RetoPanel items={items} selectedIds={selectedIds} onToggle={toggleChip} taskPreview={taskPreview} />
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="fix-text" className="text-sm font-medium text-ink">
          Tu texto
        </label>
        <textarea
          id="fix-text"
          name="text"
          data-testid="fix-textarea"
          required
          autoFocus
          placeholder="Escribe en español…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-40 rounded-xl border border-line bg-paper-elevated px-4 py-3 text-base leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </div>

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      <button
        type="submit"
        data-testid="fix-submit"
        disabled={pending}
        className="flex h-12 items-center justify-center gap-2 rounded-full bg-accent text-base font-semibold text-accent-fg transition-opacity active:opacity-90 disabled:opacity-60"
      >
        {pending && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
        )}
        {pending ? "Calificando…" : "Calificar"}
      </button>
    </form>
  );
}

function RetoPanel({
  items,
  selectedIds,
  onToggle,
  taskPreview,
}: {
  items: RetoItem[] | null;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  taskPreview: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Elige qué usar</h2>
        {items === null ? (
          <p className="text-sm text-ink-muted">Cargando…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Aún no tienes elementos guardados. Lee algo y guarda alguna expresión primero.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {items.map((item) => {
              const selected = selectedIds.has(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid="item-chip"
                  data-item-id={item.id}
                  data-selected={selected}
                  data-due={item.due}
                  onClick={() => onToggle(item.id)}
                  className={
                    selected
                      ? "inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg"
                      : "inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink-muted active:bg-line/30"
                  }
                >
                  {item.due && (
                    <span
                      data-testid="item-chip-due-dot"
                      aria-hidden="true"
                      className={
                        selected ? "h-1.5 w-1.5 rounded-full bg-accent-fg/70" : "h-1.5 w-1.5 rounded-full bg-accent"
                      }
                    />
                  )}
                  {item.chunk}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        data-testid="fix-task-preview"
        className="rounded-xl border border-line bg-paper-elevated px-4 py-3 text-sm text-ink"
      >
        <span className="font-semibold">Tu reto: </span>
        {taskPreview}
      </div>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={
        active
          ? "h-10 rounded-full bg-accent text-sm font-semibold text-accent-fg"
          : "h-10 rounded-full text-sm font-medium text-ink-muted active:bg-line/40"
      }
    >
      {children}
    </button>
  );
}
