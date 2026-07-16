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
> 演进名：**RPA Efficiency Agent**（**diagnose + maintain 已实现**；develop 预留）。


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
│  │  diagnose · maintain（已实现）· develop（预留）           │ │

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

`diagnose` 与 **`maintain`** 均为 Runtime 上的 **Skill**（playbook 型弱脑 + tools）。  
diagnose 负责听懂失败并分诊；maintain 负责巡检与受控补丁（默认不写盘）。
  
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
  "notes": "可选：信息不足时的说明",
  "fixClass": "code_boundary|null_guard|element|env|config|unknown",
  "fixability": "auto|assisted|manual",
  "fixTargets": []
}
```

`fixClass` / `fixability` / `fixTargets` 由 `lib/triage.js` 填充，供 **maintain fix** 消费；**diagnose 本身不写业务流程文件**。


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
   - CLI poll.js 与 service 均走配置 pollMaxPages（默认 50）；禁止再写死 3 页
4. 对每条失败记录（status ∈ error/stopped/fail）：
   a. build_fingerprint（优先 remark，不足再 search_logs 补全）
   b. 取 job 真实失败时间 failureAt = endTime → startTime → triggerTime
   c. upsert queue：
      - 仅 **新 jobUuid** 时 occurrenceCount++（同 job 再 poll 不虚增）
      - firstSeen/lastSeen/lastFailureAt = 真实失败时间（非 poll 墙钟）
      - lastPolledAt = 本机 poll 写入时刻
   d. 紧急 remark → data/alerts/
   e. 记入本轮 lastPollFindings[{ fingerprint, count, jobUuid, failureAt, ... }]
5. 更新 cursor.json（时间窗 + lastScanned/lastFailed + lastPollFindings）
6. S18：新 job 同指纹 → regressed；静默期满 → verified
```



### 4.3 错误指纹

```
指纹 = robotUuid + flowName + 错误类型 + 元素名/文件名特征
errorSignature = flowName + 错误类型 + 元素名   （不含 robotUuid，供跨应用归并）
```

| 步骤 | 规则 |
|------|------|
| 输入优先级 | ① `remark` 正则 → ② 日志 `level=错误` 的 flowName/lineNumber/text |
| 归一化 | 去掉 jobUuid、时间戳、绝对路径、长数字串；保留错误类型关键词与元素/文件 basename |
| 调度层 remark | 无「在【流程】中」时（如「任务等待运行超时。原因：机器人未连接」）：解析「原因：…」；指纹前缀用 **调度层**（`unknown-flow` 仅为历史/弱特征占位，不是真实流程名） |
| 输出 | `{ fingerprint, errorSignature, robotUuid, robotName, flowName, lineNumber, errorType, elementName, rawRemark }` |

**作用：** 去重主键、queue 文件名、KB 命中键、跨应用归并的基础特征。  
`errorSignature` 已落地（S10b）；queue 文件名仍按 fingerprint，不改磁盘主键语义。

**跨应用归并（S10b）：** 同 `errorSignature` 且 ≥2 个 `robotUuid` 才成组；过弱特征（如 `unknown-flow|超时|-`、`unknown-flow|unknown-error|-`）**不归并**，避免调度噪声误合成「跨应用根因」。

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
# develop → skill_not_implemented
# maintain：
#   node monitor/agent.js maintain inspect --robot <uuid>
#   node monitor/agent.js maintain fix --fingerprint <fp> [--apply]
#   node monitor/agent.js maintain rollback --patch <id>
```


### 5.8 `service.js`（M2）

- `node monitor/service.js` 常驻；`--once` 单轮 poll→diagnose→report  
- `--llm` 诊断启用 LLM（默认偏规则）  
- `pollIntervalMinutes` 周期 poll + drain（poll 翻页上限 = **config.pollMaxPages**，与 CLI 一致）  
- `diagnoseCron` / `reportCron` 简易分时触发  
- `healthPort` 默认 8787，仅 `127.0.0.1`（工作台 + `/health`）  
- `data/service.pid` 单实例锁  
- 进程日志：`data/logs/service-YYYYMMDD.log`；boot 失败不拖垮 HTTP  
- Windows：`deploy/windows/start-service.ps1` 经**任务计划**拉起，关闭终端不杀进程  

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
    { "fingerprint": "...", "jobUuid": "...", "count": 1, "robotName": "...", "failureAt": "..." }
  ]
}
```


