# RPA 监听诊断 Agent — 技术方案

> 基于 [SPEC-monitor-agent.md](SPEC-monitor-agent.md)。产品设计已定型，OpenAPI 衔接点已验证。  
> **最终交付物：一个可独立运行、可推广的 RPA 诊断 / 提效 Agent**（不是三个散装脚本）。  
> **架构红线与防漂清单见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)**（身份、硬边界、Skill、M1-min/full、S3.5；与本文冲突时先服从冻结清单）。  
> 本文描述从工具层 → 诊断 Agent → 常驻运行时 → 自主闭环的完整技术路径。  
> 先本地实现，暂不部署生产。

---

## 一、目标与边界

### 1.1 最终交付物定义

> **RPA 诊断 AI Agent：确定性监听入队 + Tool-using Diagnosis Agent + 本地 KB 记忆 + 可常驻运行时。**  
> 演进名：**RPA Efficiency Agent**（诊断 skill 之外预留 develop / maintain，见冻结清单 §5）。

它回答的是 **WHY（根因）+ SO WHAT（怎么修）**，不重复造影刀 Dashboard（Dashboard 回答 WHAT）。

| 能力 | 含义 |
|------|------|
| 目标 | 理解线上 RPA 失败，给出根因与修复方向 |
| 感知 | 自行拉取运行记录 / 步骤日志 |
| 工具 | 查流程结构、查/写 KB、渲染报告、紧急告警 |
| 推理 | 多步排查（信息不够就再调工具）；**M1-min 允许 playbook 弱推理** |
| 记忆 | KB + 历史诊断可复用 |
| 运行 | 可常驻服务，也可 CLI 单次拉起 |
| 扩展 | 同一 Runtime 可挂载新 skill（开发/维护），禁止平行脚本栈 |

**能力可弱，架构身份不可弱**——详见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) §0。

### 1.2 硬原则（不可破）

完整红线见冻结清单 **H1–H10**。此处摘要：

1. **监听确定性、诊断走 Agent 面、两者分离**  
   轮询 / 去重 / 入队不走大模型；Agent 只负责理解与决策。  
   禁止让 Agent 自己每 N 分钟轮询 OpenAPI（贵、慢、不稳）。
2. **rpa-skill 只读引用**，不修改其源码与目录。
3. **密钥不入库**，走 `config.local.js` / 环境变量。
4. **状态外置**，进程可崩溃重跑（指纹去重 + diagnosed 幂等）。
5. **业务进 lib tools + runner**；入口薄封装；CLI 与 Service 共用一套实现。
6. **新能力以 Tool / Skill 扩展**，禁止新增与 Agent 平行的 `diagnose.js` 业务栈。

### 1.3 分阶段交付（与 SPEC 对齐并升级）

| 阶段 | 目标 | 形态 |
|------|------|------|
| **M0 工具层** | Agent 的「手」：OpenAPI / 指纹 / rpa / kb + **tool 注册表落桩** | 可 import 的 lib + 验证脚本 |
| **M1 诊断 Agent** | 对单条失败 / 指纹做诊断（**M1-min playbook 或 M1-full tool-loop**） | CLI：`agent.js diagnose` |
| **M2 Agent 运行时** | 常驻调度 + 自动入队 + 自动诊断 + 日报 | 独立服务进程（同一 runner） |
| **M3 自主闭环** | KB-first、跨应用归并、分诊、可行动建议 | 产品化增强 |

> 与旧 Phase 编号关系：SPEC 的 Phase 1 ≈ 本方案 M0+M1+M2 的最小闭环；SPEC Phase 2（KB-first 实时）≈ M3；Phase 3/4（分诊/Jira/自动修复）接在 M3 之后。

**M1 两档（与冻结清单 §6 对齐）：**

| 档位 | 含义 | 对外称 Agent |
|------|------|----------------|
| **M1-min** | 注册表 + runner + 结构化 I/O + kb 路径；推理可为固定/半固定 playbook | ✅ 可（弱脑） |
| **M1-full** | 多轮自主 tool-use 稳定 | 增强 |

### 1.4 明确不做（当前不进主路径）

