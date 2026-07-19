# Scripts

## Media optimization

Helpers for preparing photos and videos before uploading to `s3://gennaroanesi.com/public/`. Both write output next to the input file as `<name>.web.<ext>` by default.

### `optimize-photo.mjs` — photo → web JPEG

Uses `sharp` (already installed as a Next.js dep, no extra setup). Resizes to max 2400px long edge, strips EXIF, progressive encoding with mozjpeg.

```bash
node scripts/optimize-photo.mjs <input> [output]
```

Examples:
```bash
node scripts/optimize-photo.mjs ~/Pictures/dolomiti.jpg
# → ~/Pictures/dolomiti.web.jpg (412 KB)

node scripts/optimize-photo.mjs input.jpg output.jpg
```

Settings baked in:

| Setting | Value | Why |
|---|---|---|
| Max size | 2400px long edge | Crisp on 5K displays under `object-cover`; not wasteful |
| Quality | 82 | Sweet spot — 80 is noticeably smaller, 85+ diminishing returns |
| Encoder | mozjpeg | ~10% smaller than stock libjpeg at same quality |
| Progressive | on | Renders blurry→sharp while loading |
| Chroma subsampling | 4:2:0 | Standard for photos |
| EXIF | stripped | Saves 50–200 KB, removes GPS metadata |
| Orientation | auto | Applies EXIF rotation so portraits aren't sideways |

Target file size: ~300–500 KB per photo.

### `optimize-video.sh` — video → web MP4

Uses `ffmpeg` (install with `sudo apt install ffmpeg`). Encodes H.264, strips audio, caps at 1080p / 30fps, fast-start for streaming playback.

```bash
./scripts/optimize-video.sh <input> [output] [crf]
```

Examples:
```bash
./scripts/optimize-video.sh "/path/to/clip.MOV"
# → /path/to/clip.web.mp4

./scripts/optimize-video.sh input.mov out.mp4
./scripts/optimize-video.sh input.mov out.mp4 28   # smaller file, lower quality
```

Settings baked in:

| Setting | Value | Why |
|---|---|---|
| Codec | H.264 (libx264) | Broadest browser autoplay support |
| CRF | 26 (default, arg 3 to override) | Good for hero loops; each +1 ≈ half the bitrate |
| Preset | slow | Better compression at encode time |
| Max size | 1920px wide (no upscale) | Enough for retina under `object-cover` |
| FPS | 30 | Caps source down if higher |
| Pixel format | yuv420p | Required for browser/iOS compatibility |
| Audio | stripped (`-an`) | Hero videos autoplay muted; saves ~10% |
| Fast start | `+faststart` | Playback begins before full download |

Target file size for a 1-minute clip: ~8–15 MB (CRF 26).

## Upload to S3

Both scripts produce files ready to drop into `s3://gennaroanesi.com/public/`. Anything under `public/*` is publicly readable via:

```
https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/<key>
```

(Path-style URL — virtual-hosted form is broken for this bucket due to the dot in the bucket name.)

## SimpleFIN Bridge — daily transaction + balance sync

Pulls transactions and balances from SimpleFIN Bridge (aggregator that exposes bank tx feeds via a standard JSON protocol) and upserts into `financeTransaction` / `financeAccount`. Meant to replace ad-hoc CSV importing.

### Files

| File | Purpose |
|---|---|
| `scripts/_simplefin.mjs` | Thin client: `claimAccessUrl`, `fetchAccounts`, `maskAccessUrl` |
| `scripts/simplefin_probe.mjs` | Read-only inspector — no writes, no AWS |
| `scripts/simplefin_pull.mjs` | Full pull: tx inserts + balance sync + freshness stamps |
| `scripts/simplefin_dedupe.mjs` | One-shot cleanup for SF/CSV cross-source dupes |

### One-time setup

1. **Claim the SimpleFIN setup token** (issued once when you connect a new bridge or add a bank):

   ```bash
   node scripts/simplefin_probe.mjs --setup-token=<base64-token>
   ```

   Prints a persistent `https://user:pass@bridge...` URL. The token is single-use.

2. **`.env.local`** (gitignored):

   ```
   SIMPLEFIN_ACCESS_URL=https://…@bridge.simplefin.org/simplefin
   COGNITO_USER=you@example.com
   COGNITO_PASSWORD=your-website-login-password
   ```

   Same Cognito credentials you use to log into the site — the pull uses client-side `InitiateAuth` to mint a JWT for admin-only mutations. No AWS profile / IAM permissions needed for the pull.

3. **Map SimpleFIN accounts → local accounts.** For each account you want synced, run `sf:probe`, copy its `ACT-…` id, and paste it into the "SimpleFIN account id" field on `/finance/accounts/<id>` (under Notes). Accounts with a blank `simplefinAccountId` are skipped entirely — leave brokerage/retirement accounts blank until you're ready for that flow.

