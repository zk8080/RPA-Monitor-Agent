# 本机开发者工作台 Web MVP — 实现计划

> **状态：** ✅ MVP 已实现（2026-07-12）  
> **产品定位：** RPA Monitor & Diagnosis Agent 的本机观察面 / 操作入口（薄 Entrypoint）  
> **不是：** 影刀二级运维 Dashboard / 带登录 SaaS / 独立业务栈  
> **配套：** [TECH-DESIGN.md](TECH-DESIGN.md) §十五 · [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)

---

## 0. 一句话目标

> 本机打开浏览器 → 看见本机应用与问题摘要 → 看懂业务流程（rpa-skill）→ 一键打开 `xbot_robot` 目录，用 Coding Agent 维护。

静默 Runtime（poll / diagnose / report）**继续跑**；Web 叠在同一进程上。

---

## 1. 范围冻结（MVP）

### 1.1 做

| # | 能力 | 说明 |
|---|------|------|
| M1 | **总览 Dashboard** | 本机应用数、queue 深度、未诊断数、最近失败应用、Runtime 状态 |
| M2 | **应用列表** | `scanLocalApps`：名称 / robotUuid / 路径 / 关联失败摘要 |
| M3 | **应用详情 · 流程逻辑** | `understand_flow` 结构化展示（summary / stages / flowRoles / rules） |
| M4 | **打开流程文件夹** | Windows：`explorer` 打开已 resolve 的 `xbotDir`；可复制路径 |
| M5 | **轻量问题挂接** | 应用详情展示该 robot 在 queue 中的失败条目（只读） |

### 1.2 明确不做（本 MVP）

| 不做 | 原因 / 后置 |
|------|-------------|
| 登录 / 角色 / 多用户 | 本机 `127.0.0.1` |
| 逐 job 运维大屏 / 成功率大盘 | 避免漂成影刀副本；需要时另开「运行统计」 |
| diagnose / maintain 写操作按钮 | P1 工作台增强 |
| apply / 自动改 py | 永不默认；与 S17 闸门一致 |
| 对话式入口 | S24 |
| 独立前端工程 / npm 重依赖 | MVP 用零构建静态页 |
| 公网绑定 / CORS 放开 | 只绑 `127.0.0.1` |

### 1.3 用户与场景

- **用户：** 开发人员（本机维护影刀流程）
- **主路径：** 总览 → 应用列表 → 详情（理解流程）→ 打开文件夹 → 外部 Coding Agent
- **次路径：** 从总览「有问题的应用」跳进详情看失败指纹

---

## 2. 架构落点（必须遵守冻结清单）

```
┌─ Entrypoints（薄）─────────────────────────────────────┐
│  service.js     调度 + 挂载 HTTP（扩展现有 health）      │
│  （可选）web 独立启动仅调试：同一 lib/http 路由          │
└───────────────────────────┬─────────────────────────────┘
                            │
┌─ lib/http（薄路由，无业务复制）─────────────────────────┐
│  读 memory / 调 tools 或 rpa / 本机 open_path           │
└───────────────────────────┬─────────────────────────────┘
                            │
┌─ Tools / lib（业务唯一落点）────────────────────────────┐
│  scan_local_apps · resolve_app · understand_flow        │
│  list_app_failures · queue · （新）open_local_path       │
└───────────────────────────┬─────────────────────────────┘
                            │
┌─ Memory / 本机盘 ───────────────────────────────────────┐
│  data/queue · data/kb · ShadowBot users/*/apps          │
│  data/cache/understand/（可选 mtime 缓存）              │
└─────────────────────────────────────────────────────────┘
```

| 规则 | 含义 |
|------|------|
| H6/H7 | 业务在 `lib/*` + tools；HTTP handler 禁止内联 OpenAPI / understand 实现 |
| H9 | 与 CLI 同源：`scanLocalApps` / `understandFlow` 与现有 tools 一致 |
| H1 | Web **不**用 `list_jobs` 做周期巡检；运行摘要来自 queue / service state |
| 安全 | 只绑 `127.0.0.1`；`open_path` 仅允许已 resolve 的 xbotDir |

