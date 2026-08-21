"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "url" | "texto" | "pdf";

/** Best-effort message for a failed POST /api/content, matching the API's documented error shapes. */
async function readErrorMessage(res: Response, mode: Mode): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 422) {
    if (mode === "pdf") {
      const message = typeof error === "string" && error.length > 0 ? error : null;
      // extractPdfText already attempts OCR before giving up (src/server/pdf.ts)
      // — its own message says so ("...ni siquiera con OCR"). Fall back to a
      // generic phrasing only when the server didn't send one.
      return message ?? "Ese PDF no tiene texto extraíble, ni siquiera con reconocimiento óptico (OCR).";
    }
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

export function AddContentForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setNote(null);

    if (mode === "texto" && text.trim().length < 40) {
      setError("El texto debe tener al menos 40 caracteres.");
      return;
    }
    if (mode === "pdf" && !pdfFile) {
      setError("Selecciona un archivo PDF.");
      return;
    }

    setPending(true);
    try {
      let res: Response;
      if (mode === "pdf") {
        const formData = new FormData();
        formData.set("file", pdfFile!);
        if (title.trim()) formData.set("title", title.trim());
        res = await fetch("/api/content", { method: "POST", body: formData });
      } else {
        const body =
          mode === "url"
            ? { url: url.trim() }
            : { text: text.trim(), ...(title.trim() ? { title: title.trim() } : {}) };
        res = await fetch("/api/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        setError(await readErrorMessage(res, mode));
        setPending(false);
        return;
      }
      const data = (await res.json()) as { content: { id: string }; note?: string };
      if (data.note) {
        // Cheapest-honest truncation UX (src/server/pdf.ts's OCR PDF_OCR_MAX_PAGES
        // cap): show the note briefly before navigating away, rather than
        // silently dropping it or plumbing a one-off banner into the reader.
        setNote(data.note);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      router.push(`/read/${data.content.id}`);
    } catch {
      setError("No se pudo conectar con el servidor. Intenta de nuevo.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-1 rounded-full bg-paper-elevated p-1 border border-line">
        <SegmentButton active={mode === "url"} onClick={() => setMode("url")}>
          URL
        </SegmentButton>
        <SegmentButton active={mode === "texto"} onClick={() => setMode("texto")}>
          Texto
        </SegmentButton>
        <SegmentButton active={mode === "pdf"} onClick={() => setMode("pdf")}>
          PDF
        </SegmentButton>
      </div>

      {mode === "url" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="url" className="text-sm font-medium text-ink">
            Dirección del artículo
          </label>
          <input
            id="url"
            name="url"
            type="url"
            inputMode="url"
            required
            autoFocus
            placeholder="https://ejemplo.com/articulo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          <p className="text-xs text-ink-muted">Página o PDF.</p>
        </div>
      )}

      {mode === "texto" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="title" className="text-sm font-medium text-ink">
              Título <span className="text-ink-muted">(opcional)</span>
            </label>
            <input
              id="title"
              name="title"
              type="text"
              placeholder="Título del texto"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="text" className="text-sm font-medium text-ink">
              Texto
            </label>
            <textarea
              id="text"
              name="text"
              required
              autoFocus
              placeholder="Pega aquí el texto en español…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-48 rounded-xl border border-line bg-paper-elevated px-4 py-3 text-base leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
          </div>
        </div>
      )}

      {mode === "pdf" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pdf-title" className="text-sm font-medium text-ink">
              Título <span className="text-ink-muted">(opcional)</span>
            </label>
            <input
              id="pdf-title"
              name="pdf-title"
              type="text"
              placeholder="Título del documento"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-12 rounded-xl border border-line bg-paper-elevated px-4 text-base text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pdf-file" className="text-sm font-medium text-ink">
              Archivo PDF
            </label>
            <input
              id="pdf-file"
              name="pdf-file"
              type="file"
              accept="application/pdf"
              onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
              className="rounded-xl border border-line bg-paper-elevated px-4 py-3 text-base text-ink outline-none file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-accent-fg focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
            <p className="text-xs text-ink-muted">
              Se extraerá el texto del PDF. Si es un escaneo (sin texto ya incrustado), se usará
              reconocimiento óptico (OCR) — tarda más, hasta un par de minutos.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      {note && (
        <div className="rounded-xl border border-line bg-paper-elevated px-4 py-3 text-sm text-ink-muted">
          {note}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="flex h-12 items-center justify-center gap-2 rounded-full bg-accent text-base font-semibold text-accent-fg transition-opacity active:opacity-90 disabled:opacity-60"
      >
        {pending && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
        )}
        {pending
          ? mode === "pdf"
            ? "Extrayendo texto… (los escaneos tardan más, hasta un par de minutos)"
            : "Agregando…"
          : "Agregar contenido"}
      </button>
    </form>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
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
