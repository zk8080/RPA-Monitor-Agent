# maintain skill 实现方案

> 基于当前 S0–S9 最小闭环（poll / diagnose / KB / report / service）。  
> 目标：在同一 Agent Runtime 上扩展 **维护巡检** 与 **受控 py 自动修**，不破坏「监听确定性、写盘可审计」原则。  
> 关联：[TECH-DESIGN.md](TECH-DESIGN.md) · [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) · rpa-skill（只读为主）

---

## 一、目标与非目标

### 1.1 目标

| 能力 | 用户价值 |
|------|----------|
| **维护巡检报告** | 对指定应用/本机 apps 做结构+线上热点体检，输出可执行维护清单（默认不改文件） |
| **py 自动修（白名单）** | 对「简单 Python 边界类」线上报错生成补丁；可选备份后写入并校验 |
| **与 diagnose 衔接** | 诊断结果可分诊到 `fixClass` / `fixability`，供 maintain 消费 |

### 1.2 非目标（本方案不做）

- 自动改元素库 / 选择器 / 任意 `.flow.json` 业务块（风险高，另立方案）
- 无审批、无备份的「LLM 自由改全项目」
- 修改 rpa-skill 源码原则（inspect/understand 保持只读；写盘在本仓受控完成）
- 替代影刀 Studio 做完整可视化编辑

### 1.3 成功标准

| 里程碑 | 验收 |
|--------|------|
| M-A 巡检 | `agent.js maintain inspect --robot <uuid>` 产出 md，含 inspect 风险 + 可选关联失败指纹 |
| M-B 补丁预览 | 对真实 `IndexError` 类失败，`maintain fix --dry-run` 给出 unified diff，不写盘 |
| M-C 受控 apply | `--apply` 仅 `fixClass=code_boundary`；有备份、可 rollback；`py_compile` 通过 |
| 架构 | 全部经 tools 注册表 + runner；无平行 `fix.js` 业务栈 |

---

## 二、总体架构

```
┌─ agent.js / service.js ─────────────────────────────────────┐
│  skills: diagnose | maintain | (develop 预留)                 │
├──────────────────────────────────────────────────────────────┤
│  maintain playbook                                            │
│    inspect_project  →  结构风险（rpa-skill inspect）           │
│    list_failures    →  关联 queue/KB 热点                       │
│    plan_fix         →  fixer 匹配 +（可选）LLM 出 diff         │
│    apply_patch      →  备份 + 写盘 + py_compile + validate     │
│    rollback_patch   →  从 data/patches 恢复                    │
│    render_maintain_report → data/reports/maintain-*.md        │
├──────────────────────────────────────────────────────────────┤
│  lib/fixers/*     白名单修复器（match / plan）                 │
│  lib/patch.js       备份、apply、rollback、审计                  │
│  lib/rpa.js         resolve_app / understand / load_blocks     │
│  rpa-skill          inspect / validate（只读或校验）；不自动改盘  │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
  data/patches/<patchId>/  before/  after.diff  meta.json
  data/reports/maintain-YYYY-MM-DD.md
  data/kb/  （修复结论可选回写）
```

**硬原则**

1. 巡检默认 **只读**；自动修默认 **`autoFix.enabled=false`**。  
2. apply 仅白名单 `fixClass`。  
3. 每次写盘必须有 **patchId + 备份 + 审计 JSON**。  
4. diagnose **不写盘修代码**；只产出分诊字段，由 maintain 执行。

---

## 三、与 diagnose 的接口扩展

### 3.1 诊断结果新增字段（向后兼容）

在现有 TECH-DESIGN §3.4 输出上扩展：

