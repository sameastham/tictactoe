import fs from "node:fs";
import path from "node:path";
import {
  ProviderError,
  type ModelJsonRequest,
  type ModelJsonResponse,
  type ModelProvider,
  type ModelUsage,
} from "@/server/language/providers/provider";

const ARTICLE_FIXTURE_PATH = path.join(process.cwd(), "fixtures", "article-es-mx.txt");
const EXTRACT_FIXTURE_PATH = path.join(process.cwd(), "fixtures", "extract.article-es-mx.json");

let cachedArticleText: string | undefined;
let cachedCannedExtract: unknown;

function loadArticleText(): string {
  if (cachedArticleText === undefined) {
    cachedArticleText = fs.readFileSync(ARTICLE_FIXTURE_PATH, "utf-8");
  }
  return cachedArticleText;
}

function loadCannedExtract(): unknown {
  if (cachedCannedExtract === undefined) {
    cachedCannedExtract = JSON.parse(fs.readFileSync(EXTRACT_FIXTURE_PATH, "utf-8"));
  }
  return cachedCannedExtract;
}

/** trim + collapse all whitespace runs to a single space. */
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * The article's first sentence, verbatim. Used so a request whose user
 * message is the article with a title prefixed (e.g. `# Title\n\n<article>`)
 * still resolves to the canned fixture instead of falling through to
 * synthesis.
 */
function firstSentence(text: string): string {
  const match = text.trimStart().match(/^[\s\S]*?[.?!]/);
  return (match ? match[0] : text).trim();
}

const REGISTER_CYCLE = ["neutral", "coloquial_mx", "formal", "pan_hispanic"] as const;

function pickEvenlySpaced<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(items[Math.floor((i * items.length) / max)]);
  }
  return picked;
}

/**
 * Deterministically synthesizes an extract-shaped result from arbitrary
 * input text, for callers that don't pass the canned fixture article.
 */
function synthesizeExtractResult(userText: string): unknown {
  const sentences = userText
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length >= 6);

  let fragments: string[];
  let isRealSentence: boolean;
  if (sentences.length > 0) {
    fragments = pickEvenlySpaced(sentences, 10);
    isRealSentence = true;
  } else {
    const words = userText.trim().split(/\s+/).filter(Boolean).slice(0, 3);
    fragments = [words.length > 0 ? words.join(" ") : userText.trim()];
    isRealSentence = false;
  }

  const candidates = fragments.map((fragment, i) => {
    const words = fragment.split(/\s+/).filter(Boolean);
    const chunkWords = isRealSentence ? words.slice(1, 4) : words;
    const chunk = chunkWords.length > 0 ? chunkWords.join(" ") : fragment;
    const everyThird = (i + 1) % 3 === 0;
    return {
      id: `c${i + 1}`,
      chunk,
      origin_sentence: fragment,
      register: REGISTER_CYCLE[i % REGISTER_CYCLE.length],
      why: "[fixture] candidato determinístico para pruebas",
      contrast_set: everyThird ? ["abordar", "afrontar", "atajar"] : null,
      taxonomy: everyThird ? ["collocation"] : null,
    };
  });

  return { difficulty: "B2", candidates };
}

/**
 * Deterministic, network-free model provider used in tests and local dev
 * without an API key. Only the "extract" purpose is implemented.
 */
export class FixtureProvider implements ModelProvider {
  readonly name = "fixture";

  async completeJson<T>(req: ModelJsonRequest<T>): Promise<ModelJsonResponse<T>> {
    if (req.purpose !== "extract") {
      throw new ProviderError(`fixture provider does not implement ${req.purpose}`, false);
    }

    const articleText = loadArticleText();
    const isCannedMatch =
      normalize(req.user) === normalize(articleText) || req.user.includes(firstSentence(articleText));

    const raw = isCannedMatch ? loadCannedExtract() : synthesizeExtractResult(req.user);

    // Always validate against the caller's schema so the fixture data can
    // never silently drift from the app's contract.
    const data = req.schema.parse(raw);

    const usage: ModelUsage = {
      inputTokens: Math.ceil(req.user.length / 4),
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    return { data, model: "fixture", usage };
  }
}