**queue/\<fingerprint\>.json**
```json
{
  "fingerprint": "...",
  "errorSignature": "获取发票税金号|匹配到多个元素|发票方案号",
  "robotUuid": "...",
  "robotName": "API-发票附件下载回传",
  "flowName": "获取发票税金号",
  "lineNumber": "35",
  "errorType": "匹配到多个元素",
  "elementName": "发票方案号",
  "occurrenceCount": 3,
  "firstSeen": "2026-07-11T02:00:00.000Z",
  "lastSeen": "2026-07-11T08:30:00.000Z",
  "firstFailureAt": "2026-07-11T02:00:00.000Z",
  "lastFailureAt": "2026-07-11T08:30:00.000Z",
  "failureAtTrusted": true,
  "lastPolledAt": "2026-07-11T09:00:00.000Z",
  "sampleJobUuids": ["416ddc07-..."],
  "rawRemark": "...",
  "diagnosed": false,
  "kbId": null
}
```

| 字段 | 语义 |
|------|------|
| `firstSeen` / `lastSeen` | **任务真实失败时间**（与 first/lastFailureAt 对齐；Web 展示用） |
| `lastFailureAt` / `firstFailureAt` | 同上，显式字段；`failureAtTrusted=true` 表示来自影刀 job 时间 |
| `lastPolledAt` | 本机 poll 写入/刷新时刻（**不是**失败时间） |
| `occurrenceCount` | 不同 `jobUuid` 次数；同 job 再扫不 +1 |

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
| `inspect` | 结构巡检（maintain inspect 已用；diagnose 可选） |
| `generate` 等 | 未来 develop skill，仍只读引用 |
| `validate` | maintain apply 后可选项目校验 |


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
| **S10** | M3 产品增强 | 见 §十五路线图 | 待做 |
| **S11–S16** ✅ | maintain | 巡检 + py 受控修 | 已交付 |

### 当前进度

- **已交付：** S0–S9 最小闭环 + **S11–S16 maintain**（巡检 + py 受控修复）+ 部署  
- **生产主路径：** `npm start` / `service.js`（监听+诊断+日报；**不**默认改代码）  
- **维护主路径：** `agent.js maintain inspect|fix|rollback`（Agent skill / playbook）  
- **写盘：** `maintain.autoFix.enabled` 默认 false；需 `--apply` 且配置允许  
- **设计详述：** [MAINTAIN-DESIGN.md](MAINTAIN-DESIGN.md)  
- **后续方向：** 见 **§十五 继续实现路线图**  

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
| KB-first | 仅 **confirmed** 高置信历史可短路（路线图 S10a） |
| 跨应用归并 | `errorSignature` 归并 + affectedApps（S10b） |
| 分诊 | `fixOwner`: business / developer / known（S10c） |
| 对话式深挖 | 可选（S24） |
| 修复可执行化 | maintain 白名单 py；元素/flow 块另立项 |
| app-map / 本机流程 | **默认 ShadowBot 自动发现**；服务器策略见 S21 |
| **maintain skill** | ✅ 巡检 + py 白名单补丁（playbook；默认不 apply） |
| **develop skill** | 预留（S22 骨架） |

---

## 十三、风险与待补