```json
{
  "rootCause": "...",
  "location": "...",
  "suggestion": "...",
  "confidence": 0.9,
  "errorCategory": "element|file|login|network|data|other",
  "fixClass": "code_boundary|null_guard|element|env|config|unknown",
  "fixability": "auto|assisted|manual",
  "fixTargets": [
    {
      "type": "python",
      "relativePath": "cs_get_one_month.py",
      "absolutePath": "C:/.../xbot_robot/cs_get_one_month.py",
      "symbol": "main",
      "lineHint": 42,
      "errorSignal": "IndexError: list index out of range"
    }
  ]
}
```

| 字段 | 含义 |
|------|------|
| `fixClass` | 修复分类，供 fixer 匹配 |
| `fixability` | auto=可走白名单自动修；assisted=只出 diff；manual=仅建议 |
| `fixTargets` | 具体文件/符号；解析失败则为 `[]` |

### 3.2 规则侧粗分诊（M1-min 即可）

| 信号（remark/日志/text） | fixClass | fixability |
|--------------------------|----------|------------|
| `IndexError` / list index / 列表越界 | `code_boundary` | auto（若命中 py 文件） |
| `NoneType` / 空引用 | `null_guard` | auto 或 assisted |
| `No such file` 且路径空 | `config` / `env` | manual 或 assisted |
| 匹配到多个元素 / 未找到元素 | `element` | **manual**（本阶段不自动） |
| 超时 / 机器人占用 | `env` | manual |
| 其它 | `unknown` | manual |

**定位 py 文件**

1. `load_blocks` 焦点为 `process.invoke_module` / code 流程 → 取 module 名  
2. 或 traceback 中 `.py` 路径（相对 xbot_robot）  
3. `resolve_app` 已有 xbotDir → `path.join(xbotDir, rel)`  

---

## 四、能力 A：维护巡检报告

### 4.1 CLI

```bash
# 单应用
node monitor/agent.js maintain inspect --robot <robotUuid>
node monitor/agent.js maintain inspect --robot <uuid> --with-failures

# 扫描本机全部（或 shadowbotUserId 下）apps
node monitor/agent.js maintain inspect --all-local

# 只渲染报告
node monitor/agent.js maintain report --date 2026-07-11
```

### 4.2 Playbook

```text
1. resolve_app(robotUuid) → xbotDir
2. invoke inspect_project(xbotDir)   # require rpa-skill/scripts/inspect.js
3. （可选）queue/KB 中该 robotUuid 近期失败 Top N
4. （可选）understand 摘要
5. render → data/reports/maintain-YYYY-MM-DD[-robot].md
6. 不写业务流程文件
```

### 4.3 报告结构（建议）

```markdown
# 维护巡检报告 <应用名> <日期>

## 概要
- 路径 / robotUuid / 巡检时间
- 风险数：高/中/低

## 结构风险（inspect）
- …

## 线上失败热点（近 24h / 近 7 日，可选）
- 指纹 / 根因 / 次数（本轮或时间窗，不用误导性全历史文案）

## 建议优先级
1. …
2. …

## 可自动修复候选
- 仅列出 fixability=auto 的历史诊断（若有）
```

### 4.4 新 tools

| Tool | 说明 | skill |
|------|------|--------|
| `inspect_project` | 封装 rpa-skill inspect，返回 JSON/文本摘要 | maintain |
| `list_app_failures` | 按 robotUuid 滤 queue/KB | maintain, diagnose |
| `render_maintain_report` | 写 maintain 报告 | maintain |

---

## 五、能力 B：py 自动修（白名单）

### 5.1 CLI

```bash
# 仅计划（默认）
node monitor/agent.js maintain fix --fingerprint <fp>
node monitor/agent.js maintain fix --fingerprint <fp> --dry-run

# 写盘（需配置允许）
node monitor/agent.js maintain fix --fingerprint <fp> --apply

# 回滚
node monitor/agent.js maintain rollback --patch <patchId>
```

### 5.2 Playbook

