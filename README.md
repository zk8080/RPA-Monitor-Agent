# RPA-Monitor-Agent

基于影刀 OpenAPI + rpa-skill 的线上 RPA **诊断 / 提效 AI Agent**。

**定位：不是错误通知器，是错误理解器；不是脚本集，是可推广的 Agent 产品。**  
给开发人员提供 WHY（根因）+ SO WHAT（怎么修），不重复造影刀 Dashboard。

**最终交付物：** 可独立运行、**可部署到服务器**的 RPA Monitor & Diagnosis Agent  
（确定性监听入队 + Tool-using 诊断 Skill + 本地 KB 记忆 + **常驻 Runtime**）  
演进目标：**RPA Efficiency Agent**（同一架构扩展开发 / 维护等技能）。

> 本仓库与 `rpa-skill` 独立。rpa-skill 负责生成/解析流程；本仓库消费其 `understand / inspect / block_library` 能力做线上诊断。

## 文档

| 文档 | 说明 |
|------|------|
| [SPEC-monitor-agent.md](SPEC-monitor-agent.md) | 产品设计 Spec |
| [TECH-DESIGN.md](TECH-DESIGN.md) | 技术方案（M0→M3，S0→S10） |
| [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) | **架构冻结清单（身份 / 红线 / Skill / 防漂）** |
| [DEPLOY.md](DEPLOY.md) | **服务器部署：常驻 / 任务计划 / systemd / PM2** |
| [CLAUDE.md](CLAUDE.md) | 本仓库开发指引 |

## 架构一览

```
确定性感知（poll）→ queue（Memory）→ diagnose skill（runner + tools）→ KB → 报告
                     ↘ 紧急 alerts（旁路）
                     Runtime（service.js）统一调度 —— 这是生产部署单元
```

- **监听不调 AI**；**诊断走 Agent 面**（能力可弱，须经 runner + 注册表）
- 能力以 **Tool** 注册；CLI 与常驻服务共用 lib
- **不必每次手敲脚本**：生产跑 `service.js`（或 `npm start`）挂机即可
- 预留 skill：`diagnose`（现）/ `develop` · `maintain`（后）

## 快速开始

```bash
# 1. 配置密钥
cp monitor/config.example.js monitor/config.local.js
# 编辑 accessKeyId / accessKeySecret；生产建议 healthPort: 8787

# 2. 验证 OpenAPI
npm run verify

# 3. 单轮：poll → diagnose → report（验收）
npm run once

# 4. 常驻 Runtime（生产主路径）
npm start
# 或 Windows 后台：powershell -File deploy/windows/start-service.ps1
```

健康检查（`healthPort` 默认 8787）：

```bash
curl http://127.0.0.1:8787/health
# 或 npm run health
```

**部署到 Windows / Linux / PM2 见 [DEPLOY.md](DEPLOY.md)。**

## 开发期 CLI（排障，非生产主路径）

```bash
npm run poll
npm run diagnose
npm run report
node monitor/agent.js diagnose --fingerprint <fp> --no-llm
```

当前进度：**S0–S9 + 部署包装**。可选：app-map、LLM、S10 增强。

## 依赖

- Node.js ≥ 18
- 影刀企业版 OpenAPI 密钥
- 本地 rpa-skill 路径（流程结构诊断用，可选）
- 可选 LLM：任意 **baseUrl + apiKey + model**（OpenAI 兼容三方 / 官方 Anthropic）


## 目录结构

```
RPA-Monitor-Agent/
├── DEPLOY.md                 # 部署指南
├── package.json              # npm start / once
├── deploy/
│   ├── ecosystem.config.cjs  # PM2
│   ├── windows/              # 启停 + 任务计划
│   └── linux/                # systemd unit
├── monitor/
│   ├── service.js            # ★ 生产 Runtime
│   ├── agent.js / poll.js / report.js
│   ├── config.example.js
│   └── lib/                  # tools + runner
└── data/                     # Memory（gitignore）
```
