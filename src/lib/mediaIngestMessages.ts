/**
 * Shared, pure error-message readers for the Listen surface's media-ingestion
 * flows (file upload, URL ingest, and the transcribe step both can trigger).
 * Extracted out of `UploadAudioForm` so it and the Fuentes inline audio-ingest
 * row (`src/components/SourceDirectory.tsx`) never drift into subtly
 * different copy for the same API error — both call these, neither defines
 * its own version. Client-safe: no `fs`, no db.
 */

/** Best-effort message for a failed POST /api/media (multipart) or transcribe call. */
export async function readUploadErrorMessage(res: Response): Promise<string> {
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
export async function readMediaUrlErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  if (res.status === 422) {
    return typeof error === "string" && error.length > 0 ? error : "No se pudo extraer audio de esa URL.";
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