**Entrypoint 增补（ARCHITECTURE-FREEZE 同步）：**  
`service.js` HTTP 从「仅 /health」扩展为「health + workbench API + 静态资源」；**仍禁止**在 service 内堆诊断/扫描业务逻辑。

---

## 3. 信息架构与页面

### 3.1 路由（前端 hash 或 path，MVP 推荐 hash）

| 页面 | 路径 | 内容 |
|------|------|------|
| 总览 | `#/` | 卡片 + 问题应用 Top N |
| 应用列表 | `#/apps` | 表格/卡片列表，搜索过滤 |
| 应用详情 | `#/apps/:robotUuid` | 概览 + 流程逻辑 + 相关失败 + 打开文件夹 |

侧栏固定：总览 | 应用 | 日报 | **设置（S26 LLM）**。

### 3.2 总览字段

| 卡片 | 数据源 |
|------|--------|
| 本机应用数 | `scanLocalApps().apps.length` |
| Queue 深度 / 未诊断 | `listQueueItems` |
| Runtime | `state`: uptime、lastPollAt、lastDiagnoseAt、pid |
| 近窗有问题的应用 | queue 按 `robotUuid` 聚合，按**真实失败时间**（`lastFailureAt` ‖ `lastSeen`）排序，取 Top 10 |
| 跨应用根因 | S10b：`errorSignature` ≥2 app；**不展示**内部 signature 原文；过弱 `unknown-flow|…` 不入组 |
| 本机 ShadowBot 根 | `getShadowBotUsersRoot`（展示用，确认扫盘位置） |

### 3.3 应用列表行

| 字段 | 来源 |
|------|------|
| name | package.json / app-map |
| robotUuid | 目录名 |
| userId | ShadowBot 账号目录 |
| xbotDir | resolve |
| failureCount / undiagnosedCount | queue 聚合 |
| lastFailureAt | queue **真实失败时间** max（`lastFailureAt` ‖ `lastSeen`；非 poll 墙钟） |

### 3.4 应用详情

**Tab A · 概览**

- 名称、uuid、userId、xbotDir、resolve source
- 按钮：`打开文件夹` · `复制路径`
- 失败摘要：count、undiagnosed、最近 5 条 fingerprint 一行摘要

**Tab B · 业务流程（核心）**

- 调 understand API，展示：
  - `summary`
  - `stages`（阶段列表）
  - `flowRoles`（流程角色/清单）
  - `businessObjects`
  - `rules`（截断展示）
  - `warnings` / `errors`
- 加载中 / 失败态要明确（rpa-skill 缺失、路径无效）
- **缓存：** 见 §5.3，避免每次点开全量分析

**Tab C · 相关问题（只读）**

- `list_app_failures` 等价数据：fingerprint、remark 摘要、diagnosed、**失败绝对时间**（`lastFailureAt` / `lastSeen`，本地 `yyyy-MM-dd HH:mm:ss`，不用「N 小时前」）
- 链到 fingerprint / 问题详情页（S25b）

---

## 4. API 契约（MVP）

> 前缀：`http://127.0.0.1:{healthPort}`  
> 响应：`Content-Type: application/json; charset=utf-8`  
> 错误：`{ ok: false, code, message }` + 合适 HTTP status

### 4.1 已有

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 保留；可与 overview 字段对齐扩展 |

