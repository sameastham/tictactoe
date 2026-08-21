/**
 * The eval harness — plan Sec.6.3: everything rests on whether `judge`
 * agrees with a competent human about what's natural in Mexican Spanish,
 * measured over the gold set (`natural_control` + `seeded_error` +
 * `adjudicated`), not assumed. Run with `npm run eval` after `npm run
 * goldset` has populated `gold_set`. Inserts one `eval_runs` row and prints a
 * readable table.
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { evalRuns, goldSet, modelCalls } from "@/db/schema";
import { DEFAULT_USER_ID, newId } from "@/lib/ids";
import type { JudgeResult } from "@/lib/contracts";
import { RUNGS, type Rung, type TaxonomyTag } from "@/lib/taxonomy";
import { JUDGE_PROMPT_VERSION } from "@/server/language/prompts";
import { getProvider } from "@/server/language/providers";
import { ProviderError } from "@/server/language/providers/provider";
import { getLanguageService } from "@/server/language/service";
import { buildLearnerBlock } from "@/server/learner";

const FALSE_FLAG_BAR = 0.1; // report as PASS when <= this
const CATCH_BAR = 0.85; // report as PASS when >= this
const ADJUDICATED_BAR = 0.75; // report as PASS when >= this

/** The worst (lowest-ranked) rung across a judgment's sentences — a single-sentence input should have exactly one. */
function worstRung(result: JudgeResult): Rung {
  let worst: Rung = "precise";
  for (const sentence of result.sentences) {
    if (RUNGS.indexOf(sentence.rung) < RUNGS.indexOf(worst)) worst = sentence.rung;
  }
  return worst;
}