### Commands

```bash
npm run sf:probe                              # 30-day window, print all mapped + unmapped accounts
npm run sf:probe -- --days=7
npm run sf:probe -- --account=ACT-abc         # zoom in on one SF account
npm run sf:probe -- --sample=10               # more sample rows per account

npm run sf:pull                               # dry-run — plan only, no writes
npm run sf:pull -- --days=7                   # tighter window (default 14)
npm run sf:pull -- --account=<financeAccountId>  # limit to one local account
npm run sf:pull -- --apply                    # actually write

npm run sf:dedupe                             # scan for SF/CSV dupes, print plan
npm run sf:dedupe -- --apply                  # delete flagged rows
npm run sf:dedupe -- --account=<id>           # scope to one local account
```

### Behavior + design notes

- **Dedup**: transactions are skipped when *either* `importHash(date, amount, description)` matches or `(accountId, date, amount)` matches an existing row. The `(accountId, date, amount)` guard catches the common case where SF's payee-style description ("Meta Payroll") differs from a prior CSV's bank-statement description ("ORIG CO NAME:META CO ENTRY DES…") — different hash, same real transaction.
- **Self-transfers**: when two mapped accounts have same-date, exact-opposite-amount transactions, both rows are marked `TRANSFER` with `toAccountId` cross-refs and category `Transfers`. Excluded from P&L via `expenseMagnitude`. Miss cases: bank-side timing skew (transfer posts a day late on the destination) — those import as INCOME/EXPENSE with `Credit Card Payment`/similar auto-category, which is also P&L-excluded, so no double-counting.
- **Auto-categorize**: uses `components/finance/categories.ts` — same rule set as the review page. Investment accounts default to category `Investments` when no rule matches, so cash-side movements stay out of P&L.
- **Balance updates**: after tx inserts, `currentBalance` is diffed against SF's authoritative `balance` and rewritten when drift ≥ $0.01.
  - **Skipped for `BROKERAGE` and `RETIREMENT`**: SF reports cash-only for these, but `currentBalance` on your side often stores total value. The pull logs what SF said without writing so you can eyeball drift. A future `cashBalance` field would let SF write authoritatively for the cash portion.
- **Freshness stamps**: every mapped account gets `lastSimplefinSyncAt` + `lastSimplefinSyncDetails` (JSON: `{fromIso, toIso, txTotal, txNew, duplicates, balanceUpdated, balanceSkipped}`) on each `--apply` run — visible on `/finance/accounts/<id>` header. `balanceUpdatedAt` bumps whenever `currentBalance` actually changes (either from SF or from a manual edit on the account form).
- **Notes trace**: each SF-imported row gets `notes: sf:<sfTxId>` for traceability + so `sf:dedupe` can distinguish sources.

### What SimpleFIN doesn't give us

- **Per-lot trade history**: SF's holdings are aggregate positions (`AAPL: 15 shares`), not lot-by-lot cost basis. Trades and lots still come via `schwab.ts` CSV importer.
- **Principal/interest/escrow split on mortgage payments**: SF exposes only the aggregate `+3619.40 Payment` and separate escrow disbursements. The split lives in monthly PDF statements only.
- **Positions with market value populated**: for our bridge, `holdings[].market-value` comes back as `0`. `shares` + `symbol` are populated. Market value is layered on via `yahoo-finance2` quotes.

### Adding a new bank

1. Create the bridge connection on beta-bridge.simplefin.org, get a setup token.
2. `node scripts/simplefin_probe.mjs --setup-token=<token>` — replaces the old access URL in `.env.local` if you're re-provisioning, or just paste the printed URL into `.env.local` for the first time.
3. `npm run sf:probe` — see the new accounts.
4. For each new account, create (or find) the matching `financeAccount` in the admin UI, then paste its SF `ACT-…` id into the "SimpleFIN account id" field.
5. `npm run sf:pull -- --days=30` (dry-run), review the plan, then `--apply`.

### Common errors

- `InvalidParameterException: Missing required parameter auth parameters` — you forgot `COGNITO_USER`/`COGNITO_PASSWORD` in `.env.local`.
- `Missing SIMPLEFIN_ACCESS_URL` — same, for the access URL.
- `Request cannot be constructed from a URL that includes credentials` — should never happen now; the client extracts `user:pass` and sends `Authorization: Basic` instead. If it recurs, `_simplefin.mjs` was reverted.
- `Validation error of type VariableTypeMismatch: 'AWSDate!' doesn't match 'String'` — AppSync filter values on `date` fields go via `String!`, not `AWSDate!`. Already fixed in the pull script; if you write a new script, mirror the pattern.