### 4.2 新增

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/overview` | 总览聚合 |
| GET | `/api/apps` | 本机应用列表 + 失败计数 |
| GET | `/api/apps/:robotUuid` | 单应用 meta + resolve + 失败摘要 |
| GET | `/api/apps/:robotUuid/understand` | 流程理解（可 `?flowName=`；走缓存） |
| POST | `/api/apps/:robotUuid/open-folder` | 打开 xbotDir（本机 shell） |
| GET | `/` 或 `/app/*` | 静态工作台页面 |

### 4.3 响应形状（约定）

**GET `/api/overview`**

```json
{
  "ok": true,
  "runtime": {
    "uptimeSec": 120,
    "lastPollAt": "...",
    "lastDiagnoseAt": "...",
    "lastReportAt": "...",
    "pid": 1234,
    "dataDir": "..."
  },
  "localApps": { "count": 42, "usersRoot": "...", "userCount": 1 },
  "queue": { "depth": 28, "undiagnosed": 5 },
  "problemApps": [
    {
      "robotUuid": "...",
      "robotName": "...",
      "failureCount": 3,
      "undiagnosedCount": 1,
      "lastSeen": "..."
    }
  ]
}
```

**GET `/api/apps`**

```json
{
  "ok": true,
  "usersRoot": "...",
  "apps": [
    {
      "robotUuid": "...",
      "name": "...",
      "userId": "...",
      "xbotDir": "...",
      "failureCount": 0,
      "undiagnosedCount": 0,
      "lastFailureAt": null
    }
  ]
}
```

**GET `/api/apps/:robotUuid/understand`**

```json
{
  "ok": true,
  "robotUuid": "...",
  "xbotDir": "...",
  "cached": true,
  "cacheKey": "...",
  "result": {
    "ok": true,
    "projectName": "...",
    "summary": "...",
    "stages": [],
    "flowRoles": [],
    "businessObjects": [],
    "rules": [],
    "warnings": [],
    "errors": []
  }
}
```

**POST `/api/apps/:robotUuid/open-folder`**

```json
{ "ok": true, "opened": "D:\\...\\xbot_robot", "method": "explorer" }
```

失败示例：`{ "ok": false, "code": "path_not_allowed", "message": "..." }`

### 4.4 静态资源

| 路径 | 文件 |
|------|------|
| `/` | `monitor/web/index.html` |
| `/assets/*` | `monitor/web/assets/*`（若有） |

SPA：前端用 hash 路由，避免服务端 history 回退复杂度。

---

## 5. 模块与文件拆分

### 5.1 新增文件

| 路径 | 职责 |
|------|------|
| `monitor/lib/http/server.js` | 创建 HTTP server：路由分发、静态文件、JSON 辅助 |
| `monitor/lib/http/routes.js` | `/api/*` 与 `/health` handlers（薄） |
| `monitor/lib/http/open-path.js` | Windows 打开目录；路径白名单校验 |
| `monitor/lib/workbench.js` | 聚合逻辑：overview、apps+queue merge、understand 缓存键 |
| `monitor/lib/understand-cache.js` | 可选：按 xbotDir mtime 缓存 understand 结果 |
| `monitor/web/index.html` | 单页工作台 UI（可内联 CSS/JS 或拆 assets） |
| `monitor/web/app.js` | 前端逻辑（fetch + 渲染） |
| `monitor/web/styles.css` | 样式 |
| `monitor/test_workbench.js` | 单测：聚合、路径校验、路由（可用临时 dataDir） |

### 5.2 修改文件

| 路径 | 改动 |
|------|------|
| `monitor/service.js` | `startHealthServer` → `startHttpServer`；挂 workbench；日志打印工作台 URL |
| `monitor/lib/tools.js` | 注册 `open_local_path`（skills: `maintain` 或 `workbench`）；`scan_local_apps` 的 skills 可扩到 `workbench` |
| `monitor/config.example.js` | `workbench: { enabled: true, openFolderEnabled: true }`；`healthPort` 注释改为「health + workbench」 |
| `package.json` | `"workbench": "node -e ... open browser"` 可选；文档脚本 |
| `ARCHITECTURE-FREEZE.md` | Entrypoints 注明 HTTP workbench 为薄入口 |
| `TECH-DESIGN.md` §十五 | 增加 **S25** 本机工作台 MVP |
| `README.md` / `CLAUDE.md` | 进度与用法一行 |

### 5.3 understand 缓存策略

```text
cacheKey = hash(xbotDir + flowName + mtimeMs(xbotDir 或 package.json))
path    = data/cache/understand/<cacheKey>.json
TTL     = 可选 24h；或仅 mtime 失效
```

- 首次 miss → 调 `rpa.understandFlow` → 写缓存  
- 大应用避免阻塞：MVP **同步调用可接受**；若 >5s 体验差，P0.1 再加 `?async=1` 任务轮询（非本 MVP 必做）  
- 缓存失败不阻塞：直接返回 live 结果

### 5.4 open-folder 安全

```text
1. resolveXbotDir(robotUuid) → xbotDir
2. 必须 mapped && exists && isValidXbotDir
3. path.resolve 后必须落在该 xbotDir（不允许 .. 逃逸；本接口只开目录根）
4. Windows: spawn explorer.exe with path（或 shell.openPath 等价）
5. 非 Windows：xdg-open / open（可选；文档写明 MVP 主验证 Windows）
6. config.workbench.openFolderEnabled === false → 403
```

**禁止：** 客户端传入任意绝对路径直接打开。

---

## 6. 实现任务拆分（建议工单顺序）

### Slice A — HTTP 骨架（0.5d）

1. 抽出 `lib/http/server.js`：从 `service.js` 迁出 health  
2. 路由表：`/health`、`/api/*`、静态 `/`  
3. service 启动日志：`workbench http://127.0.0.1:8787/`  
4. 验收：`curl /health` 仍可用；`curl /` 返回 HTML

### Slice B — 聚合 API（0.5–1d）

1. `lib/workbench.js`：`buildOverview` / `listAppsWithStats` / `getAppDetail`  
2. 实现 `GET /api/overview`、`/api/apps`、`/api/apps/:id`  
3. queue 聚合纯函数单测  
4. 验收：有真实 data/queue 时 problemApps 非空

### Slice C — understand + 缓存（0.5–1d）

1. `GET .../understand` → resolve → `understandFlow`  
2. mtime 缓存读写  
3. rpa-skill 缺失时友好错误码 `rpa_skill_missing`  
4. 验收：对本机任一 robot 返回 summary/stages

### Slice D — open-folder（0.25d）

1. `open-path.js` + tool 注册  
2. `POST .../open-folder`  
3. 验收：资源管理器打开正确目录；伪造 uuid 失败

### Slice E — 前端页面（1d）

1. `web/index.html` + `app.js` + `styles.css`  
2. 三页：总览 / 列表 / 详情  
3. 详情：understand 渲染 + 打开文件夹 + 复制路径  
4. 基础空态、加载中、错误提示  
5. 验收：仅浏览器走通主路径，无需 CLI

### Slice F — 文档与自检（0.25d）

1. README 用法；TECH-DESIGN S25；FREEZE 入口一行  
2. `node monitor/test_workbench.js`  
3. `npm start` 后浏览器点验清单（§7）

**合计粗估：** 约 **3–4 人日**（单人连续做）。

---

## 7. 验收清单

### 功能

- [ ] `npm start` 后访问 `http://127.0.0.1:8787/` 见到工作台  
- [ ] 总览显示应用数、queue、runtime  
- [ ] 应用列表与 `scan_shadowbot.js` 数量级一致  
- [ ] 点进应用可见 xbotDir；understand 有业务摘要（依赖本机 rpa-skill + 有效工程）  
- [ ] 「打开文件夹」弹出资源管理器到 `xbot_robot`  
- [ ] 「复制路径」可用  
- [ ] 应用相关失败与 queue 中该 robot 条目一致  
- [ ] `healthPort=0` 时 HTTP 全关（与现网一致）  
- [ ] `workbench.enabled=false` 时仅保留 `/health`（或 API 404，行为写进 config 注释）

### 架构

- [ ] 无第二套 understand/scan 实现；均走 `lib/rpa` / tools  
- [ ] service.js 无大块业务  
- [ ] 未引入必须登录  
- [ ] 未绑定 `0.0.0.0`  
- [ ] open-folder 拒绝非 resolve 路径

### 回归

- [ ] `npm run verify`（若需密钥）  
- [ ] `node monitor/test_fingerprint.js`  
- [ ] `node monitor/test_maintain.js`  
- [ ] `node monitor/test_workbench.js`  
- [ ] CLI diagnose / maintain 行为不变  

---

## 8. 配置草案

```js
// config.example.js / config.local.js
healthPort: 8787, // 0=关闭 HTTP（health + workbench）

workbench: {
  enabled: true,           // false：不挂静态页与 /api（可仍保留 /health）
  openFolderEnabled: true, // 本机打开目录
  understandCache: true,   // data/cache/understand
  // openCommand: null,    // 可选覆盖；默认 Windows explorer
},
```

---

## 9. UI 实现约束（MVP）

- **零构建：** 原生 HTML/CSS/JS，无 React/Vue 脚手架  
- **风格：** 深色或简洁浅色单栏+内容；可读优先，不追求设计系统  
- **中文 UI**  
- **长文本：** summary / rules 可折叠  
- **性能：** 列表渲染本机几十～几百应用可接受；不做虚拟滚动除非卡  

线框级结构：

```text
+--------+----------------------------------+
| 总览   |  本机工作台 · RPA Monitor Agent   |
| 应用   |----------------------------------|
|        |  [卡片] [卡片] [卡片]             |
|        |  问题应用 Top                     |
|        |  - appA  3 failures              |
+--------+----------------------------------+

应用详情:
  标题 · uuid
  [打开文件夹] [复制路径]
  [概览] [业务流程] [相关问题]
  ----
  summary...
  stages...
```

---

## 10. 与现有 backlog 的关系

| 编号 | 关系 |
|------|------|
| **S25** | **本计划 = S25 本机开发者工作台 MVP**（优先插入，贴当前产品诉求） |
| S17–S18 | 不阻塞 S25；P1 工作台可展示 patch / 验证状态 |
| S20 | 日报页可后挂同一 HTTP |
| S24 | 对话入口另议；可复用同一 API |
| S21 | 服务器无 ShadowBot 时应用列表降级；MVP 主场景是本机 Windows |

**推荐排期：**

1. **先做 S25（本 MVP）** — 立刻提升可感知性与上手  
2. 再 S17 dry-run 钩子 — 给后续「补丁」页喂数据  
3. 再 S18 / 操作按钮（触发 diagnose / fix dry-run）

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| understand 慢 | mtime 缓存；UI 明确 loading |
| 扫盘慢 | overview/apps 可短时内存缓存 30–60s |
| service 事件循环被重 CPU 占用 | understand 仅按需；后续 worker（非 MVP） |
| 用户以为是运维大盘 | README/页眉写清「本机开发者工作台」 |
| 打开文件夹无反应 | 返回 method + path；失败 message 展示 |

---

## 12. 后续（非 MVP，预留接口心智）

| 阶段 | 能力 |
|------|------|
| P1 | 问题列表页、KB 诊断详情、一键 `runSkill('diagnose')` |
| P1 | maintain inspect 报告展示 |
| P2 | patch diff 预览、S17 联动 |
| P2 | 「用 Cursor 打开」（可配置 `openCommand`） |
| P3 | 对话入口、tool-loop |

---

## 13. 开工命令（实现时自用）

```bash
# 实现完成后
npm start
# 浏览器打开
# http://127.0.0.1:8787/

curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/api/overview
curl -s http://127.0.0.1:8787/api/apps
curl -s http://127.0.0.1:8787/api/apps/<robotUuid>
curl -s http://127.0.0.1:8787/api/apps/<robotUuid>/understand
curl -s -X POST http://127.0.0.1:8787/api/apps/<robotUuid>/open-folder

node monitor/test_workbench.js
```

---

*文档状态：实现计划已定；代码未开工。*  
*最后更新：2026-07-12*
