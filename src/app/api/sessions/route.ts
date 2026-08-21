import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { SURFACES } from "@/lib/taxonomy";
import { createSession } from "@/server/repo";

const CreateSessionBodySchema = z.object({
  surface: z.enum(SURFACES),
  contentId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = CreateSessionBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const { surface, contentId } = parsed.data;

    const db = getDb();
    const session = createSession(db, { surface, contentId });

    return NextResponse.json({ sessionId: session.id }, { status: 201 });
  } catch (error) {
    console.error("POST /api/sessions failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
