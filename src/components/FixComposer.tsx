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

export function FixComposer() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("libre");
  const [text, setText] = useState("");
  const [items, setItems] = useState<RetoItem[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preselectedRef = useRef(false);

  // Reto's target-item chips: due items first (the scheduler's Fix-prompt
  // delivery preference), topped up with the most recent captures when the
  // learner doesn't have >= 3 due yet, so the panel never looks sparse for a
  // fresh learner. Due items are marked so their chip can show a due badge.
  useEffect(() => {
    async function load() {
      let due: RetoItem[] = [];
      try {
        const res = await fetch(`/api/items/due?limit=${RETO_CHIP_COUNT}`);
        if (res.ok) {
          const data = (await res.json()) as { items: DueItemDto[] };
          due = data.items.map((item) => ({ id: item.id, chunk: item.chunk, register: item.register, due: true }));
        }
      } catch {
        // fall through to recent-only below
      }

      let merged = due;
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
          // keep whatever due items we already have
        }
      }

      setItems(merged);
      if (!preselectedRef.current) {
        preselectedRef.current = true;
        setSelectedIds(new Set(merged.slice(0, PRESELECT_COUNT).map((item) => item.id)));
      }
    }
    load().catch(() => setItems([]));
  }, []);

  function toggleChip(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedChunks = (items ?? []).filter((item) => selectedIds.has(item.id)).map((item) => item.chunk);
  const taskPreview = buildTask(selectedChunks);

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
      body.task = taskPreview;
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
