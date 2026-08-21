# vendor/tessdata

Vendored Tesseract OCR trained-data file for Spanish, used by the OCR fallback
in `src/server/pdf.ts` (`extractPdfText`, scanned/image-only PDFs) via
`tesseract.js`, `createWorker("spa", ...)`.

## What's here

- `spa.traineddata.gz` — the Spanish `tessdata_fast` model, gzip-recompressed.

## Origin

Downloaded from the official Tesseract OCR project's `tessdata_fast` repo
(the fast/int8 variant of the trained models — smaller and faster than
`tessdata`/`tessdata_best`, the right tradeoff for CPU-only OCR on the
deployment target, a 2019 Intel MacBook Pro with no GPU/Apple Silicon; see
CLAUDE.md Sec.6):

- Repo: https://github.com/tesseract-ocr/tessdata_fast
- File: `spa.traineddata`
- Commit at time of vendoring: `87416418657359cb625c412a48b6e1d6d41c29bd`

The file was downloaded as-is and re-compressed with `gzip -9` (tesseract.js's
Node loader gunzips on load when `gzip: true`, the default — see
`loadLangPath`/`langPath` wiring in `src/server/pdf.ts`). No other
transformation was applied.

## License

Apache License 2.0 (same license as Tesseract OCR itself) — see the
`tessdata_fast` repo's `LICENSE` file. Copyright the Tesseract OCR
contributors / Google.

## Why vendored instead of fetched at runtime

`extractPdfText`'s OCR path must work with no network access (same posture as
the rest of the model/STT stack — see CLAUDE.md Sec.6). Left unset,
tesseract.js's `langPath` defaults to fetching `spa.traineddata.gz` from the
jsdelivr CDN on first use; `src/server/pdf.ts` instead points `langPath` at
this directory so the language data loads from local disk only, verified
under both `next dev` and `next build`/`npm start`.

## Updating

Re-run the download + `gzip -9` steps against a newer `tessdata_fast` commit,
replace `spa.traineddata.gz`, and update the commit hash above.