- 用 Agent 做 OpenAPI 轮询
- 常驻 Web Dashboard UI（可后加轻量 HTTP 控制面）
- 自动改流程（SPEC Phase 4，审批闸门未定前不做）
- 修改 rpa-skill 源码
- **先做空转 service、后补诊断**（有壳无脑）
- **平行脚本诊断栈**（与 `agent.js` 双轨）

---

## 二、总体架构

### 2.1 逻辑架构

```
┌──────────────────────────────────────────────────────────────┐
│         RPA Efficiency Agent（产品边界 · 见冻结清单）          │
│  ┌─ Entrypoints（薄）───────────────────────────────────────┐ │
│  │  agent.js（skill 路由）· service.js · poll.js · report.js │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌─ Scheduler / Runtime（确定性触发，M2 常驻）──────────────┐ │
│  │  every N min → poll & fingerprint & enqueue              │ │
│  │  daily / drain → skill: diagnose                         │ │
│  │  daily → report                                          │ │
│  │  紧急规则 → alerts（旁路，不经完整 diagnose）             │ │
│  └──────────────────────────────────────────────────────────┘ │
│                          │ 写入 queue（Memory）                │
│                          ▼                                     │
│  ┌─ Skills + Agent Runner（脑，可弱不可无）─────────────────┐ │
│  │  diagnose（现）· develop/maintain（预留）                 │ │
│  │  Playbook 或 tool-loop → 结构化 JSON → KB                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌─ Tools（手 · lib/* + 注册表）────────────────────────────┐ │
│  │  yingdao · fingerprint · rpa · kb · render_report …      │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌─ Memory / State ─────────────────────────────────────────┐ │
│  │  data/cursor · queue · kb · alerts · reports · app-map   │ │
│  └──────────────────────────────────────────────────────────┘ │
│  可选 HTTP：/health · /diagnose · /reports（M2 后置）         │
└───────────────┬───────────────────────────┬───────────────────┘
                │                           │
                ▼                           ▼
         影刀 OpenAPI                 rpa-skill（只读 require）
         token / job/list             understand / project_reader
         job/log/search               block_library / inspect
                │                           │
                └─────────── LLM API ───────┘
                     （仅 Skill 推理面，非 poll）
```

规范图示与红线见 [ARCHITECTURE-FREEZE.md §2–3](ARCHITECTURE-FREEZE.md)。

### 2.2 进程形态演进

| 阶段 | 怎么跑 | 说明 |
|------|--------|------|
| M0–M1 | CLI 短进程 | `node monitor/agent.js diagnose ...`；poll 可独立跑 |
| M2+ | **一个常驻服务** | `node monitor/service.js` 或 PM2 / Windows 服务 |
| 始终可降级 | 手动 CLI | 服务挂了也能单次诊断，不锁死 |

M0/M1 看起来像脚本是**过渡进程形态**；模块必须按「可被 Agent runtime 与 CLI 共用」来写，避免最后推倒重来。  
**进程短 ≠ 产品是脚本**——身份与模块边界从第一天按 Agent。

### 2.3 数据流（端到端）

```
影刀失败运行
    │ poll（确定性感知）
    ▼
指纹去重 ──紧急──▶ data/alerts/（即时，不经完整 diagnose）
    │ 普通
    ▼
data/queue/<fingerprint>.json          ← Agent 工作记忆
    │ skill: diagnose（runner + tools）
    ├─ search_logs / understand_flow / load_blocks / kb_search
    ▼
data/kb/KB-XXXX.json                   ← 长期记忆
    │ report
    ▼
data/reports/YYYY-MM-DD.md
```

---

## 三、Diagnosis Agent 设计（核心）

### 3.1 定位

`diagnose` 是当前唯一实现的 **Skill**，是最终交付物的智能核心（演进后与 develop/maintain 并列）。  
它不是「把日志塞进一次 prompt 的一次性脚本」，而是 **经 runner 调用 tools、产出结构化结果并写入 Memory** 的诊断技能：

```
观察 queue 条目
  → 需要日志？→ search_logs
  → 需要流程结构？→ resolve_app → understand_flow / load_blocks
  → 有历史吗？→ kb_search
  → 信息足够？→ 输出结构化诊断 → kb_write
  → 不够？→ 继续调 tool（有步数/费用上限；M1-min 可用固定序）
```

### 3.2 运行方式

