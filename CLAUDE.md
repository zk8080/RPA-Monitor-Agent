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
| poll | 默认 **最近 24h**；`lastPollFindings` |
| resolve_app | ShadowBot 自动 `xbot_robot` |
| diagnose | playbook：规则 ± LLM ± rpa-skill；**triage** 出 fixClass |
| maintain | playbook skill：`inspect` / `fix`（默认 dry-run）/ `rollback` |
| 写盘 | 仅 `maintain fix --apply` + autoFix 配置；**service 不自动改 py** |
| report | 本轮 findings 条数，无历史 occurrence 展示 |
| LLM | `lib/llm.js`；timeout 默认 600s |
| 形态 | **Agent skills + tools**；CLI/service 为触发方式，非「散装脚本身份」 |


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
   - `node monitor/agent.js maintain inspect --robot <uuid>`  
   - `node monitor/test_maintain.js`  
4. 密钥：`config.local.js` gitignore  

### 当前实现进度

- ✅ S0–S9 + 部署  
- ✅ S11–S16 maintain（巡检 + py 受控修；默认不 apply）  
- ➡ **继续实现 backlog：** [TECH-DESIGN.md §十五](TECH-DESIGN.md)  
  - **P0：** S17 诊后 dry-run 存 patch；S18 修复验证闭环  
  - **P1：** S19 更多 fixer；S20 日报挂钩；S10a KB-first  
  - **P2：** 跨应用 / fixOwner / 服务器源码策略 / develop 骨架  
  - **P3：** tool-loop / 对话入口（可选）  
  - **禁止：** service 默认 apply 生产 py  



## 已验证事实（OpenAPI）

1. 端点 `dispatch/v2/job/list` + `job/log/search`  
2. `jobUuid` 直接衔接  
3. 日志 `flowName` + `lineNumber` + `level`  

## git

- remote：`git@github.com:zk8080/RPA-Monitor-Agent.git`  
- 默认分支 **main**  
- 提交身份沿用 global：`zk8080 <zhangkang8080@163.com>`  
