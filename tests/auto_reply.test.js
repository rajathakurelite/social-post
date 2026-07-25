import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import {
  matchRules,
  formatReply,
  keywordToRegex,
  validatePatternSafety,
  validateFlags,
  validateRulesList,
  normalizeRule,
  defaultSampleRules,
  processInbound,
  isAutoReplyEnabled,
  platformAutoReplyEnabled,
  expandTemplates,
  pickReplyVariant,
  renderRuleReply,
  detectLanguage,
  inQuietHours,
  withinBusinessHours,
  canaryAllows,
  canaryBucket,
  linkGuard,
  hasMention,
  explainPattern,
  buildReplyPayload,
  isDuplicateMessage,
  saveRules,
  loadRules,
  loadSettings,
  saveSettings,
  diffRules,
  listRuleSnapshots,
  setTakeover,
  isTakenOver,
  loadTakeovers,
  listApprovals,
  resolveApproval,
  listFollowUps,
  processFollowUps,
  getStats,
  resetEngineState,
  readDlq,
  matchLogToCsv,
  simulateInbox,
  paths,
} from '../skills/auto_reply.js';

const SETTINGS = () => ({
  matchMode: 'first',
  maxRepliesPerHour: 60,
  stopWords: [],
  ignoreList: [],
  businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  escalationWords: [],
  mentionTokens: [],
  allowedLinkDomains: [],
  approvalRequired: false,
  notifyWebhookUrl: '',
  memoryWindow: 5,
  llmFallback: { enabled: false },
  templates: [],
});

function rule(overrides = {}) {
  const n = normalizeRule({
    id: 'r1',
    name: 'r1',
    platform: 'whatsapp',
    pattern: 'hello\\s+(world)',
    flags: 'i',
    reply: 'Hi $1!',
    ...overrides,
  });
  if (!n.ok) throw new Error(n.error);
  return n.rule;
}