| 场景 | 方式 | 理由 |
|------|------|------|
| 队列批量诊断 / 定时诊断 | **Messages API + tools**（经 `agent-runner`） | 无状态、可 cron/服务化 |
| M1-min | Runner 内 **playbook** 调同一批 tools + 模型出 JSON | 弱脑、架构仍是 Agent |
| 开发者临时深挖 | Claude Code + `/rpa` 等 | 交互式，不进自动化主路径 |

主路径只用 API（经 `lib/llm.js`）。  
通用配置：`llmBaseUrl` + `llmApiKey` + `llmModel`（或嵌套 `llm: { baseUrl, apiKey, model }`），默认 **OpenAI 兼容** `chat/completions`，任意三方中转均可。  
`llmApiStyle: 'anthropic'` 时走官方 Messages 风格。  
旧字段 `anthropicApiKey` / `anthropicModel` 仍兼容。无 apiKey 时 diagnose 纯规则。


### 3.3 Tool 清单（Agent 的手）

所有 tool 实现落在 `monitor/lib/*`，经 **注册表** 暴露；Agent 与 CLI 共用。

| Tool 名 | 底层模块 | 作用 | 何时用 |
|---------|----------|------|--------|
| `get_token` | `lib/yingdao.js` | 鉴权（通常对 Agent 透明，由客户端缓存） | 内部 |
| `list_jobs` | `lib/yingdao.js` | 拉运行记录（**供 poll 用，不进 diagnose 主 loop**） | 调度层 |
| `search_logs` | `lib/yingdao.js` | 按 jobUuid 拉步骤日志 | 补全 flowName/line/text |
| `build_fingerprint` | `lib/fingerprint.js` | remark/日志 → 稳定指纹 | poll 入队；Agent 校验 |
| `resolve_app` | `lib/rpa.js` | robotUuid → 本地 xbotDir（app-map） | 诊断前 |
| `understand_flow` | `lib/rpa.js` | 调 rpa-skill understand | 需要流程语义时 |
| `load_blocks` | `lib/rpa.js` | 读 flowName 在 lineNumber 附近的指令块 | 精确定位 |
| `kb_search` | `lib/kb.js` | 按 fingerprint / 类型 / 元素查历史 | 诊断前必查 |
| `kb_write` | `lib/kb.js` | 写入/更新知识库条目 | 诊断完成后 |
| `render_report` | report 模块 | 渲染日报（也可调度层直接调） | 日报任务 |

**边界：** `list_jobs` 给确定性 poll 用，不作为 diagnose 每轮「自己去扫盘」的工具。Skill 输入应是**已经入队的失败**或用户指定的 `jobUuid`。

### 3.4 诊断 I/O 契约

**Agent 初始输入（系统/用户消息中的任务上下文）：**

```json
{
  "task": "diagnose_failure",
  "skill": "diagnose",
  "error": {
    "fingerprint": "...",
    "robotUuid": "...",
    "robotName": "...",
    "flowName": "...",
    "lineNumber": "...",
    "errorType": "...",
    "elementName": "...",
    "remark": "...",
    "occurrenceCount": 3,
    "sampleJobUuids": ["..."]
  },
  "constraints": {
    "maxToolRounds": 8,
    "preferKbReuse": true
  }
}
```

**最终输出（强制 JSON，结束 loop 时提交）：**

```json
{
  "rootCause": "一句话根因",
  "location": "子流程/行号/指令类型",
  "suggestion": "修复方向",
  "confidence": 0.0,
  "errorCategory": "element|file|login|network|data|other",
  "relatedFingerprintHints": [],
  "kbAction": "create|update|reuse",
  "reusedKbId": null,
  "notes": "可选：信息不足时的说明"
}
```

### 3.5 Loop 控制与成本

| 项 | 规则 |
|----|------|
| 最大 tool 轮次 | 默认 8，可配；M1-min 可更低 |
| 同指纹 24h | 完整 diagnose 最多 1 次；再次出现只累加 occurrence |
| KB 高置信命中 | M3：可短路；M1 先实现 search + 附带历史；**未确认 KB 不自动当最终结论** |
| 无本地流程目录 | 允许降级：仅日志 + remark，`confidence` 下调，不阻塞整批 |
| 有 xbot_robot | `resolve_app`（ShadowBot 自动发现优先）→ understand + load_blocks → 规则补指令名；可选 LLM 加深 |
| 单 tool 失败 | 记入 notes，尝试其他路径，不整任务崩溃 |
| 日志体积 | 入模前截断；脱敏 base64 / 过长路径（发票 PDF base64 已见） |
| LLM | 可选；`llmTimeoutMs` 默认 600000；失败回落规则 |