1. **本机流程路径**：Windows 已自动发现；服务器/无 ShadowBot 时需共享盘或 app-map（S21）  
2. **flowName ↔ `.flow.json`**：load_blocks 按 name/filename 匹配，异常命名需验证  
3. **日志敏感/过大**：入模前截断脱敏  
4. **Agent 成本**：maxToolRounds、LLM 超时、同指纹可重复 diagnose  
5. **LLM / JSON 稳定性**：校验失败或超时 → 规则回落 + notes  
6. **双开 poll**：service.pid 锁  
7. **架构漂移**：ARCHITECTURE-FREEZE §9  
8. **自动修误用**：禁止 service 默认 apply；仅白名单 + 备份 + 回滚  

---

## 十四、与旧「纯脚本 Phase 1」方案的关系

| 旧表述 | 现表述 |
|--------|--------|
| 交付三脚本 poll/diagnose/report | 交付 **AI Agent**（CLI → 常驻 Runtime） |
| diagnose 固定流水线 + 单次 prompt | **diagnose skill**（M1-min playbook → M1-full tool-use） |
| 部署=永远 cron 短进程 | M0–M1 可用 CLI；**M2 起独立 Agent 服务** |
| 模块划分 yingdao/fingerprint/rpa/kb | **全部保留，升级为 Agent tools** |
| OpenAPI 验证结论 | **全部保留** |
| （无） | **架构冻结清单** + **maintain skill** |

旧方案中仍正确且继续沿用的部分：分层原则、指纹设计、queue/kb 文件结构、紧急旁路、rpa-skill 只读、密钥约定。

---

## 十五、继续实现路线图（待做 backlog）

> 原则：保持 playbook Agent + 写盘闸门；**service 永不默认 auto-apply 生产 py**。  
> 推荐优先级 **P0 → P3**。

### 15.1 优先级总表

| 优先级 | 编号 | 方向 | 交付物 | 验收要点 |
|--------|------|------|--------|----------|
| **P0** | **S25** ✅ | **本机开发者工作台 Web MVP** | 同进程 HTTP：总览 + 应用列表 + understand + 打开文件夹 | 浏览器走通主路径；只绑 127.0.0.1；业务走 lib/tools |
| **P0** | **S17** ✅ | 诊后自动 **dry-run 存 patch** | `maintain.autoPlanOnDiagnose`：fixability=auto 时 maintain fix dry-run | 开启后诊断结果含 autoPlan.patchId；xbot **未改** |
| **P0** | **S18** ✅ | 修复验证闭环 | apply→`fixed_pending_verify`；新 job 同指纹→`regressed`；静默 quietDays→`verified` | poll 日志 / patch meta / KB status |
| **P1** | **S19** ✅ | 更多 py fixer | `python_empty_path` 空路径守卫；autoFix.classes 含 `config` | `test_maintain` 夹具 |
| **P1** | **S20** ✅ | maintain 进入日报 | report 附可预览修候选 / dry-run / 待验证 / 复发 | 日报「维护与补丁」节 |
| **P1** | **S10a** ✅ | KB-first 短路 | `diagnose.kbFirst`；仅 confirmed+同 fp+高置信 | 开关默认关；pending 永不短路 |
| **P1** | **S25b** ✅ | 工作台操作面 | 一键 diagnose / maintain dry-run；`/api/findings`；问题详情页 | 经 `runSkill`；Web **永不 apply** |
| **P2** | **S10b** ✅ | 跨应用归并 | `errorSignature` + `affectedApps`（queue 主键仍 fingerprint） | 日报/总览「跨应用根因」；KB 写入 affectedApps |
| **P1** | **S26** ✅ | 工作台配置 LLM | `data/settings.llm.json` + GET/PUT/test + 设置页；env > file > local.js | 脱敏 GET；热生效；diagnoseUseLlm；见 [PLAN-LLM-WEB-SETTINGS.md](PLAN-LLM-WEB-SETTINGS.md) |
| **P1** | **S27a** ✅ | **Coding Agent 瘦身交接包** | `lib/handoff.js` + `/api/findings/:fp/handoff` + `/api/apps/:uuid/handoff`；详情「复制提示」；诊断 opt-in | 默认短（路径+现象）；不含日志/全量档案；Web 不 apply；`test_handoff.js` |
| **P1** | **S27b** ✅ | **失败噪声分流 bucket** | `lib/bucket.js`：env_robot / schedule / **element** / code / data_config / unknown；UI 三档筛选 | 元素≠代码；code 仅 py/变量类；`test_bucket.js` |
| **P1** | **S27d** ✅ | **queue 处置态 workStatus** | open / snoozed / ignored / resolved；新 job 唤醒规则；优先队列仅 open + 近 24h；处理完成可选填原因/方案 | 不删 queue；regressed 强制 open；`test_work_status.js` |
| **P2** | **S10c** ⏸ | 分诊标签 `fixOwner` | business / developer / known | **暂缓**：业务侧尚无明确归属划分；规则易误导，待组织分工清晰后再做 |
| **P2** | **S21** | 服务器流程源码策略 | 无 ShadowBot：共享盘 / app-map / 降级 | DEPLOY 专节 + 配置（当前无服务器需求可后置） |
| **P2** | **S22** ⏸ | develop skill 骨架 | `agent.js develop` 路由 + playbook 占位 | **暂缓**：当前收益低于「工作台 → 复制路径 → Coding Agent」；真要生成流程再立项 |
| **P3** | **S23** | maintain tool-loop（可选） | 模型多步读 py/日志，写盘仍白名单 | opt-in；默认 playbook |
| **P3** | **S24** | 对话式入口（可选） | 「修这个 fingerprint」→ 同一 runner | 不替代 CLI/service |

