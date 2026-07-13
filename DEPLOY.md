# 部署指南：可挂机的 RPA Diagnosis Agent

## 先回答你的问题

| 疑问 | 答案 |
|------|------|
| 还是得自己每次执行 node 脚本吗？ | **不必。** 日常应跑 **`service.js` 常驻 Runtime**（或任务计划定时 `--once`），不是手敲 poll/diagnose。 |
| 想要的是可部署在服务器上的 Agent？ | **产品目标就是这个。** CLI 只是开发/排障入口；**部署单元 = 一个常驻（或定时）Agent 进程**。 |
| `node monitor/agent.js` 还要不要？ | 需要时手动深挖单条失败；**生产主路径是 service**。 |

```
开发排障（可选）          生产部署（主路径）
─────────────────        ─────────────────────────────
poll.js / agent.js   →   service.js 常驻 或 定时 --once
report.js 手动           进程内自动 poll + diagnose + report
                         可选 GET /health
```

---

## 三种部署形态（按环境选）

### A. Windows 服务器 / 本机挂机（推荐起步）

**形态：** 一个 Node 进程常驻，崩溃用计划任务或 NSSM 拉起。

```powershell
# 仓库根目录
copy monitor\config.example.js monitor\config.local.js
# 编辑密钥：accessKeyId / accessKeySecret；建议 healthPort: 8787

# 本机安装 / 更新 rpa-skill（流程图 + 结构诊断；见下文「方案 A」）
powershell -File scripts\bootstrap-rpa-skill.ps1 -Repo <rpa-skill-git-url> -WriteConfig

# 单轮验收（跑完退出）
npm run once

# 前台常驻（调试）
npm start

# 后台常驻 + 写日志（推荐；经任务计划拉起，关终端不杀进程）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\start-service.ps1

# 停止
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\stop-service.ps1
```

**说明：**

- `start-service.ps1` 会注册任务计划 **`RPA-Monitor-Agent`**（登录自启 + 立刻启动），action 为直接跑 `node monitor/service.js`（非 powershell 子进程）。  
- 日志：`data/logs/service-yyyyMMdd.log`（service 进程内追加）+ 启动记录。  
- 单实例：`data/service.pid`；`stop-service.ps1` 先停任务再杀进程，避免 RestartCount 拉回。  
- 感知翻页：`pollMaxPages`（默认 50）× `size`（默认 50）；**service 不再写死 3 页**。  
- 可选 `robotClientUuid`：空 = 密钥可见范围内全部应用；填了才限某客户端。

**备选：只定时、不常驻**

- 程序：`node.exe`  
- 参数：`monitor/service.js --once`  
- 触发：每 15 分钟  

适合不能常驻进程、只允许计划任务的环境。

### B. Linux 服务器 + systemd（公司常见）

```bash
# 1. Node ≥ 18，克隆仓库
cp monitor/config.example.js monitor/config.local.js
# 编辑密钥；healthPort 建议 8787

# 2. 单轮验收
npm run once

# 3. 安装 systemd 单元（按实际路径改 WorkingDirectory / User）
sudo cp deploy/linux/rpa-monitor-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rpa-monitor-agent

# 4. 看状态与日志
systemctl status rpa-monitor-agent
journalctl -u rpa-monitor-agent -f
curl -s http://127.0.0.1:8787/health
```

### C. PM2（Node 运维习惯时）

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup   # 按提示配置开机
pm2 logs rpa-monitor-agent
```

---

## 配套依赖：rpa-skill（方案 A · 本机安装）

工作台「业务流程 / 重新解析」与 diagnose 的结构理解依赖 **本机 rpa-skill**（`require` 只读，**不是**远程 HTTP）。

每台部署机各自装一份 skill，用 git 同步版本。推荐目录布局：

```text
D:\RPA-Monitor-Agent     ← 本仓库
D:\RPA-Skill             ← rpa-skill（与 Monitor 同级，只读）
```

### 一键脚本（Windows）

```powershell
# 仓库根目录。首次需要 skill 的 git 地址（或设 $env:RPA_SKILL_REPO）
powershell -File scripts\bootstrap-rpa-skill.ps1 `
  -Repo git@github.com:YOUR_ORG/RPA-Skill.git `
  -WriteConfig

# 已有 D:\RPA-Skill 时：pull + 写 config
powershell -File scripts\bootstrap-rpa-skill.ps1 -WriteConfig
```

| 参数 | 说明 |
|------|------|
| `-Path` | 安装目录，默认「Monitor 父目录/RPA-Skill」 |
| `-Repo` | git 远程；也可环境变量 `RPA_SKILL_REPO` |
| `-Branch` | 默认 `main` |
| `-WriteConfig` | 更新 `monitor/config.local.js` 的 `rpaSkillPath` |

也可用环境变量覆盖路径（优先级高于 config）：

```powershell
$env:RPA_SKILL_PATH = "D:\RPA-Skill"
```

### 校验

```powershell
node -e "const c=require('./monitor/lib/config').loadConfig(); console.log(c.rpaSkillPath)"
# 应打印本机 skill 绝对路径；目录下需有 scripts/understand.js
```

### 多机同步

| 做法 | 说明 |
|------|------|
| 每台跑 bootstrap 或 `git pull` | **推荐** |
| 钉 tag / release | 生产机 checkout 固定 tag，避免漂 |
| 不支持 | 把 `rpaSkillPath` 写成 `https://…`（当前实现是本地 require） |