/** Flagged = below "natural" on the ladder, OR the judge attached any issue at all. */
function isFlagged(result: JudgeResult): boolean {
  const issues = result.sentences.flatMap((s) => s.issues);
  const worst = worstRung(result);
  return worst === "incorrect" || worst === "acceptable" || issues.length > 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

function verdict(n: number | null, bar: number, direction: "max" | "min"): string {
  if (n === null) return "—";
  const pass = direction === "max" ? n <= bar : n >= bar;
  return pass ? "PASS" : "FAIL";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main() {
  const db = getDb();
  const provider = getProvider();
  const languageService = getLanguageService();
  const learner = buildLearnerBlock(db);

  const rows = db.select().from(goldSet).where(eq(goldSet.userId, DEFAULT_USER_ID)).all();
  if (rows.length === 0) {
    console.log("No gold_set rows found — run `npm run goldset` first.");
    return;
  }

  const runStartedAt = new Date();
  let errored = 0;
  let modelUsed = "unknown";

  const controlFlags: boolean[] = [];
  const seededResults: { caught: boolean; tagMatch: boolean | null }[] = [];
  const adjudicatedResults: { agree: boolean }[] = [];

  for (const row of rows) {
    // Nothing to compare a judged rung against — skip before spending a model call.
    if (row.set === "adjudicated" && !row.expectedRung) continue;

    let judgment: JudgeResult;
    try {
      const { result, model } = await languageService.judge(
        { text: row.sentence, task: null, target_items: [] },
        learner,
      );
      judgment = result;
      modelUsed = model;
    } catch (error) {
      if (error instanceof ProviderError) {
        errored++;
        console.warn(`  [errored] ${row.set} ${row.id}: ${error.message}`);
        continue;
      }
      throw error;
    }

    const flagged = isFlagged(judgment);

    if (row.set === "natural_control") {
      controlFlags.push(flagged);
    } else if (row.set === "seeded_error") {
      const expectedTag: TaxonomyTag | undefined = row.expectedTags[0];
      const issueTags = judgment.sentences.flatMap((s) => s.issues.map((i) => i.tag));
      seededResults.push({
        caught: flagged,
        tagMatch: flagged ? (expectedTag !== undefined && issueTags.includes(expectedTag)) : null,
      });
    } else if (row.set === "adjudicated") {
      adjudicatedResults.push({ agree: worstRung(judgment) === row.expectedRung });
    }
  }

  const falseFlagRate = rate(controlFlags.filter(Boolean).length, controlFlags.length);
  const caughtCount = seededResults.filter((r) => r.caught).length;
  const catchRate = rate(caughtCount, seededResults.length);
  const tagAccuracy = rate(seededResults.filter((r) => r.tagMatch === true).length, caughtCount);
  const adjudicatedAgreement = rate(adjudicatedResults.filter((r) => r.agree).length, adjudicatedResults.length);

  const agreement: Record<string, number> = {
    n_control: controlFlags.length,
    n_seeded: seededResults.length,
    n_adjudicated: adjudicatedResults.length,
  };
  if (falseFlagRate !== null) agreement.false_flag_rate = falseFlagRate;
  if (catchRate !== null) agreement.catch_rate = catchRate;
  if (tagAccuracy !== null) agreement.tag_accuracy = tagAccuracy;
  if (adjudicatedAgreement !== null) agreement.adjudicated_agreement = adjudicatedAgreement;

  // Cost/tokens for exactly this run: every judge call this loop made — success
  // or failure — logged one model_calls row (LanguageService's hard rule), so
  // a createdAt >= runStartedAt window captures the full cost of the run.
  const callRows = db
    .select()
    .from(modelCalls)
    .where(
      and(eq(modelCalls.userId, DEFAULT_USER_ID), eq(modelCalls.purpose, "judge"), gte(modelCalls.createdAt, runStartedAt)),
    )
    .all();
  const costUsd = callRows.reduce((sum, r) => sum + r.costUsd, 0);
  const inputTokens = callRows.reduce((sum, r) => sum + r.inputTokens, 0);
  const outputTokens = callRows.reduce((sum, r) => sum + r.outputTokens, 0);

  const notes =
    provider.name === "fixture"
      ? "fixture provider: judge only recognizes literal 'hacer sentido' / 'depender que' / 'muy muy' — catch rate here reflects rule coverage, not real judge quality. Real numbers require claude-opus-5."
      : `${provider.name} provider, ${modelUsed}`;

  db.insert(evalRuns)
    .values({
      id: newId(),
      userId: DEFAULT_USER_ID,
      promptName: "judge",
      promptVersion: JUDGE_PROMPT_VERSION,
      model: modelUsed,
      agreement,
      costUsd,
      inputTokens,
      outputTokens,
      notes,
      createdAt: new Date(),
    })
    .run();

  console.log("");
  console.log(`Eval run — judge.${JUDGE_PROMPT_VERSION} (${provider.name} / ${modelUsed})`);
  console.log("-".repeat(78));
  console.log(`${pad("metric", 24)}${pad("value", 10)}${pad("bar", 12)}${pad("verdict", 8)}n`);
  console.log(
    `${pad("false_flag_rate", 24)}${pad(pct(falseFlagRate), 10)}${pad("<= 10%", 12)}${pad(
      verdict(falseFlagRate, FALSE_FLAG_BAR, "max"),
      8,
    )}${controlFlags.length}`,
  );
  console.log(
    `${pad("catch_rate", 24)}${pad(pct(catchRate), 10)}${pad(">= 85%", 12)}${pad(
      verdict(catchRate, CATCH_BAR, "min"),
      8,
    )}${seededResults.length}`,
  );
  console.log(
    `${pad("tag_accuracy", 24)}${pad(pct(tagAccuracy), 10)}${pad("(report only)", 12)}${pad("—", 8)}${caughtCount} caught`,
  );
  console.log(
    `${pad("adjudicated_agreement", 24)}${pad(pct(adjudicatedAgreement), 10)}${pad(">= 75%", 12)}${pad(
      verdict(adjudicatedAgreement, ADJUDICATED_BAR, "min"),
      8,
    )}${adjudicatedResults.length}`,
  );
  console.log("-".repeat(78));
  console.log(`errored rows: ${errored}`);
  console.log(`cost: $${costUsd.toFixed(4)}   input tokens: ${inputTokens}   output tokens: ${outputTokens}`);
  console.log(`notes: ${notes}`);
  console.log("");
}

main();
