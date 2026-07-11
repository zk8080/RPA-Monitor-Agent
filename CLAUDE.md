# RPA-Monitor-Agent（开发指引）

本仓库是「影刀 RPA **诊断 / 提效 AI Agent**」的独立项目，**不是** rpa-skill 的一部分。

最终交付物：确定性监听 + Tool-using Diagnosis Agent + KB + 可常驻运行时  
（演进：同一 Runtime 扩展 develop / maintain → **RPA Efficiency Agent**）。

| 文档 | 用途 |
|------|------|
| [SPEC-monitor-agent.md](SPEC-monitor-agent.md) | 产品设计 |
| [TECH-DESIGN.md](TECH-DESIGN.md) | 技术方案（M0→M3，S0→S10） |
| [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) | **架构冻结 / 防漂（实现必遵）** |
| [DEPLOY.md](DEPLOY.md) | **服务器部署（service 常驻 / systemd / PM2）** |
| [README.md](README.md) | 仓库说明 |


## 架构红线（摘要）

完整条款见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)。冲突时 **先服从冻结清单**。

1. **产品身份是 Agent**，不是脚本集。能力可弱（M1-min playbook），入口/tools/runner/memory/skill **不可弱**。
2. **监听确定性、诊断走 Agent 面**；禁止 Agent 主 loop 用 `list_jobs` 巡检。
3. **业务只进 `monitor/lib/*` + 注册表**；`agent.js` / `poll.js` / `service.js` 保持薄封装。
4. **CLI 与 Service 共用同一 runner + tools**；禁止平行 `diagnose.js` 业务栈。
5. **S6（diagnose 闭环）在 S9（service）之前**；**S3.5（agent 入口 + 注册表）不晚于 S5**。
6. rpa-skill **只读**；密钥不入库；状态在 `data/*`。

## 与 rpa-skill 的关系

```
D:\RPA-Skill          生产：流程生成 / understand / inspect / block_library
       ▲
       │ 路径引用（RPA_SKILL_PATH 或 config.rpaSkillPath）
       │
D:\RPA-Monitor-Agent  消费：监听 OpenAPI + 诊断 Agent + 日报 / KB
```

- 本仓库 **不修改** rpa-skill 源码
- 诊断时用 `require(RPA_SKILL_PATH + '/scripts/...')` 调用其能力
- rpa-skill 脚本内部用相对 require，外部绝对路径 require 可正确解析依赖

## 本地目录

```
D:\RPA-Monitor-Agent
├── SPEC-monitor-agent.md
├── TECH-DESIGN.md
├── ARCHITECTURE-FREEZE.md   # 架构冻结
├── CLAUDE.md
├── README.md
├── monitor/
│   ├── verify_openapi.js
│   ├── config.example.js
│   ├── config.local.js      # 密钥，gitignore
│   ├── poll.js / agent.js / service.js / report.js
│   └── lib/                 # tools + agent-runner + 注册表
└── data/                    # Agent Memory，gitignore
```

## 开发流程

1. 方案：改 SPEC / TECH-DESIGN；**改身份或边界时同步改 ARCHITECTURE-FREEZE**
2. 实现：按 TECH-DESIGN §十（S1→S10）+ 冻结清单 §8 检查点落地
3. 能力优先做成 **lib tool 并注册**，供 Agent 与 CLI 共用
4. 验证：
   - `node monitor/verify_openapi.js`
   - `node monitor/test_fingerprint.js`
   - `node monitor/poll.js --once`
   - `node monitor/agent.js diagnose --queue --limit 3 --no-llm`
   - `node monitor/report.js`
   - `node monitor/service.js --once`
5. **S0–S9 最小闭环已可用**；S10 与 app-map / LLM 为增强
6. 暂不推远程，本地 git 管理即可

### 当前实现进度

- ✅ S0–S9：感知 / diagnose skill / KB / 日报 / service Runtime
- ➡ 可选：app-map、LLM、S10（KB-first / 跨应用 / 分诊）




## 工程约定

- **密钥不入库**：`monitor/config.local.js` 已 gitignore，只提交 `config.example.js`
- **监听与诊断分离**：监听层不调 AI；诊断层才是 skill + tools
- **禁止 Agent 轮询 OpenAPI**：`list_jobs` 只给确定性 poll
- **不硬编码敏感信息**：token / webhook / 密码走配置或环境变量
- **rpa-skill 只读引用**：只 require 其脚本，不写入其目录
- **走偏自检**：见 ARCHITECTURE-FREEZE §9

## 已验证事实（2026-07-11）

见 SPEC 第七节：

1. 端点用 `dispatch/v2/job/list` + `dispatch/v2/job/log/search`，**不是**旧的 `app/open/query/use/record/list`
2. `jobUuid` 直接衔接，无需转换
3. 日志带 `flowName` + `lineNumber` + `level`，可直接定位子流程行号

## git

- 本地仓库，暂无 remote
- 提交身份沿用 global：`zk8080 <zhangkang8080@163.com>`
