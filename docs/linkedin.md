# LinkedIn

## What the skill does

`skills/post_linkedin.js` creates a post via the LinkedIn REST Posts API:

`POST https://api.linkedin.com/rest/posts`

Headers include `LinkedIn-Version` (default `202405`) and `X-Restli-Protocol-Version: 2.0.0`. Author is the URN in `LINKEDIN_AUTHOR_URN` (person or organization).

## Required `.env` vars

| Variable | Purpose |
|----------|---------|
| `LINKEDIN_ACCESS_TOKEN` | OAuth 2.0 access token |
| `LINKEDIN_AUTHOR_URN` | `urn:li:person:…` or `urn:li:organization:…` |

Optional: `LINKEDIN_VERSION` (default `202405`).

## Toggles

| Control | Role |
|---------|------|
| `LINKEDIN_ENABLED` | Hard on/off. Unset → enabled. `false` / `0` / `no` / `off` → skip. |
| `PLATFORMS` | Include `linkedin` in the comma list (when not using `--only=`). |
| `--only=linkedin` | Selects LinkedIn for this run **only if** `LINKEDIN_ENABLED` is not disabled. |

See [docs/README.md](./README.md) for how selection and enable flags combine.

## Credential collection (short)

1. Create/select a LinkedIn developer app; request posting products/scopes (`w_member_social` and/or `w_organization_social`).
2. Complete three-legged OAuth; store `access_token` → `LINKEDIN_ACCESS_TOKEN` (note expiry).
3. Set author URN to match token type: person vs organization → `LINKEDIN_AUTHOR_URN`.
4. Store in vault under exact env names.

**Detail:** root [README.md → Plugin: LinkedIn](../README.md#plugin-linkedin).

## Dry-run / live verify

```bash
node scripts/run.js --dry-run --only=linkedin "linkedin smoke"

# LINKEDIN_ENABLED=false → expect skip
node scripts/run.js --dry-run --only=linkedin "linkedin smoke"

node scripts/run.js --only=linkedin "linkedin live topic"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Skipped: missing config | Empty token or author URN |
| 4xx from Posts API | URN type mismatches token (person vs org), missing product approval, or expired token |
| Version errors | Stale `LINKEDIN_VERSION`; update per LinkedIn versioning docs |
| Skipped: `LINKEDIN_ENABLED=false` | Flag off |
