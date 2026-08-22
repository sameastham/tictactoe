import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { content, modelCalls } from "@/db/schema";
import type { StoredExtraction } from "@/lib/contracts";
import {
  ProviderError,
  type ModelJsonRequest,
  type ModelJsonResponse,
  type ModelUsage,
} from "@/server/language/providers/provider";
import { createContent } from "@/server/repo";
import { POST } from "./route";

/**
 * A provider whose `completeJson` never resolves on its own: each call is
 * parked in `pending` until the test settles it. That lets a test hold an
 * extraction "in flight" while it fires more requests at the route.
 */
const stub = vi.hoisted(() => {
  type Pending = {
    req: { schema: { parse(value: unknown): unknown } };
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  const pending: Pending[] = [];
  const provider = {
    name: "stub-dedup",
    calls: 0,
    completeJson(req: Pending["req"]): Promise<unknown> {
      provider.calls += 1;
      return new Promise((resolve, reject) => pending.push({ req, resolve, reject }));
    },
  };
  return { provider, pending };
});

vi.mock("@/server/language/providers", () => ({
  getProvider: () => stub.provider,
}));

// One in-memory DB for the whole file: the route (and the LanguageService
// singleton it builds) reach the DB only through `getDb()`.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = actual.createTestDb();
  return { ...actual, getDb: () => db };
});

const GOOD_SENTENCE = "Esta es una buena frase de prueba con longitud suficiente para la validación.";
const ARTICLE_TEXT = `Texto introductorio de relleno para superar el mínimo exigido. ${GOOD_SENTENCE} Más texto de cierre para el artículo de prueba.`;

const USAGE: ModelUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function makeResult(chunk: string) {
  return {
    difficulty: "B2",
    candidates: [
      {
        id: "c1",
        chunk,
        origin_sentence: GOOD_SENTENCE,
        register: "neutral",
        why: "verbatim in the article",
        contrast_set: null,
        taxonomy: null,
      },
    ],
  };
}

/** Resolves the oldest parked provider call with a valid extraction naming `chunk`. */
function resolveOldestPending(chunk = "buena frase") {
  const next = stub.pending.shift();
  if (!next) throw new Error("no pending provider call to resolve");
  const req = next.req as unknown as ModelJsonRequest<unknown>;
  const response: ModelJsonResponse<unknown> = {
    data: req.schema.parse(makeResult(chunk)),
    model: "stub-model",
    usage: USAGE,
  };
  next.resolve(response);
}

function rejectOldestPending(error: unknown) {
  const next = stub.pending.shift();
  if (!next) throw new Error("no pending provider call to reject");
  next.reject(error);
}

function post(id: string, opts: { force?: boolean } = {}) {
  const url = `http://localhost/api/content/${id}/extract${opts.force ? "?force=1" : ""}`;
  return POST(new NextRequest(url, { method: "POST" }), { params: Promise.resolve({ id }) });
}

/** Waits until the provider call count reaches `expected`, then a beat longer to catch any straggler that would push it past. */
async function waitForProviderCalls(expected: number) {
  await vi.waitFor(() => expect(stub.provider.calls).toBe(expected));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(stub.provider.calls).toBe(expected);
}

function newContentId(): string {
  return createContent(getDb(), { source: "paste", type: "paste", text: ARTICLE_TEXT }).id;
}

function countExtractModelCalls(contentId: string): number {
  return getDb().select().from(modelCalls).where(eq(modelCalls.contentId, contentId)).all().length;
}

