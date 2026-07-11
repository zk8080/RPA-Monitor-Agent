# maintain skill 实现方案

> 基于 S0–S9 最小闭环，扩展 **维护巡检** 与 **受控 py 修复**。  
> 关联：[TECH-DESIGN.md](TECH-DESIGN.md) · [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) · rpa-skill  

---

## 〇、实现状态（与代码对齐）

| 项 | 状态 |
|----|------|
| **S11–S16** | ✅ **已实现**（commit `75c34f8` 起） |
| skill | `diagnose` · **`maintain`** · `develop`（仍预留） |
| 形态 | **Agent skill + playbook（弱脑）**，不是旁路运维脚本；也不是多轮自主改代码的强 Agent |
| 写盘默认 | **关闭**：`maintain.autoFix.enabled=false`；需显式 `--apply` 且配置允许（或 `--force-apply`） |
| service | poll/diagnose/report **不会**自动改 py |

### 产品定位（避免误解）

| 说法 | 是否准确 |
|------|----------|
| maintain 是统一 Runtime 下的 **skill**（tools + runner + patches 审计） | ✅ |
| CLI（`agent.js maintain …`）= 调用 skill 的入口，与 diagnose 同级 | ✅ |
| 模型多轮自主决定读改文件并默认写盘 | ❌ 当前为固定 playbook |
| 「只是测试脚本，`--apply` 仅测试用」 | ❌ `--apply` 是正式写盘闸门，默认不用 |

### 已落地命令

```bash
# 巡检（只读 → data/reports/maintain-*.md）
node monitor/agent.js maintain inspect --robot <robotUuid>
node monitor/agent.js maintain inspect --all-local

# py 补丁预览（默认不写 xbot）
node monitor/agent.js maintain fix --fingerprint <fp>

# 写盘（需 autoFix.enabled 或 --force-apply；慎用）
node monitor/agent.js maintain fix --fingerprint <fp> --apply

# 回滚
node monitor/agent.js maintain rollback --patch <patchId>

# 自检（临时目录，不碰生产 AppData）
node monitor/test_maintain.js
```

### 代码落点

```
monitor/lib/triage.js              # fixClass / fixability / fixTargets
monitor/lib/skills/maintain.js     # inspect / fix / rollback playbook
monitor/lib/skills/diagnose.js     # 输出分诊字段
monitor/lib/fixers/               # python_index_error, python_none_guard
monitor/lib/patch.js               # 备份 / apply / rollback
monitor/lib/rpa.js                 # inspectProject, readProjectFile
monitor/lib/tools.js               # 注册 maintain 相关 tools
monitor/test_maintain.js
```

配置：`config.example.js` → `maintain.autoFix`。  
详细设计下文仍有效；**第六节任务表中 S11–S16 视为完成**，后续为增强项。

---

## 一、目标与非目标

### 1.1 目标

| 能力 | 用户价值 | 实现 |
|------|----------|------|
| **维护巡检报告** | 结构+可选失败热点体检 | ✅ `maintain inspect` |
| **py 受控修复** | 白名单边界类补丁；可选 apply | ✅ `maintain fix`（默认 dry-run） |
| **与 diagnose 衔接** | `fixClass` / `fixability` / `fixTargets` | ✅ triage + diagnose 输出 |

### 1.2 非目标（仍不做）

- 自动改元素库 / 选择器 / 任意 `.flow.json`
- 无备份的 LLM 自由改全项目
- service 诊完默认 auto-apply
- 修改 rpa-skill 只读原则

### 1.3 成功标准（已验收要点）

| 里程碑 | 状态 |
|--------|------|
| M-A 巡检 | ✅ 真实 robot 产出 maintain-*.md |
| M-B 补丁预览 | ✅ fixer + patch dry-run / 临时 py |
| M-C 受控 apply | ✅ 单元：apply + py 逻辑 + rollback；生产默认关 |
| 架构 | ✅ tools + runner + skill，无平行 fix 业务栈 |

---

## 二、总体架构

```
┌─ agent.js / service.js ─────────────────────────────────────┐
│  skills: diagnose | maintain | develop（预留）                 │
├──────────────────────────────────────────────────────────────┤
│  maintain playbook（固定编排，非自由 tool-loop）                │
│    inspect → inspect_project + list_app_failures → 报告 md    │
│    fix     → triage/queue → fixer.plan → patch（默认 dry-run） │
│            → --apply 时备份写盘 + py_compile                   │
│    rollback → data/patches 恢复                               │
├──────────────────────────────────────────────────────────────┤
│  lib/fixers · patch · triage · rpa(inspect/read) · tools    │
│  rpa-skill：inspect / understand / validate（读/校验）         │
└──────────────────────────────────────────────────────────────┘
```