### 3.6 与「固定流水线」的关系

早期（**M1-min**）可用**固定/半固定 playbook** 跑通（search_logs → understand → 模型出 JSON），但代码结构必须：

1. 步骤调用的是 **注册表中的 lib tools**，不是写死在入口文件里的内联 HTTP；
2. 经 **`agent-runner`** 执行，并写入 queue/kb；
3. 可升级为 **tool-use 自主 loop**（M1-full），无需推翻目录与入口。

禁止：

- 长期平行维护一个不经 runner 的 `diagnose.js` 业务实现；
- 「只能线性脚本、与 Agent 两套逻辑」。

---

## 四、确定性监听层（Scheduler / poll）

### 4.1 职责

轮询 OpenAPI → 失败检测 → 指纹去重 → 紧急分流 / 入队。  
**不调 AI。不调 rpa-skill。**  
架构定位：**Agent 的感知子系统**，不是并列的「另一个小产品」。

### 4.2 流程

```
1. 计算时间窗：现在 − pollLookbackHours（默认 24h）→ triggerTimeBegin/End（yyyy-MM-dd HH:mm:ss 本地时区）
2. getToken（内存缓存）
3. listJobs(triggerTimeBegin/End, size, robotClientUuid?, 翻页至不足一页；上限 pollMaxPages)
4. 对每条失败记录：
   a. build_fingerprint（优先 remark，不足再 search_logs 补全）
   b. 指纹已见 → occurrenceCount++（queue 内部去重用，日报不展示）
   c. 紧急 → data/alerts/
   d. 写入/更新 data/queue/<fingerprint>.json
   e. 记入本轮 lastPollFindings[{ fingerprint, count, jobUuid, ... }]
5. 更新 cursor.json（时间窗 + lastScanned/lastFailed + lastPollFindings）
```



### 4.3 错误指纹

```
指纹 = robotUuid + flowName + 错误类型 + 元素名/文件名特征
```

| 步骤 | 规则 |
|------|------|
| 输入优先级 | ① `remark` 正则 → ② 日志 `level=错误` 的 flowName/lineNumber/text |
| 归一化 | 去掉 jobUuid、时间戳、绝对路径、长数字串；保留错误类型关键词与元素/文件 basename |
| 输出 | `{ fingerprint, robotUuid, robotName, flowName, lineNumber, errorType, elementName, rawRemark }` |

**作用：** 去重主键、queue 文件名、KB 命中键、跨应用归并的基础特征。  
增强期可增加 `errorSignature`（不含 app）供归并，不破坏现有 fingerprint 文件名语义（见冻结清单 §7）。

### 4.4 紧急告警

| 项 | 规则 |
|----|------|
| 判定 | `status=error` 且 remark 含「断连 / 未连接 / 鉴权 / 登录失败」等（可配词表） |
| 输出 | `data/alerts/YYYY-MM-DD-HHmmss.json` + 控制台红字 |
| 推送 | 配置预留 `alertWebhook`；实现可后置 |
| 与 diagnose | **旁路**，不进入完整诊断 skill（快、稳） |

---

## 五、模块与目录

### 5.1 目标目录

```
RPA-Monitor-Agent/
├── SPEC / TECH-DESIGN / ARCHITECTURE-FREEZE / DEPLOY / README / CLAUDE
├── package.json                 # npm start / once / verify …
├── deploy/                      # Windows / Linux systemd / PM2
├── monitor/
│   ├── config.example.js
│   ├── config.local.js          # gitignore
│   ├── verify_openapi.js
│   ├── poll.js / agent.js / service.js / report.js
│   ├── scan_shadowbot.js        # 本机 apps 扫描自检
│   ├── test_fingerprint.js
│   └── lib/
│       ├── config.js · yingdao.js · fingerprint.js · memory.js
│       ├── poll.js · rpa.js · kb.js · llm.js · report.js
│       ├── tools.js · agent-runner.js · lock.js · cron.js
│       └── skills/diagnose.js   # M1-min playbook
└── data/                        # gitignore · Memory
    ├── cursor.json              # 含 lastPollFindings
    ├── queue/ · kb/ · alerts/ · reports/
    └── app-map.json             # 可选手工覆盖（非必须）
```


