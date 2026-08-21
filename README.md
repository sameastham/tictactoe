# Español Coach

A personal Mexican-Spanish B2→C1 trainer: it captures chunks (words, collocations, idioms) from real content you consume, prompts you to produce them yourself, judges your output against a naturalness ladder, and keeps an append-only event log of everything so your progress is fully auditable over time.

## Getting started

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run seed
npm run dev
```

## Note

`legacy/` holds this repository's previous, unrelated project: a tic-tac-toe game. It is kept for reference and is not part of the Español Coach app.
