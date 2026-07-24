# YouTube

## What the skill does

`skills/post_youtube.js` uses **YouTube Data API v3** to update **title and description** of **one existing video** (`YOUTUBE_VIDEO_ID`):

1. `videos.list` (load current snippet)
2. `videos.update` (write new title/description)

It does **not** upload new video files or create Community posts. Access tokens come from refresh-token exchange (`utils/google_access_token.js`).

## Required `.env` vars

| Variable | Purpose |
|----------|---------|
| `YOUTUBE_CLIENT_ID` | Google OAuth client ID |
| `YOUTUBE_CLIENT_SECRET` | Google OAuth client secret |
| `YOUTUBE_REFRESH_TOKEN` | Refresh token for the channel-owning Google account |
| `YOUTUBE_VIDEO_ID` | Existing video id (`v=` in the watch URL) |

## Toggles

| Control | Role |
|---------|------|
| `YOUTUBE_ENABLED` | Hard on/off. Unset → enabled. `false` / `0` / `no` / `off` → skip. |
| `PLATFORMS` | Include `youtube` in the comma list (when not using `--only=`). |
| `--only=youtube` | Selects YouTube for this run **only if** `YOUTUBE_ENABLED` is not disabled. |

See [docs/README.md](./README.md) for how selection and enable flags combine.

## Credential collection (short)

1. Google Cloud project → enable **YouTube Data API v3**.
2. Configure OAuth consent + OAuth client; complete one-time consent for the channel owner.
3. Store `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` in the vault.
4. Set `YOUTUBE_VIDEO_ID` from `https://www.youtube.com/watch?v=VIDEO_ID` (OAuth account must be able to edit that video).

**Detail:** root [README.md → Plugin: YouTube](../README.md#plugin-youtube).

## Dry-run / live verify

```bash
node scripts/run.js --dry-run --only=youtube "youtube smoke"

# YOUTUBE_ENABLED=false → expect skip
node scripts/run.js --dry-run --only=youtube "youtube smoke"

# Live updates the configured video’s title/description
node scripts/run.js --only=youtube "youtube live topic"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Skipped: missing config | Any of the four required vars empty |
| 403 / insufficient permissions | Wrong Google account, missing YouTube scope, or video not owned by that channel |
| Invalid refresh / token errors | Revoked refresh token or wrong client id/secret pair |
| Video not found | Bad `YOUTUBE_VIDEO_ID` |
| Skipped: `YOUTUBE_ENABLED=false` | Flag off |
