import Link from "next/link";
import { SourceDirectory } from "@/components/SourceDirectory";

export default function FuentesPage() {
  return (
    <div className="min-h-dvh px-4 pb-28 pt-6">
      <header className="mb-2 flex items-center gap-3">
        <Link
          href="/"
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
        <h1 className="text-xl font-bold tracking-tight">Fuentes</h1>
      </header>

      <p className="mb-5 text-sm text-ink-muted">
        Material auténtico sugerido — tú eliges la pieza, el app la trae.
      </p>

      <SourceDirectory />
    </div>
  );
}