function cleanDataFiles() {
  for (const p of [
    paths.RULES_PATH,
    paths.SETTINGS_PATH,
    paths.LOG_PATH,
    paths.DLQ_PATH,
    paths.APPROVALS_PATH,
    process.env.AUTO_REPLY_TAKEOVER_PATH,
  ]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(paths.HISTORY_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

beforeEach(() => {
  resetEngineState();
  cleanDataFiles();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rule matching + capture templating', () => {
  it('matches the sample internship rule and renders captures', () => {
    const hits = matchRules('hello internship please', {
      rules: validateRulesList(defaultSampleRules()).rules,
      platform: 'whatsapp',
      settings: SETTINGS(),
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].rule.id).toBe('internship-hello');
    expect(hits[0].reply).toMatch(/internship/i);
  });

  it('formatReply substitutes $1..$n and $&', () => {
    const m = 'order 42 now'.match(/order (\d+)/);
    expect(formatReply('Got $1 ($&)', m)).toBe('Got 42 (order 42)');
    expect(formatReply('none', null)).toBe('none');
    expect(formatReply('missing $9 stays empty', m)).toBe('missing  stays empty');
  });

  it('respects priority ordering and matchMode first/all', () => {
    const low = rule({ id: 'low', pattern: 'hello', priority: 1, reply: 'low' });
    const high = rule({ id: 'high', pattern: 'hello', priority: 9, reply: 'high' });
    const first = matchRules('hello world', { rules: [low, high], settings: SETTINGS() });
    expect(first).toHaveLength(1);
    expect(first[0].rule.id).toBe('high');
    const all = matchRules('hello world', {
      rules: [low, high],
      settings: { ...SETTINGS(), matchMode: 'all' },
    });
    expect(all.map((h) => h.rule.id)).toEqual(['high', 'low']);
  });

  it('skips disabled rules and honors stopWords', () => {
    const r = rule({ enabled: false });
    expect(matchRules('hello world', { rules: [r], settings: SETTINGS() })).toHaveLength(0);
    const active = rule();
    expect(
      matchRules('hello world unsubscribe', {
        rules: [active],
        settings: { ...SETTINGS(), stopWords: ['unsubscribe'] },
      })
    ).toHaveLength(0);
  });

  it('language gate (78): rule.lang only matches detected language', () => {
    const en = rule({ id: 'en-only', pattern: 'internship', lang: 'en', reply: 'ok' });
    expect(
      matchRules('I want an internship please', { rules: [en], settings: SETTINGS() })
    ).toHaveLength(1);
    expect(
      matchRules('मुझे internship चाहिए कृपया बताइए विवरण', { rules: [en], settings: SETTINGS() })
    ).toHaveLength(0);
  });
});

describe('safety limits', () => {
  it('rejects catastrophic patterns and oversized inputs', () => {
    expect(validatePatternSafety('(a+)+')).toBeTruthy();
    expect(validatePatternSafety('a'.repeat(401))).toBeTruthy();
    expect(validatePatternSafety('')).toBeTruthy();
    expect(validatePatternSafety('\\b(hello)\\b')).toBeNull();
    expect(() => matchRules('x'.repeat(4001), { rules: [], settings: SETTINGS() })).toThrow(
      /max length/
    );
  });

  it('validates flags and rule lists', () => {
    expect(validateFlags('gi')).toBeNull();
    expect(validateFlags('gg')).toMatch(/duplicate/);
    expect(validateFlags('x')).toMatch(/flags/);
    const dup = validateRulesList([rule({ id: 'a' }), rule({ id: 'a' })]);
    expect(dup.ok).toBe(false);
    const badPlatform = validateRulesList([
      { id: 'x', platform: 'tiktok', pattern: 'a', reply: 'b' },
    ]);
    expect(badPlatform.ok).toBe(false);
    const badCanary = validateRulesList([
      { id: 'x', platform: 'whatsapp', pattern: 'a', reply: 'b', canaryPercent: 150 },
    ]);
    expect(badCanary.ok).toBe(false);
  });

  it('keywordToRegex escapes special chars', () => {
    const { pattern, flags } = keywordToRegex('node.js, apply');
    const re = new RegExp(pattern, flags);
    expect(re.test('learn Node.js today')).toBe(true);
    expect(re.test('nodexjs')).toBe(false);
  });
});

describe('templates (73) + A/B variants (74)', () => {
  it('expands {{tpl:id}} references and leaves unknown ids visible', () => {
    const settings = { ...SETTINGS(), templates: [{ id: 'cta', text: 'Apply at airepro.in' }] };
    expect(expandTemplates('Hi! {{tpl:cta}}', settings)).toBe('Hi! Apply at airepro.in');
    expect(expandTemplates('Hi! {{tpl:nope}}', settings)).toBe('Hi! {{tpl:nope}}');
  });

  it('picks weighted variants deterministically with injected rng', () => {
    const r = rule({
      reply: 'base',
      replyVariants: [
        { text: 'variant A', weight: 1 },
        { text: 'variant B', weight: 3 },
      ],
    });
    expect(pickReplyVariant(r, () => 0.0).text).toBe('variant A');
    expect(pickReplyVariant(r, () => 0.9).text).toBe('variant B');
    expect(pickReplyVariant(rule(), () => 0.5)).toEqual({ text: 'Hi $1!', variantIndex: null });
  });

  it('renderRuleReply composes variant + template + captures', () => {
    const r = rule({
      pattern: 'hello\\s+(world)',
      replyVariants: [{ text: 'Hey $1 — {{tpl:cta}}', weight: 1 }],
    });
    const m = 'hello world'.match(/hello\s+(world)/);
    const settings = { ...SETTINGS(), templates: [{ id: 'cta', text: 'visit us' }] };
    expect(renderRuleReply(r, m, settings, () => 0).reply).toBe('Hey world — visit us');
  });
});

describe('quiet hours (71) + business hours (72)', () => {
  it('detects quiet windows including midnight wrap', () => {
    const qh = { start: '22:00', end: '07:00', tzOffsetMinutes: 0 };
    expect(inQuietHours(qh, new Date('2026-07-25T23:30:00Z'))).toBe(true);
    expect(inQuietHours(qh, new Date('2026-07-25T06:59:00Z'))).toBe(true);
    expect(inQuietHours(qh, new Date('2026-07-25T12:00:00Z'))).toBe(false);
    expect(inQuietHours(null, new Date())).toBe(false);
  });

  it('business hours profile allows/blocks by window and day', () => {
    const bh = {
      enabled: true,
      start: '09:00',
      end: '18:00',
      days: [1, 2, 3, 4, 5],
      tzOffsetMinutes: 0,
    };
    // 2026-07-22 is a Wednesday
    expect(withinBusinessHours(bh, new Date('2026-07-22T10:00:00Z'))).toBe(true);
    expect(withinBusinessHours(bh, new Date('2026-07-22T20:00:00Z'))).toBe(false);
    // 2026-07-26 is a Sunday
    expect(withinBusinessHours(bh, new Date('2026-07-26T10:00:00Z'))).toBe(false);
    expect(withinBusinessHours({ ...bh, enabled: false }, new Date('2026-07-26T10:00:00Z'))).toBe(
      true
    );
  });

  it('quiet-hours rule skips send when armed', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ quietHours: { start: '00:00', end: '23:59', tzOffsetMinutes: 0 } })]);
    saveSettings(SETTINGS());
    const send = vi.fn();
    const out = await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      { sendReply: send, now: new Date('2026-07-25T12:00:00Z') }
    );
    expect(send).not.toHaveBeenCalled();
    expect(out.matches[0].skipped).toBe('quietHours');
  });
});

