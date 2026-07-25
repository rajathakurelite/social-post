# Auto-reply (regex rules)

Local WhatsApp / Facebook inbound matching with optional auto-send. **Safe by default:** nothing is sent unless `AUTO_REPLY_ENABLED=true` **and** the matched rule has `enabled: true`.

## Quick start

1. Copy env flags from `.env.example`:
   - `AUTO_REPLY_ENABLED=false` (keep false until you are ready)
   - `WHATSAPP_VERIFY_TOKEN=` (for Meta webhook verification)
2. Start the operator API: `npm run dev:api` (or `npm run dev`).
3. Open the UI → **Auto-reply** tab.
4. Edit rules → **Save rules** → use **Test (dry-run)** with sample text.

Offline unit smoke (no network):

```bash
npm run smoke:auto-reply
```

## Rule shape

Stored in `config/auto_reply_rules.json`:

| Field | Description |
|-------|-------------|
| `id` | Stable id |
| `name` | Operator label |
| `enabled` | Must be true to match for live send |
| `platform` | `whatsapp` or `facebook` |
| `pattern` | JavaScript regex source |
| `flags` | e.g. `i`, `im` |
| `reply` | Template; `$1`, `$2`, … and `$&` (full match) |
| `cooldownSec` | Per chat+rule cooldown |
| `scope` | `any` \| `dm` \| `group` (stored; WA groups limited by Meta) |
| `priority` | Higher runs first |
| `tags` | Free-form labels for filtering / bulk enable-disable |
| `replyVariants` | A/B variants `[{ text, weight }]` (weighted random; replaces `reply`) |
| `quietHours` | `{ start: "22:00", end: "07:00", tzOffsetMinutes? }` — no sends inside window |
| `lang` | Only reply when detected inbound language matches (`en` / `hi`) |
| `canaryPercent` | 0–100; only auto-send for this % of chats (stable hash bucket) |
| `requireMention` | In groups, only reply when a `mentionTokens` token is present |
| `replyType` / `buttons` | `text` \| `buttons` \| `list` — WhatsApp interactive payload (opt-in) |
| `followUp` | `{ afterMinutes, text }` — queued after a live send; cancelled by takeover |
| `useContext` | Match against the last N inbound lines (conversation memory), not just this message |

Settings in `config/auto_reply_settings.json`: `matchMode` (`first`\|`all`), `maxRepliesPerHour`, `stopWords`, `ignoreList`, `businessHours` (shared send window), `escalationWords` (never auto-reply), `mentionTokens`, `allowedLinkDomains` (link guard), `approvalRequired` (queue replies for operator confirm), `notifyWebhookUrl` (ops ping after live send), `memoryWindow`, `llmFallback.enabled` (draft-only), `templates` (`{{tpl:id}}` snippets).

Rules are snapshotted to `config/auto_reply_history/` (last 10) on every save.

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/auto-reply/rules` | Rules + settings |
| PUT | `/api/auto-reply/rules` | Replace full list (`{ rules, settings? }`) |
| PUT | `/api/auto-reply/settings` | Settings only |
| POST | `/api/auto-reply/test` | `{ text, dryRun?: true }` — default dry, **does not send** |
| POST | `/api/auto-reply/keyword-to-regex` | Keyword helper |
| GET | `/api/auto-reply/log` | Recent matches from `output/auto-reply-log.jsonl` |
| GET | `/api/auto-reply/log.csv` | Match log as CSV download |
| GET | `/api/auto-reply/stats` | Counters (inbound/matches/sent/skips) + queue depths |
| GET | `/api/auto-reply/dlq` | Dead-letter queue of failed sends |
| POST | `/api/auto-reply/rules/bulk` | `{ ids, enabled }` bulk toggle |
| POST | `/api/auto-reply/rules/diff` | Preview added/removed/changed vs saved rules |
| GET | `/api/auto-reply/history` | Rules snapshots (versioning) |
| POST | `/api/auto-reply/explain` | `{ pattern, flags, sampleText? }` → group count, named groups, sample |
| GET/POST | `/api/auto-reply/takeover` | Pause/resume auto-reply per chat |
| GET/POST | `/api/auto-reply/approvals[/:id]` | Approval queue; `{ action: approve\|reject }` |
| GET/POST | `/api/auto-reply/followups[/run]` | Pending follow-ups; manual tick (dry-run by default) |
| POST | `/api/auto-reply/simulate` | Replay `{ messages: [...] }` — always dry-run |
| GET | `/api/webhooks/whatsapp` | Meta hub challenge if `WHATSAPP_VERIFY_TOKEN` set |
| POST | `/api/webhooks/whatsapp` | Signature-verified (`WHATSAPP_APP_SECRET`); match → send only if armed |
| GET/POST | `/api/webhooks/facebook` | Verify + matching; Messenger Send API only when armed + configured |

Offline chaos simulator: `npm run smoke:simulate` replays `config/sample_inbox.json` (duplicates, media, groups) through the engine — always dry-run.

## Example match

Inbound: `hello internship please`

Sample rule pattern: `hello\s+(internship)(\s+(.+))?` (flags `i`)

Rendered reply uses `$1` → `internship`.

## Safety

- Catastrophic-looking nested quantifiers are rejected on save.
- Pattern / reply length limits apply.
- Hourly rate cap and per-rule cooldown apply before send.
- Send-time guards (in order): mention guard → quiet hours → business hours → canary → link guard → cooldown → rate limit → approval queue.
- `X-Hub-Signature-256` verified when `WHATSAPP_APP_SECRET` is set (401 on mismatch); duplicate webhook message ids deduped for 24h.
- Failed sends land in `output/auto-reply-dlq.jsonl`, never retried blindly.
- Per-platform kill switches: `AUTO_REPLY_WHATSAPP_ENABLED` / `AUTO_REPLY_FACEBOOK_ENABLED`.
- Webhook POST always returns 200 to Meta after signature check; failures are logged.
- Never commit `.env` or verify tokens.
