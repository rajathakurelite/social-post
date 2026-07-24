# Facebook Page

## What the skill does

`skills/post_facebook.js` publishes a **Page feed post** (not a personal profile):

`POST https://graph.facebook.com/{version}/{page-id}/feed`

Default Graph version is `v19.0` (`FB_GRAPH_VERSION` optional override).

## Required `.env` vars

| Variable | Purpose |
|----------|---------|
| `FB_PAGE_ID` | Numeric Page ID |
| `FB_PAGE_TOKEN` | Page access token with `pages_manage_posts` |

Optional: `FB_GRAPH_VERSION` (default `v19.0`).

## Toggles

| Control | Role |
|---------|------|
| `FACEBOOK_ENABLED` | Hard on/off. Unset → enabled. `false` / `0` / `no` / `off` → skip. |
| `PLATFORMS` | Include `facebook` in the comma list (when not using `--only=`). |
| `--only=facebook` | Selects Facebook for this run **only if** `FACEBOOK_ENABLED` is not disabled. |

See [docs/README.md](./README.md) for how selection and enable flags combine.

## Credential collection (short)

1. Confirm Meta app / Page access and `pages_manage_posts` (plus typical discovery scopes).
2. Obtain numeric **Page ID** → `FB_PAGE_ID`.
3. Obtain a **Page access token** (prefer long-lived / System User for production) → `FB_PAGE_TOKEN`.
4. Store both in a secret manager labeled with those exact env names; map into local `.env` (never commit).

**Detail:** root [README.md → Plugin: Facebook Page](../README.md#plugin-facebook-page).

## Dry-run / live verify

```bash
# Safe: generate + preview; no Graph publish
node scripts/run.js --dry-run --only=facebook "facebook smoke"

# Confirm disable flag works (expect skip, not publish)
# FACEBOOK_ENABLED=false
node scripts/run.js --dry-run --only=facebook "facebook smoke"

# Live (only with real Page creds and approval)
node scripts/run.js --only=facebook "facebook live topic"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Skipped: missing config | Empty `FB_PAGE_ID` or `FB_PAGE_TOKEN` |
| Skipped: `FACEBOOK_ENABLED=false` | Flag off (including under `--only=`) |
| Permission / OAuth errors from Graph | Token is not a Page token, wrong Page, or missing `pages_manage_posts` |
| Wrong Page / 404-style Graph errors | `FB_PAGE_ID` does not match the token’s Page |