describe('cooldowns + hourly rate limit', () => {
  it('applies per chat+rule cooldown', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ cooldownSec: 300 })]);
    saveSettings(SETTINGS());
    const send = vi.fn().mockResolvedValue('ok');
    const args = { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false };
    const first = await processInbound(args, { sendReply: send });
    expect(first.matches[0].sent).toBe(true);
    const second = await processInbound(args, { sendReply: send });
    expect(second.matches[0].sent).toBe(false);
    expect(second.matches[0].skipped).toBe('cooldown');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('enforces maxRepliesPerHour', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ cooldownSec: 0 })]);
    saveSettings({ ...SETTINGS(), maxRepliesPerHour: 1 });
    const send = vi.fn().mockResolvedValue('ok');
    const a = await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      { sendReply: send }
    );
    const b = await processInbound(
      { text: 'hello world', from: '222', platform: 'whatsapp', dryRun: false },
      { sendReply: send }
    );
    expect(a.matches[0].sent).toBe(true);
    expect(b.matches[0].skipped).toBe('rateLimit');
  });
});

describe('dry-run + arming gates', () => {
  it('never sends in dry-run', async () => {
    saveRules([rule()]);
    saveSettings(SETTINGS());
    const send = vi.fn();
    const out = await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: true },
      { sendReply: send }
    );
    expect(send).not.toHaveBeenCalled();
    expect(out.dryRun).toBe(true);
    expect(isAutoReplyEnabled()).toBe(false);
  });

  it('per-platform env flags (97) gate sends', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    vi.stubEnv('AUTO_REPLY_WHATSAPP_ENABLED', 'false');
    expect(platformAutoReplyEnabled('whatsapp')).toBe(false);
    expect(platformAutoReplyEnabled('facebook')).toBe(true);
    saveRules([rule()]);
    saveSettings(SETTINGS());
    const send = vi.fn();
    const out = await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      { sendReply: send }
    );
    expect(send).not.toHaveBeenCalled();
    expect(out.matches[0].skipped).toBe('platformDisabled');
  });
});

describe('takeover (76), escalation (77), mention guard (98)', () => {
  it('human takeover pauses a chat until cleared', async () => {
    saveRules([rule()]);
    saveSettings(SETTINGS());
    setTakeover('whatsapp', '111', true);
    expect(isTakenOver('whatsapp:111')).toBe(true);
    const out = await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: true },
      {}
    );
    expect(out.skipped).toBe('takeover');
    setTakeover('whatsapp', '111', false);
    expect(loadTakeovers()['whatsapp:111']).toBeUndefined();
  });

  it('escalation keywords skip auto-reply entirely', async () => {
    saveRules([rule({ pattern: 'refund' })]);
    saveSettings({ ...SETTINGS(), escalationWords: ['angry', 'lawyer'] });
    const out = await processInbound(
      { text: 'I am ANGRY about my refund', from: '1', platform: 'whatsapp', dryRun: true },
      {}
    );
    expect(out.skipped).toBe('escalation');
  });

  it('group mention guard blocks unmentioned sends', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ requireMention: true, scope: 'any' })]);
    saveSettings({ ...SETTINGS(), mentionTokens: ['@airepro'] });
    const send = vi.fn();
    const blocked = await processInbound(
      { text: 'hello world', from: 'g1', platform: 'whatsapp', isGroup: true, dryRun: false },
      { sendReply: send }
    );
    expect(blocked.matches[0].skipped).toBe('mentionRequired');
    const allowed = await processInbound(
      {
        text: 'hello world @airepro',
        from: 'g2',
        platform: 'whatsapp',
        isGroup: true,
        dryRun: false,
      },
      { sendReply: send }
    );
    expect(allowed.matches[0].sent).toBe(true);
    expect(hasMention('ping @airepro', ['@airepro'])).toBe(true);
    expect(hasMention('ping nobody', ['@airepro'])).toBe(false);
  });
});

