/**
 * Vitest setup: runs before each test file.
 * - Redirects all auto-reply data files to a per-run temp directory so tests
 *   never touch operator rules/settings/logs.
 * - Injects FAKE credentials BEFORE config.js loads (.env values never win:
 *   dotenv does not override pre-set process.env) so no real secret can leak
 *   into test output or assertions.
 * - Points Ollama at an unreachable local port — tests must never need a model.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-social-agent-test-'));

process.env.AUTO_REPLY_RULES_PATH = path.join(tmpRoot, 'rules.json');
process.env.AUTO_REPLY_SETTINGS_PATH = path.join(tmpRoot, 'settings.json');
process.env.AUTO_REPLY_LOG_PATH = path.join(tmpRoot, 'log.jsonl');
process.env.AUTO_REPLY_DLQ_PATH = path.join(tmpRoot, 'dlq.jsonl');
process.env.AUTO_REPLY_HISTORY_DIR = path.join(tmpRoot, 'history');
process.env.AUTO_REPLY_TAKEOVER_PATH = path.join(tmpRoot, 'takeover.json');
process.env.AUTO_REPLY_APPROVALS_PATH = path.join(tmpRoot, 'approvals.json');

// Wave-3 stores (publish history, schedule queue, disk drafts, UTM settings)
process.env.PUBLISH_LOG_PATH = path.join(tmpRoot, 'publish-log.jsonl');
process.env.SCHEDULE_PATH = path.join(tmpRoot, 'schedule.json');
process.env.DRAFTS_PATH = path.join(tmpRoot, 'drafts.json');
process.env.UTM_SETTINGS_PATH = path.join(tmpRoot, 'utm_settings.json');
process.env.OPS_OUTPUT_DIR = tmpRoot;
process.env.OPS_PAUSE_FLAG_PATH = path.join(tmpRoot, 'ops-paused.flag');
process.env.OPS_PID_PATH = path.join(tmpRoot, 'api.pid');
delete process.env.UI_FORCE_DRY_RUN;
delete process.env.QUEUE_ARMED;
delete process.env.DEMO_MODE;
delete process.env.MOCK_OLLAMA;

// Safety rails: never live, never Ollama, never visual-mode Playwright renders.
process.env.DRY_RUN = 'true';
process.env.AUTO_REPLY_ENABLED = '';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.FACEBOOK_POST_MODE = 'text';

// Fake credentials (config.js reads env before .env because these are pre-set).
process.env.FB_PAGE_ID = '1234567890';
process.env.FB_PAGE_TOKEN = 'FAKE_FB_PAGE_TOKEN_do_not_leak_9f8e7d';
process.env.TWITTER_OAUTH2_ACCESS_TOKEN = 'FAKE_TW_TOKEN_do_not_leak_1a2b3c';
process.env.LINKEDIN_ACCESS_TOKEN = 'FAKE_LI_TOKEN_do_not_leak_4d5e6f';
process.env.LINKEDIN_AUTHOR_URN = 'urn:li:person:FAKE';
process.env.YOUTUBE_CLIENT_ID = 'FAKE_YT_CLIENT_ID';
process.env.YOUTUBE_CLIENT_SECRET = 'FAKE_YT_SECRET_do_not_leak_7g8h9i';
process.env.YOUTUBE_REFRESH_TOKEN = 'FAKE_YT_REFRESH_do_not_leak_0j1k2l';
process.env.YOUTUBE_VIDEO_ID = 'FAKEVIDEO';
process.env.WHATSAPP_ACCESS_TOKEN = 'FAKE_WA_TOKEN_do_not_leak_3m4n5o';
process.env.WHATSAPP_PHONE_NUMBER_ID = '10000000001';
process.env.WHATSAPP_TO = '15550000000';
process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
delete process.env.WHATSAPP_APP_SECRET;
delete process.env.FB_APP_SECRET;

export const testTmpRoot = tmpRoot;
