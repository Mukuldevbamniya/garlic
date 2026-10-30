# Garlic

Finds recurring charges in a bank or card statement, warns you before they renew, and prepares a cancellation only after you authorize it.

## Run it

Requires Node 24+ (`node:sqlite`) and pnpm.

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:5173
- API: http://localhost:8787

The ledger starts empty. Import a CSV from your bank or card. Statements are stored in `data/garlic.db`. Settings → Clear ledger wipes that file's contents.

```bash
pnpm build
pnpm start
```

`pnpm start` serves `dist/` from the same process when a build exists.

## AI is optional

With no key, detection, alerts, cancellation plans, and Ask Garlic run on local rules.

```bash
cp .env.example .env
# set GOOGLE_GENERATIVE_AI_API_KEY or ANTHROPIC_API_KEY
```

Gemini uses `@ai-sdk/google` and the Generative Language API. Optional: `GEMINI_MODEL` (default `gemini-2.5-flash`), `ANTHROPIC_MODEL`, `PORT`, `GARLIC_DB`.

## What it does

Charges are grouped by merchant, then tested against weekly, biweekly, four-weekly, monthly, quarterly, semiannual, and annual cycles. A 28-day cycle is kept separate from a calendar month. Variable amounts stay in the series. A one-off annual fee does not break a monthly cadence. Short or ambiguous history is marked for review instead of trusted.

Alerts cover renewals, price increases, trial endings, annual renewals, overlapping services, failed charges, and plans you have not used. You can read, snooze, or resolve each one.

Cancellation has four steps:

1. Choose a rehearsal or a real cancellation, and read the consequences, provider terms, effective date, and any fee.
2. Acknowledge those terms and type the confirmation phrase. The server issues a single-use token for that plan, valid for 10 minutes.
3. The agent walks the steps. App Store, phone, and unknown routes stop and hand the step to you.
4. You get a receipt. If you finished the cancellation yourself, you can record a reference.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | API + Vite |
| `pnpm test` | Detection and CSV tests |
| `pnpm lint` | Oxlint |
| `pnpm build` | Typecheck and build the SPA |
| `pnpm start` | Serve API and built SPA |