describe('idempotency (83) + DLQ (84) + stats (85)', () => {
  it('dedupes webhook message ids', async () => {
    saveRules([rule()]);
    saveSettings(SETTINGS());
    expect(isDuplicateMessage('wamid.X1')).toBe(false);
    expect(isDuplicateMessage('wamid.X1')).toBe(true);
    const out = await processInbound(
      { text: 'hello world', from: '1', platform: 'whatsapp', dryRun: true, messageId: 'wamid.X1' },
      {}
    );
    expect(out.skipped).toBe('duplicate');
  });

  it('failed sends land in the dead-letter queue', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule()]);
    saveSettings(SETTINGS());
    const out = await processInbound(
      { text: 'hello world', from: '1', platform: 'whatsapp', dryRun: false },
      { sendReply: vi.fn().mockRejectedValue(new Error('boom 500')) }
    );
    expect(out.matches[0].sendError).toMatch(/boom/);
    const dlq = readDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].ruleId).toBe('r1');
    expect(getStats().dlq).toBe(1);
  });

  it('counters track inbound/matches/sent/skips', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule()]);
    saveSettings(SETTINGS());
    await processInbound(
      { text: 'hello world', from: '1', platform: 'whatsapp', dryRun: false },
      { sendReply: vi.fn().mockResolvedValue('ok') }
    );
    await processInbound(
      { text: 'no match here', from: '2', platform: 'whatsapp', dryRun: true },
      {}
    );
    const s = getStats();
    expect(s.inbound).toBe(2);
    expect(s.matches).toBe(1);
    expect(s.sent).toBe(1);
  });

  it('media inbound (79) is logged, not crashed on', async () => {
    saveRules([rule()]);
    saveSettings(SETTINGS());
    const out = await processInbound(
      { text: '', type: 'image', from: '1', platform: 'whatsapp', dryRun: true },
      {}
    );
    expect(out.skipped).toBe('mediaType');
    expect(out.mediaType).toBe('image');
  });
});

describe('canary (96) + link guard (99)', () => {
  it('canary buckets are deterministic and gate sends', () => {
    const b = canaryBucket('whatsapp:12345');
    expect(canaryBucket('whatsapp:12345')).toBe(b);
    expect(canaryAllows('any', 100)).toBe(true);
    expect(canaryAllows('any', null)).toBe(true);
    expect(canaryAllows('any', 0)).toBe(false);
    expect(canaryAllows('whatsapp:12345', b + 1)).toBe(true);
    expect(canaryAllows('whatsapp:12345', b)).toBe(false);
  });

  it('canary skip is reported when armed', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ canaryPercent: 0 })]);
    saveSettings(SETTINGS());
    const send = vi.fn();
    const out = await processInbound(
      { text: 'hello world', from: '1', platform: 'whatsapp', dryRun: false },
      { sendReply: send }
    );
    expect(out.matches[0].skipped).toBe('canary');
    expect(send).not.toHaveBeenCalled();
  });

  it('link guard blocks non-allowlisted URLs in replies', async () => {
    expect(linkGuard('go to https://airepro.in/x', ['airepro.in']).ok).toBe(true);
    expect(linkGuard('go to https://evil.example/x', ['airepro.in']).ok).toBe(false);
    expect(linkGuard('no links at all', ['airepro.in']).ok).toBe(true);
    expect(linkGuard('any https://anywhere.com', []).ok).toBe(true);

    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ reply: 'visit https://not-allowed.example now' })]);
    saveSettings({ ...SETTINGS(), allowedLinkDomains: ['airepro.in'] });
    const out = await processInbound(
      { text: 'hello world', from: '1', platform: 'whatsapp', dryRun: false },
      { sendReply: vi.fn() }
    );
    expect(out.matches[0].skipped).toBe('linkGuard');
  });
});

