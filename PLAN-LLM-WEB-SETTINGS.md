# 计划：工作台配置 LLM（S26）

> **状态：** ✅ 已实现（S26）  
> **编号：** S26（P1 建议）  
> **关联：** [TECH-DESIGN.md](TECH-DESIGN.md) · [WEB-WORKBENCH-MVP.md](WEB-WORKBENCH-MVP.md) · [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)  
> **目标：** 在本机 Web 工作台配置 LLM（baseUrl / apiKey / model 等），无需手改 `config.local.js` 并尽量热生效。

---

## 1. 背景与动机

| 现状 | 问题 |
|------|------|
| LLM 写在 `config.local.js` 或环境变量 | 换模型/网关要改文件 + 常需重启 |
| `loadConfig()` 启动时 `require` | 改 local.js 不热更新 |
| service 默认偏 `--no-llm` | 配了 key 仍可能不走模型，体验拧巴 |
| 工作台无设置面 | 非开发同事难用 |

**不做：** 完整「系统设置中心」、Web 配置影刀密钥（二期）、把密钥写进 git。

---

## 2. 设计原则（对齐冻结清单）

1. **密钥不入库**：可写配置落在 `data/*`（gitignore），禁止提交。  
2. **业务进 lib**：读写/脱敏/merge 在 `lib/settings.js`（或等价）；HTTP 路由薄。  
3. **不改 `config.local.js`**：Web **不**覆写 JS 模块；避免格式损坏与 `require` 缓存。  
4. **仅本机**：继续只绑 `127.0.0.1`；`workbench.settingsEnabled` 可关写接口。  
5. **CLI / service / Web 共用** 同一 `loadConfig` / `resolveLlmConfig` 结果。  
6. **读接口脱敏**：前端永不拿到完整 apiKey。

---

## 3. 配置优先级（定稿）

```text
环境变量（最高，部署强制）
  → data/settings.llm.json（Web 可写覆盖层）
    → config.local.js / 嵌套 llm
      → 代码默认值
```

| 层级 | 用途 |
|------|------|
| env | 服务器/CI 注入，压过一切 |
| `data/settings.llm.json` | 本机工作台持久化，热读 |
| `config.local.js` | 开发者底稿、bootstrap |
| defaults | 空 key → LLM 视为未启用 |

---

## 4. 数据模型

### 4.1 文件：`data/settings.llm.json`

