# Twitter / X

## What the skill does

`skills/post_twitter.js` creates a tweet via API v2:

`POST https://api.twitter.com/2/tweets` with JSON `{ "text": "..." }`.

Auth is **either** OAuth 2.0 user token **or** OAuth 1.0a user context (HMAC). Text is truncated to `TWITTER_MAX_CHARS` (default 280).

## Required `.env` vars

Use **one** auth path:

| Method | Variables |
|--------|-----------|
| **OAuth 2.0** | `TWITTER_OAUTH2_ACCESS_TOKEN` (must include `tweet.write`) |
| **OAuth 1.0a** | `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET` |

Optional: `TWITTER_MAX_CHARS` (default `280`).

## Toggles

| Control | Role |
|---------|------|
| `TWITTER_ENABLED` | Hard on/off. Unset → enabled. `false` / `0` / `no` / `off` → skip. |
| `PLATFORMS` | Include `twitter` in the comma list (when not using `--only=`). |
| `--only=twitter` | Selects X for this run **only if** `TWITTER_ENABLED` is not disabled. |

See [docs/README.md](./README.md) for how selection and enable flags combine.

## Credential collection (short)

1. In the [X Developer Portal](https://developer.twitter.com/en/portal/dashboard), create/select Project + App with write access.
2. **OAuth 1.0a (common for automation):** Consumer Key/Secret → `TWITTER_API_KEY` / `TWITTER_API_SECRET`; Access Token/Secret with **Read and write** → `TWITTER_ACCESS_TOKEN` / `TWITTER_ACCESS_TOKEN_SECRET`.
3. **OAuth 2.0:** Complete user PKCE flow with `tweet.write`; put access token in `TWITTER_OAUTH2_ACCESS_TOKEN` (refresh is not built into this repo).
4. Vault-label with exact env names; never commit secrets.

**Detail:** root [README.md → Plugin: Twitter / X](../README.md#plugin-twitter--x).

## Dry-run / live verify

```bash
node scripts/run.js --dry-run --only=twitter "twitter smoke"

# TWITTER_ENABLED=false → expect skip even with --only=
node scripts/run.js --dry-run --only=twitter "twitter smoke"

# Live (approved + configured auth)
node scripts/run.js --only=twitter "twitter live topic"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Skipped: no Twitter credentials | Neither OAuth2 token nor full OAuth1 quartet set |
| Config / assert failure | Partial OAuth1 set (missing one of the four keys) |
| 401 / 403 from API | Wrong keys, read-only access token, or OAuth2 missing `tweet.write` |
| Text truncated oddly | `TWITTER_MAX_CHARS` too low for premium/long-form accounts |
| Skipped: `TWITTER_ENABLED=false` | Flag off |