describe('approval queue (92)', () => {
  it('queues replies instead of sending, then approves/rejects', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule()]);
    saveSettings({ ...SETTINGS(), approvalRequired: true });
    const send = vi.fn().mockResolvedValue('ok');
    const out = await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      { sendReply: send }
    );
    expect(send).not.toHaveBeenCalled();
    expect(out.matches[0].skipped).toBe('approvalQueue');
    const pending = listApprovals();
    expect(pending).toHaveLength(1);

    const approved = await resolveApproval(pending[0].id, 'approve', { sendReply: send });
    expect(approved.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listApprovals()[0].status).toBe('sent');

    const again = await resolveApproval(pending[0].id, 'approve', { sendReply: send });
    expect(again.ok).toBe(false);
  });

  it('cannot approve-send when disarmed', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule()]);
    saveSettings({ ...SETTINGS(), approvalRequired: true });
    await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      {}
    );
    const pending = listApprovals();
    vi.stubEnv('AUTO_REPLY_ENABLED', '');
    const res = await resolveApproval(pending[0].id, 'approve', { sendReply: vi.fn() });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/AUTO_REPLY_ENABLED/);
  });
});

describe('follow-ups (75)', () => {
  it('schedules a follow-up after a send and processes when due', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ followUp: { afterMinutes: 1, text: 'Still there?' } })]);
    saveSettings(SETTINGS());
    const send = vi.fn().mockResolvedValue('ok');
    await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      { sendReply: send }
    );
    expect(listFollowUps()).toHaveLength(1);

    // Not due yet
    const early = await processFollowUps({ dryRun: false, sendReply: send, now: Date.now() });
    expect(early).toHaveLength(0);

    const late = await processFollowUps({
      dryRun: false,
      sendReply: send,
      now: Date.now() + 2 * 60 * 1000,
    });
    expect(late).toHaveLength(1);
    expect(late[0].sent).toBe(true);
    expect(listFollowUps()).toHaveLength(0);
  });

  it('takeover cancels pending follow-ups', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([rule({ followUp: { afterMinutes: 1, text: 'Still there?' } })]);
    saveSettings(SETTINGS());
    await processInbound(
      { text: 'hello world', from: '111', platform: 'whatsapp', dryRun: false },
      { sendReply: vi.fn().mockResolvedValue('ok') }
    );
    expect(listFollowUps()).toHaveLength(1);
    setTakeover('whatsapp', '111', true);
    setTakeover('whatsapp', '111', false);
    expect(listFollowUps()).toHaveLength(0);
  });
});

describe('versioning (95) + diff (88) + CSV (94)', () => {
  it('snapshots previous rules on save', () => {
    saveRules([rule({ id: 'v1' })]);
    saveRules([rule({ id: 'v2' })]);
    const snaps = listRuleSnapshots();
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const restored = JSON.parse(fs.readFileSync(`${paths.HISTORY_DIR}/${snaps[0].file}`, 'utf8'));
    expect(restored[0].id).toBe('v1');
  });

  it('diffRules reports added/removed/changed', () => {
    saveRules([rule({ id: 'keep' }), rule({ id: 'gone' })]);
    const d = diffRules([rule({ id: 'keep', reply: 'changed reply' }), rule({ id: 'new' })]);
    expect(d.ok).toBe(true);
    expect(d.added).toEqual(['new']);
    expect(d.removed).toEqual(['gone']);
    expect(d.changed).toEqual(['keep']);
  });

  it('exports match log entries as CSV with escaping', () => {
    const csv = matchLogToCsv([
      {
        ts: '2026-01-01T00:00:00Z',
        platform: 'whatsapp',
        from: '1',
        scope: 'dm',
        text: 'hello, "world"',
        matches: [{ ruleId: 'r1', reply: 'hi', sent: false, skipped: 'dryRun' }],
      },
    ]);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"hello, ""world"""');
    expect(csv).toContain('r1');
  });
});

