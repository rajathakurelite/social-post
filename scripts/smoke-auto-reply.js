/**
 * Offline smoke for regex auto-reply (no network, no WhatsApp send).
 */
import assert from 'assert';
import {
  matchRules,
  formatReply,
  keywordToRegex,
  validatePatternSafety,
  validateRulesList,
  defaultSampleRules,
  processInbound,
  isAutoReplyEnabled,
} from '../skills/auto_reply.js';

function ok(name) {
  console.log(`OK  ${name}`);
}

try {
  const rules = defaultSampleRules();
  const hits = matchRules('hello internship please', {
    rules,
    platform: 'whatsapp',
    settings: { matchMode: 'first', maxRepliesPerHour: 60, stopWords: [], ignoreList: [] },
  });
  assert.ok(hits.length >= 1, 'expected a match');
  assert.equal(hits[0].rule.id, 'internship-hello');
  assert.ok(hits[0].match[1] && /internship/i.test(hits[0].match[1]), 'capture $1');
  assert.ok(/Hi! Thanks for asking about internship/i.test(hits[0].reply), hits[0].reply);
  ok('sample internship match + captures');

  const m = 'hello internship cohort'.match(/hello\s+(internship)(\s+(.+))?/i);
  const reply = formatReply('About $1$2', m);
  assert.ok(reply.includes('internship'), reply);
  ok('formatReply $1 $2');

  const { pattern, flags } = keywordToRegex('internship, apply');
  assert.ok(pattern.includes('internship'));
  assert.ok(flags.includes('i'));
  assert.ok(new RegExp(pattern, flags).test('Need Internship info'));
  ok('keywordToRegex helper');

  assert.ok(validatePatternSafety('(a+)+'), 'expected safety error');
  ok('reject nested catastrophic pattern');

  const bad = validateRulesList([{ id: 'x', platform: 'tiktok', pattern: 'a', reply: 'b' }]);
  assert.equal(bad.ok, false);
  ok('validateRulesList rejects bad platform');

  let sent = false;
  const out = await processInbound(
    { text: 'hello internship', platform: 'whatsapp', from: '15551234567', dryRun: true },
    {
      sendReply: async () => {
        sent = true;
      },
    }
  );
  assert.equal(sent, false);
  assert.ok(out.matches?.length >= 1);
  assert.equal(out.matches[0].sent, false);
  ok('processInbound dry-run never sends');

  console.log('  AUTO_REPLY_ENABLED =', isAutoReplyEnabled());
  console.log('\nsmoke:auto-reply PASSED');
  process.exit(0);
} catch (e) {
  console.error('\nsmoke:auto-reply FAILED:', e.message || e);
  process.exit(1);
}
