import Link from "next/link";
import { UploadAudioForm } from "@/components/UploadAudioForm";

export default function ListenAddPage() {
  return (
    <div className="min-h-dvh px-4 pb-28 pt-6">
      <header className="mb-6 flex items-center gap-3">
        <Link
          href="/listen"
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
        <h1 className="text-xl font-bold tracking-tight">Subir audio</h1>
      </header>

      <UploadAudioForm />

      <Link
        href="/fuentes"
        data-testid="link-to-fuentes"
        className="mt-6 block text-center text-sm font-semibold text-accent"
      >
        ¿No sabes qué leer? Explora fuentes →
      </Link>
    </div>
  );
}