入口脚本保持**薄**：解析参数 → 调 lib / agent-runner。业务与 tool 实现不进入口文件。  
命名与红线见 [ARCHITECTURE-FREEZE.md §4](ARCHITECTURE-FREEZE.md)。

### 5.2 `lib/yingdao.js`

```js
async function getToken({ accessKeyId, accessKeySecret }) -> string
async function listJobs(token, { robotClientUuid?, statusList?, cursorId?, size, cursorDirection }) -> { dataList, nextId, hasData }
async function searchLogs(token, jobUuid, { page, size }) -> { logs, page }
```

- accessToken 进程内缓存
- 错误码透传，调用方决定重试
- 从 `verify_openapi.js` 抽出公共逻辑；verify 改依赖 lib 后仍须通过

### 5.3 `lib/fingerprint.js`

见 §4.3。用已有真实 remark 做单测/夹具验证稳定性。

### 5.4 `lib/rpa.js`

```js
resolveXbotDir(robotUuid) → { mapped, xbotDir, source, ... }
// 优先级：data/app-map.json 手工覆盖
//       → %LOCALAPPDATA%/ShadowBot/users/<userId>/apps/<robotUuid>/xbot_robot 自动发现
// 可选配置：shadowbotUsersRoot / shadowbotUserId
understandFlow(xbotDir, flowName?)  // require rpa-skill understand
loadFlowBlocks(xbotDir, flowName, lineNumber?)  // project_reader 邻近指令块
scanLocalApps()  // 扫描本机 apps（scan_shadowbot.js）
```

**本机路径约定（Windows 影刀客户端）：**

```text
%LOCALAPPDATA%\ShadowBot\users\<userId>\apps\<robotUuid>\xbot_robot
```

- **默认自动发现**，无需为每个应用手写 app-map  
- `data/app-map.json` 仅作特殊路径覆盖  
- 找不到目录 → 诊断降级为日志/remark，notes 说明  

自检：`node monitor/scan_shadowbot.js [--robot <uuid>]`


### 5.5 `lib/kb.js`

- 路径：`data/kb/KB-XXXX.json`
- 查询：fingerprint 精确 + errorType/elementName 模糊
- 写入：create / update；记录 occurrence、firstSeen/lastSeen
- 默认 `status: pending_review`；确认流后置
- CF 同步：接口预留，M 前段只本地

### 5.6 `lib/tools.js` + `lib/agent-runner.js` + `skills/diagnose.js`

**tools.js：** name / schema / handler / 可见 skill；`list_jobs` 仅 perception。

**agent-runner.js：** skill 路由；`diagnose` → playbook 或 `--queue` drain。

**M1-min diagnose playbook（真实实现顺序）：**

```text
queue_get / 构建 working
  →（可选）search_logs + build_fingerprint
  → kb_search（附带历史，不自动当结论）
  → resolve_app（自动 xbot_robot）
  → understand_flow / load_blocks（有 xbotDir 时，rpa-skill）
  → buildRuleDiagnosis（规则；有焦点指令则写入 location/suggestion）
  →（可选）LLM 增强（llm+rules；失败回落 rules）
  → kb_write + queue diagnosed
```

rpa-skill **读流程上下文**，不单独生成修复文案；修复建议 = 规则 ± LLM，并引用真实指令名。

### 5.7 `agent.js`（CLI）

```bash
node monitor/agent.js diagnose --job <jobUuid>
node monitor/agent.js diagnose --fingerprint <fp>
node monitor/agent.js diagnose --queue --limit 5
node monitor/agent.js diagnose --queue --limit 5 --no-llm   # 纯规则
# develop / maintain → skill_not_implemented
```

### 5.8 `service.js`（M2）