describe('regex explain (89) + payloads (80) + language (78)', () => {
  it('explainPattern counts groups, finds named groups, runs samples', () => {
    const out = explainPattern('hello\\s+(?<who>\\w+)\\s+(now)?', 'i', 'Hello WORLD now');
    expect(out.ok).toBe(true);
    expect(out.groupCount).toBe(2);
    expect(out.namedGroups).toEqual(['who']);
    expect(out.sample.matched).toBe(true);
    expect(out.sample.groups.who).toBe('WORLD');
    expect(explainPattern('(a+)+').ok).toBe(false);
  });

  it('buildReplyPayload emits text/buttons/list shapes', () => {
    const r = rule({ replyType: 'buttons', buttons: ['Yes', 'No'] });
    const p = buildReplyPayload(r, 'Pick one');
    expect(p.type).toBe('interactive');
    expect(p.interactive.action.buttons).toHaveLength(2);
    const plain = buildReplyPayload(rule(), 'hi');
    expect(plain).toEqual({ type: 'text', text: { body: 'hi' } });
    const list = buildReplyPayload(rule({ replyType: 'list', buttons: ['A', 'B', 'C'] }), 'menu');
    expect(list.interactive.type).toBe('list');
  });

  it('detectLanguage separates en/hi/unknown', () => {
    expect(detectLanguage('plain english text here')).toBe('en');
    expect(detectLanguage('नमस्ते आप कैसे हैं')).toBe('hi');
    expect(detectLanguage('ab')).toBe('unknown');
  });
});

describe('LLM fallback (91) + memory (90) + simulator (100)', () => {
  it('drafts via injected generator when no rule matches (never sends)', async () => {
    saveRules([rule()]);
    saveSettings({ ...SETTINGS(), llmFallback: { enabled: true } });
    const draft = vi.fn().mockResolvedValue('Suggested reply from LLM');
    const out = await processInbound(
      { text: 'completely unrelated', from: '1', platform: 'whatsapp', dryRun: true },
      { generateDraft: draft }
    );
    expect(draft).toHaveBeenCalled();
    expect(out.llmDraft).toBe('Suggested reply from LLM');
    expect(out.sent).toBe(false);
  });

  it('contextual rules match against the conversation window', async () => {
    const ctxRule = rule({
      id: 'ctx',
      pattern: 'internship[\\s\\S]*budget',
      useContext: true,
      reply: 'ctx hit',
    });
    saveRules([ctxRule]);
    saveSettings(SETTINGS());
    await processInbound(
      { text: 'tell me about internship', from: '9', platform: 'whatsapp', dryRun: true },
      {}
    );
    const out = await processInbound(
      { text: 'what is the budget', from: '9', platform: 'whatsapp', dryRun: true },
      {}
    );
    expect(out.matches.map((m) => m.ruleId)).toContain('ctx');
  });

  it('simulateInbox replays messages dry-run with summary', async () => {
    saveRules([rule({ pattern: 'internship' })]);
    saveSettings(SETTINGS());
    const out = await simulateInbox([
      { from: 'a', text: 'internship please', messageId: 's1' },
      { from: 'b', text: 'nothing relevant' },
      { from: 'a', text: 'internship please', messageId: 's1' }, // duplicate id
    ]);
    expect(out.total).toBe(3);
    expect(out.matched).toBe(1);
    expect(out.results[2].skipped).toBe('duplicate');
    expect(out.results.every((r) => r.sent === false || r.sent === undefined)).toBe(true);
  });
});

describe('settings + rules persistence', () => {
  it('normalizes settings shapes and persists new fields', () => {
    const saved = saveSettings({
      matchMode: 'all',
      maxRepliesPerHour: 10,
      businessHours: { enabled: true, start: '10:00', end: '17:00', days: [1, 2] },
      templates: [
        { id: 'a b!', text: 'hi' },
        { id: 'ok', text: 'yo' },
      ],
      allowedLinkDomains: ['Airepro.IN'],
      approvalRequired: true,
    });
    expect(saved.matchMode).toBe('all');
    expect(saved.businessHours.enabled).toBe(true);
    expect(saved.templates.find((t) => t.id === 'ok')).toBeTruthy();
    expect(saved.allowedLinkDomains).toEqual(['airepro.in']);
    const loaded = loadSettings();
    expect(loaded.approvalRequired).toBe(true);
  });

  it('normalizeRule keeps wave-2 fields through save/load', () => {
    saveRules([
      rule({
        tags: ['Internship', 'FAQ'],
        canaryPercent: 25,
        quietHours: { start: '22:00', end: '07:00' },
        replyVariants: [{ text: 'v1', weight: 2 }],
      }),
    ]);
    const [r] = loadRules();
    expect(r.tags).toEqual(['internship', 'faq']);
    expect(r.canaryPercent).toBe(25);
    expect(r.quietHours.start).toBe('22:00');
    expect(r.replyVariants).toHaveLength(1);
  });
});
