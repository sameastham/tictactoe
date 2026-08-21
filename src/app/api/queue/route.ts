import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getQueueCards } from "@/server/scheduler";

const QUEUE_MAX = 10;

/**
 * The home-screen "Repaso" queue: up to 10 due items mapped to cloze card
 * data (see `getQueueCards` in `src/server/scheduler.ts`). Fetched
 * client-side by `src/components/ReviewQueue.tsx`.
 */
export async function GET() {
  try {
    const db = getDb();
    const cards = getQueueCards(db, QUEUE_MAX);
    return NextResponse.json({ cards });
  } catch (error) {
    console.error("GET /api/queue failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