```json
{
  "version": 1,
  "updatedAt": "2026-07-13T10:00:00.000Z",
  "baseUrl": "https://national.venlacy.com/v1",
  "apiKey": "sk-...",
  "model": "grok-4.5",
  "apiStyle": "openai",
  "timeoutMs": 600000,
  "diagnoseUseLlm": true
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `baseUrl` | 建议 | OpenAI 兼容根路径 |
| `apiKey` | 建议 | 明文仅存 data 盘；GET 永不回全文 |
| `model` | 建议 | |
| `apiStyle` | 可选 | `openai`（默认）\| `anthropic` |
| `timeoutMs` | 可选 | 默认 600000 |
| `diagnoseUseLlm` | 可选 | **service / 工作台 diagnose 默认是否用 LLM**；默认 `true`（有可用 key 时） |

**注意：** 文件含密钥 → 确认 `data/` 已在 `.gitignore`；备份/打包文档注明勿外传。

### 4.2 运行时 merge 结果（对内）

与现有一致，最终仍产出：

```js
cfg.llm = { baseUrl, apiKey, model, apiStyle, timeoutMs }
cfg.diagnoseUseLlm = boolean  // 新增语义字段
```

`lib/llm.js` 的 `resolveLlmConfig` **尽量少改**；优先在 `loadConfig` 合并 file overlay。

---

## 5. API（本机 workbench）

均受 `workbench.enabled` + 建议 `workbench.settingsEnabled`（默认 true）约束。

### 5.1 `GET /api/settings/llm`

**响应（脱敏）：**

```json
{
  "ok": true,
  "configured": true,
  "source": "settings_file|env|config_local|none",
  "baseUrl": "https://...",
  "model": "grok-4.5",
  "apiStyle": "openai",
  "timeoutMs": 600000,
  "diagnoseUseLlm": true,
  "apiKeyConfigured": true,
  "apiKeyMasked": "sk-…Ot9o",
  "envLocked": {
    "apiKey": false,
    "baseUrl": false,
    "model": false
  }
}
```

- `envLocked.*`：该字段若被环境变量固定，UI 显示只读并提示「由环境变量锁定」。  
- **禁止**返回 `apiKey` 全文。

### 5.2 `PUT /api/settings/llm`

**请求：**

```json
{
  "baseUrl": "...",
  "apiKey": "...",
  "model": "...",
  "apiStyle": "openai",
  "timeoutMs": 600000,
  "diagnoseUseLlm": true
}
```

| 约定 | 行为 |
|------|------|
| `apiKey` 省略或 `""` | **保留**文件中已有 key（避免「保存其它字段误清空」） |
| `apiKey` 为特殊字面量 `"__CLEAR__"` 或 `"clear": true` | 清空 key（二选一，实现时定一种） |
| env 已锁定字段 | 忽略写入或 400，响应说明 |

写成功后：`updatedAt` 刷新；可选短缓存 invalidate。

### 5.3 `POST /api/settings/llm/test`（M1 包含）

- 用**当前请求 body 或已保存配置**发一条极短 chat（如 `ping` → 期望任意非空回复）。  
- 超时沿用 `timeoutMs`（可上限 30s 测活用）。  
- 响应：`{ ok, latencyMs, model, message? }`；错误不回显完整 key。

### 5.4 非目标 API（本期不做）

- 影刀 AK/SK  
- poll 间隔 / cron  
- 多 profile 切换  

---

## 6. 模块与改动面

| 路径 | 职责 |
|------|------|
| `monitor/lib/settings-llm.js`（新） | 读/写 `data/settings.llm.json`、mask、merge helpers、test 调用 |
| `monitor/lib/config.js` | `loadConfig` 合并 file overlay；缓存策略见下 |
| `monitor/lib/llm.js` | 仅必要时适配；test 可复用 `chat` |
| `monitor/lib/http/routes.js` | GET/PUT/POST 薄封装 |
| `monitor/lib/workbench.js` | 可选：`getLlmSettings` / `saveLlmSettings` 供 routes 调 |
| `monitor/service.js` | diagnose 默认 `useLlm` 读 `cfg.diagnoseUseLlm`（有 key 时） |
| `monitor/web/app.js` + `index.html` / `styles.css` | 「设置」页或总览入口抽屉 |
| `monitor/config.example.js` | 注释说明：Web 可覆盖；env 优先 |
| `monitor/test_settings_llm.js`（新） | 脱敏、merge 优先级、空 key 保留、弱特征写盘 |

**禁止：** 在 `web/app.js` 存 key 到 localStorage；在 `service.js` 内联 HTTP 调模型。

---

## 7. 热更新策略

| 方案 | 采用 |
|------|------|
| 每次 `loadConfig()` 读 JSON | **是**（可加 1～2s mtime 缓存，写时 invalidate） |
| 写完杀进程 | 否 |
| 改 `config.local.js` | 否 |

**service 常驻：** 下一轮 poll→diagnose 或工作台一键 diagnose 即用新配置，**无需重启**（env 变更仍需重启/重载进程）。

---

## 8. diagnose 默认是否用 LLM（产品定稿）

| 场景 | 行为 |
|------|------|
| 无可用 apiKey（各层皆空） | 纯规则；与今一致 |
| 有 apiKey 且 `diagnoseUseLlm !== false` | **默认 useLlm=true**（service 周期 / 工作台一键） |
| `diagnoseUseLlm === false` | 强制规则，即使有 key |
| CLI `--llm` / `--no-llm` | **显式参数仍优先**于 settings |

实现要点：

- 改 `service.js`：`opts.noLlm` 默认改为「由 cfg 决定」而非写死 `true`。  
- 工作台 `runWorkbenchAction` diagnose：默认跟 `diagnoseUseLlm`，请求体可覆盖。

---

## 9. Web UI（M1）

### 入口

- 侧栏新增 **「设置」**（或总览右上角齿轮）→ 单页「LLM」。

### 表单

| 控件 | 绑定 |
|------|------|
| Base URL | baseUrl |
| API Key | 密码框；placeholder 显示 masked；留空=不修改 |
| Model | model |
| API 风格 | select openai / anthropic |
| 超时 (ms) | timeoutMs |
| 诊断使用 LLM | checkbox → diagnoseUseLlm |
| 保存 | PUT |
| 测试连接 | POST test |
| 来源提示 | source + envLocked |

### 状态

- 保存成功 toast；测试中 disabled；失败展示 `message`（无 key）。  
- `settingsEnabled: false` 时只读提示。

---

## 10. 实现步骤（PR 切分建议）

### PR1 — 后端骨架（可无 UI）

1. `lib/settings-llm.js`：path、read、write（atomic）、mask、merge  
2. `loadConfig` 接入 overlay + `diagnoseUseLlm`  
3. routes：GET / PUT / test  
4. `test_settings_llm.js`  
5. `.gitignore` 确认 `data/` 已覆盖（必要时加 `data/settings*.json` 注释）

**验收：** curl 本机 PUT 后 GET 见 masked；`node -e` loadConfig 能读到新 model；env 压过 file。

### PR2 — service / workbench 行为

1. service 默认 useLlm 跟 settings  
2. 工作台 diagnose 默认跟 settings  
3. 日志打一行 `llm configured=… useLlm=…`（**不打 key**）

**验收：** 仅写 data 文件、不改 config.local，轮询/一键诊断能走 LLM。

### PR3 — Web UI

1. 设置页 + 表单 + 测试  
2. 侧栏入口  
3. 简短 `DEPLOY.md` / `WEB-WORKBENCH-MVP` / `CLAUDE` 补一句

**验收：** 浏览器改 model → 测试连接成功 → 保存 → 刷新仍在；完整 key 不出现在 Network 响应（除用户自己 PUT 的 body）。

---

## 11. 验收清单

- [ ] `data/settings.llm.json` 可写；git status 不出现密钥文件（data 被 ignore）  
- [ ] GET 无明文 key；mask 正确  
- [ ] PUT 空 apiKey 不清空  
- [ ] 优先级：env > file > local.js  
- [ ] 改 file 后无需重启 service 即可下一轮生效  
- [ ] diagnoseUseLlm 开关控制 service / Web 默认  
- [ ] CLI `--no-llm` 仍可强制规则  
- [ ] test 接口在错误网关时返回可读错误  
- [ ] 仅 127.0.0.1；架构无平行 LLM 客户端  

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| data 备份泄露 key | 文档警告；后续可选 DPAPI/系统凭据（非 M1） |
| 误绑 0.0.0.0 | 保持现有 bind；settings 写接口同 host |
| require 缓存 local.js | Web 只动 JSON |
| 与 config.local 双源混淆 | UI 展示 `source`；README 写清优先级 |
| test 烧 token | 最短 prompt；可选日限（后置） |

---

## 13. 工作量粗估

| 块 | 量级 |
|----|------|
| PR1 lib + API + 测试 | 0.5～1 d |
| PR2 service/workbench 接线 | 0.25 d |
| PR3 UI + 文档 | 0.5 d |
| **合计** | **约 1～2 人日** |

---

## 14. 明确不做（本期）

- 多模型 profile / 一键切换账号  
- Web 配影刀 OpenAPI  
- 远程多用户鉴权  
- 加密存 key（可列 S26b）  
- 改 ARCHITECTURE 身份边界  

---

## 15. 文档回写（实现时）

| 文档 | 补什么 |
|------|--------|
| TECH-DESIGN §十五 | S26 行 + 配置优先级一句 |
| WEB-WORKBENCH-MVP | 设置页与 API |
| DEPLOY | data/settings.llm.json；env 优先 |
| CLAUDE.md | 实现要点表一行 |
| config.example.js | 注释指向 Web / data overlay |

---

## 16. 拍板记录（讨论结论）

| 项 | 结论 |
|----|------|
| 存储 | `data/settings.llm.json`，不改 config.local.js |
| 测试连接 | **M1 做** |
| 默认 LLM | 有 key 且 diagnoseUseLlm 非 false → 默认用 |
| UI | 侧栏「设置」 |
| 开关 | `workbench.settingsEnabled` 可关写 |

---

**下一步：** 确认本计划无异议后按 PR1→PR3 实现；实现中若 env 锁定字段交互要简化，可先做「env 存在则整表只读」。
