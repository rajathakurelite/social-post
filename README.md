# ai-social-agent

Production-oriented Node.js automation that uses **Ollama** (Gemma) to draft social copy and publishes to **Facebook Page**, **X (Twitter)**, **LinkedIn**, **YouTube** (video metadata), and **WhatsApp** (Business Cloud API). Each network is a small **plugin** under `skills/`.

---

## Table of contents

1. [Quick setup & run](#quick-setup--run)
2. [Team workflow — how members collect credentials](#team-workflow--how-members-collect-credentials)
3. [Environment variables quick reference](#environment-variables-quick-reference)
4. [Plugin: Ollama (AI generation)](#plugin-ollama-ai-generation)
5. [Plugin: Facebook Page](#plugin-facebook-page)
6. [Plugin: Twitter / X](#plugin-twitter--x)
7. [Plugin: LinkedIn](#plugin-linkedin)
8. [Plugin: YouTube](#plugin-youtube)
9. [Plugin: WhatsApp Business](#plugin-whatsapp-business)
10. [Running, platforms, and troubleshooting](#running-platforms-and-troubleshooting)
11. [Project layout](#project-layout)
12. [Security](#security)

---

## Quick setup & run

```bash
cd ai-social-agent
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

Fill `.env` using the sections below. Set **`PLATFORMS`** to only the networks you have configured (others are skipped automatically).

```bash
node scripts/run.js "Your topic"
npm start -- "Your topic"
node scripts/run.js --only=facebook,whatsapp "Your topic"
```

---

## Team workflow — how members collect credentials

### Suggested roles

| Role | Responsibility |
|------|------------------|
| **Platform owner** | Admin access on the Facebook Page, LinkedIn Page/org, YouTube channel, WhatsApp Business Account, X account. Approves app permissions and posts. |
| **Developer / DevOps** | Creates developer apps (Meta, Google Cloud, LinkedIn, X), enables APIs, stores secrets, maintains `.env` on servers. |
| **Content operator** | Runs the script with a topic; does **not** need raw tokens if a shared secure runner is used. |

### Rules for the whole team

1. **Never** paste access tokens, refresh tokens, or client secrets into chat, email, or public tickets. Use a **company-approved secret manager** (1Password, Bitwarden, Azure Key Vault, AWS Secrets Manager, etc.).
2. Label each secret in the vault with the **exact environment variable name** from `.env.example` (e.g. `FB_PAGE_TOKEN`).
3. **Rotate** any credential that was exposed or when a teammate leaves the project.
4. Prefer **long-lived Page / system user tokens** for production automation; document **who** can regenerate them.

### What each platform owner should deliver

Ask each owner to complete their checklist (below) and store values in the vault. **Developer** then maps them into `.env` on the machine that runs the agent.

**Minimum handoff template (copy for internal use):**

```text
Project: ai-social-agent
Collected by: [name]  Date: [date]

Ollama:
  [ ] OLLAMA_URL (who hosts it, firewall OK?)
  [ ] MODEL name verified with ollama list

Facebook:
  [ ] FB_PAGE_ID
  [ ] FB_PAGE_TOKEN (and expiry type: long-lived?)

Twitter/X:
  [ ] OAuth2 path OR OAuth1 path (which one?)
  [ ] Values stored under correct env names

LinkedIn:
  [ ] LINKEDIN_ACCESS_TOKEN (expiry?)
  [ ] LINKEDIN_AUTHOR_URN

YouTube:
  [ ] OAuth client created in which GCP project?
  [ ] YOUTUBE_CLIENT_ID / SECRET / REFRESH_TOKEN
  [ ] YOUTUBE_VIDEO_ID to update

WhatsApp:
  [ ] WHATSAPP_ACCESS_TOKEN source (temp vs system user)
  [ ] WHATSAPP_PHONE_NUMBER_ID
  [ ] WHATSAPP_TO (numbers opted in?)
```

---

## Environment variables quick reference

| Plugin | Required env vars | Optional |
|--------|-------------------|----------|
| **Ollama** | `OLLAMA_URL`, `MODEL` | — |
| **Facebook** | `FB_PAGE_ID`, `FB_PAGE_TOKEN` | `FB_GRAPH_VERSION` |
| **Twitter** | OAuth2: `TWITTER_OAUTH2_ACCESS_TOKEN` **or** OAuth1: `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET` | `TWITTER_MAX_CHARS` |
| **LinkedIn** | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN` | `LINKEDIN_VERSION` |
| **YouTube** | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_VIDEO_ID` | — |
| **WhatsApp** | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TO` | `WHATSAPP_GRAPH_VERSION` |
| **Runner** | — | `PLATFORMS` (comma list) |

---

## Plugin: Ollama (AI generation)

**What it does:** Calls `POST {OLLAMA_URL}/api/generate` to produce text sections for each social network.

### Information team members should collect

| Item | Env var | How to get it |
|------|---------|----------------|
| Server base URL | `OLLAMA_URL` | Whoever runs Ollama: `http://HOST:11434` (no trailing slash required). If remote, confirm firewall and `OLLAMA_HOST=0.0.0.0` (or OS equivalent) so LAN can reach it. |
| Model tag | `MODEL` | On the Ollama host: `ollama list`. Use the exact tag (e.g. `gemma:7b-instruct`). Run `ollama pull <tag>` if missing. |

### Steps for the person hosting Ollama

1. Install [Ollama](https://ollama.com) on a machine that can stay on during automation.
2. Pull the model: `ollama pull <MODEL>`.
3. From another PC on the same network, open `http://<ip>:11434` or run a test generate; if it fails, fix binding/firewall.
4. Share **`OLLAMA_URL`** and **`MODEL`** with DevOps via the secret manager or internal doc (URL is not as sensitive as tokens, but still internal).

---

## Plugin: Facebook Page

**What it does:** `POST https://graph.facebook.com/{version}/{page-id}/feed` — publishes a **Page post** (not a personal profile post).

### Permissions and products

- Meta app needs **Facebook Login** and/or use cases that include **Pages**.
- Token needs **`pages_manage_posts`** (and typically **`pages_read_engagement`**, **`pages_show_list`** for discovery tools).
- Use a **Page access token** that is valid for **your** Page.

### How a team member collects `FB_PAGE_ID`

1. Open [Meta Business Suite](https://business.facebook.com/) or the Page on facebook.com.
2. Page **Settings** → **Page transparency** or **About** — some Pages show **Page ID**.
3. Alternative: [Graph API Explorer](https://developers.facebook.com/tools/explorer/) — query `me/accounts` with a User token that manages the Page; each item has `id` (that is the **Page ID** for the API).

**Deliverable:** Numeric `FB_PAGE_ID` (e.g. `123456789012345`).

### How a team member collects `FB_PAGE_TOKEN`

1. Go to [Meta for Developers](https://developers.facebook.com/) → **My Apps** → select or create the app.
2. Add **Facebook Login** (or the Page-related use case your org uses).
3. In **App settings**, note **App ID** / roles: the person generating tokens needs **Admin** or **Developer** on the app.
4. Use **Graph API Explorer**:
   - Select the app, add permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.
   - **Generate User token** → extend to long-lived user token (per Meta docs).
   - Call `me/accounts` → find your Page → copy **`access_token`** next to that Page (**Page access token**).
5. For **production**, Meta recommends a **System User** + **Page** assignment to get a long-lived token (see [Long-lived Page access tokens](https://developers.facebook.com/docs/pages/access-tokens/)).

**Deliverable:** String `FB_PAGE_TOKEN` (treat as password). Note **expiry** and renewal owner.

### Optional: `FB_GRAPH_VERSION`

Default in code is `v19.0`. Change only if your org standardizes another version (e.g. `v21.0`).

---

## Plugin: Twitter / X

**What it does:** `POST https://api.twitter.com/2/tweets` with JSON `{ "text": "..." }`.

### Choose one authentication method for the team

| Method | Env vars | When to use |
|--------|----------|-------------|
| **OAuth 2.0 user** | `TWITTER_OAUTH2_ACCESS_TOKEN` | Fine-grained scopes; good when you already use OAuth2 user flow (PKCE) and store refresh/access tokens. Token must include **`tweet.write`**. |
| **OAuth 1.0a user** | `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET` | Classic “Consumer + Access” keys from the Developer Portal; app uses HMAC signing (see `utils/twitter_oauth1.js`). |

### How a team member collects OAuth 1.0a (common for automation)

1. Owner logs into [X Developer Portal](https://developer.twitter.com/en/portal/dashboard).
2. Create a **Project** and **App** (Elevated access may be required for posting — check current X policy).
3. Under **Keys and tokens**:
   - **Consumer Keys** → API Key and API Key Secret → map to `TWITTER_API_KEY` and `TWITTER_API_SECRET`.
   - **Access Token and Secret** (must be **Read and write** if you only see read-only, regenerate with write) → `TWITTER_ACCESS_TOKEN` and `TWITTER_ACCESS_TOKEN_SECRET`.
4. Store all four in the vault; never commit to git.

### How a team member collects OAuth 2.0 user token

1. Implement or use an internal OAuth2 **Authorization Code with PKCE** flow against X’s endpoints, with scopes **`tweet.read`**, **`tweet.write`**, **`users.read`** (adjust per X docs).
2. After authorization, persist **access token** (and usually **refresh token** if provided) securely.
3. Put the **access token** in `TWITTER_OAUTH2_ACCESS_TOKEN` (refresh logic is not in this repo — refresh before expiry or extend the app).

### Optional: `TWITTER_MAX_CHARS`

Default `280`. Increase only if the posting account supports longer posts per X rules.

---

## Plugin: LinkedIn

**What it does:** `POST https://api.linkedin.com/rest/posts` with headers `LinkedIn-Version` and `X-Restli-Protocol-Version: 2.0.0`.

### How a team member collects `LINKEDIN_ACCESS_TOKEN`

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/) → **Create app**.
2. Associate the app with a **Company Page** if posting as an organization.
3. Request products/scopes appropriate for posting:
   - **Sign In with LinkedIn** / **Share on LinkedIn** — exact product names change; you need **`w_member_social`** (post as person) or **`w_organization_social`** (post as org).
4. Complete **OAuth 2.0** authorization URL, get **authorization code**, exchange for **access token** (three-legged OAuth). Store **`access_token`** → `LINKEDIN_ACCESS_TOKEN`.
5. Note **expiry** (`expires_in`); plan refresh or re-auth.

### How a team member collects `LINKEDIN_AUTHOR_URN`

- **Person:** `urn:li:person:{id}` — `id` from [Profile API](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/profile) or LinkedIn’s “me” response using `r_liteprofile` / `openid` products as allowed.
- **Organization:** `urn:li:organization:{id}` — numeric org ID from your LinkedIn Page URL or Marketing API organization list.

**Deliverable:** Full URN string exactly as required by the API.

### Optional: `LINKEDIN_VERSION`

Monthly version header (default **`202405`**). If LinkedIn returns version errors, update to a current month from their [versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning) docs.

---

## Plugin: YouTube

**What it does:** Uses **YouTube Data API v3**: `videos.list` then `videos.update` to change **`title`** and **`description`** of **one existing video** (`YOUTUBE_VIDEO_ID`). It does **not** upload new video files or create Community posts.

### How a team member collects Google Cloud / OAuth values

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a **project**.
2. **APIs & Services** → **Library** → enable **YouTube Data API v3**.
3. **OAuth consent screen** — configure (Internal workspace vs External) and add scopes:
   - At minimum, scope that allows managing your videos, e.g. `https://www.googleapis.com/auth/youtube.force-ssl` (confirm latest scope list in Google docs).
4. **Credentials** → **Create credentials** → **OAuth client ID** (Desktop or Web, depending on how you run the one-time consent).
5. Run OAuth flow (Google’s OAuth Playground or a small script) to obtain **refresh token** for the channel owner account:
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `YOUTUBE_REFRESH_TOKEN`

**Deliverable:** Three values above, stored in vault. Document **which Google account** owns the channel.

### How a team member collects `YOUTUBE_VIDEO_ID`

1. Open the video on YouTube; URL looks like `https://www.youtube.com/watch?v=VIDEO_ID`.
2. The **`v=`** query value is `YOUTUBE_VIDEO_ID` (11-character id).

**Note:** The OAuth account must be able to **edit** that video (same channel).

---

## Plugin: WhatsApp Business

**What it does:** `POST https://graph.facebook.com/{version}/{phone-number-id}/messages` — sends a **text** message to phone number(s) in `WHATSAPP_TO`.

### Compliance (whole team must understand)

- Recipients must **opt in** to messages from your business.
- **24-hour session window:** free-form text is for active conversations; **outside** that window Meta usually requires **approved message templates**. This codebase sends **session text** only — if you hit errors, work with your Meta admin to add **templates** and extend the code.

### How a team member collects `WHATSAPP_PHONE_NUMBER_ID` and token

1. [Meta for Developers](https://developers.facebook.com/) → same or separate app → add **WhatsApp** product.
2. **WhatsApp → API Setup**:
   - Copy **Temporary access token** for testing (expires) **or** set up **System User** + assign WhatsApp assets for production (long-lived).
   - Copy **Phone number ID** (numeric) — this is **`WHATSAPP_PHONE_NUMBER_ID`**. It is **not** the same as the display phone string.
3. Put token in **`WHATSAPP_ACCESS_TOKEN`**.

### How a team member collects `WHATSAPP_TO`

- E.164 **digits only**, country code included, **no** `+` or spaces.
- Example US: `15551234567`. Example UK: `447700900123`.
- Multiple numbers: comma-separated list. Each recipient must be **allowed** in your WhatsApp settings (test numbers in dev).

**Deliverable:** Confirm with **legal/compliance** that use case and opt-in are satisfied.

### Optional: `WHATSAPP_GRAPH_VERSION`

Default **`v21.0`**. Align with Meta’s current Graph version if your app is pinned elsewhere.

---

## Running, platforms, and troubleshooting

- **`PLATFORMS`** — comma list: `facebook,twitter,linkedin,youtube,whatsapp`. Missing credentials → **skip** with log; API failure → **exit code 1** for that run.
- **Preview** — logs show a short preview for Twitter; check full text in Ollama output during debugging.
- **Facebook “permission” errors** — re-check Page token and that the token includes `pages_manage_posts` for that Page.
- **LinkedIn 4xx** — wrong `LINKEDIN_AUTHOR_URN` vs token type (person vs org), or missing product approval.
- **YouTube 403** — scope or wrong Google account vs video owner.
- **WhatsApp template / window errors** — use templates or reply inside session window.

---

## Project layout

| Path | Role |
|------|------|
| `config/config.js` | Env loading, platform toggles, assertion helpers |
| `utils/logger.js` | `info`, `error`, `success` |
| `utils/twitter_oauth1.js` | OAuth 1.0a signing for X |
| `utils/google_access_token.js` | Google refresh-token → access token |
| `skills/generate_post.js` | Ollama `/api/generate`, multi-platform parsing |
| `skills/post_facebook.js` | Page feed |
| `skills/post_twitter.js` | `POST /2/tweets` |
| `skills/post_linkedin.js` | LinkedIn `rest/posts` |
| `skills/post_youtube.js` | `videos.list` + `videos.update` |
| `skills/post_whatsapp.js` | WhatsApp Cloud API text messages |
| `scripts/run.js` | CLI orchestration |

---

## Security

- Never commit **`.env`** or tokens.
- Restrict who can **regenerate** Meta/Google/LinkedIn/X credentials.
- Use least privilege: tokens only for the Pages/channels needed.

---

## License

MIT
