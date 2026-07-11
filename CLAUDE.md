# RPA-Monitor-Agent（开发指引）

本仓库是「影刀 RPA **诊断 / 提效 AI Agent**」的独立项目，**不是** rpa-skill 的一部分。

最终交付物：确定性监听 + diagnose skill + KB + 可常驻 Runtime  
（演进：同一 Runtime 扩展 develop / maintain → **RPA Efficiency Agent**）。

| 文档 | 用途 |
|------|------|
| [SPEC-monitor-agent.md](SPEC-monitor-agent.md) | 产品设计 |
| [TECH-DESIGN.md](TECH-DESIGN.md) | 技术方案（**以实现对齐版为准**） |
| [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) | **架构冻结 / 防漂（实现必遵）** |
| [DEPLOY.md](DEPLOY.md) | **服务器部署** |
| [README.md](README.md) | 仓库说明 |

## 架构红线（摘要）

完整条款见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)。冲突时 **先服从冻结清单**。

1. **产品身份是 Agent**，不是脚本集。能力可弱（M1-min playbook），入口/tools/runner/memory/skill **不可弱**。
2. **监听确定性、诊断走 Agent 面**；禁止 Agent 主 loop 用 `list_jobs` 巡检。
3. **业务只进 `monitor/lib/*` + 注册表**；入口保持薄封装。
4. **CLI 与 Service 共用同一 runner + tools**；禁止平行 `diagnose.js` 业务栈。
5. rpa-skill **只读**；密钥不入库；状态在 `data/*`。

## 真实实现要点（便于改代码）

| 主题 | 实现 |
|------|------|
| poll | 默认 **最近 24h**（`triggerTimeBegin/End`）；`lastPollFindings` 记本轮失败 |
| resolve_app | **ShadowBot 自动路径** `%LOCALAPPDATA%\ShadowBot\users\*\apps\<uuid>\xbot_robot`；app-map 可选覆盖 |
| diagnose | playbook：kb → resolve → understand/load_blocks → **规则** → 可选 **LLM** → kb_write |
| report | 默认只报 **本轮 findings**；失败条数用本轮 count，**不展示**历史 occurrence |
| LLM | `lib/llm.js`：baseUrl+apiKey+model；`llmTimeoutMs` 默认 600s |
| service | `--once` / 常驻；默认 diagnose 偏规则，`--llm` 才调模型 |

## 与 rpa-skill 的关系

```
D:\RPA-Skill          生产：流程生成 / understand / inspect / block_library
       ▲
       │ 只读 require
D:\RPA-Monitor-Agent  消费：监听 OpenAPI + 诊断 Agent + 日报 / KB
```

## 开发流程

1. 方案：改 SPEC / TECH-DESIGN；改身份边界时同步 ARCHITECTURE-FREEZE  
2. 实现：能力做成 **lib tool 并注册**  
3. 验证：  
   - `npm run verify`  
   - `node monitor/test_fingerprint.js`  
   - `node monitor/poll.js --once`  
   - `node monitor/agent.js diagnose --fingerprint <fp>`  
   - `node monitor/report.js`  
   - `node monitor/service.js --once`  
4. 密钥：`config.local.js` gitignore  

### 当前实现进度

- ✅ S0–S9 + 部署（Windows/Linux/PM2）  
- ➡ 可选 S10、服务器流程源码策略  

## 已验证事实（OpenAPI）

1. 端点 `dispatch/v2/job/list` + `job/log/search`  
2. `jobUuid` 直接衔接  
3. 日志 `flowName` + `lineNumber` + `level`  

## git

- remote：`git@github.com:zk8080/RPA-Monitor-Agent.git`  
- 默认分支 **main**  
- 提交身份沿用 global：`zk8080 <zhangkang8080@163.com>`  
