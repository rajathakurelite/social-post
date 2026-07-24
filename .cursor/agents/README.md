# ai-social-agent — Cursor subagents

Project-scoped specialists for this repo. Cursor delegates to them by `name` / `description`.

| Agent | Use when |
|-------|----------|
| [`content-generator`](./content-generator.md) | Ollama prompts, multi-platform pack parsing, copy quality |
| [`facebook-publisher`](./facebook-publisher.md) | Facebook Page Graph feed posts |
| [`twitter-publisher`](./twitter-publisher.md) | X/Twitter OAuth1/OAuth2 + tweets |
| [`linkedin-publisher`](./linkedin-publisher.md) | LinkedIn REST posts + author URNs |
| [`youtube-publisher`](./youtube-publisher.md) | YouTube Data API title/description updates |
| [`whatsapp-publisher`](./whatsapp-publisher.md) | WhatsApp Cloud API + opt-in/compliance |
| [`credentials-ops`](./credentials-ops.md) | `.env`, vault handoff, assert helpers |
| [`runner-orchestrator`](./runner-orchestrator.md) | `scripts/run.js`, `PLATFORMS`, CLI flags |
| [`production-hardening`](./production-hardening.md) | Retries, dry-run, secrets, logging, CI |
| [`social-debugger`](./social-debugger.md) | API 4xx/5xx, skip vs fail, token expiry |
| [`verify-functionality`](./verify-functionality.md) | Smoke / dry-run / regression; verify all functionality before release |

## How to invoke

```
Use the content-generator subagent to tighten the multi-platform Ollama prompt.
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
README.md / .env.example  → credentials-ops
```

## Rules for all agents

- Never commit `.env` or paste live tokens into chat/commits.
- Prefer minimal diffs that match existing ESM + `node-fetch` style.
- Platform plugins stay isolated under `skills/`; shared config stays in `config/config.js`.
