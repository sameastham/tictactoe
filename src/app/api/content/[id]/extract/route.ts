import { NextRequest, NextResponse } from "next/server";
import type { StoredExtraction } from "@/lib/contracts";
import { getDb, type Db } from "@/db";
import { buildLearnerBlock } from "@/server/learner";
import { EXTRACT_PROMPT_VERSION } from "@/server/language/prompts";
import { getProvider } from "@/server/language/providers";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { type ContentRow, getContent, saveExtraction } from "@/server/repo";

/**
 * Extractions currently running, keyed by content id. An extract call takes
 * a minute or more, and the Read page is routinely reloaded mid-"Extrayendo…"
 * (especially in the Android WebView), which used to fire a second, identical
 * model call for the same content. Concurrent requests for one content id —
 * forced or not — now await the same promise, so exactly one provider call
 * (and one `model_calls` row) happens per in-flight extraction. The entry is
 * removed once the extraction settles, so a later `?force=1` runs afresh.
 *
 * Module-level state is sufficient here: this is a single-user,
 * single-process app.
 */
const inFlight = new Map<string, Promise<StoredExtraction>>();

/** Runs one extraction via `LanguageService` and persists it onto the content row. */
async function runExtraction(db: Db, row: ContentRow): Promise<StoredExtraction> {
  const learner = buildLearnerBlock(db);
  const { result, model } = await getLanguageService().extract(
    { title: row.title, text: row.text },
    learner,
    { contentId: row.id },
  );

  const extraction: StoredExtraction = {
    promptVersion: EXTRACT_PROMPT_VERSION,
    model,
    provider: getProvider().name,
    extractedAt: Date.now(),
    result,
  };

  saveExtraction(db, row.id, extraction);
  return extraction;
}

/** Returns the in-flight extraction for `row.id`, starting one if none is running. */
function getOrStartExtraction(db: Db, row: ContentRow): Promise<StoredExtraction> {
  const existing = inFlight.get(row.id);
  if (existing) return existing;

  const pending: Promise<StoredExtraction> = runExtraction(db, row).finally(() => {
    if (inFlight.get(row.id) === pending) inFlight.delete(row.id);
  });
  inFlight.set(row.id, pending);
  return pending;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = getContent(db, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "1";

    if (row.extraction && !force) {
      return NextResponse.json({ extraction: row.extraction, cached: true });
    }

    const extraction = await getOrStartExtraction(db, row);

    return NextResponse.json({ extraction, cached: false });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/content/[id]/extract failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
