# Español Coach

## 1. What this is

A single-user tool moving one learner (high B2 → high C1, Mexican Spanish) through a
capture-produce-judge loop: Read/Listen surfaces pull chunk items out of real content, the
learner later produces them (Fix/Talk), and a model judges the output against a naturalness
ladder. Everything that happens is logged to an append-only event log; the learner's profile is
derived from that log, not stored separately. Everything derives from the append-only event log;
surfaces are interfaces over it.

Currently built: the Read surface (URL fetch / paste → `content` row) and `LanguageService.extract`
(article → candidate chunks). Not yet built: Listen (dictation), Fix (judge), Talk (converse), the
FSRS review scheduler, and the eval harness over `gold_set`. Don't assume any of these exist.

## 2. Commands

- `npm run dev` — Next.js dev server.
- `npm run build` — production build.
- `npm start` — run the production build.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `eslint .`.
- `npm test` — `vitest run`, tests live at `src/**/*.test.ts`.
- `npm run e2e` — `next build && playwright test`: rebuilds the production bundle, then runs the
  Playwright suite (`e2e/`) against it, so the command is self-contained. `npm run e2e:only` skips
  the rebuild and just runs `playwright test` against whatever build is already on disk.
- `npm run db:generate` — `drizzle-kit generate`, writes a new migration from `src/db/schema.ts`.
- `npm run db:migrate` — `drizzle-kit migrate`, applies migrations to `DB_PATH` (default
  `data/app.db`).
- `npm run seed` — `tsx scripts/seed.ts`: applies migrations, then idempotently inserts the
  fixture article as a first content row.

`MODEL_PROVIDER=fixture` forces the deterministic, no-network `FixtureProvider`. With
`MODEL_PROVIDER` unset and no `ANTHROPIC_API_KEY`, fixture is the automatic default (see
`src/server/language/providers/index.ts`); set `ANTHROPIC_API_KEY` (or `MODEL_PROVIDER=anthropic`)
to hit the real API.

## 3. Hard rules

- **No model calls outside `src/server/language/`.** `LanguageService` (`service.ts`) is the only
  gateway; there are exactly three prompt purposes: `extract`, `judge`, `converse` (`judge` and
  `converse` currently throw `NotImplementedError`). Every provider call — success or failure —
  must produce one `model_calls` row via `logModelCall`.
- **`events` is append-only.** Never `UPDATE` or `DELETE` a row in `events`; a correction is a new
  event, not an edit. `src/server/repo.ts` deliberately exposes no event-mutation function — keep
  it that way. Decisions (keep/discard) are derived by replaying `captured`/`discarded` events
  (see `getDecisions`), not stored as mutable state.
- **Every table row carries `user_id`.** Use `DEFAULT_USER_ID` from `src/lib/ids.ts`
  (`"u_local"`). This is single-user today; multi-user must stay a migration (swap the constant
  for a real value), never a schema rewrite.
- **Items are chunks/constructions with context, never bare single words.** An item (and every
  extracted `Candidate`) always carries `origin_sentence` (verbatim from the source content) and,
  for items, `originContentId`. `LanguageService.extract` already enforces this at the prompt level
  and again in code (`cleanExtractResult` drops any candidate whose `origin_sentence` isn't a
  verbatim substring of the article, or whose `chunk` isn't a verbatim substring of
  `origin_sentence`).
- **Multi-table writes happen in one better-sqlite3 transaction.** See `recordDecision` in
  `src/server/repo.ts` for the pattern (`db.transaction((tx) => { ... })`). Event payloads are
  self-describing — the full candidate JSON lives in the payload — so the log replays without
  joining out to `items`/`content`.
- **Drizzle-portable column types only**: `text` / `integer` / `real`, JSON via
  `{ mode: "json" }`. No SQLite-only column features in `src/db/schema.ts` or in queries — the
  eventual Postgres swap has to stay cheap.
- **`src/lib/` is client-safe**: no `fs`, no db, no server-only imports. `src/db/` and
  `src/server/` must never be imported from a client component (`src/db/index.ts` intentionally
  skips `import "server-only"` only because seed scripts and vitest need it outside the Next.js
  runtime — that is not license to import it client-side).
- **`src/lib/contracts.ts` is the single source of truth for every JSON shape** — model output,
  event payloads, API request bodies. Change a shape there first; every type in the app (including
  `EventPayload`, `StoredExtraction`) is inferred from these Zod schemas, not hand-declared.

## 4. Taxonomy v0

From `src/lib/taxonomy.ts`. Tags tag items, errors, and captured chunks:

- `grammar` — morphosyntax errors (agreement, conjugation, mood/tense).
- `preposition` — wrong or missing preposition.
- `word_choice` — wrong lexical item for the intended meaning.
- `collocation` — right words, wrong pairing (a native wouldn't combine them that way).
- `register` — wrong formality/dialect level for context.
- `idiomaticity` — grammatically fine but not how a native speaker would phrase it.
- `discourse` — connective tissue between clauses/sentences (argumentation, narration flow).
- `redundancy` — says more than a native speaker would to convey the same thing.
- `word_order` — constituent order is off.
- `listening_reduction` — miss caused by connected speech / elision, not vocabulary.
- `listening_lexical` — miss caused by not knowing the word/chunk itself.

**Rule:** the taxonomy grows from data. Append new tags to the `TAXONOMY` const array; never
rename or remove an existing one — events reference tags by string and the log is immutable.

**Register labels** (`REGISTERS`): `neutral`, `formal`, `coloquial_mx`, `pan_hispanic`.

**Judgment ladder** (`JudgeResultSchema.rung`): `incorrect < acceptable < natural < precise`.
"Precise" means tighter within the *same* register — not fancier. A textbook-sounding,
higher-register alternative to a natural coloquial_mx sentence is a regression, not an
improvement.

## 5. Prompts

Prompts live in `prompts/` as `name.vN.md` (e.g. `prompts/extract.v1.md`); the filename **is**
the version, loaded by `loadPrompt(name, version)` in `src/server/language/prompts.ts`. Any
semantic edit to a prompt is a new file with a bumped version — never an in-place rewrite of an
existing `.md`. `EXTRACT_PROMPT_VERSION` (currently `"v1"`) is recorded on every `model_calls` row
and on the `StoredExtraction` persisted to `content.extraction` — preserve this provenance trail
for `judge` and `converse` when they're built.

`buildLearnerBlock(db)` (`src/server/learner.ts`) assembles the learner profile — static config
from `config/learner.json` plus the 5 most recent `produced_error` events from the log — and is
passed to every model call via `renderPrompt`, which substitutes `{{LEARNER_BLOCK}}`.

## 6. Model policy

- Default provider: `anthropic`, model `claude-opus-5` (`DEFAULT_MODEL` in
  `src/server/language/providers/anthropic.ts`), overridable with `MODEL_ID`.
- **The deployment target is a 2019 Intel MacBook Pro (64 GB RAM, no Apple Silicon).** No local
  LLM is viable there — hosted models are the only `extract`/`judge`/`converse` path. When the
  Listen surface is built, do NOT reach for `mlx-whisper` (Apple Silicon only): use
  `faster-whisper` (CTranslate2, CPU int8) or a hosted STT API for transcription.
- `fixture` provider (`FixtureProvider`) is deterministic and network-free, for tests/offline dev;
  it only implements `purpose: "extract"` and throws for `judge`/`converse`.
- Both live behind the `ModelProvider` interface (`provider.ts`) — `completeJson<T>` in,
  schema-validated `{ data, model, usage }` out. Don't call the Anthropic SDK from anywhere else.
- On `claude-opus-5`, never pass `thinking`, `temperature`, or `top_p` — the API rejects them.
  Structured output goes through `client.messages.parse` with
  `output_config: { format: zodOutputFormat(schema) }`, not manual JSON parsing.
- The SDK already retries transient failures (network errors, 408/409/429/5xx) internally;
  `mapSdkError` only classifies retryability for the caller, it does not add another retry loop.

## 7. Environment quirks

- Next 16: a dynamic route's `params` is a `Promise` — `await params` before use. (No dynamic API
  routes exist yet in this repo; apply this when you add the first one.)
- Drizzle `{ mode: "timestamp_ms" }` columns take and return JS `Date` objects, not numbers.
- better-sqlite3 is synchronous — its query methods (`.get()`, `.all()`, `.run()`) are not
  awaited; only the model provider calls in this app are actually async.
- `serverExternalPackages: ["better-sqlite3", "jsdom"]` in `next.config.ts` — required for both to
  work under the Next server runtime; don't remove it.
- Tailwind v4, CSS-first config (`@import "tailwindcss"` in `globals.css` via `postcss.config.mjs`)
  — there is no `tailwind.config.*` file to edit.
- Tests: `vitest run`, files matched by `src/**/*.test.ts` (see `vitest.config.ts`); path alias
  `@/*` → `src/*` in both vitest and `tsconfig.json`.
- E2E: Playwright, config at `playwright.config.ts`, specs in `e2e/`. Single chromium project
  (`devices["Pixel 7"]`), `workers: 1` and `fullyParallel: false` — every spec shares one
  throwaway sqlite DB (`.tmp/e2e.db`) so tests must run serially, never in parallel.
  `globalSetup` (`e2e/global-setup.ts`) deletes and re-seeds that DB before each run, so
  `npm run e2e` is repeatable from a clean state every time. The `webServer` runs a real
  production server (`npm start -- -p 3111`) with `MODEL_PROVIDER=fixture` (no network/API key
  needed) and `DB_PATH=.tmp/e2e.db`. Browsers expected at
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.
- `legacy/` is an unrelated prior tic-tac-toe project kept for reference only; it's excluded from
  `tsconfig.json` and `eslint.config.mjs`. Don't touch it, don't treat it as part of this app.

## 8. File-writing convention

When generating a large file, write the skeleton first with Write, then extend it with Edit calls,
rather than emitting the whole thing in one Write — long single writes are more prone to silent
truncation.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
