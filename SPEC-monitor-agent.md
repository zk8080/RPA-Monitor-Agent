# RPA 监听诊断 Agent 产品设计 Spec

> 本文档记录「基于影刀 OpenAPI + rpa-skill 构建线上运行监听与诊断 Agent」的产品设计讨论成果。  
> **技术方案**见 [TECH-DESIGN.md](TECH-DESIGN.md)。  
> **架构冻结 / 防漂（实现身份必须是 Agent）**见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)。  
> 本项目已从 rpa-skill 独立为 `D:\RPA-Monitor-Agent`。  
> 最终交付物定义为可独立运行、可推广的 **RPA 诊断 AI Agent**（演进为 RPA 提效 Agent），而非散装脚本集合。

---

## 一、产品定位

**不是错误通知器，是错误理解器。**  
**不是脚本工具箱，是可常驻、可扩展 skill 的 Agent 产品。**

影刀后台已有任务监控和数据统计 dashboard（给运维/IT 看 WHAT），本产品不重复造 dashboard。核心差异是给开发人员提供 **WHY（根因）+ SO WHAT（怎么修）**，靠 rpa-skill 解析应用流程的能力实现 dashboard 做不到的事。

能力深度可以分期（诊断可先弱），**产品骨架必须是 Agent**（统一入口、Tool、Memory、Runtime、可扩展 Skills）——见架构冻结清单。

### 最终交付形态（产品侧）

| 组成 | 说明 |
|------|------|
| 确定性监听 | 轮询失败、指纹去重、紧急告警、入队（不调 AI；Agent 的感知层） |
| 诊断 AI Skill | Tool-using 排查：日志 / 流程结构 / KB → 根因 + 修复方向 |
| 记忆 | 本地知识库，可复用历史方案 |
| 运行时 | CLI 可单次诊断；演进为可常驻的独立 Agent 服务 |
| 扩展面 | **diagnose + maintain 已实现**；develop 预留，形成 RPA 提效 Agent |


### 与现有 dashboard 的本质区别

| 维度 | 影刀 Dashboard | 本 Agent |
|------|----------------|----------|
| 回答的问题 | WHAT（哪个应用挂了、什么时候、报错原文） | WHY（为什么挂）+ SO WHAT（怎么修） |
| 展示粒度 | 按运行记录逐条 | 按根因归并去重 |
| 跨应用视角 | 按应用隔离 | 跨应用关联同一根因 |
| 流程定位 | 只给报错原文 | 定位到具体步骤 + 指令块 |
| 修复建议 | 无 | 每条带修复方向 |
| 历史记忆 | 无 | KB 命中时附带历史解决方案 |

---

## 二、目标用户

- **开发人员**（含「以开发者角色维护流程的业务人员」）
- 不面向运维/IT（他们有 dashboard）
- Phase 1 / M1–M2 不区分受众，统一按开发人员视角输出诊断
- **对内推广 / 绩效场景**：须能讲清 Agent 架构与扩展路径，而非「几个脚本」

---

## 三、核心价值（分阶段）

| 阶段 | 目标 | 对应 TECH-DESIGN |
|------|------|------------------|
| 近期 | 减少人工查日志时间 + 缩短故障发现到修复时间；**交付会诊断的 AI Agent** | M0 工具层 + M1 诊断 Skill + M2 运行时 |
| 中期 | KB 成熟后开启实时/短路诊断，命中走自动答复 | M3 KB-first |
| 远期 | 诊断经验沉淀为可复用知识库；扩展开发/维护 skill；修复验证闭环 | M3+ / Efficiency Agent / SPEC Phase 3–4 |

---

## 四、整体架构（分层）

```
┌─ 感知层（确定性，不依赖 AI）─────────────────────────────────┐
│  定时轮询影刀 OpenAPI · 指纹去重 · 紧急告警 · 入队 queue      │
│  （Agent Runtime 的感知子系统，不是并列脚本产品）              │
└───────────────────────────────────────────────────────────────┘
                        ↓
┌─ 诊断层（diagnose skill + tools，复用 rpa-skill）─────────────┐
│  Agent Runner（playbook 或 tool-loop）                         │
│  -> 按需 search_logs / understand_flow / load_blocks           │
│  -> kb_search / kb_write · 结构化根因 + 修复方向               │
└───────────────────────────────────────────────────────────────┘
                        ↓
┌─ 输出与记忆 ──────────────────────────────────────────────────┐
│  日报 · KB · 紧急告警 ·（后置 CF/Jira）                        │
└───────────────────────────────────────────────────────────────┘
```

