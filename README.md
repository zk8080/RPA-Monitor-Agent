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

## 当前进度

| 范围 | 状态 |
|------|------|
| S0–S9 监听诊断 Runtime | ✅ |
| S11–S16 maintain 巡检 + py 受控修 | ✅ |
| S10 M3（KB-first 等） | 未做 |
| service 自动 apply | **不做默认**；可选后续 dry-run 钩子 |

## 依赖

- Node.js ≥ 18、影刀 OpenAPI  
- 本机 ShadowBot（流程结构/维护；可降级）  
- rpa-skill、可选 LLM  

密钥仅 `monitor/config.local.js`（gitignore）。