- `node monitor/service.js` 常驻；`--once` 单轮 poll→diagnose→report  
- `--llm` 诊断启用 LLM（默认偏规则）  
- `pollIntervalMinutes` 周期 poll + drain  
- `diagnoseCron` / `reportCron` 简易分时触发  
- `healthPort` 默认 8787，仅 `127.0.0.1`  
- `data/service.pid` 单实例锁  

### 5.9 `report.js`

- **默认 scope=`poll_window`**：只展示 `cursor.lastPollFindings` 命中的指纹  
- 失败条数 = 本轮 findings.count 之和 / lastFailed，**不展示** queue 历史 `occurrenceCount`  
- `--scope calendar_day|all` 可选  
- 输出 `data/reports/YYYY-MM-DD.md`  
- diagnose **不会**自动写日报；需 `report.js` 或 service 流程  


---

## 六、数据架构

### 6.1 状态文件

**cursor.json（实现字段）**
```json
{
  "lastNextId": "...",
  "lastPollAt": "2026-07-11T13:42:01.517Z",
  "lastLookbackHours": 24,
  "lastTriggerTimeBegin": "2026-07-10 21:42:01",
  "lastTriggerTimeEnd": "2026-07-11 21:42:01",
  "lastScanned": 13,
  "lastFailed": 2,
  "lastPollFindings": [
    { "fingerprint": "...", "jobUuid": "...", "count": 1, "robotName": "..." }
  ]
}
```


**queue/\<fingerprint\>.json**
```json
{
  "fingerprint": "...",
  "robotUuid": "...",
  "robotName": "API-发票附件下载回传",
  "flowName": "获取发票税金号",
  "lineNumber": "35",
  "errorType": "匹配到多个元素",
  "elementName": "发票方案号",
  "occurrenceCount": 3,
  "firstSeen": "...",
  "lastSeen": "...",
  "sampleJobUuids": ["416ddc07-..."],
  "rawRemark": "...",
  "diagnosed": false,
  "kbId": null
}
```

**kb/KB-XXXX.json**（对齐 SPEC 5.5，并扩展 Agent 字段）
```json
{
  "id": "KB-0032",
  "fingerprint": "...",
  "errorSignature": "归一化错误特征",
  "rootCause": "...",
  "solution": "...",
  "location": "子流程/行号/指令类型",
  "errorCategory": "element|file|login|network|data|other",
  "affectedBlocks": ["click_element"],
  "affectedApps": [],
  "confidence": 0.85,
  "occurrenceCount": 12,
  "firstSeen": "2026-07-11",
  "lastSeen": "2026-07-11",
  "status": "confirmed|pending_review",
  "sourceJobUuids": []
}
```

### 6.2 生命周期

```
OpenAPI 失败 → queue（指纹聚合）→ diagnose skill → kb → reports
                  ↘ alerts（紧急旁路）
```

一致性单位：单文件原子写。无 DB、无分布式事务。  
Memory 语义见 [ARCHITECTURE-FREEZE.md §7](ARCHITECTURE-FREEZE.md)。

---

## 七、外部接口

### 7.1 影刀 OpenAPI（✅ 2026-07-11 已验证）

| 接口 | 端点 | 用途 |
|------|------|------|
| 鉴权 | `token/v2/token/create` | accessToken，最长 2h |
| 运行列表 | `POST dispatch/v2/job/list` | 增量失败；`jobUuid` 直接可用 |
| 步骤日志 | `POST dispatch/v2/job/log/search` | flowName / lineNumber / text |

关键已验证事实：

1. 端点是 `dispatch/v2/*`，**不是**旧的 `app/open/query/use/record/list`
2. `jobUuid` 直接衔接 list → log，无需转换
3. 日志带专用字段 `flowName` + `lineNumber` + `level`，可直接定位
4. `remark` 已浓缩定位信息，多数情况不调日志即可做指纹

验证脚本：`node monitor/verify_openapi.js`。

### 7.2 rpa-skill（只读 require）

| 能力 | 用途 |
|------|------|
| `understand` | 流程结构与步骤语义 |
| 读 flow / project_reader | lineNumber 附近指令块 |
| `block_library` | 错误 ↔ 指令类型 |
| `inspect` | 结构风险（可选 tool；未来 maintain） |
| `generate` 等 | 未来 develop skill，仍只读引用 |

路径：`RPA_SKILL_PATH` > `config.rpaSkillPath` > `D:/RPA-Skill`。

