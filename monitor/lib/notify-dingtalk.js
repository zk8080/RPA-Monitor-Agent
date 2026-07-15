/**
 * 钉钉自定义机器人 Webhook 发送（Markdown）
 * 支持加签 secret：timestamp + HMAC-SHA256
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * @param {string} webhookUrl
 * @param {string} [secret]
 * @returns {string}
 */
function buildSignedUrl(webhookUrl, secret) {
  const base = String(webhookUrl || '').trim();
  if (!base) throw new Error('webhookUrl empty');
  const sec = String(secret || '').trim();
  if (!sec) return base;

  const timestamp = String(Date.now());
  const stringToSign = `${timestamp}\n${sec}`;
  const sign = encodeURIComponent(
    crypto.createHmac('sha256', sec).update(stringToSign, 'utf8').digest('base64'),
  );
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}timestamp=${timestamp}&sign=${sign}`;
}

/**
 * @param {string} urlStr
 * @param {object} body
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, statusCode: number, body: string, json?: object }>}
 */
function postJson(urlStr, body, opts = {}) {
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error(`invalid webhook url: ${e.message}`));
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode || 0,
            body: text.slice(0, 2000),
            json,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`dingtalk request timeout ${timeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 规范化 @ 配置
 * @param {{ atMobiles?: string[], atAll?: boolean }|null|undefined} at
 */
function normalizeAt(at) {
  if (!at || typeof at !== 'object') {
    return { atMobiles: [], isAtAll: false };
  }
  const mobiles = Array.isArray(at.atMobiles)
    ? at.atMobiles.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  return {
    atMobiles: mobiles,
    isAtAll: at.atAll === true || at.isAtAll === true,
  };
}

/**
 * 在 Markdown 正文末尾补上 @ 文本（钉钉要求正文里也要有 @手机号 / @所有人）
 * @param {string} text
 * @param {{ atMobiles: string[], isAtAll: boolean }} at
 */
function appendAtText(text, at) {
  const t = String(text || '');
  const bits = [];
  if (at.isAtAll) bits.push('@所有人');
  for (const m of at.atMobiles || []) {
    bits.push(`@${m}`);
  }
  if (!bits.length) return t;
  // 已包含则不重复
  if (bits.every((b) => t.includes(b))) return t;
  return `${t}\n\n${bits.join(' ')}`;
}

/**
 * 发送 Markdown 消息
 * @param {{ webhookUrl: string, secret?: string }} conf
 * @param {{ title: string, text: string, at?: { atMobiles?: string[], atAll?: boolean } }} msg
 * @param {{ timeoutMs?: number }} [opts]
 */
async function sendMarkdown(conf, msg, opts = {}) {
  const webhookUrl = conf && conf.webhookUrl;
  if (!webhookUrl) {
    return { ok: false, code: 'not_configured', message: '未配置 webhookUrl' };
  }
  const title = String((msg && msg.title) || 'RPA 通知').slice(0, 64);
  const at = normalizeAt(msg && msg.at);
  let text = String((msg && msg.text) || '');
  text = appendAtText(text, at).slice(0, 18000);
  if (!text.trim()) {
    return { ok: false, code: 'empty_body', message: '消息正文为空' };
  }

  let url;
  try {
    url = buildSignedUrl(webhookUrl, conf.secret);
  } catch (e) {
    return { ok: false, code: 'sign_error', message: e.message || String(e) };
  }

  const payload = {
    msgtype: 'markdown',
    markdown: { title, text },
  };
  if (at.isAtAll || (at.atMobiles && at.atMobiles.length)) {
    payload.at = {
      atMobiles: at.atMobiles || [],
      isAtAll: at.isAtAll === true,
    };
  }

  try {
    const res = await postJson(url, payload, opts);
    // 钉钉业务码：errcode === 0
    const errcode =
      res.json && res.json.errcode != null ? Number(res.json.errcode) : res.ok ? 0 : -1;
    const errmsg = (res.json && res.json.errmsg) || res.body || '';
    if (errcode === 0) {
      return { ok: true, statusCode: res.statusCode, errcode, message: 'ok' };
    }
    return {
      ok: false,
      code: 'dingtalk_error',
      statusCode: res.statusCode,
      errcode,
      message: errmsg || `dingtalk errcode=${errcode}`,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      message: e && e.message ? e.message : String(e),
    };
  }
}

module.exports = {
  buildSignedUrl,
  sendMarkdown,
  postJson,
  normalizeAt,
  appendAtText,
};
