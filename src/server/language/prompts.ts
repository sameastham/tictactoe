import fs from "node:fs";
import path from "node:path";
import type { LearnerBlock } from "@/lib/contracts";

export const EXTRACT_PROMPT_VERSION = "v1";
export const JUDGE_PROMPT_VERSION = "v1";
export const CONVERSE_PROMPT_VERSION = "v1";

export type PromptName = "extract" | "judge" | "converse";

export type LoadedPrompt = {
  name: PromptName;
  version: string;
  text: string;
};

const promptCache = new Map<string, LoadedPrompt>();

/** Reads `prompts/{name}.{version}.md` from the project root, caching by name+version. */
export function loadPrompt(name: PromptName, version: string): LoadedPrompt {
  const key = `${name}.${version}`;
  const cached = promptCache.get(key);
  if (cached) return cached;

  const filePath = path.join(process.cwd(), "prompts", `${name}.${version}.md`);
  const text = fs.readFileSync(filePath, "utf-8");
  const prompt: LoadedPrompt = { name, version, text };
  promptCache.set(key, prompt);
  return prompt;
}

/** Substitutes `{{LEARNER_BLOCK}}` in a prompt template with the pretty-printed learner block. */
export function renderPrompt(text: string, learner: LearnerBlock): string {
  return text.replace("{{LEARNER_BLOCK}}", JSON.stringify(learner, null, 2));
}
