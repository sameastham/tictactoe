import { NextRequest, NextResponse } from "next/server";
import type { StoredExtraction } from "@/lib/contracts";
import { getDb } from "@/db";
import { buildLearnerBlock } from "@/server/learner";
import { EXTRACT_PROMPT_VERSION } from "@/server/language/prompts";
import { getProvider } from "@/server/language/providers";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { getContent, saveExtraction } from "@/server/repo";

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

    const learner = buildLearnerBlock(db);
    const { result, model } = await getLanguageService().extract(
      { title: row.title, text: row.text },
      learner,
      { contentId: id },
    );

    const extraction: StoredExtraction = {
      promptVersion: EXTRACT_PROMPT_VERSION,
      model,
      provider: getProvider().name,
      extractedAt: Date.now(),
      result,
    };

    saveExtraction(db, id, extraction);

    return NextResponse.json({ extraction, cached: false });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("POST /api/content/[id]/extract failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