**设计原则：监听和诊断必须分离。** 监听是确定性的，不需要 AI；诊断才是 Agent + rpa-skill 发挥价值的地方。混在一起会让 AI 做大量无意义的轮询，浪费且不可靠。

运行时演进：先 CLI（`agent.js diagnose`）验证 Skill，再收进常驻 `service.js`（见 TECH-DESIGN M2）。  
模块边界与红线见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)。

---

## 五、Phase 1 详细设计

> 实现拆步、目录、tool 清单、Agent I/O 契约以 [TECH-DESIGN.md](TECH-DESIGN.md) 为准。  
> 架构身份与防漂以 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) 为准。  
> 本节保留产品行为说明。

### 5.1 监听层

**职责：** 轮询 OpenAPI，检测失败，去重，入队。

**输入：** 影刀 OpenAPI（见第七节）

**核心逻辑：**
1. 定时（每 N 分钟）轮询「查询应用运行记录」接口，按时间范围/游标拉取最新记录
2. 筛选失败状态的记录
3. 对需要补全的失败记录，调「查询应用运行日志」接口拉步骤级日志
4. 按错误指纹去重（见 5.3）
5. 紧急错误（机器人断连、鉴权失败、核心应用连续失败）-> 即时推送原始告警，不等诊断 Agent
6. 其余错误入队，由诊断 skill 批量或按调度消费

**状态管理：** 需要持久化以下状态（防止重启丢数据/重复告警）
- 已处理的最大记录 id / 时间戳（游标分页）
- 已入队错误列表（去重）
- 知识库条目

### 5.2 诊断层（AI Agent Skill）

**职责：** 对队列中的失败做结构化诊断（根因 + 定位 + 修复方向）。

**诊断链路（runner + tools，与实现对齐）：**
```
错误指纹 + sampleJobUuid + robotUuid
  ->（按需）search_logs 补全 flowName / lineNumber / text
  -> resolve_app：ShadowBot 本机自动 xbot_robot（app-map 可选覆盖）
  ->（有目录时）understand / load_blocks（rpa-skill 只读）
  -> kb_search：命中则附带历史方案（不自动当最终结论）
  -> 规则诊断 ± 可选 LLM → 根因 + 修复方向（可含真实指令名）
  -> kb_write：新建或更新条目
```


日志已带 `flowName` + `lineNumber`（见 7.3），**无需 text 语义匹配才能定位子流程行号**。

**跨应用根因归并：** 多应用/多次失败若根因相同，归并为一条诊断（dashboard 做不到；实现上在增强阶段落地）。

### 5.3 错误指纹（去重与归并的基础）

```
指纹 = robotUuid(appId) + flowName + 错误类型 + 元素名/文件名等特征
```

来源：`job/list` 的 `remark` 已含「子流程名 + 行号 + 错误类型 + 元素名」（如「在【获取发票税金号】中第35行：匹配到多个元素...发票方案号」），不调日志接口即可初步生成指纹；日志接口的 `flowName + lineNumber + text` 用于补全和精确化。

归一化：去掉时间戳、变量值、路径、jobUuid 等动态部分，保留 `robotUuid + flowName + 错误类型 + 元素名`。

**作用：**
- 24h 内同一应用挂 50 次同一错误 -> 只完整诊断 1 次，记录出现次数 50
- 跨应用如果指纹相似 -> 诊断时尝试归并为同一根因

### 5.4 Phase 1 日报格式（示例）

```
【影刀每日诊断报告 2026-07-11】

今日失败运行 47 次，归并为 3 个根因：

■ 1. 销售数据导出流程 - Excel 文件被占用（28 次）
  应用：销售日报导出 (appId: xxx)
  定位：第 7 步「读取销售Excel」/ 指令：excel_read
  根因：目标文件被其他程序占用，文件锁冲突
  建议：运行前加文件占用检测步骤，或提醒使用者在流程执行前关闭 Excel
  历史：首次出现，已入库

■ 2. 多个流程登录失败（15 次，跨 3 个应用）
  涉及：采购订单同步、库存盘点、供应商对账
  定位：均为登录步骤 / 指令：web_click + web_input
  根因：登录页按钮元素定位失效，疑似页面改版
  建议：重新抓取登录页元素，更新元素库
  历史：KB-0032 类似，上次因素库过期导致（附链接）

■ 3. 机器人断连（4 次）⚠️ 即时告警已发
  根因：客户端版本更新后未重启
  状态：已即时推送，无需日报跟进

--
本周累计 5 个根因，3 个已入库，2 个待确认。
完整周报已同步至 CF：[链接]
```

