/**
 * 通用 LLM 客户端：baseUrl + apiKey + model
 *
 * 默认走 OpenAI 兼容协议（多数三方中转 / 自建网关）：
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer {apiKey}
 *
 * 可选 apiStyle: 'anthropic' 走官方 Messages API 头与路径。
 *
 * 兼容旧配置 anthropicApiKey / anthropicModel。
 */

/**
 * @param {object} cfg loadConfig() 结果
 * @returns {{
 *   enabled: boolean,
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   apiStyle: 'openai'|'anthropic',
 *   timeoutMs: number,
 * }}
 */
function resolveLlmConfig(cfg = {}) {
  const nested = cfg.llm && typeof cfg.llm === 'object' ? cfg.llm : {};

  const apiKey =
    pick(
      process.env.LLM_API_KEY,
      process.env.OPENAI_API_KEY,
      nested.apiKey,
      cfg.llmApiKey,
      // 旧字段兼容
      process.env.ANTHROPIC_API_KEY,
      cfg.anthropicApiKey,
    ) || '';

  let baseUrl =
    pick(
      process.env.LLM_BASE_URL,
      process.env.OPENAI_BASE_URL,
      nested.baseUrl,
      cfg.llmBaseUrl,
      process.env.ANTHROPIC_BASE_URL,
      cfg.anthropicBaseUrl,
    ) || '';

  const model =
    pick(
      process.env.LLM_MODEL,
      process.env.OPENAI_MODEL,
      nested.model,
      cfg.llmModel,
      process.env.ANTHROPIC_MODEL,
      cfg.anthropicModel,
      'gpt-4o-mini',
    ) || 'gpt-4o-mini';

  let apiStyle = String(
    pick(process.env.LLM_API_STYLE, nested.apiStyle, cfg.llmApiStyle, '') || '',
  ).toLowerCase();

  // 仅配了旧 anthropic 字段、未显式 style 时，默认 anthropic 官方
  if (!apiStyle) {
    if (baseUrl && /anthropic\.com/i.test(baseUrl)) apiStyle = 'anthropic';
    else if (!baseUrl && (cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY) && !cfg.llmApiKey && !nested.apiKey) {
      apiStyle = 'anthropic';
      baseUrl = baseUrl || 'https://api.anthropic.com';
    } else {
      apiStyle = 'openai';
    }
  }

  if (!baseUrl) {
    baseUrl = apiStyle === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  }

  // 去掉末尾 /
  baseUrl = String(baseUrl).replace(/\/+$/, '');

  const timeoutMs = parseInt(
    String(pick(process.env.LLM_TIMEOUT_MS, nested.timeoutMs, cfg.llmTimeoutMs, 600000)),
    10,
  ) || 600000;


  return {
    enabled: Boolean(apiKey),
    baseUrl,
    apiKey,
    model,
    apiStyle: apiStyle === 'anthropic' ? 'anthropic' : 'openai',
    timeoutMs,
  };
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function isLlmConfigured(cfg) {
  return resolveLlmConfig(cfg).enabled;
}

/**
 * Chat completion，返回助手纯文本
 * @param {object} cfg
 * @param {{ system?: string, user: string, temperature?: number, maxTokens?: number }} opts
 */
async function chatText(cfg, opts) {
  const llm = resolveLlmConfig(cfg);
  if (!llm.enabled) {
    throw new Error('LLM 未配置：请设置 llm.apiKey（或 LLM_API_KEY）');
  }

  if (llm.apiStyle === 'anthropic') {
    return chatAnthropic(llm, opts);
  }
  return chatOpenAiCompatible(llm, opts);
}

/**
 * 要求模型返回 JSON 对象；从文本中抠第一段 JSON
 */
async function chatJson(cfg, opts) {
  const text = await chatText(cfg, opts);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`LLM 未返回 JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(jsonMatch[0]);
}

async function chatOpenAiCompatible(llm, opts) {
  const url = joinUrl(llm.baseUrl, 'chat/completions');
  const body = {
    model: llm.model,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
    messages: [],
  };
  if (opts.system) {
    body.messages.push({ role: 'system', content: opts.system });
  }
  body.messages.push({ role: 'user', content: opts.user });

  // 部分网关支持 json_object；失败时调用方仍可从文本解析
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    llm.timeoutMs,
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      JSON.stringify(data).slice(0, 300);
    throw new Error(`LLM HTTP ${res.status}: ${msg}`);
  }

  const choice = data.choices && data.choices[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // 少数实现 content 为 parts
    return content.map((p) => p.text || p.content || '').join('\n');
  }
  throw new Error(`LLM 响应无 choices[0].message.content: ${JSON.stringify(data).slice(0, 300)}`);
}

async function chatAnthropic(llm, opts) {
  const url = joinUrl(llm.baseUrl, 'v1/messages');
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': llm.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
        system: opts.system || undefined,
        messages: [{ role: 'user', content: opts.user }],
      }),
    },
    llm.timeoutMs,
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`LLM HTTP ${res.status}: ${msg}`);
  }
  const text = (data.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (!text) throw new Error(`Anthropic 响应无 text: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}

function joinUrl(base, pathPart) {
  let b = String(base).replace(/\/+$/, '');
  let p = String(pathPart).replace(/^\/+/, '');

  // openai: base 未含 /v1 且目标是 chat/completions → 自动补 /v1
  if (p === 'chat/completions' && !/\/v1$/i.test(b) && !/\/v\d+$/i.test(b)) {
    b = `${b}/v1`;
  }

  // base 已是 .../v1 且 path 误写 v1/...
  if (/\/v1$/i.test(b) && p.startsWith('v1/')) {
    p = p.slice(3);
  }

  return `${b}/${p}`;
}


async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM 请求超时 (${timeoutMs}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveLlmConfig,
  isLlmConfigured,
  chatText,
  chatJson,
};
