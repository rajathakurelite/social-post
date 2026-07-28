# Kimi with ai-social-agent

Operator runbook for using **Kimi-related models** through this project's Ollama integration (`skills/generate_post.js` → `POST {OLLAMA_URL}/api/generate`).

This project does **not** call Moonshot/Kimi APIs directly. All generation goes through **Ollama** (typically the Docker container named `ollama` on `127.0.0.1:11434`). Which Kimi option you get depends only on the `MODEL` tag and whether that tag is local or Ollama Cloud.

See also: [Ollama](./ollama.md) (general generation setup), root [README → Plugin: Ollama](../README.md#plugin-ollama-ai-generation).

---

## When you can use Kimi (availability)

There is **no weekday / calendar schedule** for Kimi in this project. Access is gated by **Docker + RAM** (local) or **Ollama account + paid Cloud subscription** (official K2.x cloud tags)—not by day of week.

### Local free — any day, anytime Docker is up

| | |
|--|--|
| **Tag** | `richardyoung/kimi-vl-a3b-thinking:iq4_xs` |
| **Cost** | Free (community GGUF; no Ollama Cloud subscription) |
| **When usable** | **Every day**, as long as the `ollama` Docker container is running and listening on `127.0.0.1:11434`, and the machine has enough RAM for the model (~**8.8 GB** weights; allow extra headroom for OS + inference) |
| **Sign-in** | Not required for this local tag |

This is the practical “use Kimi for free on this machine” path. Pull once, then use whenever the container is up—no Mon–Fri-only limits, no subscription clock.

### Official Kimi K2.x cloud — any day with an active subscription

| | |
|--|--|
| **Tags** | e.g. `kimi-k2.6:cloud` (and other official library `kimi-k2.*:cloud` entries) |
| **Cost** | Requires **Ollama account sign-in** **and** a **paid Ollama Cloud subscription** |
| **When usable** | **Any day** while the subscription is active and the Docker Ollama instance is signed in / can reach Ollama Cloud |
| **Without sign-in** | Typically **401 Unauthorized** |
| **Without subscription** | Typically **403** (subscription / plan required) |

Cloud access is **subscription-gated**, not calendar-gated. There is no “only on certain weekdays” rule in this repo or in the local setup—if you are signed in and subscribed, you can use cloud tags any day; if not, they fail regardless of the day.

### Full local Kimi K2 — not practical here

Official / full **local Kimi K2** (~**1T** parameters / hundreds of GB RAM, e.g. workstation-class pulls such as `batiai/kimi-k2.6:iq3` needing on the order of **≥384 GB**) is **not practical** on a typical developer machine used with this project. Prefer the local A3B GGUF above, or cloud K2.x if you have an Ollama Cloud plan.

---

## Current project config

Generation always needs:

| Variable | Role |
|----------|------|
| `OLLAMA_URL` | Ollama base URL (no trailing slash required). With Docker on the host: `http://127.0.0.1:11434` |
| `MODEL` | Exact tag from `ollama list` / `/api/tags` |

Defaults if unset (see `config/config.js` / [ollama.md](./ollama.md)): `OLLAMA_URL=http://localhost:11434`, `MODEL=gemma:7b-instruct`.

`.env.example` documents the Kimi-related options as comments next to `MODEL`:

```env
OLLAMA_URL=http://127.0.0.1:11434
MODEL=gemma:7b-instruct
# Local free Moonshot/Kimi (community GGUF, ~8.8GB): MODEL=richardyoung/kimi-vl-a3b-thinking:iq4_xs
# Cloud via Docker Ollama (needs ollama signin / subscription): MODEL=kimi-k2.6:cloud
```

### Recommended free local tag

For free local Kimi-related copy on this stack:

```env
OLLAMA_URL=http://127.0.0.1:11434
MODEL=richardyoung/kimi-vl-a3b-thinking:iq4_xs
```

Pull once (from a shell that can talk to the same Ollama instance the app uses—e.g. `docker exec` into `ollama`, or host `ollama` CLI if it points at the same server):

```bash
ollama pull richardyoung/kimi-vl-a3b-thinking:iq4_xs
ollama list
```

### Switch back to Gemma (default-style local)

```env
MODEL=gemma:7b-instruct
```

Ensure the tag is pulled (`ollama pull gemma:7b-instruct`) before running.

### Switch to official cloud K2.x

```env
MODEL=kimi-k2.6:cloud
```

Prerequisites:

1. Docker `ollama` container running and reachable at `OLLAMA_URL`.
2. `ollama signin` (or equivalent signed-in session for that Ollama instance).
3. Active **paid Ollama Cloud** subscription.

Without (2) expect **401**; without (3) expect **403**. This project does not bypass those gates.

Optional timeout (thinking / larger models may need more than the default 120s):

```env
# OLLAMA_TIMEOUT_MS=120000
```

There is **no** `OLLAMA_ENABLED` flag—Ollama is required for generation whenever you run the CLI/UI generate path (unless `MOCK_OLLAMA=true` for offline/canned tests).

---

## Day-to-day usage checklist

1. **Start Ollama (Docker)**  
   ```bash
   docker start ollama
   ```  
   Confirm it is listening: browser or `curl http://127.0.0.1:11434/api/tags` (or open the tags URL). `OLLAMA_URL` in `.env` should match (`http://127.0.0.1:11434`).

2. **Verify the model tag is present**  
   ```bash
   ollama list
   # or: curl http://127.0.0.1:11434/api/tags
   ```  
   `MODEL` in `.env` must match the listed name **exactly** (including `:iq4_xs` / `:cloud`).

3. **Dry-run generation (safe — no publish APIs)**  
   ```bash
   node scripts/run.js --dry-run "kimi smoke"
   ```  
   Dry-run still **calls Ollama** and logs section previews; it only skips platform publish. Failure here is an Ollama/`MODEL` problem, not Facebook/etc.

4. **Live publish**  
   Out of scope for this doc unless platform credentials are already configured and you intentionally run without `--dry-run`. Generation must succeed first; if Ollama fails, the runner exits **1** and platforms never publish. See per-platform guides under [docs/README.md](./README.md).

5. **UI / operator console**  
   Same `OLLAMA_URL` + `MODEL` apply when the server generates/polishes copy. Prefer dry-run / `UI_FORCE_DRY_RUN` until you mean to publish live.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|----------------|------------|
| **401 Unauthorized** (cloud tags) | Not signed in to Ollama / cloud session missing | `ollama signin` on the instance that serves `OLLAMA_URL`; retry. Local GGUF tag should not need this. |
| **403** (subscription / forbidden) | No active Ollama Cloud subscription (or plan does not allow the cloud model) | Subscribe / fix plan, or switch `MODEL` to local free `richardyoung/kimi-vl-a3b-thinking:iq4_xs` |
| **Ollama unreachable** / connection errors | Container stopped, wrong `OLLAMA_URL`, port not mapped | `docker start ollama`; confirm `http://127.0.0.1:11434`; fix `.env` |
| **Model not found** | Tag not pulled or `MODEL` typo | `ollama pull <exact MODEL>`; align `.env` with `ollama list` |
| **Generate timeout** | Slow host / large or thinking model; default `OLLAMA_TIMEOUT_MS` (120000) too low | Raise `OLLAMA_TIMEOUT_MS`; free RAM; avoid running heavy apps alongside ~8.8 GB local model |
| **Exit code 1 before any platform logs** | Generation failed | Fix Ollama/`MODEL` first ([ollama.md](./ollama.md)); platforms never run without successful copy |
| **OOM / container killed** during local Kimi | Insufficient RAM for ~8.8 GB model + runtime | Free memory, close other apps, or use a smaller/`gemma` model; do not attempt full local K2 |

Cloud vs local quick check: if `MODEL` ends with `:cloud`, treat failures as **auth/subscription** until proven otherwise. If it is the `richardyoung/...:iq4_xs` tag, treat failures as **Docker / pull / RAM / timeout**.

---

## Quick reference

| Model tag | Cost | When usable | RAM / notes |
|-----------|------|-------------|-------------|
| `richardyoung/kimi-vl-a3b-thinking:iq4_xs` | Free | **Any day** — whenever Docker `ollama` is up on `127.0.0.1:11434` | ~**8.8 GB** weights; recommended free local Kimi-related option |
| `kimi-k2.6:cloud` (and other official `kimi-k2.*:cloud`) | Paid Ollama Cloud + sign-in | **Any day** with active subscription + signed-in Ollama | Cloud-hosted; **401** without sign-in, **403** without subscription; no weekday-only schedule |
| `gemma:7b-instruct` | Free (local) | Any day Docker/Ollama is up | Project default-style local model; switch `MODEL` back to this to leave Kimi |
| Full local Kimi K2 (~1T) | N/A (impractical) | Not usable on typical machines for this project | Hundreds of GB RAM (e.g. iq3-class workstation pulls); do not plan on it here |

---

## Plain answer: “What days can I use Kimi?”

- **Local free tag** (`richardyoung/kimi-vl-a3b-thinking:iq4_xs`): **any day** — no calendar restriction; only need the `ollama` container running and enough RAM.
- **Official cloud K2.x**: **any day** you have an **active Ollama Cloud subscription** and a signed-in Ollama instance; not limited to certain weekdays.
- **Full local K2**: effectively **no** on this machine class.
