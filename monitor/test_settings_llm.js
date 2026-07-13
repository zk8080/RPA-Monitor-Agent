/**
 * S26：LLM settings 文件 / 脱敏 / merge / 空 key 保留
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const settingsLlm = require('./lib/settings-llm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-llm-set-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// mask
assert.strictEqual(settingsLlm.maskApiKey(''), '');
assert.ok(settingsLlm.maskApiKey('sk-abcdefghijklmnop').includes('…'));

// 写入
const w = settingsLlm.saveLlmSettings(dataDir, {
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-secret-key-12345678',
  model: 'test-model',
  apiStyle: 'openai',
  timeoutMs: 120000,
  diagnoseUseLlm: true,
});
assert.strictEqual(w.ok, true);
assert.ok(fs.existsSync(path.join(dataDir, 'settings.llm.json')));

const file = settingsLlm.readSettingsFile(dataDir, { force: true });
assert.strictEqual(file.model, 'test-model');
assert.strictEqual(file.apiKey, 'sk-secret-key-12345678');

// 空 apiKey 保留
const w2 = settingsLlm.saveLlmSettings(dataDir, {
  model: 'model-2',
  apiKey: '',
});
assert.strictEqual(w2.ok, true);
const file2 = settingsLlm.readSettingsFile(dataDir, { force: true });
assert.strictEqual(file2.model, 'model-2');
assert.strictEqual(file2.apiKey, 'sk-secret-key-12345678', 'empty key must keep previous');

// clear
const w3 = settingsLlm.saveLlmSettings(dataDir, { apiKey: '__CLEAR__' });
assert.strictEqual(w3.ok, true);
const file3 = settingsLlm.readSettingsFile(dataDir, { force: true });
assert.strictEqual(file3.apiKey, '');

// overlay
settingsLlm.saveLlmSettings(dataDir, {
  baseUrl: 'https://gw.test/v1',
  apiKey: 'sk-overlay',
  model: 'm1',
  diagnoseUseLlm: false,
});
const o = settingsLlm.getFileOverlay(dataDir);
assert.strictEqual(o.baseUrl, 'https://gw.test/v1');
assert.strictEqual(o.apiKey, 'sk-overlay');
assert.strictEqual(o.diagnoseUseLlm, false);
assert.strictEqual(o.hasFile, true);

// public 脱敏（伪造 cfg）
const cfg = {
  dataDir,
  llmBaseUrl: o.baseUrl,
  llmApiKey: o.apiKey,
  llmModel: o.model,
  llmApiStyle: 'openai',
  llmTimeoutMs: 600000,
  llm: {
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    model: o.model,
    apiStyle: 'openai',
    timeoutMs: 600000,
  },
  diagnoseUseLlm: false,
};
const pub = settingsLlm.getPublicLlmSettings(cfg);
assert.strictEqual(pub.ok, true);
assert.strictEqual(pub.configured, true);
assert.ok(pub.apiKeyMasked);
assert.strictEqual(pub.apiKey, undefined);
assert.ok(!JSON.stringify(pub).includes('sk-overlay'));

// settings disabled
const denied = settingsLlm.saveLlmSettings(dataDir, { model: 'x' }, { settingsEnabled: false });
assert.strictEqual(denied.ok, false);
assert.strictEqual(denied.code, 'settings_disabled');

console.log('✅ test_settings_llm passed');