```text
1. 加载 queue 条目 + 最近诊断 / 现场再跑精简 diagnose
2. 若 fixability=manual 且非强制 → 退出，只打印 suggestion
3. resolve_app + 读取 fixTargets 中 py 文件
4. fixers.match → 选最高分 fixer（阈值则 LLM generic_python_patch，仍属 assisted）
5. fixer.plan → files[] + unifiedDiff + risk
6. dry-run：写 data/patches/<id>/ 预览，不改 xbot
7. apply（若允许）：
     a. 备份 before/
     b. 写入 after
     c. python -m py_compile <file>（失败则 rollback 本 patch）
     d. 可选 validate.js xbotDir
     e. meta.status = applied | failed
8. 可选 kb_write 更新 solution / patchId
```

### 5.3 Fixer 注册表

路径：`monitor/lib/fixers/`

```js
// 契约
{
  id: 'python_index_error',
  fixClass: 'code_boundary',
  match(ctx) → number,   // 0~1
  plan(ctx) → {
    title, risk: 'low'|'mid',
    files: [{ relativePath, absolutePath, original, proposed, diff }],
    rationale
  }
}
```

**首批实现（建议）**

| id | 匹配 | 策略 |
|----|------|------|
| `python_index_error` | IndexError / list index | 规则模板优先；不够再 LLM |
| `python_none_guard` | NoneType attribute | 同上 |
| `python_empty_path` | 空路径 No such file | 守卫 + 日志 |

**LLM 用于 plan 时的约束**

- 输入：单文件或单函数 + 报错上下文（截断）  
- 输出：仅该文件的完整新内容或 diff  
- 禁止改：`package.json`、无关 py、`.flow.json`（本阶段）  
- `llmTimeoutMs` 沿用配置（默认 600s）

### 5.4 `lib/patch.js`

```text
data/patches/<patchId>/
  meta.json       # fingerprint, robotUuid, fixerId, status, times
  before/<rel>    # 原文件
  proposed/<rel>  # 拟写入
  patch.diff
```

API：

```js
createPatch(meta, files) → patchId
applyPatch(patchId) → { ok, error? }   // 备份已在 create 时完成
rollbackPatch(patchId) → { ok }
```

### 5.5 配置

```js
// config.local.js / config.example.js
maintain: {
  autoFix: {
    enabled: false,                 // 总开关，默认关
    classes: ['code_boundary', 'null_guard'],
    requirePyCompile: true,
    requireValidate: false,         // 有需要再开 rpa-skill validate
    maxFilesPerPatch: 1,
    maxPatchBytes: 200000
  }
}
```

环境变量可选：`MAINTAIN_AUTO_FIX=1`。

**service 集成（后置）**

- 默认：diagnose 后 **不** auto apply  
- 若 `autoFix.enabled`：仅 `fixability=auto` 且 class 命中 → dry-run 存 patch，或直接 apply（建议先 dry-run + 告警）

---

## 六、实现分期（任务表）

> 编号接 S10 之后，避免与 M3 产品增强混淆。

| 步 | 名称 | 交付 | 验收 |
|----|------|------|------|
| **S11** | diagnose 分诊字段 | `fixClass` / `fixability` / `fixTargets` 规则填充 | 对 py IndexError 样例能指出 py 路径 |
| **S12** | tools：inspect + read_file | `inspect_project`、`read_project_file` | CLI 可打印 inspect 与 py 片段 |
| **S13** | **maintain inspect** | playbook + maintain 报告 md | 对发票应用出巡检报告 |
| **S14** | patch 底座 | `lib/patch.js` + patches 目录约定 | dry-run 落盘 meta/diff/before |
| **S15** | fixer：index_error | 规则或 LLM plan | 真实/夹具 py 出合理 diff |
| **S16** | **maintain fix** | dry-run 默认；`--apply` 受配置约束 | apply 后 py_compile；rollback 成功 |
| **S17** | 衔接与开关 | diagnose→fix 提示；service 可选钩子 | 文档 + config.example |
| **S18** | （可选）验证闭环 | 同指纹是否复发；KB status | 复发标记 regressed |

