"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Prominent CTA on `/talk`: POSTs `/api/talk/start` (no body — the topic is
 * server-seeded) and navigates straight into the new chat session.
 */
export function StartTalkButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/talk/start", { method: "POST" });
      if (!res.ok) {
        setError("No se pudo empezar la plática. Intenta de nuevo.");
        setPending(false);
        return;
      }
      const data = (await res.json()) as { sessionId: string };
      router.push(`/talk/${data.sessionId}`);
    } catch {
      setError("No se pudo conectar con el servidor.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="start-talk"
        onClick={handleStart}
        disabled={pending}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent text-base font-semibold text-accent-fg transition-opacity active:opacity-90 disabled:opacity-60"
      >
        {pending && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg" />
        )}
        {pending ? "Empezando…" : "Empezar plática"}
      </button>
      {error && <p className="text-sm text-danger-fg">{error}</p>}
    </div>
  );
}
