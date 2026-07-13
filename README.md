# RPA-Monitor-Agent

基于影刀 OpenAPI + rpa-skill 的线上 RPA **诊断 / 提效 AI Agent**。

**定位：不是错误通知器，是错误理解器；不是散装脚本，是可推广的 Agent 产品。**  
能力以 **skill + tools + Memory** 组织；推理可为 playbook（弱脑），写盘带闸门。

**交付：** 确定性监听 + **diagnose** + **maintain** + KB + 常驻 Runtime  
演进：**develop** skill、KB-first 等（S10+）。

## 文档

| 文档 | 说明 |
|------|------|
| [SPEC-monitor-agent.md](SPEC-monitor-agent.md) | 产品设计 |
| [TECH-DESIGN.md](TECH-DESIGN.md) | 技术方案（S0–S9 + maintain 实现对齐） |
| [MAINTAIN-DESIGN.md](MAINTAIN-DESIGN.md) | **maintain skill（巡检 + py 受控修复，已实现）** |
| [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) | 架构冻结 |
| [DEPLOY.md](DEPLOY.md) | 部署 |
| [CLAUDE.md](CLAUDE.md) | 开发指引 |

## 实际运行链路

```
poll（最近 24h）→ queue + lastPollFindings
  → diagnose skill（playbook）
       resolve_app（ShadowBot 自动 xbot_robot）
       → rpa-skill understand / load_blocks
       → 规则 ± LLM → fixClass 分诊 → KB
  → report（本轮失败条数，无历史 occurrence 展示）

maintain skill（同一 agent.js / runner，按需触发）
  → inspect：结构巡检报告（只读）
  → fix：白名单 py 补丁（默认 dry-run；--apply 才写盘）
  → rollback：data/patches 恢复
```

- **形态：** Agent skills（playbook），CLI/service 只是触发方式  
- **py 报错不会默认自动改代码**；需 `maintain fix` 预览，确认后 `--apply` + 配置  
- LLM：`baseUrl + apiKey + model`；超时默认 600s  

## 快速开始

```bash
cp monitor/config.example.js monitor/config.local.js
# 填影刀密钥；可选 llm*、maintain.autoFix
# 配置 rpaSkillPath 指向本机 rpa-skill（只读）
```

**Windows · 本机安装 rpa-skill（方案 A）**

```powershell
# 与 Monitor 同级目录安装 skill，并写入 config.local.js
powershell -File scripts\bootstrap-rpa-skill.ps1 -Repo <rpa-skill-git-url> -WriteConfig
```

详见 [DEPLOY.md](DEPLOY.md)「配套依赖：rpa-skill」。

```bash
npm run verify
npm run once
node monitor/service.js --once --llm
npm start
curl http://127.0.0.1:8787/health
```

```bash
# 诊断
node monitor/agent.js diagnose --fingerprint <fp> --no-llm

# 维护巡检（只读）
node monitor/agent.js maintain inspect --robot <robotUuid>

# py 补丁预览（不写生产流程）
node monitor/agent.js maintain fix --fingerprint <fp>

# 写盘（默认关；需 autoFix.enabled 或 --force-apply）
node monitor/agent.js maintain fix --fingerprint <fp> --apply

node monitor/test_maintain.js   # 单元自检（临时目录）
```

## 本机工作台（S25）

常驻 Runtime 时自动挂载（`healthPort` 默认 8787，仅 `127.0.0.1`）：

```bash
npm start
# 浏览器打开 http://127.0.0.1:8787/
```

| 页面 | 能力 |
|------|------|
| 总览 | 本机应用数、queue、runtime、问题应用 |
| 应用列表 | ShadowBot 本机扫描 + 失败计数 |
| 应用详情 | 流程 understand（rpa-skill）、打开文件夹、相关失败 |

自检：`npm run test:workbench`  
设计：[WEB-WORKBENCH-MVP.md](WEB-WORKBENCH-MVP.md)

## 当前进度

| 范围 | 状态 |
|------|------|
| S0–S9 监听诊断 Runtime | ✅ |
| S11–S16 maintain 巡检 + py 受控修 | ✅ |
| **S25** 本机开发者工作台 Web MVP | ✅ |
| **S25b** 工作台操作面 | ✅（诊断 / 预览修复 / 问题详情） |
| **S17** 诊后 dry-run 存 patch | ✅（`maintain.autoPlanOnDiagnose`，默认关） |
| **S18** 修复验证闭环 | ✅（pending_verify / regressed / verified） |
| **S20 / S10a / S19** P1 | ✅ 日报挂钩 · KB-first · 空路径 fixer |
| **S10b** 跨应用归并 | ✅ errorSignature ≥2 app；弱 unknown-flow 不归并；卡片不展示内部 signature |
| queue 失败时间 | ✅ 影刀 job 时间（非 poll 墙钟）；工作台绝对本地时间 |
| S10c+ 后续 | 见下表 |
| service 自动 apply | **永不默认** |

## 继续实现方向（backlog）

完整说明见 [TECH-DESIGN.md §十五](TECH-DESIGN.md)。摘要：

| 优先级 | 编号 | 方向 |
|--------|------|------|
| **P0** | **S25** ✅ | 本机工作台 Web MVP |
| **P0** | **S17** ✅ | 诊后自动 **dry-run 存 patch**（`autoPlanOnDiagnose`） |
| **P0** | **S18** ✅ | 修复验证闭环（复发 / verified） |
| **P1** | **S19** ✅ | 空路径 py fixer |
| **P1** | **S20** ✅ | maintain 候选进日报 |
| **P1** | **S10a** ✅ | KB-first（仅 confirmed） |
| **P1** | **S25b** ✅ | 工作台操作面 |
| **P2** | **S10b** ✅ | 跨应用归并（errorSignature） |
| **P2** | **S10c** ⏸ | fixOwner 分诊（归属未明确，暂缓） |
| **P2** | **S21** | 服务器无 ShadowBot 时的源码策略（暂无需求） |
| **P2** | **S22** ⏸ | develop skill 骨架（不如工作台 → Coding Agent，暂缓） |
| **P3** | **S23/S24** | maintain tool-loop / 对话入口（可选） |

**明确不做：** service 默认改生产 py；无闸门的 LLM 全量改流程。


## 依赖

- Node.js ≥ 18、影刀 OpenAPI  
- 本机 ShadowBot（流程结构/维护；可降级）  
- rpa-skill、可选 LLM  

密钥仅 `monitor/config.local.js`（gitignore）。
