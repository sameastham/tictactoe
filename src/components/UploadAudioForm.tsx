"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "archivo" | "url";
type Phase = "idle" | "uploading" | "transcribing" | "transcribe-error";

/** Best-effort message for a failed POST /api/media (multipart) or transcribe call. */
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

/** Best-effort message for a failed POST /api/media (JSON/URL) call — same status codes, different copy. */
async function readUrlErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 422) {
    return typeof error === "string" && error.length > 0
      ? error
      : "No se pudo extraer audio de esa URL.";
  }
  if (res.status === 400) {
    return "Revisa la URL e intenta de nuevo.";
  }
  if (res.status === 502) {
    return typeof error === "string" && error.length > 0
      ? error
      : "No se pudo descargar ese video o podcast. Intenta de nuevo.";
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Algo salió mal. Intenta de nuevo.";
}

export function UploadAudioForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("archivo");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
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

  async function handleFileSubmit() {
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

  async function handleUrlSubmit() {
    if (!url.trim()) {
      setError("Ingresa una URL de YouTube o podcast.");
      return;
    }
    setError(null);
    setPhase("uploading");

    try {
      const res = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), ...(urlTitle.trim() ? { title: urlTitle.trim() } : {}) }),
      });
      if (!res.ok) {
        setError(await readUrlErrorMessage(res));
        setPhase("idle");
        return;
      }
      const data = (await res.json()) as { content: { id: string }; transcribed: boolean };
      contentIdRef.current = data.content.id;
      if (data.transcribed) {
        router.push(`/listen/${data.content.id}`);
        return;
      }
      await runTranscribe(data.content.id);
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPhase("idle");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === "uploading" || phase === "transcribing") return;
    if (mode === "archivo") {
      await handleFileSubmit();
    } else {
      await handleUrlSubmit();
    }
  }

  function handleRetryTranscribe() {
    if (contentIdRef.current) runTranscribe(contentIdRef.current);
  }

  const busy = phase === "uploading" || phase === "transcribing";

  return (
    <form onSubmit={handleSubmit} data-testid="upload-audio-form" className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-1 rounded-full bg-paper-elevated p-1 border border-line">
        <SegmentButton
          testId="listen-mode-archivo"
          active={mode === "archivo"}
          disabled={busy}
          onClick={() => {
            setMode("archivo");
            setError(null);
          }}
        >
          Archivo
        </SegmentButton>
        <SegmentButton
          testId="listen-mode-url"
          active={mode === "url"}
          disabled={busy}
          onClick={() => {
            setMode("url");
            setError(null);
          }}
        >
          URL
        </SegmentButton>
      </div>

      {mode === "archivo" ? (
        <>
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
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="media-url" className="text-sm font-medium text-ink">
              URL de YouTube o podcast
            </label>
            <input
              id="media-url"
              name="url"
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=…"
              data-testid="media-url-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
            <p className="text-xs text-ink-muted">
              YouTube o podcast — se usarán subtítulos humanos si existen; si no, se transcribirá el audio (puede
              tardar).
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="media-url-title" className="text-sm font-medium text-ink">
              Título <span className="text-ink-muted">(opcional)</span>
            </label>
            <input
              id="media-url-title"
              name="urlTitle"
              type="text"
              placeholder="Título del audio"
              data-testid="media-url-title-input"
              value={urlTitle}
              onChange={(e) => setUrlTitle(e.target.value)}
              disabled={busy}
              className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
          </div>
        </>
      )}

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
          {phase === "uploading"
            ? mode === "url"
              ? "Descargando…"
              : "Subiendo…"
            : phase === "transcribing"
              ? "Transcribiendo…"
              : mode === "url"
                ? "Agregar desde URL"
                : "Subir audio"}
        </button>
      )}
    </form>
  );
}

function SegmentButton({
  active,
  disabled,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={
        active
          ? "h-10 rounded-full bg-accent text-sm font-semibold text-accent-fg disabled:opacity-60"
          : "h-10 rounded-full text-sm font-medium text-ink-muted active:bg-line/40 disabled:opacity-60"
      }
    >
      {children}
    </button>
  );
}
