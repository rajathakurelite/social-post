# Facebook Page

## What the skill does

`skills/post_facebook.js` supports two modes (env `FACEBOOK_POST_MODE`, default **`visual`**):

| Mode | API | Content |
|------|-----|---------|
| **visual** (default) | `POST /{page-id}/photos` | Short 3-line caption + branded PNG (HTML template → Playwright) |
| **text** | `POST /{page-id}/feed` | Classic long-form Page feed `message` (+ optional `link`) |

CLI override for one run: `--text-only` (forces text mode).

Default Graph version is `v19.0` (`FB_GRAPH_VERSION` optional override).

### Visual creative flow

1. Ollama returns structured fields: `FB_CAPTION`, `FB_HEADLINE`, `FB_ACCENT_WORD`, `FB_SUBHEAD`, `FB_BODY`, `FB_CTA_LABEL`
2. **Image source (pick one):**
   - **Auto creative (default):** `skills/render_creative.js` fills `templates/airepro-internship.html` and screenshots → `output/creatives/{timestamp}.png`
   - **Operator upload (UI):** `POST /api/upload` saves JPEG/PNG/WebP (max 5 MB) under `output/uploads/`. Pass `uploadId` to `/api/polish` and `/api/publish` — the upload **replaces** the auto creative for that Facebook photo post (not an extra attachment). Other networks stay text-only.
3. Live runs upload the image with caption via Photos API; **dry-run** (CLI or UI default) logs caption + image path and does **not** call Graph

Assets live under `assets/airepro/` (see that folder’s README). Install Chromium once:

```bash
npm install
npx playwright install chromium
```

## Required `.env` vars

| Variable | Purpose |
|----------|---------|
| `FB_PAGE_ID` | Numeric Page ID |
| `FB_PAGE_TOKEN` | Page access token with `pages_manage_posts` |

Optional:

| Variable | Purpose |
|----------|---------|
| `FB_GRAPH_VERSION` | Default `v19.0` |
| `FACEBOOK_POST_MODE` | `visual` (default) or `text` |
| `AIREPRO_INTERNSHIPS_URL` | CTA on creative (default `https://airepro.in/view/internships`) |

## Toggles

| Control | Role |
|---------|------|
| `FACEBOOK_ENABLED` | Hard on/off. Unset → enabled. `false` / `0` / `no` / `off` → skip. |
| `FACEBOOK_POST_MODE` | `visual` vs `text` |
| `PLATFORMS` | Include `facebook` in the comma list (when not using `--only=`). |
| `--only=facebook` | Selects Facebook for this run **only if** `FACEBOOK_ENABLED` is not disabled. |
| `--text-only` | Force text feed post for this run. |
| `--dry-run` | Generate caption (+ PNG in visual mode); no Graph publish. |

See [docs/README.md](./README.md) for how selection and enable flags combine.

## Credential collection (short)

1. Confirm Meta app / Page access and `pages_manage_posts` (plus typical discovery scopes).
2. Obtain numeric **Page ID** → `FB_PAGE_ID`.
3. Obtain a **Page access token** (prefer long-lived / System User for production) → `FB_PAGE_TOKEN`.
4. Store both in a secret manager labeled with those exact env names; map into local `.env` (never commit).

**Detail:** root [README.md → Plugin: Facebook Page](../README.md#plugin-facebook-page).

## Brand angles

CLI topics are **angles within the Airepro brand** (internships / freelance), not standalone subjects. Visual captions stay **3 short lines** (hook, brand line, Visit URL). Edit messaging in `config/brand/airepro.md` (or set `BRAND_PROFILE`). Dry-run logs the **full** Facebook caption and creative PNG path.

## Local operator UI (optional image)

```bash
npm run dev   # UI http://127.0.0.1:5173 — dry-run ON by default
```

Polish without an image → auto creative preview. Upload an image → polish/publish dry-run uses `imageSource: "upload"`. Never posts live unless you turn dry-run off.

## Dry-run / live verify

```bash
# Safe: generate 3-line caption + PNG under output/creatives/; no Graph publish
node scripts/run.js --dry-run --only=facebook "dream internship for students"

# Text-only mode (no PNG)
node scripts/run.js --dry-run --text-only --only=facebook "summer internships for students"

# Confirm disable flag works (expect skip, not publish)
# FACEBOOK_ENABLED=false
node scripts/run.js --dry-run --only=facebook "summer internships for students"

# Live (only with real Page creds and approval of the dry-run creative)
node scripts/run.js --only=facebook "dream internship for students"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Skipped: missing config | Empty `FB_PAGE_ID` or `FB_PAGE_TOKEN` |
| Skipped: `FACEBOOK_ENABLED=false` | Flag off (including under `--only=`) |
| Creative render / Playwright errors | Run `npx playwright install chromium` |
| Permission / OAuth errors from Graph | Token is not a Page token, wrong Page, or missing `pages_manage_posts` |
| Wrong Page / 404-style Graph errors | `FB_PAGE_ID` does not match the token’s Page |
| Photos upload fails | Token lacks publish permission, or image path invalid |
