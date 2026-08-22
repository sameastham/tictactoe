"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CURATED_SOURCES, urlBelongsToSource, type CuratedSource } from "@/lib/sources";
import { REGISTER_CHIP_CLASSES, REGISTER_LABELS, SOURCE_KIND_CHIP_CLASSES, SOURCE_KIND_LABELS } from "@/lib/labels";
import { readMediaUrlErrorMessage, readUploadErrorMessage } from "@/lib/mediaIngestMessages";

/**
 * Best-effort message for a failed POST /api/content {url} call — mirrors
 * the "url" branch of AddContentForm's `readErrorMessage`
 * (src/components/AddContentForm.tsx) so a lectura/pdf/mixto card shows the
 * same friendly copy the /add form does for the same API errors, without
 * pulling in that function's texto/pdf-upload branches this card never hits.
 */
async function readContentUrlErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 422) {
    return "No se pudo extraer un artículo legible de esa URL.";
  }
  if (res.status === 413) {
    return "Ese PDF pesa demasiado (máx. 20 MB).";
  }
  if (res.status === 400) {
    return "Revisa los datos e intenta de nuevo.";
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Algo salió mal. Intenta de nuevo.";
}

const WRONG_HOST_ERROR = "Esa URL no es de esta fuente — pégala en Agregar contenido si es de otro sitio.";

type CardPhase = "idle" | "pending";

/**
 * The Fuentes directory ("¿No sabes qué leer?"): a hand-curated list of
 * authentic Mexican sources (CURATED_SOURCES, src/lib/sources.ts). The app
 * never crawls or generates from these — each card just opens the source's
 * own site externally and offers an inline "paste a URL, we bring it in"
 * row that reuses the same ingestion endpoints the /add and /listen/add
 * forms already call.
 */
export function SourceDirectory() {
  return (
    <ul className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4" data-testid="source-list">
      {CURATED_SOURCES.map((source) => (
        <li key={source.id}>
          <SourceCard source={source} />
        </li>
      ))}
    </ul>
  );
}

function SourceCard({ source }: { source: CuratedSource }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<CardPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  /** lectura/pdf/mixto: POST /api/content {url}, then go read it — same call AddContentForm's URL mode makes. */
  async function ingestContentUrl(trimmed: string) {
    const res = await fetch("/api/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: trimmed }),
    });
    if (!res.ok) {
      setError(await readContentUrlErrorMessage(res));
      setPhase("idle");
      return;
    }
    const data = (await res.json()) as { content: { id: string } };
    router.push(`/read/${data.content.id}`);
  }

  /**
   * audio: mirrors UploadAudioForm's URL-mode flow (`handleUrlSubmit` +
   * `runTranscribe` in src/components/UploadAudioForm.tsx) — POST
   * /api/media as JSON, then if the response didn't already come back
   * transcribed (no human captions found), call the transcribe endpoint
   * before navigating. Kept as its own copy rather than a shared hook
   * because UploadAudioForm's phase machine (idle/uploading/transcribing/
   * transcribe-error, with a standalone retry button) is form-wide state
   * this single inline row doesn't need — but the error copy for each step
   * IS shared, see src/lib/mediaIngestMessages.ts.
   */
  async function ingestMediaUrl(trimmed: string) {
    const res = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: trimmed }),
    });
    if (!res.ok) {
      setError(await readMediaUrlErrorMessage(res));
      setPhase("idle");
      return;
    }
    const data = (await res.json()) as { content: { id: string }; transcribed: boolean };
    if (data.transcribed) {
      router.push(`/listen/${data.content.id}`);
      return;
    }
    const transcribeRes = await fetch(`/api/content/${data.content.id}/transcribe`, { method: "POST" });
    if (!transcribeRes.ok) {
      setError(await readUploadErrorMessage(transcribeRes));
      setPhase("idle");
      return;
    }
    router.push(`/listen/${data.content.id}`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === "pending") return;
    setError(null);

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Pega una URL primero.");
      return;
    }
    if (!urlBelongsToSource(trimmed, source)) {
      setError(WRONG_HOST_ERROR);
      return;
    }

    setPhase("pending");
    try {
      if (source.kind === "audio") {
        await ingestMediaUrl(trimmed);
      } else {
        await ingestContentUrl(trimmed);
      }
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPhase("idle");
    }
  }

  const pending = phase === "pending";

  return (
    <div
      data-testid="source-card"
      data-source-id={source.id}
      className="rounded-2xl border border-line bg-paper-elevated p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold leading-snug text-ink">{source.name}</h2>
        <span
          data-testid="source-kind-badge"
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${SOURCE_KIND_CHIP_CLASSES[source.kind]}`}
        >
          {SOURCE_KIND_LABELS[source.kind]}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {source.registers.map((register) => (
          <span
            key={register}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${REGISTER_CHIP_CLASSES[register]}`}
          >
            {REGISTER_LABELS[register]}
          </span>
        ))}
        {source.domains.map((domain) => (
          <span
            key={domain}
            className="rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-ink-muted"
          >
            {domain}
          </span>
        ))}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-ink-muted">{source.description}</p>

      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="source-open-site"
        className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-sm font-semibold text-ink active:bg-line/40"
      >
        Abrir sitio
        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
          <path
            d="M7 17 17 7M9 7h8v8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>

      <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            type="url"
            inputMode="url"
            placeholder={source.ingestHint}
            aria-label={`URL de ${source.name}`}
            data-testid="source-url-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={pending}
            className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper px-3 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          <button
            type="submit"
            disabled={pending}
            data-testid="source-ingest-submit"
            className="flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg active:opacity-90 disabled:opacity-60"
          >
            {pending && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
            )}
            {pending ? "Trayendo…" : "Traer"}
          </button>
        </div>
        {error && (
          <p
            data-testid="source-error"
            className="rounded-xl border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg"
          >
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
