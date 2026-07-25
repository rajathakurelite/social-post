# Error catalog (Wave-3 taxonomy)

API errors use `{ error, code, requestId }` (features 172, 212).

| Code | Cause | Operator fix |
|------|-------|--------------|
| `VALIDATION` | Bad request body / missing fields | Fix payload; see route docs |
| `NOT_FOUND` | Missing resource / disabled feature flag | Check id or `config/feature_flags.json` |
| `CONFLICT` | Duplicate name / conflicting state | Rename or overwrite intentionally |
| `RATE_LIMITED` | Too many mutations | Wait; check `RateLimit-*` headers |
| `PAUSED` | Panic switch active | `POST /api/ops/resume` |
| `DEMO` | `DEMO_MODE=true` | Unset demo mode for writes |
| `FORBIDDEN` | Dry-run pin / policy block | Clear `UI_FORCE_DRY_RUN` if intentional |
| `OLLAMA_DOWN` | Ollama unreachable | Start Ollama or `MOCK_OLLAMA=true` |
| `OLLAMA_CIRCUIT_OPEN` | Too many consecutive Ollama failures | Wait cooldown; check model health |
| `FB_TOKEN_EXPIRED` | Facebook token rejected (e.g. code 190) | Refresh Page token — see `docs/facebook.md` |
| `TWITTER_TOKEN_EXPIRED` | X auth rejected | Refresh OAuth — see `docs/twitter.md` |
| `LINKEDIN_TOKEN_EXPIRED` | LinkedIn 401 | Refresh token — see `docs/linkedin.md` |
| `YOUTUBE_TOKEN_EXPIRED` | YouTube OAuth invalid | Refresh — see `docs/youtube.md` |
| `WHATSAPP_TOKEN_EXPIRED` | WhatsApp Cloud token invalid | Refresh — see `docs/whatsapp.md` |
| `TOKEN_EXPIRED` | Generic auth expiry | Refresh platform credentials |
| `PUBLISH_LOCKED` | Concurrent live publish | Wait for in-flight live publish |
| `INTERNAL` | Unexpected server error | Check `output/api-access.jsonl` + console logs |
