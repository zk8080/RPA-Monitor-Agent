# 架构冻结清单（Architecture Freeze）

> **地位：** 本文件冻结「是什么产品、边界在哪、什么绝不能写成脚本堆」。  
> 与 [TECH-DESIGN.md](TECH-DESIGN.md) 配套：TECH-DESIGN 管怎么建；**本文管建的时候不许偏到哪去**。  
> 与 [SPEC-monitor-agent.md](SPEC-monitor-agent.md) 配套：SPEC 管产品要什么；**本文管实现身份必须是 Agent**。  
> **变更规则：** 改本文任一条「冻结项」须显式修订本文 + TECH-DESIGN 对应节，禁止静默偏离。

---

## 0. 一句话定调（冻结）

> **最终交付物是可推广的 RPA 提效 Agent，不是脚本集。**  
> 能力可以弱（推理轮次少、skill 先只做 diagnose），**架构身份不能弱**（统一入口、Tool 注册、Memory、Runtime、可扩展 Skills）。

| 可以弱 | 不能弱 |
|--------|--------|
| 诊断深度、tool 轮次、归因文案质量 | 产品叫 Agent，入口与模块按 Agent 长 |
| 先只实现 `diagnose` skill | Skills 扩展缝（develop / maintain）预留 |
| M1 用 playbook 驱动代替自由探索 | 业务逻辑落在 lib tools + runner，不进薄入口 |
| 日报 / webhook / CF 后置 | queue / kb / cursor 作为 Agent Memory 存在 |

**绩效与推广叙事应对齐本文，而不是「我们写了几个 Node 脚本」。**

---

## 1. 产品身份（冻结）

### 1.1 正式名称（对内对外统一）

| 阶段 | 名称 | 说明 |
|------|------|------|
| 当前主交付 | **RPA Monitor & Diagnosis Agent** | 可监听运行失败 + 辅助诊断修复 |
| 演进目标 | **RPA Efficiency Agent** | 诊断 + 后续开发/维护等同 Runtime 扩展 |

仓库名 `RPA-Monitor-Agent` 可保留；**代码、文档、演示禁止自称「监控脚本 / 报表工具」作为最终形态。**

### 1.2 产品必须能讲清的五句话

实现任意里程碑时，以下五句须仍然成立：

1. 这是一个 **Agent**：有目标、有工具、有观察、有结构化产出、有记忆。  
2. **感知（监听）确定性**，**诊断（推理）走 Agent 面**，二者分离。  
3. 能力以 **Tool** 注册，CLI 与常驻 Runtime **共用同一套 lib**。  
4. 失败进入 **Memory（queue）**，诊断写入 **KB**，可复盘、可演示。  
5. 架构上可扩展 **新 skill**（开发/维护 RPA），而不是再开一摊独立脚本。

缺任一句 = 架构已漂，须停下来改结构，而不是继续堆功能。

---

## 2. 逻辑架构（冻结）

```
┌──────────────────────────────────────────────────────────┐
│           RPA Efficiency Agent（产品边界）                 │
│                                                          │
│  ┌─ Entrypoints（薄，禁止堆业务）───────────────────────┐ │
│  │  agent.js     统一 Agent CLI（按 skill 路由）         │ │
│  │  service.js   同一 Agent 的常驻 Runtime（M2）         │ │
│  │  poll.js      感知子系统 CLI 入口（薄封装）           │ │
│  │  report.js    产出渲染入口（可被 Runtime 调度）       │ │
│  │  verify_*.js  验收/探针，不进入产品主路径逻辑复制     │ │
│  └──────────────────────────────────────────────────────┘ │
│                          │                                 │
│  ┌─ Runtime / Scheduler（确定性触发）───────────────────┐ │
│  │  poll → fingerprint → enqueue / alert                 │ │
│  │  trigger skill: diagnose（及未来 develop/maintain）   │ │
│  │  report / health                                      │ │
│  │  禁止：在调度层内联 OpenAPI HTTP 或诊断 prompt        │ │
│  └──────────────────────────────────────────────────────┘ │
│                          │                                 │
│  ┌─ Skills（能力面，可扩展）────────────────────────────┐ │
│  │  diagnose   ← 当前唯一实现目标                        │ │
│  │  develop    ← 预留（接 rpa-skill 生成等）             │ │
│  │  maintain   ← 预留（inspect / 巡检等）                │ │
│  └──────────────────────────────────────────────────────┘ │
│                          │                                 │
│  ┌─ Agent Runner（脑，可弱不可无）──────────────────────┐ │
│  │  统一：装载 skill 可见 tools → 执行（playbook 或 loop）│ │
│  │       → 校验结构化输出 → 写 Memory/KB                 │ │
│  │  M1-min 允许 playbook；禁止绕过 runner 的平行诊断脚本 │ │
│  └──────────────────────────────────────────────────────┘ │
│                          │                                 │
│  ┌─ Tools（手，唯一实现落点）───────────────────────────┐ │
│  │  lib/yingdao · fingerprint · rpa · kb · …             │ │
│  │  lib/tools.js（或等价）= 名称/schema/handler 注册表   │ │
│  └──────────────────────────────────────────────────────┘ │
│                          │                                 │
│  ┌─ Memory / State（外置、可崩溃恢复）──────────────────┐ │
│  │  data/cursor · queue · kb · alerts · reports · app-map│ │
│  └──────────────────────────────────────────────────────┘ │
└───────────────────────────┬───────────────┬──────────────┘
                            ▼               ▼
                     影刀 OpenAPI     rpa-skill（只读）
```