**推荐实施顺序：S11 → S12 → S13（先巡检可见）→ S14 → S15 → S16（再自动修）。**

---

## 七、目录与模块清单

```
monitor/
  agent.js                         # maintain 子命令路由
  lib/
    skills/
      diagnose.js                  # 扩展分诊字段
      maintain.js                  # 新建：inspect / fix / rollback / report
    fixers/
      index.js                     # match 调度
      python_index_error.js
      python_none_guard.js
    patch.js                       # 新建
    rpa.js                         # 可增 runInspect / 已有 resolve
    tools.js                       # 注册新 tools
  config.example.js                # maintain.autoFix
data/
  patches/                         # gitignore 已覆盖 data/
  reports/maintain-*.md
```

`.gitignore`：`data/` 已忽略，patches 不会入库（正确）。

---

## 八、安全与合规

| 项 | 要求 |
|----|------|
| 默认 | 巡检只读；fix dry-run；`autoFix.enabled=false` |
| 写盘 | 仅白名单 class + maxFiles=1 + 备份 |
| 审计 | 每 patch 可追溯到 fingerprint / jobUuid / fixer / 时间 |
| 密钥 | 不进 patch 内容日志；LLM 入参脱敏路径可保留 |
| 推广话术 | 「受控自动修复 + 可回滚」，非「AI 随意改流程」 |

与 ARCHITECTURE-FREEZE：允许新增 skill 与 tool；禁止无 runner 的平行修复脚本。

---

## 九、测试与夹具

| 类型 | 内容 |
|------|------|
| 单元 | fixer.match 对真实 remark 片段；patch apply/rollback 临时目录 |
| 夹具 | `testdata/python_index_error/app.py` + 伪造 fingerprint 上下文 |
| 集成 | 对本机发票 xbot 只跑 inspect（只读）；fix 用夹具目录勿写生产 apps |
| 回归 | diagnose 旧字段仍存在；无 maintain 配置时行为与现网一致 |

**禁止**在未备份情况下对真实 `AppData\...\xbot_robot` 默认 `--apply` 做 CI。

---

## 十、service / 报告集成（可选）

| 时机 | 行为 |
|------|------|
| 每日 reportCron 后 | 可选生成「失败热点 + 未处理 auto 候选」一页 |
| poll 后 | 不自动 apply |
| 显式 cron | `maintain inspect --all-local` 周级即可 |

---

## 十一、工作量粗估（1 人）

| 阶段 | 内容 | 粗估 |
|------|------|------|
| S11–S12 | 分诊 + 只读 tools | 1–2 天 |
| S13 | 巡检报告闭环 | 1–2 天 |
| S14–S16 | patch + 1～2 个 fixer + apply | 3–5 天 |
| S17 文档与配置 | 0.5–1 天 |
| **合计到可用 demo** | | **约 1.5–2 周** |

---

## 十二、决策记录（方案默认）

| 议题 | 决定 |
|------|------|
| 先做哪条 | **先 S13 巡检，再 S16 py 自动修**（见第六节顺序） |
| 元素错误 | 本阶段 **不** auto |
| LLM | plan 可用；apply 前后必须机器校验 |
| rpa-skill | inspect/validate 复用；写 py 在本仓 patch 层 |
| 与 S10 | S10=产品 M3（KB-first 等）；maintain=S11+ 并行能力线 |

---

## 十三、下一步行动

1. 评审本方案：是否接受「先巡检后 py 自动修」与 autoFix 默认关闭。  
2. 通过后从 **S11（diagnose 分诊字段）** 开工。  
3. 首个对外演示建议：  
   - Demo1：`maintain inspect` 出报告  
   - Demo2：夹具 py IndexError → dry-run diff → 可选 apply+rollback  

---

*文档状态：maintain 实现方案 v1。*  
*创建：2026-07-11*
