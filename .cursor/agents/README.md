# ai-social-agent — Cursor subagents

Project-scoped specialists for this repo. Cursor delegates to them by `name` / `description`.

| Agent | Use when |
|-------|----------|
| [`content-generator`](./content-generator.md) | Ollama prompts, multi-platform pack parsing, copy quality |
| [`compose-ui-world-class`](./compose-ui-world-class.md) | Airepro `web/` compose UX, upload/preview, polish/publish, a11y (checklist 1–30) |
| [`social-automation`](./social-automation.md) | Regex auto-reply, webhooks, Wave-2 automation (checklist 31–100) |
| [`platform-wave3`](./platform-wave3.md) | Wave-3 feature catalog: compose/publish depth, reliability/ops, analytics/DX (checklist 101–270) |
| [`finish-wave`](./finish-wave.md) | Finish remaining Wave-3 (Batches 2–4); inventory partial work, ship IDs, offline gates, mark ✅ |
| [`facebook-publisher`](./facebook-publisher.md) | Facebook Page Graph feed posts |
| [`twitter-publisher`](./twitter-publisher.md) | X/Twitter OAuth1/OAuth2 + tweets |
| [`linkedin-publisher`](./linkedin-publisher.md) | LinkedIn REST posts + author URNs |
| [`youtube-publisher`](./youtube-publisher.md) | YouTube Data API title/description updates |
| [`whatsapp-publisher`](./whatsapp-publisher.md) | WhatsApp Cloud API + opt-in/compliance |
| [`credentials-ops`](./credentials-ops.md) | `.env`, vault handoff, assert helpers, `*_ENABLED` |
| [`runner-orchestrator`](./runner-orchestrator.md) | `scripts/run.js`, `PLATFORMS`, `*_ENABLED`, CLI flags |
| [`production-hardening`](./production-hardening.md) | Retries, dry-run, secrets, logging, CI |
| [`social-debugger`](./social-debugger.md) | API 4xx/5xx, skip vs fail, token expiry |
| [`verify-functionality`](./verify-functionality.md) | Smoke / dry-run / regression; verify all functionality before release |

## How to invoke

```
Use the content-generator subagent to tighten the multi-platform Ollama prompt.
Use the compose-ui-world-class subagent to polish the Airepro operator compose UX.
Use the social-automation subagent for regex auto-reply rules and WhatsApp webhooks.
Use the platform-wave3 subagent for Wave-3 features (publish history, retries, stats, DX).
Use the finish-wave subagent to complete Batches 2–4 and run offline gates.
Use the social-debugger subagent to diagnose LinkedIn 403s.
Use the production-hardening subagent before we ship.
Use the verify-functionality subagent to smoke-test dry-run and skip-vs-fail.
```

## Layout map

```
config/config.js          → credentials-ops, runner-orchestrator, verify-functionality
skills/generate_post.js   → content-generator, verify-functionality
skills/post_*.js          → *-publisher agents, verify-functionality
utils/*                   → twitter-publisher, youtube-publisher, production-hardening, verify-functionality
scripts/run.js            → runner-orchestrator, social-debugger, verify-functionality
web/ + server/index.js    → compose-ui-world-class, social-automation, verify-functionality
skills/auto_reply.js      → social-automation, verify-functionality
README.md / .env.example / docs/ → credentials-ops, runner-orchestrator, social-automation
```

## Rules for all agents

- Never commit `.env` or paste live tokens into chat/commits.
- Prefer minimal diffs that match existing ESM + `node-fetch` style.
- Platform plugins stay isolated under `skills/`; shared config stays in `config/config.js`.