describe("POST /api/content/[id]/extract — in-flight dedup", () => {
  it("two concurrent POSTs share one provider call and receive the same extraction", async () => {
    const id = newContentId();
    const callsBefore = stub.provider.calls;

    const first = post(id);
    const second = post(id);
    await waitForProviderCalls(callsBefore + 1);

    resolveOldestPending("buena frase");
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const bodyA = (await a.json()) as { extraction: StoredExtraction; cached: boolean };
    const bodyB = (await b.json()) as { extraction: StoredExtraction; cached: boolean };
    expect(bodyA.cached).toBe(false);
    expect(bodyB.cached).toBe(false);
    expect(bodyA.extraction).toEqual(bodyB.extraction);
    expect(bodyA.extraction.result.candidates.map((c) => c.chunk)).toEqual(["buena frase"]);

    // One provider call → exactly one model_calls row, and the result is persisted.
    expect(stub.provider.calls).toBe(callsBefore + 1);
    expect(countExtractModelCalls(id)).toBe(1);
    const row = getDb().select().from(content).where(eq(content.id, id)).get();
    expect(row?.extraction).toEqual(bodyA.extraction);
  });

  it("a POST after persistence returns cached:true without calling the provider", async () => {
    const id = newContentId();
    const callsBefore = stub.provider.calls;

    const first = post(id);
    await waitForProviderCalls(callsBefore + 1);
    resolveOldestPending("buena frase");
    const persisted = ((await (await first).json()) as { extraction: StoredExtraction }).extraction;

    const later = await post(id);
    expect(later.status).toBe(200);
    const body = (await later.json()) as { extraction: StoredExtraction; cached: boolean };
    expect(body.cached).toBe(true);
    expect(body.extraction).toEqual(persisted);
    expect(stub.provider.calls).toBe(callsBefore + 1);
    expect(countExtractModelCalls(id)).toBe(1);
  });

  it("?force=1 re-extracts after persistence, and concurrent forced calls still share one provider call", async () => {
    const id = newContentId();
    const callsBefore = stub.provider.calls;

    const first = post(id);
    await waitForProviderCalls(callsBefore + 1);
    resolveOldestPending("buena frase");
    await first;

    // The in-flight entry was cleared on completion, so a forced call runs a new extraction…
    const forcedA = post(id, { force: true });
    const forcedB = post(id, { force: true });
    // …and a plain call arriving alongside it just sees the persisted one.
    const plain = await post(id);
    expect(((await plain.json()) as { cached: boolean }).cached).toBe(true);

    await waitForProviderCalls(callsBefore + 2);
    resolveOldestPending("frase de prueba");

    const [a, b] = await Promise.all([forcedA, forcedB]);
    const bodyA = (await a.json()) as { extraction: StoredExtraction; cached: boolean };
    const bodyB = (await b.json()) as { extraction: StoredExtraction; cached: boolean };
    expect(bodyA.cached).toBe(false);
    expect(bodyA.extraction).toEqual(bodyB.extraction);
    expect(bodyA.extraction.result.candidates.map((c) => c.chunk)).toEqual(["frase de prueba"]);
    expect(stub.provider.calls).toBe(callsBefore + 2);
    expect(countExtractModelCalls(id)).toBe(2);

    const row = getDb().select().from(content).where(eq(content.id, id)).get();
    expect(row?.extraction).toEqual(bodyA.extraction);
  });

  it("a failed extraction is reported to every waiter and clears the in-flight entry", async () => {
    const id = newContentId();
    const callsBefore = stub.provider.calls;

    const first = post(id);
    const second = post(id);
    await waitForProviderCalls(callsBefore + 1);
    rejectOldestPending(new ProviderError("upstream exploded", true));

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(502);
    expect(b.status).toBe(502);
    expect(countExtractModelCalls(id)).toBe(1);

    // The failed attempt is gone from the map, so the next request starts a fresh extraction.
    const retry = post(id);
    await waitForProviderCalls(callsBefore + 2);
    resolveOldestPending("buena frase");
    const body = (await (await retry).json()) as { cached: boolean };
    expect(body.cached).toBe(false);
    expect(countExtractModelCalls(id)).toBe(2);
  });

  it("different content ids never share an in-flight extraction", async () => {
    const idA = newContentId();
    const idB = newContentId();
    const callsBefore = stub.provider.calls;

    const a = post(idA);
    const b = post(idB);
    await waitForProviderCalls(callsBefore + 2);
    resolveOldestPending("buena frase");
    resolveOldestPending("frase de prueba");

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(countExtractModelCalls(idA)).toBe(1);
    expect(countExtractModelCalls(idB)).toBe(1);
  });
});
