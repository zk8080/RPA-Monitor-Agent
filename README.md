# RPA-Monitor-Agent

基于影刀 OpenAPI + rpa-skill 的线上 RPA **诊断 / 提效 AI Agent**。

**定位：不是错误通知器，是错误理解器；不是脚本集，是可推广的 Agent 产品。**  
给开发人员提供 WHY（根因）+ SO WHAT（怎么修），不重复造影刀 Dashboard。

**最终交付物：** 可独立运行、**可部署到服务器**的 RPA Monitor & Diagnosis Agent  
（确定性监听入队 + diagnose skill + 本地 KB + **常驻 Runtime**）  
演进目标：**RPA Efficiency Agent**（同一架构扩展 develop / maintain）。

> 本仓库与 `rpa-skill` 独立。诊断时只读引用其 `understand` / `project_reader` 等能力。

## 文档

| 文档 | 说明 |
|------|------|
| [SPEC-monitor-agent.md](SPEC-monitor-agent.md) | 产品设计 Spec |
| [TECH-DESIGN.md](TECH-DESIGN.md) | **技术方案（与 S0–S9 实现对齐）** |
| [MAINTAIN-DESIGN.md](MAINTAIN-DESIGN.md) | **maintain：巡检报告 + py 受控自动修（规划）** |
| [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) | 架构冻结 / 防漂 |

| [DEPLOY.md](DEPLOY.md) | 服务器部署 |
| [CLAUDE.md](CLAUDE.md) | 开发指引 |

## 实际运行链路

```
poll（最近 24h 时间窗）
  → 失败指纹入队 queue + lastPollFindings
  → diagnose skill（playbook）
       resolve_app（ShadowBot 自动找 xbot_robot，app-map 可选覆盖）
       → rpa-skill understand / load_blocks（有目录时）
       → 规则诊断 ± 可选 LLM
       → 写 KB
  → report（只展示本轮 poll 命中；不展示历史 occurrence 累计）
```

- **监听不调 AI**；诊断走 runner + tools  
- 生产：`service.js` 调度；CLI 用于排障  
- LLM：通用 `baseUrl + apiKey + model`（OpenAI 兼容三方）

## 快速开始

```bash
cp monitor/config.example.js monitor/config.local.js
# 填 accessKeyId / accessKeySecret；可选 llm*、robotClientUuid

npm run verify          # OpenAPI
npm run once            # poll → diagnose → report（规则向；要 LLM 见下）
node monitor/service.js --once --llm   # 单轮且启用 LLM

npm start               # 常驻
# Windows 后台：powershell -File deploy/windows/start-service.ps1
curl http://127.0.0.1:8787/health
```

常用 CLI：

```bash
node monitor/poll.js --once --hours 24
node monitor/agent.js diagnose --fingerprint <fp>
node monitor/agent.js diagnose --queue --limit 5
node monitor/report.js
node monitor/scan_shadowbot.js
```

## 当前进度

**S0–S9 已完成并推送 `main`。** S10（KB-first / 跨应用 / 分诊等）未做。

## 依赖

- Node.js ≥ 18  
- 影刀企业版 OpenAPI 密钥  
- 本机 ShadowBot 应用目录（流程结构诊断；服务器无客户端时可降级或 app-map）  
- rpa-skill 路径（默认 `D:/RPA-Skill`）  
- 可选 LLM 三方 Key  

## 目录（实现）

```
monitor/          # 入口 + lib tools + skills/diagnose
deploy/           # Windows / systemd / PM2
data/             # gitignore：cursor / queue / kb / reports
```

密钥只放 `monitor/config.local.js`（gitignore），勿提交。
