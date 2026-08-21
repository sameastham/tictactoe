"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = "idle" | "uploading" | "transcribing" | "transcribe-error";

/** Best-effort message for a failed POST /api/media or transcribe call. */
async function readErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 413) {
    return "El archivo es demasiado grande (máx. 50 MB).";
  }
  if (error === "unsupported_media_type") {
    return "Formato no compatible. Usa wav, mp3, m4a u ogg.";
  }
  if (error === "missing_file") {
    return "Selecciona un archivo de audio.";
  }
  if (res.status === 502) {
    return typeof error === "string" && error.length > 0 ? error : "No se pudo transcribir el audio.";
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Algo salió mal. Intenta de nuevo.";
}

export function UploadAudioForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // The upload survives a failed transcribe — kept out of state so a retry
  // doesn't need to re-derive it from anywhere else.
  const contentIdRef = useRef<string | null>(null);

  async function runTranscribe(contentId: string) {
    setPhase("transcribing");
    setError(null);
    try {
      const res = await fetch(`/api/content/${contentId}/transcribe`, { method: "POST" });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        setPhase("transcribe-error");
        return;
      }
      router.push(`/listen/${contentId}`);
    } catch {
      setError("No se pudo conectar con el servidor.");
      setPhase("transcribe-error");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === "uploading" || phase === "transcribing") return;
    if (!file) {
      setError("Selecciona un archivo de audio.");
      return;
    }
    setError(null);
    setPhase("uploading");

    const formData = new FormData();
    formData.append("file", file);
    if (title.trim()) formData.append("title", title.trim());

    try {
      const res = await fetch("/api/media", { method: "POST", body: formData });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        setPhase("idle");
        return;
      }
      const data = (await res.json()) as { content: { id: string } };
      contentIdRef.current = data.content.id;
      await runTranscribe(data.content.id);
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPhase("idle");
    }
  }

  function handleRetryTranscribe() {
    if (contentIdRef.current) runTranscribe(contentIdRef.current);
  }

  const busy = phase === "uploading" || phase === "transcribing";

  return (
    <form onSubmit={handleSubmit} data-testid="upload-audio-form" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="audio-file" className="text-sm font-medium text-ink">
          Archivo de audio
        </label>
        <input
          id="audio-file"
          name="file"
          type="file"
          accept="audio/*"
          data-testid="audio-file-input"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-xl border border-line bg-paper-elevated px-3 py-3 text-sm text-ink outline-none file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-accent-fg focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
        <p className="text-xs text-ink-muted">wav, mp3, m4a u ogg — hasta 50 MB.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audio-title" className="text-sm font-medium text-ink">
          Título <span className="text-ink-muted">(opcional)</span>
        </label>
        <input
          id="audio-title"
          name="title"
          type="text"
          placeholder="Título del audio"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </div>

      {phase === "transcribing" && (
        <div
          data-testid="transcribing-status"
          className="flex items-center gap-3 rounded-xl border border-line bg-paper-elevated px-4 py-3 text-sm text-ink-muted"
        >
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
          Transcribiendo… esto puede tardar varios minutos con audio real.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      {phase === "transcribe-error" ? (
        <button
          type="button"
          data-testid="retry-transcribe"
          onClick={handleRetryTranscribe}
          className="flex h-12 items-center justify-center rounded-full bg-accent text-base font-semibold text-accent-fg active:opacity-90"
        >
          Reintentar transcripción
        </button>
      ) : (
        <button
          type="submit"
          data-testid="upload-submit"
          disabled={busy}
          className="flex h-12 items-center justify-center gap-2 rounded-full bg-accent text-base font-semibold text-accent-fg transition-opacity active:opacity-90 disabled:opacity-60"
        >
          {busy && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
          )}
          {phase === "uploading" ? "Subiendo…" : phase === "transcribing" ? "Transcribiendo…" : "Subir audio"}
        </button>
      )}
    </form>
  );
}