### 15.2 P0 说明

**S17 诊后 dry-run（已实现）**

```text
diagnose 完成
  → maintain.autoPlanOnDiagnose=true（或 MAINTAIN_AUTO_PLAN=1）
  → fixability==auto 且 fixTargets 含 python
  → maintain fix（dry-run）→ data/patches/patch-xxx
  → 结果字段 autoPlan.patchId；日志「已生成补丁预览」
  → 绝不自动 apply（autoFix.enabled 仍默认 false）
```

配置：

```js
maintain: {
  autoPlanOnDiagnose: false, // 默认关；打开仅 dry-run
  autoFix: { enabled: false, classes: ['code_boundary', 'null_guard'] }
}
```

**S18 验证闭环（已实现）**

- apply 成功 → `lib/verify.markPatchPendingVerify`：`status=fixed_pending_verify`  
- poll 入队时若 **新 jobUuid** 且同 fingerprint 有 pending/applied patch → `regressed` + 日志建议 rollback  
- 每轮 poll 末 `tickVerification`：静默 `maintain.verify.quietDays`（默认 3）天 → `verified`  
- 配置：`maintain.verify.quietDays` 或 `MAINTAIN_VERIFY_QUIET_DAYS`  

### 15.3 S27a 交接包说明（已实现）

**定位：** 给 **外部 Coding Agent**（Cursor / Claude Code 等）的开工摘要，**不是** Monitor 内 LLM 的 system/user（与业务解读 `settings.business-brief`、diagnose system 分离）。

**默认瘦身（L0）：**

- 路径 / 应用 / 流程位置 / 错误类型 / 备注（截断）/ 分诊  
- **不含** 诊断根因建议、运行日志、多 job 列表、business-brief  
- 工作方式压成短列表，避免挤占上下文  

**可选：**

- 查询参数 / UI「含诊断」→ `includeDiagnose=1` 附带 Monitor 判断（仍截断）  
- `workbench.handoffIncludeDiagnose`（默认 `false`）改服务端默认  

