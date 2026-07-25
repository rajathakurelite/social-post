# Compose & publish (Wave-3, features 101–150)

Operator console depth on top of the base compose → polish → publish flow. Everything defaults to **dry-run**; live sends still require the existing armed/confirmed path.

## Operator UI

| Area | What it does |
|------|----------------|
| **History** tab | Lists `output/publish-log.jsonl` with platform chips + dry-run badges; calendar strip merges history + schedule |
| **Schedule** | Datetime on the publish bar queues to `output/schedule.json` instead of publishing |
| **Brand voice** | Formal ↔ playful tone injected into polish prompts |
| **Hashtag packs** | Named packs from `config/hashtag_packs.json`, appended without overflowing platform caps |
| **UTM** | Optional campaign slug applied to `airepro.in` links at polish time |
| **Drafts** | Named disk drafts in `output/drafts.json` (plus existing sessionStorage draft) |
| **Lint** | Emoji/tone, banned words, handles, URLs, brand presence — banned words block publish until acknowledged |
| **Thread / chapters / tags** | X thread preview, YouTube chapter hints + tag field, LinkedIn first-comment stub (copy-only) |

## Safety flags

| Env | Effect |
|-----|--------|
| `UI_FORCE_DRY_RUN=true` | Hides/locks the live toggle; `POST /api/publish` with `dryRun:false` returns **403** |
| `QUEUE_ARMED=true` | Allows the queue runner to honor schedules queued with `dryRun:false` (default: always dry-run) |

```bash
# Process due schedule entries (dry-run unless QUEUE_ARMED=true)
node scripts/queue-runner.js
# or: npm run queue:run
```

## Useful APIs

- `GET /api/publish/history?limit=N` — newest first; non-numeric limit → 400
- `POST /api/schedule` — save draft + `fireAt` (dryRun forced true by default)
- `GET/POST /api/drafts` — disk draft autosave / named drafts
- `GET/PUT /api/compose/utm` — UTM on/off + campaign slug
- `GET /api/compose/hashtag-packs` · `best-times` · `topic-chips` · `lint-config` · `link-slugs`
- `POST /api/polish` with `{ only: "twitter" }` — regenerate one platform card
- `POST /api/publish` with `dryRunByPlatform` — mixed dry-run / live per platform (when not force-pinned)

Config JSON lives under `config/` (`hashtag_packs.json`, `best_times.json`, `content_lint.json`, `link_slugs.json`). Outputs land in `output/` (`publish-log.jsonl`, `schedule.json`, `drafts.json`).

## Verify offline

```bash
npm test
npm run smoke:ui
```

`smoke:ui` hits history/schedule/drafts/upload/dry-run publish + the queue runner without calling social networks. Full Ollama polish is optional when the model is up.