**冻结含义：** 新代码必须落在上图某一层；若发现只能塞进「又一个独立 .js 脚本」且不经 tools/runner/memory，则设计错误。

---

## 3. 硬边界（冻结 · 不可破）

### 3.1 必须遵守

| # | 规则 |
|---|------|
| H1 | **监听确定性、诊断走 Agent 面、两者分离。** 轮询/去重/入队不调大模型。 |
| H2 | **禁止 Agent 主 loop 使用 `list_jobs` 做周期巡检。** `list_jobs` 仅感知层（poll / 调度）。 |
| H3 | **rpa-skill 只读 require**，不修改其源码与目录。 |
| H4 | **密钥不入库**（`config.local.js` / 环境变量）。 |
| H5 | **状态外置**于 `data/*`；进程可崩溃重跑（指纹去重 + `diagnosed` 幂等）。 |
| H6 | **业务能力只进 `monitor/lib/*`（及明确的 report 模块）**；入口文件只做参数解析与调用。 |
| H7 | **新能力默认以 Tool 形式出现**，并挂到注册表；禁止只在某个入口文件里写死一份 HTTP/读盘逻辑。 |
| H8 | **诊断输出必须走结构化契约**（见 TECH-DESIGN §3.4），并具备写入 KB 的路径（可 `pending_review`）。 |
| H9 | **CLI 与 Service 调用同一套 runner + tools**；禁止 Service 一套逻辑、CLI 另一套复制粘贴。 |
| H10 | **Skills 路由预留**：入口形态为 `agent.js <skill> ...`（或等价），当前 skill=`diagnose`；禁止把入口写成死函数名且无法扩展第二 skill。 |

### 3.2 明确禁止（实现红线）

| 禁止 | 原因 |
|------|------|
| 新增 `diagnose.js` 作为与 Agent 平行的「真正诊断实现」 | 双栈，最终推倒重来 |
| 在 `poll.js` 内联鉴权/list/search 的完整 HTTP 实现 | 感知逻辑必须复用 `lib/yingdao` |
| 入口文件超过「薄封装」体量（大段业务分支、prompt、解析） | 身份退化成脚本集 |
| 诊断结果只 `console.log` 散文、不写 queue/kb 状态 | 没有 Memory，不可演示闭环 |
| 为了快，把 tool 逻辑复制进 runner/prompt 字符串长期维护 | 手脑再次粘连 |
| 未确认 KB 条目直接当高置信自动短路（M3 前） | 错误工业化；M1 只允许 search 附带 |
| 修改 rpa-skill 或把本仓逻辑写进 rpa-skill | 边界破坏 |
| 先做空转 `service.js`（无 diagnose skill 闭环）当主进度 | 本末倒置（有壳无脑） |

### 3.3 允许的弱化（不是红线）

- Runner 在 **M1-min** 用 **playbook**（固定 tool 序 + 一次/少次模型调用），不必一上来完全自主 tool-use。  
- `maxToolRounds` 可先设低（如 2～4）。  
- 无本地 xbot_robot 时降级为 remark/log 诊断，`confidence` 下调。  
- **resolve_app** 默认自动扫描 `%LOCALAPPDATA%\ShadowBot\users\*\apps\<robotUuid>\xbot_robot`。  

- `develop` / `maintain` skill 仅占位（路由拒绝并提示未实现即可）。  
- 紧急告警旁路不经完整 diagnose（仍须写 `data/alerts`，规则确定性）。

**弱化边界：** 弱的是推理策略，不是「有没有 runner / tools / skill 入口 / 结构化 I/O」。

---

## 4. 模块与命名冻结

### 4.1 目录与职责（不得改名乱挂）

