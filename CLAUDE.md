# RPA-Monitor-Agent（开发指引）

本仓库是「影刀 RPA **诊断 / 提效 AI Agent**」的独立项目，**不是** rpa-skill 的一部分。

最终交付物：确定性监听 + diagnose skill + KB + 可常驻 Runtime  
（演进：同一 Runtime 扩展 develop / maintain → **RPA Efficiency Agent**）。

| 文档 | 用途 |
|------|------|
| [SPEC-monitor-agent.md](SPEC-monitor-agent.md) | 产品设计 |
| [TECH-DESIGN.md](TECH-DESIGN.md) | 技术方案（**以实现对齐版为准**） |
| [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) | **架构冻结 / 防漂（实现必遵）** |
| [WEB-WORKBENCH-MVP.md](WEB-WORKBENCH-MVP.md) | **本机 Web 工作台 MVP 实现计划（S25）** |
| [PLAN-LLM-WEB-SETTINGS.md](PLAN-LLM-WEB-SETTINGS.md) | **S26 工作台配置 LLM（已实现）** |
| [PRODUCT.md](PRODUCT.md) / [DESIGN.md](DESIGN.md) | **Web 工作台产品与视觉上下文（impeccable）** |
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
| poll | 默认 **最近 24h**；翻页上限 **`pollMaxPages`（默认 50）**；CLI 与 service 一致 |
| queue 时间 | **`lastSeen`/`lastFailureAt` = 影刀 job 失败时间**；`lastPolledAt` = poll 写入；同 jobUuid 不虚增 occurrence |
| 指纹 | remark → 日志补全；调度层无流程名 → 前缀「调度层」+ 解析「原因：」；弱 `unknown-flow\|超时` 不跨应用归并 |
| resolve_app | ShadowBot 自动 `xbot_robot` |
| diagnose | playbook：规则 ± LLM ± rpa-skill；**triage** 出 fixClass |
| maintain | playbook skill：`inspect` / `fix`（默认 dry-run）/ `rollback` |
| 写盘 | 仅 `maintain fix --apply` + autoFix 配置；**service 不自动改 py** |
| report | 本轮 findings 条数，无历史 occurrence 展示 |
| workbench | 失败时间 **绝对本地时间**；跨应用卡片不展示内部 errorSignature；**设置页**配 LLM；业务流程 **业务解读(LLM)**；**S27a 交接提示**（`lib/handoff` 瘦身；默认不含诊断）；**S27b bucket 分流**（可开发 vs 环境/调度） |
| LLM | `lib/llm.js`；timeout 默认 600s；**env > data/settings.llm.json > config.local**；`diagnoseUseLlm` |
| 形态 | **Agent skills + tools**；CLI/service 为触发方式，非「散装脚本身份」 |
| 验证补充 | `node monitor/test_queue_time.js` |


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
   - `node monitor/test_workbench.js`
   - `node monitor/test_handoff.js`
   - `node monitor/test_bucket.js`
   - `node monitor/test_work_status.js`
   - `node monitor/test_queue_time.js`
   - `node monitor/test_settings_llm.js`  


4. 密钥：`config.local.js` gitignore  

### 当前实现进度

- ✅ S0–S9 + 部署  
- ✅ S11–S16 maintain（巡检 + py 受控修；默认不 apply）  
- ✅ **S25 本机工作台 Web MVP**（`http://127.0.0.1:8787/`）  
- ✅ **S17 诊后 dry-run 存 patch**（`maintain.autoPlanOnDiagnose`，默认关；绝不 apply）  
- ✅ **S18 修复验证闭环**（apply → pending_verify；新 job 同指纹 → regressed；静默期满 → verified）  
- ✅ **S25b 工作台操作面**（一键 diagnose / fix dry-run；问题详情；patches API）  
- ✅ **S20** 日报 maintain/patch 挂钩  
- ✅ **S10a** KB-first（仅 confirmed，默认关）  
- ✅ **S19** 空路径 py fixer（`python_empty_path`）  
- ✅ **S10b** 跨应用根因归并（errorSignature ≥2 app）  
- ➡ **继续实现 backlog：** [TECH-DESIGN.md §十五](TECH-DESIGN.md)  
  - **主路径（当前）：** 工作台理解失败/流程 → **复制瘦身交接提示 / 打开 Agent** → Coding Agent 改代码（收益最高）  
  - ✅ **S27a** 瘦身交接包（`lib/handoff.js`；诊断 opt-in；非可配全文模板）  
  - ✅ **S27b** 噪声分流 bucket（`lib/bucket.js`；元素≠代码；code 仅 py/变量；UI 三档筛选）  
  - ✅ **S27d** workStatus（open/snoozed/ignored/resolved；新 job 唤醒；优先队列仅 open；处理完成可记原因/方案）  
  - **P2 后置：** S21 服务器源码（暂无需求）  
  - **P2 ⏸ S10c** fixOwner：归属划分未明确，暂缓  
  - **P2 ⏸ S22** develop 骨架：不如直接 Coding Agent，暂缓  
  - ✅ **S26** 工作台配置 LLM（`data/settings.llm.json` + `/settings`）  

  - **P3：** tool-loop / 对话入口（可选）  
  - **禁止：** service 默认 apply 生产 py；Web 复制平行业务栈  



## 已验证事实（OpenAPI）

1. 端点 `dispatch/v2/job/list` + `job/log/search`  
2. `jobUuid` 直接衔接  
3. 日志 `flowName` + `lineNumber` + `level`  

## git

- remote：`git@github.com:zk8080/RPA-Monitor-Agent.git`  
- 默认分支 **main**  
- 提交身份沿用 global：`zk8080 <zhangkang8080@163.com>`  