无 skill 时：poll / 规则 diagnose / 日报仍可跑；**流程图与结构 understand 不可用**。

---

## 配置（服务器必看）

`monitor/config.local.js`（**勿提交 git**）或环境变量：

| 项 | 说明 | 生产建议 |
|----|------|----------|
| `accessKeyId` / `accessKeySecret` | 影刀 OpenAPI | 必填 |
| `robotClientUuid` | 限定机器人 | 有多机器人时建议填 |
| `pollIntervalMinutes` | 轮询间隔 | 15 |
| `diagnoseCron` / `reportCron` | 额外诊断/日报（分 时） | `0 9 * * *` / `5 9 * * *` |
| `healthPort` | HTTP 健康检查 | **8787**（0=关闭） |
| `rpaSkillPath` | rpa-skill **本机**路径 | 见上文方案 A；也可用 `RPA_SKILL_PATH` |
| `llmBaseUrl` / `llmApiKey` / `llmModel` | 通用 LLM（OpenAI 兼容） | 可选；无 apiKey 则纯规则 |
| `llmApiStyle` | `openai`（默认）或 `anthropic` | 三方中转一般用 openai |
| `llmTimeoutMs` | LLM 超时 ms | 默认 **600000**（10 分钟） |
| `pollLookbackHours` | 感知时间窗（小时） | 默认 **24** |
| `pollMaxPages` | 时间窗内最多翻页（CLI **与 service 共用**） | 默认 **50**（约 50×size 条/轮上限） |
| `shadowbotUserId` / `shadowbotUsersRoot` | 本机流程自动发现 | Windows 有客户端时可填 userId 固定账号 |
| （兼容）`anthropicApiKey` | 旧字段，仍可读 | 建议迁到 llm* |


| `DATA_DIR` 环境变量 | Memory 目录 | 默认真仓库 `data/`；可指到数据盘 |

环境变量优先级高于 `config.local.js`：

```text
YD_ACCESS_KEY_ID / YD_ACCESS_KEY_SECRET
YD_ROBOT_CLIENT_UUID / YD_JOB_SIZE
RPA_SKILL_PATH
LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_API_STYLE / LLM_TIMEOUT_MS
POLL_LOOKBACK_HOURS / POLL_MAX_PAGES
HEALTH_PORT / DATA_DIR
```



---

## 健康检查与运维

常驻且 `healthPort > 0` 时：

```bash
curl -s http://127.0.0.1:8787/health
```

示例字段：`uptimeSec`、`lastPollAt`、`queueDepth`、`undiagnosed`、`pid`。

| 现象 | 处理 |
|------|------|
| 提示 already_running | 看 `data/service.pid`；进程已死则删 pid 文件再启 |
| 无新失败入队 | 查密钥、`robotClientUuid`、影刀侧是否有 error 运行 |
| 诊断弱 / 无指令块 | 确认本机存在 ShadowBot `users\*\apps\<uuid>\xbot_robot`；或写 app-map；或接受纯日志诊断 |

| 磁盘涨 | `data/queue`、`data/kb`、`data/reports` 按需归档（后期可加清理策略） |

日志：

- Windows 包装脚本：`data/logs/service-YYYYMMDD.log`  
- systemd：`journalctl -u rpa-monitor-agent`  
- PM2：`pm2 logs`

---

## 架构上「部署的是什么」

```
┌─────────────────────────────────────────┐
│  服务器进程：node monitor/service.js      │  ← 部署单元
│    Scheduler（确定性）                    │
│      poll → queue / alerts               │
│      diagnose skill（runner + tools）    │
│      report → data/reports/              │
│    GET /health（可选）                    │
└─────────────────────────────────────────┘
         │                    │
    影刀 OpenAPI          rpa-skill（只读，可选）
```

- **不是**「运维每天跑三个脚本」  
- **是**「一个 Agent Runtime 挂在服务器上，自己听、自己诊、自己出报告」  
- CLI（`agent.js diagnose --job …`）始终可降级使用，服务挂了也能单次诊断  

与 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md) 一致：service 只调度，业务在 lib tools。

---

## 安全注意

1. `config.local.js` / 密钥 **不要进 git、不要打进公开镜像层**  
2. `healthPort` 默认只绑本机逻辑使用；若对公网暴露须加防火墙/反向代理鉴权（当前 `/health` **无鉴权**）  
3. `data/` 含失败日志摘要，按公司规范做盘权限  
4. rpa-skill **本机只读**（方案 A：每机一份 + bootstrap 脚本）；流程目录优先本机 ShadowBot 自动发现，app-map 仅覆盖  



---

## 验收清单（上线前）

- [ ] `npm run once` 成功：poll 有扫描、queue/kb 有更新、reports 有 md  
- [ ] `npm start` 或 systemd/PM2 常驻后，`curl /health` 返回 ok  
- [ ] 进程杀死后能自动拉起（任务计划 / systemd Restart / PM2）  
- [ ] 双开第二实例会因 `service.pid` 拒绝（防双 poll）  
- [ ] 密钥不在仓库远程历史中  

---

## 和「手敲脚本」的边界（宣讲可用）

> 开发期可用 CLI 验证 tool 与 skill；**生产交付的是可常驻的 Diagnosis Agent Runtime**（`service.js`），由操作系统或进程管理器托管，自动完成监听、诊断入 KB 与日报，并提供健康检查。

详细模块见 [TECH-DESIGN.md](TECH-DESIGN.md)；红线见 [ARCHITECTURE-FREEZE.md](ARCHITECTURE-FREEZE.md)。