**硬原则**

1. 巡检默认只读；**autoFix.enabled 默认 false**。  
2. apply 仅白名单 `fixClass`（code_boundary / null_guard）。  
3. 写盘必有 patchId + before/ + patch.diff。  
4. diagnose **不写代码**；只分诊，maintain 才 fix。

---

## 三、diagnose 分诊字段（已实现）

```json
{
  "fixClass": "code_boundary|null_guard|element|env|config|unknown",
  "fixability": "auto|assisted|manual",
  "fixTargets": [
    { "type": "python|flow_block", "relativePath": "...", "absolutePath": "...", "lineHint": 42 }
  ]
}
```

| 信号 | fixClass | fixability |
|------|----------|------------|
| IndexError / list index | code_boundary | auto（有 py 目标时） |
| NoneType | null_guard | auto / assisted |
| 多元素 / 未找到元素 | element | **manual**（不自动修） |
| 超时 / 断连 | env | manual |

实现：`monitor/lib/triage.js`，由 `buildRuleDiagnosis` 合并进 diagnosis。

---

## 四、维护巡检（已实现）

```bash
node monitor/agent.js maintain inspect --robot <uuid>
node monitor/agent.js maintain inspect --all-local
```

Playbook：`resolve_app` → `inspect_project` → 可选 `list_app_failures` → `data/reports/maintain-YYYY-MM-DD-*.md`。

---

## 五、py 受控修复（已实现）

### 5.1 默认不自动改生产代码

| 操作 | 是否改 xbot 内 py |
|------|-------------------|
| diagnose / poll / service | 否 |
| `maintain fix`（无 --apply） | 否，只生成 `data/patches/<id>/` |
| `maintain fix --apply` 且 `autoFix.enabled=false` | 默认仍不写盘（提示开配置或 `--force-apply`） |
| `enabled=true` + `--apply` + class 命中 | 是（备份 + py_compile） |
| `test_maintain.js` | 仅系统临时目录 |

**`--apply` 是正式写盘闸门，不是「仅测试参数」。** 测试用同一机制，对象换成临时文件。

### 5.2 CLI

```bash
node monitor/agent.js maintain fix --fingerprint <fp>          # 预览
node monitor/agent.js maintain fix --fingerprint <fp> --apply # 写盘（受配置约束）
node monitor/agent.js maintain rollback --patch <patchId>
```

### 5.3 Fixer（首批）

| id | 匹配 |
|----|------|
| `python_index_error` | IndexError / 下标 |
| `python_none_guard` | NoneType 属性访问 |

### 5.4 配置

```js
maintain: {
  autoFix: {
    enabled: false,
    classes: ['code_boundary', 'null_guard'],
    requirePyCompile: true,
    maxFilesPerPatch: 1,
    maxPatchBytes: 200000
  }
}
```

---

## 六、任务表

| 步 | 内容 | 状态 |
|----|------|------|
| S11 分诊字段 | triage + diagnose | ✅ |
| S12 inspect/read tools | tools 注册 | ✅ |
| S13 maintain inspect | 报告 md | ✅ |
| S14 patch 底座 | lib/patch.js | ✅ |
| S15 fixers | index_error / none_guard | ✅ |
| S16 fix/rollback CLI | dry-run 默认 | ✅ |
| S17 service 钩子 | 诊后自动 dry-run 存 patch | 可选未做 |
| S18 验证闭环 | 同指纹是否复发 | 可选未做 |

---

## 七、安全与宣讲

- 默认：巡检只读；fix 预览；**不自动 apply**  
- 企业话术：**「Agent maintain skill：受控补丁 + 可回滚」**，非「AI 脚本乱改流程」  
- 架构话术：与 diagnose 同为 **playbook 型 Agent 能力**；CLI/service 是触发方式  

---

## 八、测试说明

| 层级 | 命令/方式 | 是否改生产 xbot |
|------|-----------|-----------------|
| 单元 | `node monitor/test_maintain.js` | 否（tmpdir） |
| 巡检 | `maintain inspect --robot …` | 否（只写 reports） |
| 分诊 | `diagnose --fingerprint …` | 否 |
| fix 预览 | `maintain fix …` | 否（patches 预览） |
| fix 写盘 | `--apply` + 配置 | **是**（需显式） |

---

## 九、后续增强（非必须）

1. service：diagnose 后自动 **dry-run 存 patch**，仍不 apply  
2. 更多 fixer；LLM 辅助 plan（复杂 py）  
3. 同指纹验证闭环  
4. maintain 内 tool-loop（更强自主，仍保留写盘闸门）  

---

*文档状态：S11–S16 已实现；本文为实现对齐版。*  
*最后更新：2026-07-11*