**API：**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/findings/:fp/handoff?includeDiagnose=` | fix 模式 markdown |
| GET | `/api/apps/:uuid/handoff` | develop 模式 markdown |

**实现：** `monitor/lib/handoff.js`（模板）→ `workbench.getFindingHandoff` / `getAppHandoff` → routes 薄转发；前端不再本地拼长 prompt。  
**首期不做：** 设置页可编辑交接全文模板；用 LLM 生成交接包。

### 15.3b S27b 噪声分流（已实现）

**定位：** 技术向 bucket（注意力分流），**不是** 组织归属 `fixOwner`（S10c 仍暂缓）。

| bucket | 标签 | actionable | 典型信号 |
|--------|------|------------|----------|
| `env_robot` | 机器人/环境 | ops | 机器人未连接、断连、离线 |
| `schedule` | 调度 | ops | 任务等待运行超时、未分配空闲机器人、调度层指纹 |
| `element` | 元素 | dev | 未找到/匹配多个元素、选择器；fixClass=element（**不**打代码） |
| `code` | 代码 | dev | 仅 py/变量/边界：IndexError、NoneType、Traceback、fixClass code_boundary·null_guard |
| `data_config` | 数据/配置 | dev | 空路径、文件不存在、fixClass config |
| `unknown` | 未分类 | either | 其余（含泛化超时） |

**UI：** 总览/应用问题筛选只暴露 **全部 / 可开发 / 环境·调度**（可开发 = code+element+data_config）。细 bucket 仍在详情 badge 与统计字段。

**接入：**

- `enrichFailureItem` / 优先队列 / `/api/overview.queue.byBucket`  
- 工作台总览 chip：全部 / 可开发 / 环境调度…  
- 问题详情 badge；应用「相关问题」筛选  
- handoff：ops 类附「勿先改业务代码」警告  

**实现：** `monitor/lib/bucket.js`；运行时计算，**不**改 queue 文件主键。

### 15.3c S27d 处置态 workStatus（已实现）

**状态：** `open`（默认）| `snoozed` | `ignored` | `resolved`（处理完成）  
**影响面：** 仅「优先处理」列表；**不**改全量 depth/bucket 统计；**不** apply py。

**新失败 = 同 fingerprint 新 `jobUuid`：**

| 当前 | 新 job | 行为 |
|------|--------|------|
| open | 是 | 保持 open |
| snoozed | 是 | **回 open**，`reopenedBy=new_job` |
| resolved | 是 | **回 open**，`reopenedBy=new_job`（保留历史处理说明） |
| ignored | 是 | **保持 ignored**，`ignoredStillFailing=true` |
| 任意 | 否（同 job 再 poll） | 不改 workStatus |
| 任意 | regressed | **强制 open** |

**处理完成：** 工作台弹层引导填写「问题原因 / 处理方案」（**选填**）；写入 queue `resolutionRootCause` / `resolutionSolution` / `resolvedAt`。不强制写 KB（后置）。  
**终态：** `resolved` 不可再人工改为 snoozed/ignored；仅可「补充说明」或「恢复待处理」(→ open)。新 job / regressed 仍自动拉回 open。  

**优先队列：** 有效 open（snoozed 过期算 open；resolved/ignored 不进）且 `lastFailureAt` 在 `workbench.priorityRecentDays`（默认 **1=滚动 24h**，0=不限）内。  

**API：** `POST /api/findings/:fp/work-status` body `{ status, snoozeDays?, rootCause?, solution? }`  
**实现：** `lib/work-status.js` + `memory.upsert` 合并 + 详情页按钮 / 弹层。

### 15.4 明确不做（除非单独立项）

| 不做 | 原因 |
|------|------|
| service 默认 apply 改生产 xbot | 安全与合规 |
| 元素选择器 / 任意 flow 块自动改 | 误伤面大 |
| 无备份、无 class 白名单的 LLM 全项目改写 | 不可审计 |

### 15.5 运维

- 生产托管 `service.js`；改代码只经 `maintain fix --apply`  
- 服务器无本机 ShadowBot 时走 **S21**  
- 推广口径见 [ARCHITECTURE-FREEZE §10](ARCHITECTURE-FREEZE.md)  

---

*文档状态：S0–S9 + maintain + 工作台 S25/S25b/S26 + **S27a 交接包** + **S27b bucket 分流** 已交付；§十五为继续实现 backlog。*  
*最后更新：2026-07-14*
