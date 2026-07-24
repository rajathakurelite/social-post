# Platform guides

Per-network docs for **ai-social-agent**: what each skill does, required env vars, how to turn platforms on/off, and how to verify safely.

| Guide | Skill | Env enable flag |
|-------|--------|-----------------|
| [Ollama](./ollama.md) | `skills/generate_post.js` | — (always required for generation) |
| [Facebook Page](./facebook.md) | `skills/post_facebook.js` | `FACEBOOK_ENABLED` |
| [Twitter / X](./twitter.md) | `skills/post_twitter.js` | `TWITTER_ENABLED` |
| [LinkedIn](./linkedin.md) | `skills/post_linkedin.js` | `LINKEDIN_ENABLED` |
| [YouTube](./youtube.md) | `skills/post_youtube.js` | `YOUTUBE_ENABLED` |
| [WhatsApp](./whatsapp.md) | `skills/post_whatsapp.js` | `WHATSAPP_ENABLED` |

Full credential collection steps, team vault handoff, and plugin detail live in the root [README.md](../README.md).

---

## How `PLATFORMS` and `*_ENABLED` interact

Publishing selection is a **two-step filter**:

1. **Select candidates** from `PLATFORMS` (comma-separated), or from CLI `--only=` when that flag is passed.
2. **Drop** any platform whose `*_ENABLED` flag is off.

### Enable flags

| Variable | Platform id |
|----------|-------------|
| `FACEBOOK_ENABLED` | `facebook` |
| `TWITTER_ENABLED` | `twitter` |
| `LINKEDIN_ENABLED` | `linkedin` |
| `YOUTUBE_ENABLED` | `youtube` |
| `WHATSAPP_ENABLED` | `whatsapp` |

**Parsing rules:**

- **Unset** → treated as **enabled** (backward compatible).
- **Disabled** when the value is `false`, `0`, `no`, or `off` (case-insensitive).
- Any other non-empty value (e.g. `true`, `1`, `yes`) → enabled.

**`--only=` still respects `*_ENABLED=false`.** Example: `--only=facebook` with `FACEBOOK_ENABLED=false` skips Facebook (hard off-switch for production safety). Expect a skip log such as `Skipping facebook: FACEBOOK_ENABLED=false`, distinct from missing-credentials skips.

### Typical setups

```env
# Publish only networks you care about (selection)
PLATFORMS=facebook,twitter,linkedin

# Hard-disable WhatsApp even if listed or passed via --only=
WHATSAPP_ENABLED=false
```

```bash
# Candidates from PLATFORMS, then filter by *_ENABLED
node scripts/run.js "Your topic"

# Narrow candidates for this run; still blocked if ENABLED=false
node scripts/run.js --only=facebook,whatsapp "Your topic"
```

### Missing credentials vs disabled

| Situation | Behavior |
|-----------|----------|
| Platform not in `PLATFORMS` / `--only=` | Not selected |
| `*_ENABLED=false` (etc.) | Skipped (disabled by flag) |
| Selected + enabled, but env incomplete | Skipped (missing credentials) |
| Selected + enabled + creds OK, API fails | Platform fails; process exit **1** |
| Generation (Ollama) fails | Process exit **1** |

---

## Safe verify commands

```bash
# Generate only — no publish APIs
node scripts/run.js --dry-run "smoke topic"
# or: DRY_RUN=1 node scripts/run.js "smoke topic"

# One network (still respects *_ENABLED)
node scripts/run.js --dry-run --only=facebook "smoke topic"
```

Live posts require real credentials and should only run after dry-run looks good. See each platform guide for live verify examples.
