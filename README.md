# ai-social-agent

Production-oriented Node.js automation that uses **Ollama** (Gemma) to draft social copy and publishes to **Facebook Page**, **X (Twitter)**, **LinkedIn**, and **YouTube** (video metadata). Architecture is modular: each network lives under `skills/`.

## Prerequisites

- **Node.js 18+**
- **Ollama** reachable at `OLLAMA_URL` with your `MODEL` pulled
- Developer credentials per platform you enable (see below)

## Setup

```bash
cd ai-social-agent
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

Edit `.env` with real values. Set **`PLATFORMS`** to the list you want (default: all four).

## Run

```bash
node scripts/run.js "Indian history"
npm start -- "Indian history"
```

Run a subset:

```bash
node scripts/run.js --only=facebook,linkedin "Your topic"
```

The app generates one **multi-section** post via Ollama (`===FACEBOOK===`, `===TWITTER===`, etc.). Platforms without credentials are **skipped** with an info log (not a hard failure), except individual POST errors mark the run as failed (`exit code 1`).

## Ollama + Gemma

1. Install [Ollama](https://ollama.com).
2. `ollama pull <MODEL>` (match `MODEL` in `.env`, e.g. `gemma:7b-instruct`).
3. If Ollama runs on another machine, set `OLLAMA_URL` (for example `http://192.168.1.62:11434`).

## Facebook Page (Graph API)

1. [Meta for Developers](https://developers.facebook.com/) — app with **Pages** usage.
2. Page access token with **`pages_manage_posts`** (and related Page permissions your app requires).
3. `FB_PAGE_ID`, `FB_PAGE_TOKEN` in `.env`.

Posts go to **`/{page-id}/feed`** as a published Page post.

## Twitter / X (API v2)

Use **either**:

- **`TWITTER_OAUTH2_ACCESS_TOKEN`** — OAuth 2.0 **user** access token with **`tweet.write`** (and typically `tweet.read`, `users.read`), **or**
- **OAuth 1.0a user context:** `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`.

Optional: **`TWITTER_MAX_CHARS`** (default `280`).

## LinkedIn (REST Posts API)

1. LinkedIn app with **Share on LinkedIn** / community scopes (e.g. **`w_member_social`** for people, **`w_organization_social`** for organizations — match your token type).
2. **`LINKEDIN_ACCESS_TOKEN`**
3. **`LINKEDIN_AUTHOR_URN`** — `urn:li:person:...` or `urn:li:organization:...`

Uses **`POST https://api.linkedin.com/rest/posts`** with `LinkedIn-Version` (default **`202405`**; override with `LINKEDIN_VERSION`).

## YouTube (Data API v3)

Public **YouTube Data API** does **not** offer a supported way to create arbitrary “Community tab” text posts like the mobile app. This project **updates an existing video’s `snippet.title` and `snippet.description`** (useful for SEO and packaging the same narrative as Shorts/long-form).

1. Google Cloud project + **OAuth consent** + **YouTube Data API v3** enabled.
2. OAuth desktop or web credentials → **`YOUTUBE_CLIENT_ID`**, **`YOUTUBE_CLIENT_SECRET`**, **`YOUTUBE_REFRESH_TOKEN`** (with scopes including `https://www.googleapis.com/auth/youtube.force-ssl` or `youtube.upload` / `youtube` as appropriate).
3. **`YOUTUBE_VIDEO_ID`** — a video already on **your** channel.

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
| `scripts/run.js` | CLI orchestration |

## Security

Never commit **`.env`**. Rotate tokens if exposed.

## License

MIT