### 5.5 知识库结构

```json
{
  "id": "KB-0032",
  "fingerprint": "app_xxx + 元素未找到 + 点击类指令",
  "errorSignature": "归一化后的错误特征",
  "rootCause": "诊断出的根因",
  "solution": "修复建议",
  "affectedBlocks": ["click_element", "wait_element"],
  "confidence": 0.85,
  "occurrenceCount": 12,
  "firstSeen": "2026-07-11",
  "lastSeen": "2026-07-11",
  "status": "confirmed | pending_review"
}
```

**设计要点：** KB 不只是给 AI 复用的机器数据，也是给人查阅的知识文档。本地结构化存储，定期同步到 CF。未确认条目不得在 M3 前自动短路为最终结论。

### 5.6 CF 集成

CF 承担两个角色（同空间不同目录）：
- **周报目录**：一周错误趋势、根因分布、修复进展。时间线视角，给人回顾用。
- **知识库目录**：每个根因一条条目，可检索可复用。问题视角，给 AI 查也给人查。

前期先跑通本地日报 + KB；CF 同步后置。

---

## 六、分阶段演进路径

### Phase 1 / M0–M2：监听 + 诊断 Agent + 可运行时

- 独立监听轮询 OpenAPI（确定性）
- 紧急错误即时告警（原始信息）
- **Diagnosis Skill（tools + runner）** 诊断，输出日报
- 知识库本地沉淀（CF 后置）
- **诊断分诊必须有**（否则和 dashboard 无区别）
- **不做受众路由**（不分业务/开发，不自动建 Jira）
- 形态：先 CLI Agent，再常驻服务（见 TECH-DESIGN）
- 架构：见 ARCHITECTURE-FREEZE（禁止漂成脚本集）

### Phase 2 / M3：KB-first

- 新错误先查 KB，命中且 **confirmed** 高置信 -> 即时自动答复
- 未命中 -> 仍走 diagnose / 日报攒着
- KB 持续增长
- **过渡触发条件：** KB 命中率 > 70% 且连续 N 天无全新错误类型

### Phase 3：分诊与工单闭环

- 诊断结果带 `fixOwner` 标签（business 可自修 / developer 需介入 / known 已知问题）
- 需开发修复的 -> 自动建 Jira，附技术诊断
- 已知问题 -> 直接给 KB 链接
- 分诊准确度验证后再自动化

### Phase 4：自动修复 + 验证 + 提效 skill 扩展

- 对特定修复类型：自动修改流程 -> 重跑 -> 验证
- 人工审批闸门（流程修改不可全自动）
- **develop / maintain skills** 挂入同一 Efficiency Agent Runtime

---

## 七、依赖的影刀 OpenAPI

### 7.1 查询应用运行列表（调度运行记录）✅ 已验证

- **端点：** `POST https://api.yingdao.com/oapi/dispatch/v2/job/list`
- **用途：** 拉取运行记录，筛选失败记录
- **鉴权：** `Authorization: Bearer {accessToken}`
- **关键请求参数：**
  - `robotClientUuid`（可选，机器人 uuid，缩小范围）
  - `statusList`（可选，状态数组，如 `["error"]` 直接筛失败）
  - `triggerTimeBegin` / `triggerTimeEnd`（可选，时间范围，格式 `yyyy-MM-dd HH:mm:ss`）
  - `cursorId`（可选，游标 id，首页留空）
  - `cursorDirection`（必填，`next`/`pre`，默认 next）
  - `size`（必填，1-100，默认 20）
- **关键响应字段：**

| 字段 | 说明 | 用途 |
|------|------|------|
| `id` | 游标 id | 分页游标 |
| `jobUuid` | 应用运行 uuid | ✅ 直接喂给 7.2 日志接口，无需转换 |
| `robotUuid` | 应用 uuid | 关联 rpa-skill 流程（对应 appId） |
| `robotName` | 应用名 | 诊断报告展示 |
| `status` | 运行状态（finish/error/stopped/cancel） | 筛选失败 |
| `remark` | 异常备注（已浓缩「子流程名+行号+错误类型+元素名」） | 摘要级错误 + 指纹去重 |
| `triggerTime/startTime/endTime` | 运行时间 | 时间范围轮询 |

分页：`hasData` 判断是否还有数据，`nextId`/`preId` 作为下一页 `cursorId`。