### 7.3 LLM API

- **通用**：`baseUrl` + `apiKey` + `model`（`monitor/lib/llm.js`）
- 默认协议：OpenAI 兼容 `POST {baseUrl}/chat/completions`，`Authorization: Bearer …`
- 可选 `apiStyle: 'anthropic'`：官方 Messages API
- 环境变量：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_API_STYLE`
- 未配置 apiKey → diagnose 仅规则引擎，不阻塞
- 最终诊断强制结构化 JSON（规则 + 可选 LLM 增强）


---

## 八、开放问题落定（SPEC 第八节）

| # | 问题 | 决定 |
|---|------|------|
| 1 | 流程业务语义 | `flowName` + `robotName`/`taskName` + understand 推断，不额外打标签 |
| 2 | flow owner | 当前不做；M3 分诊再引入 |
| 3 | Jira/CF | 先本地文件；CF/Jira 后置 |
| 4 | 部署形态 | **M0–M1：CLI；M2+：常驻 Agent 服务**（非「永远只做 cron 脚本」） |
| 5 | AI 调用 | **API + tools，经 agent-runner**；Code session 仅人工排查 |
| 6 | 产品身份 | **Agent（可推广）**；能力可弱，架构见 ARCHITECTURE-FREEZE |

---

## 九、配置

`monitor/config.local.js`（gitignore）：

```js
module.exports = {
  accessKeyId: '...',
  accessKeySecret: '...',
  robotClientUuid: '',        // 可选，限定机器人
  size: 50,                   // 每页条数
  pollLookbackHours: 24,      // 感知时间窗（小时）；0=不按时间
  pollMaxPages: 50,

  rpaSkillPath: 'D:/RPA-Skill',
  // shadowbotUsersRoot / shadowbotUserId 可选

  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  llmApiStyle: 'openai',      // openai | anthropic
  llmTimeoutMs: 600000,

  maxToolRounds: 8,
  pollIntervalMinutes: 15,
  diagnoseCron: '0 9 * * *',
  reportCron: '5 9 * * *',
  healthPort: 8787,           // 0=关闭；仅绑定 127.0.0.1
  alertWebhook: '',
};
```

优先级：**环境变量 > config.local.js > 默认值**。  
LLM 环境变量：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_API_STYLE` / `LLM_TIMEOUT_MS`。  
Poll：`POLL_LOOKBACK_HOURS` / `POLL_MAX_PAGES`。


---

## 十、实现路线（按 Agent 交付）

> 判断有没有走偏的四条标准：  
> ① 新能力是否以 **tool** 形式出现；  
> ② 诊断是否经 **runner + skill**（而非入口内联平行栈）；  
> ③ 是否有 **KB / queue 记忆闭环**；  
> ④ 是否仍符合 [ARCHITECTURE-FREEZE](ARCHITECTURE-FREEZE.md) H1–H10。