| 路径 | 职责 | 禁止变成 |
|------|------|----------|
| `monitor/agent.js` | **唯一** Agent CLI 入口；解析 skill + 参数 → runner | 诊断业务本体 |
| `monitor/service.js` | 常驻 Runtime：调度 poll / diagnose / report | 重写一套 tools |
| `monitor/poll.js` | 感知 CLI：一次或循环调用感知流水线 | OpenAPI 客户端本体 |
| `monitor/report.js` | 报告渲染（可被 skill/调度调用） | 独立「分析引擎」 |
| `monitor/verify_openapi.js` | 链路验收；应依赖 lib，不复制长期业务分叉 | 第二个 yingdao |
| `monitor/lib/yingdao.js` | OpenAPI client（token 缓存、list、search） | — |
| `monitor/lib/fingerprint.js` | 错误指纹 | — |
| `monitor/lib/rpa.js` | rpa-skill 适配 | — |
| `monitor/lib/kb.js` | 知识库读写查 | — |
| `monitor/lib/tools.js` | **Tool 注册表**（name / schema / handler / 可见 skill） | 可与 runner 合并，但注册概念必须存在 |
| `monitor/lib/agent-runner.js` | Skill 执行：playbook 或 tool-loop + 输出校验 | 具体 HTTP/读 flow 实现 |
| `monitor/lib/skills/*`（可选） | 每 skill 的 prompt/playbook/可见 tool 列表 | 把 skill 逻辑写回入口 |
| `data/*` | Memory / State | 提交密钥或把 data 当代码 |

> `tools.js` / `skills/` 可在实现时合并文件，但 **注册表 + skill 路由 + runner** 三个概念不可消灭。

### 4.2 Tool 清单归属（冻结）

| Tool | 模块 | 谁可调用 |
|------|------|----------|
| `get_token` | yingdao | 内部；对 Agent 透明优先 |
| `list_jobs` | yingdao | **仅** poll / 调度感知；**不进** diagnose 主 loop |
| `search_logs` | yingdao | diagnose；poll 补全指纹时也可 |
| `build_fingerprint` | fingerprint | poll；diagnose 可校验 |
| `resolve_app` | rpa | diagnose |
| `understand_flow` | rpa | diagnose（及未来 maintain） |
| `load_blocks` | rpa | diagnose |
| `kb_search` / `kb_write` | kb | diagnose（及未来 skills） |
| `render_report` | report | 调度 / 显式 skill 步骤 |

新增 tool：先补注册表与本文/TECH-DESIGN 清单，再写 handler。

### 4.3 CLI 形态（冻结）

```bash
# Agent 主入口（skill 在前）
node monitor/agent.js diagnose --job <jobUuid>
node monitor/agent.js diagnose --fingerprint <fp>
node monitor/agent.js diagnose --queue [--limit N]

# 预留（可先打印 not implemented）
node monitor/agent.js develop ...
node monitor/agent.js maintain ...

# 感知 / 运行时（仍是同一产品，不是旁路项目）
node monitor/poll.js [--once]
node monitor/service.js
node monitor/report.js [--date YYYY-MM-DD]
```

---

## 5. Skill 模型（冻结）

### 5.1 当前与预留

| Skill | 状态 | 目标 | 典型 tools |
|-------|------|------|------------|
| `diagnose` | **现在做** | 失败 → 根因/定位/建议 → KB | search_logs, resolve_app, understand_flow, load_blocks, kb_* |
| `develop` | 预留 | 新开发/生成流程辅助 | 未来：rpa generate 等（只读接 skill 仓） |
| `maintain` | 预留 | 巡检/结构风险/批量维护 | 未来：inspect, validate 等 |

### 5.2 Skill 契约（最小）

每个 skill 必须能回答：

1. **输入**：从哪来（queue 条目 / 用户参数 / 未来需求文档）  
2. **可见 tools**：注册表过滤列表  
3. **输出**：结构化 JSON schema（diagnose 用 TECH-DESIGN §3.4）  
4. **记忆副作用**：写 queue 字段 / kb / reports 中的哪些  

未实现的 skill：统一错误 `skill_not_implemented`，不要静默 no-op。

---

## 6. 推理强度 vs 架构完整度（冻结）

### 6.1 两档 M1（防止空转，也防止假 Agent）

| 档位 | 推理 | 架构要求 | 可否对外称 Agent |
|------|------|----------|------------------|
| **M1-min** | Playbook：固定/半固定 tool 序 + 模型生成结构化结论；轮次可很少 | 已有 agent 入口、tools 注册表、runner、diagnose I/O、kb_write 路径 | **可以**（弱脑 Agent） |
| **M1-full** | 多轮 tool-use，模型决定下一步 | 同上 + 自主 loop 稳定、校验/降级 | 增强演示 |

### 6.2 判定「这还是不是 Agent」

同时满足才算：