### 7.2 查询应用运行日志（步骤级）

- **端点：** `POST https://api.yingdao.com/oapi/dispatch/v2/job/log/search`
- **用途：** 拉取单次运行的步骤级日志
- **关键请求参数：**
  - `jobUuid`（必填，运行 UUID）
  - `queryFilter.searchKey`（可选，关键字搜索）
  - `queryFilter.sort`（可选，按时间排序还原执行顺序）
  - `page` / `size`（分页）
- **关键响应字段：**

| 字段 | 说明 | 用途 |
|------|------|------|
| `level` | 日志等级（信息/错误） | 筛选错误级日志 |
| `text` | 日志文本（≤1K，超长截断） | 错误详情 + 变量值 |
| `time` | 时间戳 | 还原执行顺序 |
| `logId` | 日志 ID | 去重/分页 |
| `flowName` | 子流程名 | ✅ 直接定位出错子流程（已验证） |
| `lineNumber` | 行号 | ✅ 直接定位出错行号（已验证） |

- **错误码：**
  - `80204001` 日志查询失败（机器人未连接/已删除）
  - `80204004` 日志查询超时

### 7.3 关键衔接点 ✅ 已验证（2026-07-11，脚本 `monitor/verify_openapi.js`）

> 用真实环境跑通验证脚本，两点均通过，第二点超预期。原「待验证」状态解除，可进入技术方案阶段。

1. **jobUuid 衔接 ✅：** `dispatch/v2/job/list` 每条记录直接返回 `jobUuid`，可直接传给 `dispatch/v2/job/log/search`，**无需 runRecordId 转换**。原 7.1 写的 `app/open/query/use/record/list` 端点已废弃，改用 `dispatch/v2/job/list`。
2. **日志定位能力 ✅（超预期）：** 步骤日志除 `text` 外还有**专用定位字段** `flowName`（子流程名）+ `lineNumber`（行号）+ `level`（信息/错误）。错误日志可直接定位到「哪个子流程第几行出了什么错」，**无需 text 语义匹配**。验证实例：`[错误] flowName=获取发票税金号 line=35 | text=匹配到多个元素, 无法唯一定位 元素名: 发票方案号`。

**额外发现：** `job/list` 的 `remark` 已浓缩定位信息（「在【获取发票税金号】中第35行：...」），不调日志接口即可做初步指纹去重。

---

## 八、待确认的开放问题

> 技术方案阶段已落定项见 [TECH-DESIGN.md §八](TECH-DESIGN.md)。架构身份见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)。下列保留产品语境；实现以 TECH-DESIGN + 冻结清单为准。

1. **流程的业务语义：** 诊断报告里业务含义从流程命名/注释 + understand 推断（不额外打标签）。
2. **流程归属信息：** Phase 1 / M1–M2 不用；分诊阶段再引入 owner。
3. **Jira/CF 边界：** 先本地文件；CF/Jira 后置。
4. **部署形态：** CLI 验证 Agent → 常驻 Agent 服务（TECH-DESIGN M2），不是「永远只有 cron 短脚本」。
5. **诊断层 AI 调用方式：** **API + tools，经 agent-runner**；Claude Code session 仅人工排查。
6. **产品身份：** 最终是可推广 Agent；能力可弱，架构不可脚本化。

---

## 九、与 rpa-skill 的关系

本 Agent 的诊断层**复用 rpa-skill 现有能力**，不重复造轮子：

| rpa-skill 现有能力 | 在本 Agent 中的用途 |
|--------------------|---------------------|
| `understand.js`（业务流程解析） | Agent tool：解析失败应用的流程结构 |
| `block_library`（180 种指令块） | 错误日志 ↔ 指令块语义 |
| `inspect.js`（技术结构巡检） | 可选 tool：结构风险；未来 maintain |
| `generate` 等 | 未来 develop skill |
| `validate.js`（流程校验） | 修复后验证（Phase 4） |

本仓库侧沉淀（不回流 rpa-skill 除非另议）：
- 错误指纹与入队
- Diagnosis skill 的 tool 编排与结构化输出
- KB 的读写与查询
- Agent Runtime 与多 skill 扩展面

---

*文档状态：产品设计稿；交付形态与实现路径以 TECH-DESIGN + ARCHITECTURE-FREEZE 为准。第七节 API 衔接点已用真实环境验证通过（见 7.3）。*  
*最后更新：2026-07-11（对齐 Agent 身份冻结；OpenAPI 验证结论保留）*
