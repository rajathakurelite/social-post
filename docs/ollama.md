# Ollama (AI generation)

## What the skill does

`skills/generate_post.js` calls Ollama to draft multi-platform copy:

`POST {OLLAMA_URL}/api/generate`

Every prompt injects the brand brief from `config/brand/{BRAND_PROFILE}.md` (default **airepro**). The CLI topic is an **angle** within that brand (e.g. remote internships)—edit `config/brand/airepro.md` to update messaging without code changes.

The runner checks `/api/tags` before generate. Unreachable host or missing `MODEL` fails with an actionable message (`ollama serve` / `ollama pull`). Generation failure exits the whole run with code **1** (platforms never publish without successful copy).

Defaults if unset: `OLLAMA_URL=http://localhost:11434`, `MODEL=gemma:7b-instruct`, `BRAND_PROFILE=airepro`.

## Required `.env` vars

| Variable | Purpose |
|----------|---------|
| `OLLAMA_URL` | Base URL of the Ollama server (no trailing slash required) |
| `MODEL` | Exact model tag from `ollama list` (e.g. `gemma:7b-instruct`) |
| `BRAND_PROFILE` | Optional. Brand brief file under `config/brand/` (default `airepro`) |

Related ops (optional): `OLLAMA_TIMEOUT_MS` (default `120000`), `HTTP_TIMEOUT_MS`, `HTTP_RETRIES`.

There is **no** `OLLAMA_ENABLED` flag — Ollama is a generation prerequisite, not a publish platform.

## Toggles (platforms only)

Ollama always runs when you invoke the runner with a topic. Platform publishing is controlled separately via `PLATFORMS`, `--only=`, and `*_ENABLED` (see [docs/README.md](./README.md)).

Dry-run still **calls Ollama** and logs previews; it only skips publish APIs.

## Credential / setup collection (short)

1. Install [Ollama](https://ollama.com) on a host that stays up during automation.
2. `ollama pull <MODEL>`; confirm with `ollama list`.
3. Share `OLLAMA_URL` and `MODEL` with DevOps (URL is less sensitive than tokens, but still treat as internal).
4. If remote: bind/firewall so clients can reach port `11434`.

**Detail:** root [README.md → Plugin: Ollama](../README.md#plugin-ollama-ai-generation).

## Dry-run / live verify

```bash
# Confirms Ollama reachability + model + section parsing (no publish)
node scripts/run.js --dry-run "ollama smoke"

# Same generation path; then publishes to enabled/selected platforms
node scripts/run.js --only=facebook "ollama + facebook live"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Cannot reach Ollama / connection errors | Wrong `OLLAMA_URL`, Ollama not running, firewall |
| Model not found | Tag mismatch; run `ollama pull <MODEL>` |
| Generate timeout | Slow model/host; raise `OLLAMA_TIMEOUT_MS` |
| Exit code 1 before any platform logs | Generation failed — fix Ollama first |