- [ ] 经 `agent.js diagnose`（或 service 调同一 runner）触发  
- [ ] 至少调用 **注册表中的 tool**（禁止 runner 内联第二套实现）  
- [ ] 产出符合诊断 JSON 契约（字段可部分为空，但 schema 在）  
- [ ] 对 queue/kb 有明确状态更新（`diagnosed` / `kbId` / KB 文件之一）  

仅「curl 日志 + 拼一段 prompt 打印」= **未达标**，即使文件名叫 agent.js。

---

## 7. Memory 语义（冻结）

| 存储 | 角色 | 写入方 |
|------|------|--------|
| `data/cursor.json` | 感知游标 | poll |
| `data/queue/<fp>.json` | 工作记忆：待诊/已诊失败聚合 | poll 写入；diagnose 更新 |
| `data/kb/KB-*.json` | 长期记忆：根因与方案 | diagnose（及人工确认流） |
| `data/alerts/*` | 紧急旁路事件 | poll 规则 |
| `data/reports/*` | 对外产出 | report / 调度 |
| `data/app-map.json` | 可选：robotUuid → xbotDir 手工覆盖 | 默认由 ShadowBot 自动发现，非必须 |


**冻结：**

- queue / kb 是 Agent Memory，不是「临时 debug 文件」。  
- KB 默认 `status: pending_review`；**M3 前禁止**未确认条目自动短路当最终结论。  
- 指纹主键策略遵循 TECH-DESIGN；跨应用归并为增强，不破坏现有 queue 文件名语义时可加 `errorSignature` 字段。

---

## 8. 实现顺序与防漂检查点

> 详细步骤仍以 TECH-DESIGN §十为准。本节只冻结 **防架构漂移** 的插入点。

| 步 | 交付 | 架构检查（不通过 = 返工） |
|----|------|---------------------------|
| S0–S9 | 最小闭环 + 部署 | ✅ 已实现（见 TECH-DESIGN 当前进度） |
| S4 | `lib/rpa.js` | 自动 ShadowBot 路径 + 可选 app-map |
| S6 | diagnose playbook | 规则 ± LLM ± rpa-skill 读块 |
| S8 | `report.js` | **本轮** findings，不展示历史 occurrence |
| S10 | M3 增强 | 不破坏 H1–H10 |


**顺序铁律：**

1. **S6（Agent 闭环）在 S9（常驻壳）之前。**  
2. **S3.5 不晚于 S5**：禁止 tool 齐了却没有 agent 入口与注册表。  
3. 禁止「先写完所有脚本逻辑，最后再 refactor 成 Agent」。

---

## 9. 走偏信号（出现即停）

若评审或 code review 出现以下现象，视为架构违规：

1. README 主路径变成三个互不调用的脚本说明，且没有 Agent / tools / memory 图。  
2. `agent.js` 不存在或只是别的脚本的 `spawn` 包装，核心逻辑在平行文件。  
3. 新增诊断能力只改了 prompt 字符串，没有 tool 或没有注册。  
4. Service 里复制了一份 listJobs/searchLogs。  
5. 演示只能「看控制台输出」，不能指着 queue/kb 文件讲闭环。  
6. 为绩效临时改 PPT 称 Agent，代码仍是脚本堆（**以代码结构为准**）。

---

## 10. 宣讲口径（冻结 · 与实现对齐）

**推荐表述：**

> 我们交付的是 **RPA 监听诊断 Agent**：确定性感知影刀运行失败并入队，诊断技能通过 Tool 调用 OpenAPI 日志、流程解析（rpa-skill）与本地知识库，输出结构化根因与修复方向；同一 Runtime 可常驻运行，并预留开发/维护类技能扩展，形成 RPA 提效 Agent 平台能力。

**避免表述：**

> 我们写了轮询脚本和日报脚本，以后再加 AI。

确定性监听不是减分项，而是 **Agent 感知层的可靠性设计**——宣讲时应主动讲清「为什么不让模型轮询」。

---

## 11. 与 TECH-DESIGN 的修订关系

| 本文 | TECH-DESIGN |
|------|-------------|
| 身份、红线、模块边界、skill、M1-min/full、S3.5 | 接口细节、指纹规则、配置、S1–S10 任务表、数据字段 |
| 冲突时 | **先服从本文冻结项**，再回头改 TECH-DESIGN 细节 |

TECH-DESIGN 已有正确方向；落地时以本文为 **guardrail**，避免「功能弱化」被执行成「架构脚本化」。

---

## 12. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-11 | 初版：冻结 Agent 产品身份、硬边界、模块、skill、M1 两档、S3.5 检查点、宣讲口径 |

---

*冻结状态：生效。实现从 S1 起必须可追溯到本文 H1–H10 与 §6.2。*