| 步 | 里程碑 | 交付 | 验收 |
|----|--------|------|------|
| **S0** ✅ | 拆仓 + 方案 + OpenAPI 验证 | 本仓库 + verify | 已完成 |
| **S1** ✅ | yingdao | `lib/yingdao.js` | verify 用 lib |
| **S2** ✅ | fingerprint | `lib/fingerprint.js` | 夹具 + 真实 remark |
| **S3** ✅ | poll + queue | 24h 时间窗 + findings | queue 有指纹 |
| **S3.5** ✅ | Agent 落桩 | tools + runner + agent.js | skill 路由 |
| **S4** ✅ | rpa | 自动 ShadowBot 路径 + understand/blocks | scan_shadowbot / diagnose 有 blocks |
| **S5** ✅ | kb | `lib/kb.js` | 可写可读 |
| **S6** ✅ | M1-min diagnose | playbook：规则 ± LLM ± rpa-skill | 结构化诊断写 KB |
| **S7** ✅ | 队列消费 | `--queue --limit` | drain |
| **S8** ✅ | report | 本轮 findings，无历史 occurrence 展示 | reports/*.md |
| **S9** ✅ | service | 常驻 / --once / 锁 / health | 部署包装 |
| **S10** | M3 增强 | KB-first、跨应用、分诊、M1-full | 待做 |

### 当前进度

- **已交付：** S0–S9 最小闭环 + 部署（`main` 已推远程时可同步）  
- **生产主路径：** `npm start` / `node monitor/service.js [--once] [--llm]`  
- **诊断形态：** 规则为主 + 可选 LLM + 有本机流程时 rpa-skill 读块  
- **下一步（可选）：** [MAINTAIN-DESIGN.md](MAINTAIN-DESIGN.md)（巡检 + py 受控自动修 S11+）；S10 KB-first；服务器流程源码挂载  







---

## 十一、M2 服务化要点

| 能力 | 要求 |
|------|------|
| 生命周期 | 常驻；SIGINT/SIGTERM 优雅停 |
| 调度 | 进程内 interval/cron；配置可改 |
| 单实例 | pid 文件或 lockfile，防止双 poll |
| 日志 | 文件滚动 + 级别；Agent 每轮 tool 可追溯 |
| 健康检查 | 可选 `/health`（uptime、lastPollAt、queue 深度） |
| 守护 | PM2 / nssm / Windows 任务计划拉起 `service.js` |
| 降级 | 服务不可用时 CLI 仍可 `agent.js diagnose` |
| 架构 | **只调度** poll / runner / report，禁止业务分叉（冻结 H9） |

---

## 十二、M3 与更远

| 能力 | 说明 |
|------|------|
| KB-first | 仅 **confirmed** 高置信历史可短路 |
| 跨应用归并 | `errorSignature` 相似 → 一条根因 + affectedApps |
| 分诊 | `fixOwner`: business / developer / known |
| 对话式深挖 | 人对某条失败追问（可选） |
| 修复可执行化 | 建议落到具体 block；自动改流程更后 + 审批闸门 |
| app-map / 本机流程 | **默认 ShadowBot 自动发现**；app-map 仅覆盖；服务器无客户端时需挂载或降级 |
| **develop / maintain skills** | 同一 Agent Runtime 扩展，接 rpa-skill；公司推广主叙事之一 |


---

## 十三、风险与待补

1. **本机流程路径**：Windows 已自动发现；服务器/无 ShadowBot 时需共享盘或 app-map  
2. **flowName ↔ `.flow.json`**：load_blocks 按 name/filename 匹配，异常命名需验证  
3. **日志敏感/过大**：入模前截断脱敏  
4. **Agent 成本**：maxToolRounds、LLM 超时、同指纹可重复 diagnose（当前未强限制 24h 一次）  
5. **LLM / JSON 稳定性**：校验失败或超时 → 规则回落 + notes  
6. **双开 poll**：service.pid 锁  
7. **架构漂移**：ARCHITECTURE-FREEZE §9  


---

## 十四、与旧「纯脚本 Phase 1」方案的关系

| 旧表述 | 现表述 |
|--------|--------|
| 交付三脚本 poll/diagnose/report | 交付 **AI Agent**（CLI → 常驻 Runtime） |
| diagnose 固定流水线 + 单次 prompt | **diagnose skill**（M1-min playbook → M1-full tool-use） |
| 部署=永远 cron 短进程 | M0–M1 可用 CLI；**M2 起独立 Agent 服务** |
| 模块划分 yingdao/fingerprint/rpa/kb | **全部保留，升级为 Agent tools** |
| OpenAPI 验证结论 | **全部保留** |
| （无） | **架构冻结清单**，防实现漂回脚本集 |

旧方案中仍正确且继续沿用的部分：分层原则、指纹设计、queue/kb 文件结构、紧急旁路、rpa-skill 只读、密钥约定、S1 起从 yingdao 抽取的实现顺序。

---

## 十五、下一步

1. 按需 S10（KB-first / 跨应用 / 分诊 / M1-full tool-use）  
2. 服务器部署时明确流程源码来源（本机 ShadowBot / 共享目录 / 降级）  
3. 运维：任务计划或 systemd 托管 `service.js`；关注 `/health`  
4. 推广叙事见 [ARCHITECTURE-FREEZE §10](ARCHITECTURE-FREEZE.md)  

---

*文档状态：与 S0–S9 真实实现对齐（24h poll、ShadowBot 自动 resolve、M1-min 规则±LLM±rpa-skill、本轮日报）。*  
*最后更新：2026-07-11*

