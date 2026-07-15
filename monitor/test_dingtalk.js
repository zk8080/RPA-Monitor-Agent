/**
 * 钉钉设置 + 晨间摘要 + 加签 URL 单测（不真正请求外网）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsDt = require('./lib/settings-dingtalk');
const notify = require('./lib/notify-dingtalk');
const morning = require('./lib/morning-digest');
const memory = require('./lib/memory');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-dt-'));
}

function testSettings() {
  const dir = tmpDir();
  const pub0 = settingsDt.getPublicDingtalkSettings({ dataDir: dir, reportCron: '5 9 * * *' });
  assert.strictEqual(pub0.enabled, false);
  assert.strictEqual(pub0.webhookConfigured, false);

  const s1 = settingsDt.saveDingtalkSettings(dir, {
    enabled: true,
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc1234567890',
    secret: 'SEChello',
    recentDays: 1,
    topN: 5,
  });
  assert.strictEqual(s1.ok, true);

  const pub = settingsDt.getPublicDingtalkSettings({ dataDir: dir, reportCron: '5 9 * * *' });
  assert.strictEqual(pub.enabled, true);
  assert.strictEqual(pub.webhookConfigured, true);
  assert.ok(pub.webhookMasked.includes('…'));
  assert.strictEqual(pub.secretConfigured, true);
  assert.ok(!String(pub.webhookMasked).includes('abc1234567890'));

  // 空 webhook 保留
  settingsDt.saveDingtalkSettings(dir, { webhookUrl: '' });
  const rt = settingsDt.getRuntimeConfig(dir);
  assert.ok(rt.webhookUrl.includes('access_token'));

  // clear
  settingsDt.saveDingtalkSettings(dir, {
    clearWebhook: true,
    clearSecret: true,
    secret: '__CLEAR__',
  });
  const rt2 = settingsDt.getRuntimeConfig(dir);
  assert.strictEqual(rt2.webhookUrl, '');
  assert.strictEqual(rt2.secret, '');

  const denied = settingsDt.saveDingtalkSettings(
    dir,
    { enabled: true },
    { settingsEnabled: false },
  );
  assert.strictEqual(denied.ok, false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok settings');
}

function testSign() {
  const url = notify.buildSignedUrl(
    'https://oapi.dingtalk.com/robot/send?access_token=t',
    'SECtest',
  );
  assert.ok(url.includes('timestamp='));
  assert.ok(url.includes('sign='));
  const plain = notify.buildSignedUrl(
    'https://oapi.dingtalk.com/robot/send?access_token=t',
    '',
  );
  assert.ok(!plain.includes('sign='));
  console.log('ok sign');
}

function testAt() {
  const dir = tmpDir();
  settingsDt.saveDingtalkSettings(dir, {
    enabled: true,
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
    atMobilesText: '13800138000, 13900139000',
    atAll: false,
    atAlways: true,
  });
  const rt = settingsDt.getRuntimeConfig(dir);
  assert.deepStrictEqual(rt.atMobiles, ['13800138000', '13900139000']);
  assert.strictEqual(rt.atAlways, true);

  const text = notify.appendAtText('hello', {
    atMobiles: ['13800138000'],
    isAtAll: false,
  });
  assert.ok(text.includes('@13800138000'));

  const textAll = notify.appendAtText('hello', { atMobiles: [], isAtAll: true });
  assert.ok(textAll.includes('@所有人'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok at');
}

async function testDigest() {
  const dir = tmpDir();
  const cfg = { dataDir: dir, healthPort: 8787 };

  const empty = morning.buildMorningDigest(cfg, { recentDays: 1, topN: 5 });
  assert.ok(empty.stats.healthy);
  assert.ok(empty.text.includes('无异常'));

  memory.upsertQueueItem(
    dir,
    {
      fingerprint: '调度层_testfp',
      robotUuid: 'r-1',
      robotName: '测试应用',
      robotClientName: 'bot@corp',
      taskName: '定时任务A',
      errorType: '任务等待运行超时',
      flowName: '',
      diagnosed: false,
      occurrenceCount: 1,
    },
    { jobUuid: 'j1', failureAt: new Date().toISOString() },
  );

  const dig = morning.buildMorningDigest(cfg, { recentDays: 1, topN: 5 });
  assert.strictEqual(dig.stats.healthy, false);
  assert.ok(dig.stats.total >= 1);
  assert.ok(dig.text.includes('测试应用'));
  assert.ok(dig.text.includes('bot@corp'));

  const send = await morning.sendMorningDigest(cfg, { force: false });
  assert.ok(send.skipped || send.code === 'disabled' || send.code === 'not_configured');

  // 一日一次：模拟今日已成功发送 → 自动路径 skip
  settingsDt.saveDingtalkSettings(dir, {
    enabled: true,
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
  });
  settingsDt.recordSendResult(dir, { ok: true });
  assert.strictEqual(morning.alreadySentToday(dir), true);
  const skip = await morning.sendMorningDigest(cfg, { force: false });
  assert.strictEqual(skip.skipped, true);
  assert.strictEqual(skip.code, 'already_sent_today');

  // 失败发送不计入「今日已发」
  settingsDt.recordSendResult(dir, { ok: false, error: 'mock fail' });
  assert.strictEqual(morning.alreadySentToday(dir), false);

  // 非今日 lastSendAt → 不算已发
  const yday = new Date();
  yday.setDate(yday.getDate() - 1);
  const prev = settingsDt.readSettingsFile(dir, { force: true });
  settingsDt.writeSettingsFile(dir, {
    ...prev,
    lastSendAt: yday.toISOString(),
    lastSendOk: true,
    lastSendError: null,
  });
  assert.strictEqual(morning.alreadySentToday(dir), false);

  assert.ok(morning.localDateKey().length === 10);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok digest');
}

async function main() {
  testSettings();
  testSign();
  testAt();
  await testDigest();
  console.log('test_dingtalk: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
