/* RPA Workbench SPA */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const content = $('#content');
  const pageTitle = $('#page-title');
  const pageDesc = $('#page-desc');
  const rtPill = $('#rt-pill');
  const rtDetail = $('#rt-detail');
  const toastEl = $('#toast');

  let toastTimer = null;
  /** 当前页可复制的主路径（快捷键 c） */
  let activeCopyPath = '';
  /** 当前页 Agent 提示全文（快捷键 shift+c） */
  let activeAgentPrompt = '';
  /** GET /api/agents 缓存 */
  let agentsCache = null;
  let agentsCacheAt = 0;
  const AGENTS_TTL_MS = 60 * 1000;
  const LAST_AGENT_KEY = 'rpa_wb_last_agent';

  const RECENT_KEY = 'rpa_wb_recent_apps';
  const RECENT_MAX = 6;

  function toast(msg, ms = 2800) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function shortPath(p, keep = 48) {
    const s = String(p || '');
    if (s.length <= keep) return s;
    return `…${s.slice(-(keep - 1))}`;
  }

  /** 展示绝对本地时间 yyyy-MM-dd HH:mm:ss（不再用「N 小时前」） */
  function formatTime(iso) {
    if (!iso) return '—';
    const raw = String(iso).trim();
    const t = Date.parse(raw);
    if (Number.isNaN(t)) {
      // 已是影刀本地串等：去掉 T/Z 截断展示
      return raw.replace('T', ' ').replace(/\.\d{3}Z?$/, '').replace(/Z$/, '').slice(0, 19);
    }
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  // 兼容旧调用名
  function relTime(iso) {
    return formatTime(iso);
  }

  function loadingHtml(label = '加载中…') {
    return `<div class="loading-block" role="status" aria-live="polite">
      <div class="skeleton-stack">
        <div class="skeleton sk-line w-40"></div>
        <div class="skeleton sk-line w-70"></div>
        <div class="skeleton sk-line w-55"></div>
      </div>
      <p class="loading-label">${esc(label)}</p>
    </div>`;
  }

  function getRecentApps() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => x && x.robotUuid).slice(0, RECENT_MAX) : [];
    } catch {
      return [];
    }
  }

  function pushRecentApp(robotUuid, name) {
    if (!robotUuid) return;
    try {
      const next = [
        { robotUuid, name: name || robotUuid, at: Date.now() },
        ...getRecentApps().filter((x) => x.robotUuid !== robotUuid),
      ].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  /**
   * Coding Agent 交接文案
   * - mode: 'fix'     诊后修复（失败详情 / 列表「复制给 Agent」）
   * - mode: 'develop'  日常开发 / 理解与维护（应用详情）
   * 原则：问题包 + 打开工程 + 用 rpa-skill 理解；不 dump 全流程 JSON
   *
   * @param {{
   *   mode?: 'fix'|'develop',
   *   name?: string,
   *   xbotDir?: string,
   *   robotUuid?: string,
   *   fingerprint?: string,
   *   flowName?: string,
   *   lineNumber?: string|number,
   *   errorType?: string,
   *   rawRemark?: string,
   *   rootCause?: string,
   *   suggestion?: string,
   *   guidanceTitle?: string,
   *   fixClass?: string,
   *   fixability?: string,
   *   taskNote?: string,
   * }} ctx
   */
  function buildAgentPrompt(ctx = {}) {
    // 有指纹默认 fix；显式 mode 优先
    const effective =
      ctx.mode === 'develop'
        ? 'develop'
        : ctx.mode === 'fix' || ctx.fingerprint
          ? 'fix'
          : 'develop';

    if (effective === 'develop') {
      return buildDevelopPrompt(ctx);
    }
    return buildFixPrompt(ctx);
  }

  function buildDevelopPrompt(ctx = {}) {
    const lines = [
      '# 任务 · 影刀 RPA 开发 / 维护',
      '当前工作区应已是该应用的 xbot_robot 目录。请先理解流程结构，再按我的需求改代码；写盘前说明影响面并确认。',
      '',
      '## 工程',
    ];
    if (ctx.name) lines.push(`- 应用：${ctx.name}`);
    if (ctx.robotUuid) lines.push(`- robotUuid：${ctx.robotUuid}`);
    if (ctx.xbotDir) lines.push(`- 路径：${ctx.xbotDir}`);
    if (ctx.taskNote) {
      lines.push('', '## 本次需求', String(ctx.taskNote).slice(0, 800));
    }

    // 日常开发不附带失败队列 / 备注；失败现场只走 fix 模式

    lines.push(
      '',
      '## 建议工作方式',
      '1. 用 rpa skill 理解本项目：`/rpa understand`（结构）或 `/rpa inspect`（风险）',
      '2. 对照 package.json / .dev 下流程与 Python 模块，理清主流程与子流程调用',
      '3. 按需求做最小改动；生成或改写 .flow.json 时遵守 rpa skill 的确认门槛（IRON LAW）',
      '4. 不要整库重写；不要假设其他未打开的应用目录',
      '',
      '## 不要做',
      '- 不要把整份 .flow.json 再贴回对话当「理解结果」；以磁盘与 rpa skill 为准',
      '- 不要整库重写；优先局部、可确认的改动',
    );
    return lines.join('\n');
  }

  function buildFixPrompt(ctx = {}) {
    const lines = [
      '# 任务 · 影刀 RPA 失败修复',
      '当前工作区应已是该应用的 xbot_robot 目录。请根据下方「失败现场」定位并修复；先理解再改，写盘前说明影响面。',
      '',
      '## 工程',
    ];
    if (ctx.name) lines.push(`- 应用：${ctx.name}`);
    if (ctx.robotUuid) lines.push(`- robotUuid：${ctx.robotUuid}`);
    if (ctx.xbotDir) lines.push(`- 路径：${ctx.xbotDir}`);

    lines.push('', '## 失败现场（来自 RPA Monitor，请优先对齐）');
    if (ctx.fingerprint) lines.push(`- 指纹：${ctx.fingerprint}`);
    if (ctx.flowName) {
      const loc =
        ctx.lineNumber != null && ctx.lineNumber !== ''
          ? `${ctx.flowName}  L${ctx.lineNumber}`
          : ctx.flowName;
      lines.push(`- 流程位置：${loc}`);
    }
    if (ctx.errorType) lines.push(`- 错误类型：${ctx.errorType}`);
    if (ctx.rawRemark) lines.push(`- 原始备注：${String(ctx.rawRemark).slice(0, 600)}`);
    if (ctx.guidanceTitle || ctx.fixClass) {
      lines.push(
        `- 分诊：${[ctx.guidanceTitle, ctx.fixClass, ctx.fixability].filter(Boolean).join(' / ')}`,
      );
    }

    if (ctx.rootCause || ctx.suggestion) {
      lines.push('', '## Monitor 已有判断（可参考，需你核实）');
      if (ctx.rootCause) lines.push(`- 根因：${String(ctx.rootCause).slice(0, 500)}`);
      if (ctx.suggestion) lines.push(`- 建议：${String(ctx.suggestion).slice(0, 500)}`);
    }

    lines.push(
      '',
      '## 建议工作方式',
      '1. 用 rpa skill 理解本项目：`/rpa understand`；若需结构风险可 `/rpa inspect`',
      '2. 打开失败相关的 .flow.json / py，对照流程名与行号（行号可能对应块序号，以实际文件为准）',
      '3. 给出最小改动方案；确认后再改文件',
      '4. 修复后说明如何回归验证（重跑任务 / 看同指纹是否再出现）',
      '',
      '## 不要做',
      '- 不要要求用户再粘贴整份流程 JSON；工程已在工作区，用 skill 或读文件理解',
      '- 不要整库重写；优先局部修复',
    );
    return lines.join('\n');
  }

  function setActiveHandoff({ path = '', agentPrompt = '' } = {}) {
    activeCopyPath = path || '';
    activeAgentPrompt = agentPrompt || '';
  }

  async function loadAgents(force = false) {
    const now = Date.now();
    if (!force && agentsCache && now - agentsCacheAt < AGENTS_TTL_MS) {
      return agentsCache;
    }
    try {
      const data = await api('/api/agents');
      if (data && data.ok && Array.isArray(data.agents)) {
        agentsCache = data.agents;
        agentsCacheAt = now;
        return agentsCache;
      }
    } catch {
      // ignore
    }
    // 离线兜底（与服务端默认一致）
    agentsCache = [
      { id: 'cursor', label: 'Cursor', kind: 'editor', hint: '' },
      { id: 'vscode', label: 'VS Code', kind: 'editor', hint: '' },
      { id: 'qoder', label: 'Qoder', kind: 'editor', hint: '' },
      { id: 'claude', label: 'Claude Code', kind: 'terminal', hint: '' },
      { id: 'codex', label: 'Codex', kind: 'terminal', hint: '' },
    ];
    agentsCacheAt = now;
    return agentsCache;
  }

  function getLastAgentId(agents) {
    try {
      const last = localStorage.getItem(LAST_AGENT_KEY);
      if (last && agents.some((a) => a.id === last)) return last;
    } catch {
      // ignore
    }
    return (agents[0] && agents[0].id) || 'cursor';
  }

  function setLastAgentId(id) {
    try {
      localStorage.setItem(LAST_AGENT_KEY, id);
    } catch {
      // ignore
    }
  }

  /**
   * 复制提示词（若有）并在本机用指定 Agent 打开 xbotDir
   * @param {string} robotUuid
   * @param {string} agentId
   * @param {{ prompt?: string, label?: string, btn?: HTMLElement, hintEl?: HTMLElement }} [opts]
   */
  async function openInAgent(robotUuid, agentId, opts = {}) {
    if (!robotUuid || !agentId) {
      toast('缺少应用或 Agent');
      return false;
    }
    const prompt = opts.prompt != null ? opts.prompt : activeAgentPrompt;
    if (prompt) {
      await copyTextQuiet(prompt);
    }
    const btn = opts.btn;
    const hintEl = opts.hintEl || $('#open-hint');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('busy');
    }
    if (hintEl) hintEl.textContent = `正在用 ${opts.label || agentId} 打开…`;
    try {
      const r = await api(`/api/apps/${encodeURIComponent(robotUuid)}/open-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agentId }),
      });
      if (r.ok) {
        setLastAgentId(agentId);
        const name = opts.label || agentId;
        const pasteHint =
          r.method === 'terminal-cmd' || r.method === 'terminal-osascript' || r.method === 'terminal-linux'
            ? `已启动 ${name} · 提示词已复制`
            : `已打开 ${name} · 提示词已复制`;
        toast(pasteHint, 2800);
        if (hintEl) {
          hintEl.innerHTML = r.opened
            ? `<span class="mono">${esc(r.opened)}</span>`
            : esc(pasteHint);
        }
        return true;
      }
      const msg = r.message || r.code || '打开失败';
      toast(msg);
      if (hintEl) hintEl.innerHTML = `<span class="err">${esc(msg)}</span>`;
      return false;
    } catch (e) {
      toast(e.message || '打开失败');
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    }
  }

  /**
   * 「在 Agent 打开」分裂按钮 + 下拉
   * @param {{ robotUuid: string, xbotDir?: string, agents?: object[], prompt?: string }} opts
   */
  function openAgentMenuHtml(opts = {}) {
    const robotUuid = opts.robotUuid || '';
    const xbotDir = opts.xbotDir || '';
    const agents = opts.agents || [];
    if (!robotUuid || !xbotDir || !agents.length) return '';
    const lastId = getLastAgentId(agents);
    const primary = agents.find((a) => a.id === lastId) || agents[0];
    const menuId = `agent-menu-${Math.random().toString(36).slice(2, 8)}`;
    return `<div class="split-btn" data-open-agent-wrap data-robot="${esc(robotUuid)}">
      <button type="button" class="btn primary split-main" data-open-agent="${esc(primary.id)}" data-agent-label="${esc(
        primary.label,
      )}" title="${esc(primary.hint || primary.label)}">在 ${esc(primary.label)} 打开</button>
      <button type="button" class="btn primary split-caret" data-agent-menu-toggle="${menuId}" aria-haspopup="menu" aria-expanded="false" aria-label="选择 Agent" title="选择 Agent">▾</button>
      <div class="agent-menu" id="${menuId}" role="menu" hidden>
        ${agents
          .map(
            (a) => `<button type="button" class="agent-menu-item" role="menuitem" data-open-agent="${esc(
              a.id,
            )}" data-agent-label="${esc(a.label)}" title="${esc(a.hint || '')}">
              <span class="agent-menu-label">${esc(a.label)}</span>
              <span class="agent-menu-kind">${esc(a.kind === 'terminal' ? '终端' : '编辑器')}</span>
            </button>`,
          )
          .join('')}
      </div>
    </div>`;
  }

  function closeAllAgentMenus() {
    document.querySelectorAll('.agent-menu').forEach((m) => {
      m.hidden = true;
    });
    document.querySelectorAll('[data-agent-menu-toggle]').forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
    });
  }

  function bindOpenAgentControls(root, { robotUuid, prompt = '' } = {}) {
    const scope = root || document;
    scope.querySelectorAll('[data-agent-menu-toggle]').forEach((btn) => {
      if (btn._menuBound) return;
      btn._menuBound = true;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-agent-menu-toggle');
        const menu = id ? document.getElementById(id) : null;
        if (!menu) return;
        const open = menu.hidden;
        closeAllAgentMenus();
        if (open) {
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
    scope.querySelectorAll('[data-open-agent]').forEach((btn) => {
      if (btn._openBound) return;
      btn._openBound = true;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const agentId = btn.getAttribute('data-open-agent');
        const label = btn.getAttribute('data-agent-label') || agentId;
        const wrap = btn.closest('[data-open-agent-wrap]');
        const uuid = (wrap && wrap.getAttribute('data-robot')) || robotUuid;
        closeAllAgentMenus();
        // 更新主按钮文案为最近选择
        if (wrap) {
          const main = wrap.querySelector('.split-main');
          if (main && agentId) {
            main.setAttribute('data-open-agent', agentId);
            main.setAttribute('data-agent-label', label);
            main.textContent = `在 ${label} 打开`;
          }
        }
        await openInAgent(uuid, agentId, {
          prompt: prompt || activeAgentPrompt,
          label,
          btn: btn.classList.contains('split-main') ? btn : wrap && wrap.querySelector('.split-main'),
        });
      });
    });
  }

  /**
   * 主路径交接条：路径可点复制；唯一主按钮 = 在 Agent 打开（自动带提示词）
   */
  function handoffBarHtml({
    xbotDir = '',
    agentPrompt = '',
    pathLabel = '本地路径',
    compact = false,
    robotUuid = '',
    agents = null,
  } = {}) {
    const path = String(xbotDir || '');
    const prompt = String(agentPrompt || '');
    if (!path && !prompt) return '';
    const openMenu =
      robotUuid && path && agents && agents.length
        ? openAgentMenuHtml({ robotUuid, xbotDir: path, agents, prompt })
        : '';
    return `<div class="handoff ${compact ? 'compact' : ''}" role="region" aria-label="交给 Coding Agent">
      <div class="handoff-label">${esc(pathLabel)}</div>
      <div class="handoff-row">
        ${
          path
            ? `<button type="button" class="handoff-path" data-copy="${esc(path)}" data-copy-msg="路径已复制" title="点击复制路径">${esc(
                path,
              )}</button>`
            : `<div class="handoff-path muted">未解析到 xbot_robot 路径</div>`
        }
        ${openMenu ? `<div class="handoff-actions">${openMenu}</div>` : ''}
      </div>
    </div>`;
  }

  function flashCopied(btn) {
    if (!btn || !btn.classList) return;
    const prev = btn.getAttribute('data-label-orig') || btn.textContent;
    if (!btn.getAttribute('data-label-orig')) btn.setAttribute('data-label-orig', prev);
    btn.classList.add('copied');
    if (btn.tagName === 'BUTTON' && !btn.classList.contains('handoff-path')) {
      btn.textContent = '已复制';
    }
    clearTimeout(btn._copyFlash);
    btn._copyFlash = setTimeout(() => {
      btn.classList.remove('copied');
      if (btn.tagName === 'BUTTON' && !btn.classList.contains('handoff-path')) {
        btn.textContent = btn.getAttribute('data-label-orig') || prev;
      }
    }, 1400);
  }

  /** copyText：okMsg 为 null 时静默（open-agent 会另发 toast） */
  async function copyTextQuiet(text) {
    const p = String(text || '');
    if (!p) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(p);
      } else {
        const ta = document.createElement('textarea');
        ta.value = p;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { accept: 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { ok: false, message: text || res.statusText };
    }
    if (!res.ok && data && data.ok !== false) {
      data = { ok: false, message: data.message || res.statusText, ...data };
    }
    return data;
  }

  function setNav(active) {
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const on = a.getAttribute('data-nav') === active;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function setHeader(title, desc = '') {
    if (pageTitle) pageTitle.textContent = title || '';
    if (pageDesc) {
      const text = String(desc || '').trim();
      pageDesc.textContent = text;
      if (text) pageDesc.removeAttribute('hidden');
      else pageDesc.setAttribute('hidden', '');
    }
    document.title = title ? `${title} · RPA Workbench` : 'RPA Workbench';
  }

  function firstRunTipHtml() {
    try {
      if (localStorage.getItem('rpa_wb_tip_dismissed') === '1') return '';
    } catch {
      // ignore
    }
    return `<div class="tip" id="first-run-tip" role="note">
      <p>打开应用 → <strong>在 Agent 打开</strong> → Chat 粘贴（Ctrl+V）。</p>
      <button type="button" class="btn sm" id="btn-dismiss-tip">知道了</button>
    </div>`;
  }

  function bindFirstRunTip() {
    const btn = $('#btn-dismiss-tip');
    if (!btn) return;
    btn.onclick = () => {
      try {
        localStorage.setItem('rpa_wb_tip_dismissed', '1');
      } catch {
        // ignore
      }
      const tip = $('#first-run-tip');
      if (tip) tip.remove();
    };
  }

  function showHelpTip() {
    try {
      localStorage.removeItem('rpa_wb_tip_dismissed');
    } catch {
      // ignore
    }
    if (location.hash !== '#/' && location.hash !== '' && location.hash !== '#') {
      location.hash = '#/';
      return;
    }
    // already on home — re-render to show tip
    renderHome();
  }

  function focusActiveTab(tab) {
    const id =
      tab === 'flow'
        ? 'tab-flow'
        : tab === 'impl'
          ? 'tab-impl'
          : tab === 'failures'
            ? 'tab-failures'
            : 'tab-overview';
    const el = document.getElementById(id);
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }

  /** 应用详情顶栏 tab：overview | flow | impl | failures */
  function normalizeAppTab(tab) {
    if (tab === 'flow' || tab === 'impl' || tab === 'failures') return tab;
    // 旧链接 /structure 等落到实现
    if (tab === 'structure' || tab === 'callgraph' || tab === 'graph') return 'impl';
    return 'overview';
  }

  /**
   * 失败列表右侧：仅状态 badge（整行是链接，不再单独「详情」按钮）
   */
  function failureSideHtml(f) {
    const canPreview = f.canPreviewFix === true;
    const fixLabel = f.guidance?.title || f.fixClass || '';
    return `<div class="item-side">
      <div class="badges">
        ${f.diagnosed ? '<span class="badge ok">已诊断</span>' : '<span class="badge warn">未诊断</span>'}
        ${fixLabel ? `<span class="badge">${esc(fixLabel)}</span>` : ''}
        ${
          canPreview
            ? '<span class="badge ok">可预览修</span>'
            : f.fixability === 'manual'
              ? '<span class="badge">需人工</span>'
              : ''
        }
        ${f.occurrenceCount ? `<span class="badge">${esc(f.occurrenceCount)} 次</span>` : ''}
      </div>
    </div>`;
  }

  /** 失败条目整行可点进详情 */
  function failureRowHtml(f, opts = {}) {
    const fp = f.fingerprint || '';
    const href = `#/findings/${encodeURIComponent(fp)}`;
    const subExtra = opts.extraSub || '';
    return `<a class="list-item" href="${href}">
      <div class="item-main">
        <div class="item-title mono">${esc(fp)}</div>
        ${subExtra}
      </div>
      ${failureSideHtml(f)}
    </a>`;
  }

  function renderGuidanceBlock(g) {
    if (!g) return '';
    const steps = (g.steps || [])
      .map((s, i) => `<li>${esc(i + 1)}. ${esc(s)}</li>`)
      .join('');
    return `<div class="panel guidance-panel">
      <h2>修复建议 · ${esc(g.title || '')}</h2>
      ${g.summary ? `<p class="summary-line" style="margin-bottom:12px">${esc(g.summary)}</p>` : ''}
      ${steps ? `<ul class="plain-list">${steps}</ul>` : ''}
    </div>`;
  }

  function bindCopyButtons(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-copy]').forEach((btn) => {
      if (btn._copyBound) return;
      btn._copyBound = true;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const msg = btn.getAttribute('data-copy-msg') || '已复制';
        const ok = await copyText(btn.getAttribute('data-copy'), msg);
        if (ok) flashCopied(btn);
      });
    });
  }

  function bindActionButtons(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-action]').forEach((btn) => {
      if (btn._actBound) return;
      btn._actBound = true;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const fp = btn.getAttribute('data-fp');
        if (!action || !fp) return;
        await runFindingAction(action, fp, btn);
      });
    });
  }

  async function runFindingAction(action, fingerprint, btn) {
    const label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.classList.add('busy');
      btn.textContent =
        action === 'diagnose' ? (label && label.includes('重新') ? '重新诊断中…' : '诊断中…') : '生成中…';
    }
    try {
      const path =
        action === 'diagnose'
          ? `/api/findings/${encodeURIComponent(fingerprint)}/diagnose`
          : `/api/findings/${encodeURIComponent(fingerprint)}/fix-dry-run`;
      const r = await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 不传 useLlm → 服务端按 diagnoseUseLlm / settings；fix 仅 dry-run
        body: JSON.stringify({ force: action === 'fix-dry-run' }),
      });
      if (r.ok) {
        if (action === 'diagnose') {
          const d = r.result && r.result.diagnosis;
          toast(d && d.rootCause ? `诊断完成：${String(d.rootCause).slice(0, 60)}` : '诊断完成');
        } else {
          const p = r.result && r.result.patch;
          const pid = p && (p.patchId || p.id);
          toast(pid ? `已生成预览 ${pid}` : r.result?.message || '预览已生成（未写盘）');
        }
        const next = `#/findings/${encodeURIComponent(fingerprint)}`;
        if (location.hash === next) await route();
        else location.hash = next;
      } else {
        // workbench 包装：真实原因在 result.message / guidance
        const inner = r.result || {};
        const g = r.guidance || inner.guidance;
        const msg =
          (g && g.summary) ||
          r.message ||
          inner.message ||
          (inner.code ? `${inner.code}` : null) ||
          r.code ||
          '操作失败';
        toast(msg);
        // 不可预览时跳转详情看完整建议
        if (r.code === 'not_previewable' || inner.code === 'not_previewable' || g) {
          const next = `#/findings/${encodeURIComponent(fingerprint)}`;
          if (location.hash === next) await route();
          else location.hash = next;
        }
      }
    } catch (err) {
      toast(err.message || '请求失败');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('busy');
        btn.textContent = label;
      }
    }
  }

  function parseRoute() {
    const raw = (location.hash || '#/').replace(/^#/, '') || '/';
    const parts = raw.split('/').filter(Boolean);
    if (!parts.length) return { name: 'home' };
    if (parts[0] === 'findings' && parts[1]) {
      return { name: 'finding', fingerprint: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === 'reports' && parts[1]) {
      return { name: 'report', date: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === 'reports') return { name: 'reports' };
    if (parts[0] === 'apps' && parts[1]) {
      return {
        name: 'app',
        robotUuid: decodeURIComponent(parts[1]),
        tab: parts[2] || 'overview',
      };
    }
    if (parts[0] === 'apps') return { name: 'apps' };
    if (parts[0] === 'settings') {
      const tab = parts[1] === 'prompts' || parts[1] === 'brief' ? 'prompts' : 'llm';
      return { name: 'settings', tab };
    }
    return { name: 'home' };
  }

  async function renderSettings(tabHint) {
    const route = parseRoute();
    const tab = tabHint === 'prompts' || tabHint === 'llm'
      ? tabHint
      : route.name === 'settings' && route.tab
        ? route.tab
        : 'llm';

    setNav('settings');
    setHeader('设置');
    activeCopyPath = '';
    activeAgentPrompt = '';
    content.innerHTML = loadingHtml('加载设置…');

    const [data, briefCfg] = await Promise.all([
      api('/api/settings/llm'),
      api('/api/settings/business-brief'),
    ]);
    if (!data || data.ok === false) {
      content.innerHTML = `<div class="err">加载失败：${esc(data && (data.message || data.code))}</div>`;
      return;
    }

    const locked = data.envLocked || {};
    const ro = data.settingsEnabled === false;
    const briefRo = ro || (briefCfg && briefCfg.settingsEnabled === false);
    const lockHint = (field) =>
      locked[field]
        ? `<span class="field-lock">环境变量锁定</span>`
        : '';

    const systemVal = (briefCfg && briefCfg.systemPrompt) || '';
    const userVal = (briefCfg && briefCfg.userPromptTemplate) || '';
    const tempVal = briefCfg && briefCfg.temperature != null ? briefCfg.temperature : 0.3;
    const maxTokVal = briefCfg && briefCfg.maxTokens != null ? briefCfg.maxTokens : 1800;

    content.innerHTML = `
      <div class="tabs settings-tabs" role="tablist" aria-label="设置分区">
        <button type="button" role="tab" class="tab ${tab === 'llm' ? 'active' : ''}"
          data-settings-tab="llm" aria-selected="${tab === 'llm'}">LLM 连接</button>
        <button type="button" role="tab" class="tab ${tab === 'prompts' ? 'active' : ''}"
          data-settings-tab="prompts" aria-selected="${tab === 'prompts'}">业务解读提示词</button>
      </div>

      <div id="settings-pane-llm" class="settings-pane ${tab === 'llm' ? 'is-active' : ''}" role="tabpanel" ${
        tab === 'llm' ? '' : 'hidden'
      }>
        <div class="panel settings-panel">
          <p class="meta mb">
            来源 <code>${esc(data.source || 'none')}</code>
            · ${data.apiKeyConfigured ? '已配置 Key' : '未配置 Key'}
            ${data.updatedAt ? `· ${esc(formatTime(data.updatedAt))}` : ''}
          </p>
          ${
            ro
              ? `<div class="tip mb">settingsEnabled=false，当前只读。</div>`
              : ''
          }
          <form id="llm-form" class="settings-form" autocomplete="off">
            <label class="field">
              <span class="field-label">Base URL ${lockHint('baseUrl')}</span>
              <input name="baseUrl" type="url" class="field-input" value="${esc(data.baseUrl || '')}"
                placeholder="https://api.openai.com/v1" ${ro || locked.baseUrl ? 'readonly' : ''} />
            </label>
            <label class="field">
              <span class="field-label">API Key ${lockHint('apiKey')}</span>
              <input name="apiKey" type="password" class="field-input" value=""
                placeholder="${esc(data.apiKeyMasked ? `已保存 ${data.apiKeyMasked} · 留空不修改` : 'sk-…')}"
                ${ro || locked.apiKey ? 'readonly' : ''} />
            </label>
            <label class="field">
              <span class="field-label">Model ${lockHint('model')}</span>
              <input name="model" type="text" class="field-input" value="${esc(data.model || '')}"
                placeholder="gpt-4o-mini" ${ro || locked.model ? 'readonly' : ''} />
            </label>
            <label class="field">
              <span class="field-label">API 风格 ${lockHint('apiStyle')}</span>
              <select name="apiStyle" class="field-input" ${ro || locked.apiStyle ? 'disabled' : ''}>
                <option value="openai" ${data.apiStyle === 'openai' || !data.apiStyle ? 'selected' : ''}>openai（兼容）</option>
                <option value="anthropic" ${data.apiStyle === 'anthropic' ? 'selected' : ''}>anthropic</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">超时 ms ${lockHint('timeoutMs')}</span>
              <input name="timeoutMs" type="number" min="1000" step="1000" class="field-input"
                value="${esc(data.timeoutMs || 600000)}" ${ro || locked.timeoutMs ? 'readonly' : ''} />
            </label>
            <label class="field field-check">
              <input name="diagnoseUseLlm" type="checkbox" ${data.diagnoseUseLlm !== false ? 'checked' : ''} ${ro ? 'disabled' : ''} />
              <span>诊断使用 LLM</span>
            </label>
            <div class="settings-actions">
              <button type="submit" class="btn primary" id="btn-llm-save" ${ro ? 'disabled' : ''}>保存</button>
              <button type="button" class="btn" id="btn-llm-test" ${ro ? 'disabled' : ''}>测试连接</button>
              <button type="button" class="btn ghost" id="btn-llm-clear-key" ${ro || locked.apiKey ? 'disabled' : ''}>清除 Key</button>
            </div>
            <p id="llm-test-result" class="meta mt" role="status"></p>
          </form>
        </div>
      </div>

      <div id="settings-pane-prompts" class="settings-pane ${tab === 'prompts' ? 'is-active' : ''}" role="tabpanel" ${
        tab === 'prompts' ? '' : 'hidden'
      }>
        <div class="panel settings-panel">
          <p class="meta mb">
            ${briefCfg && briefCfg.customized ? '已自定义' : '内置默认'}
            ${briefCfg && briefCfg.updatedAt ? `· ${esc(formatTime(briefCfg.updatedAt))}` : ''}
          </p>
          <form id="brief-prompt-form" class="settings-form">
            <label class="field">
              <span class="field-label">System prompt</span>
              <textarea name="systemPrompt" class="field-input field-textarea" rows="10" ${briefRo ? 'readonly' : ''}>${esc(systemVal)}</textarea>
            </label>
            <label class="field">
              <span class="field-label">User prompt 模板（需含 {{digest}}）</span>
              <textarea name="userPromptTemplate" class="field-input field-textarea" rows="14" ${briefRo ? 'readonly' : ''} placeholder="须包含 {{digest}} 或 {{material}}">${esc(userVal)}</textarea>
            </label>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">temperature</span>
                <input name="temperature" type="number" min="0" max="2" step="0.1" class="field-input"
                  value="${esc(tempVal)}" ${briefRo ? 'readonly' : ''} />
              </label>
              <label class="field">
                <span class="field-label">maxTokens</span>
                <input name="maxTokens" type="number" min="256" max="8000" step="100" class="field-input"
                  value="${esc(maxTokVal)}" ${briefRo ? 'readonly' : ''} />
              </label>
            </div>
            <div class="settings-actions">
              <button type="submit" class="btn primary" ${briefRo ? 'disabled' : ''}>保存提示词</button>
              <button type="button" class="btn ghost" id="btn-brief-prompt-reset" ${briefRo ? 'disabled' : ''}>恢复默认</button>
            </div>
          </form>
        </div>
      </div>`;

    // 切换 Tab：改 hash，避免整页堆叠
    content.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-settings-tab') || 'llm';
        const hash = next === 'prompts' ? '#/settings/prompts' : '#/settings/llm';
        if (location.hash === hash) {
          // 同 hash 时手动切换显示
          switchSettingsTab(next);
        } else {
          location.hash = hash;
        }
      });
    });

    function switchSettingsTab(next) {
      content.querySelectorAll('[data-settings-tab]').forEach((b) => {
        const on = b.getAttribute('data-settings-tab') === next;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const llmPane = $('#settings-pane-llm');
      const promptPane = $('#settings-pane-prompts');
      if (llmPane) {
        llmPane.classList.toggle('is-active', next === 'llm');
        if (next === 'llm') llmPane.removeAttribute('hidden');
        else llmPane.setAttribute('hidden', '');
      }
      if (promptPane) {
        promptPane.classList.toggle('is-active', next === 'prompts');
        if (next === 'prompts') promptPane.removeAttribute('hidden');
        else promptPane.setAttribute('hidden', '');
      }
      setHeader('设置');
    }

    const form = $('#llm-form');
    const resultEl = $('#llm-test-result');

    function formBody({ clearKey = false } = {}) {
      if (!form) return {};
      const fd = new FormData(form);
      const body = {
        baseUrl: String(fd.get('baseUrl') || '').trim(),
        model: String(fd.get('model') || '').trim(),
        apiStyle: String(fd.get('apiStyle') || 'openai'),
        timeoutMs: parseInt(String(fd.get('timeoutMs') || '600000'), 10) || 600000,
        diagnoseUseLlm: form.querySelector('[name=diagnoseUseLlm]')?.checked !== false,
      };
      const key = String(fd.get('apiKey') || '');
      if (clearKey) body.apiKey = '__CLEAR__';
      else if (key.trim()) body.apiKey = key.trim();
      return body;
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (ro) return;
        const btn = $('#btn-llm-save');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '保存中…';
        }
        try {
          const r = await api('/api/settings/llm', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(formBody()),
          });
          if (r && r.ok) {
            toast('LLM 设置已保存');
            await renderSettings('llm');
          } else {
            toast(r.message || r.code || '保存失败');
          }
        } catch (err) {
          toast(err.message || '保存失败');
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = '保存';
          }
        }
      });
    }

    const testBtn = $('#btn-llm-test');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        testBtn.textContent = '测试中…';
        if (resultEl) resultEl.textContent = '';
        try {
          const r = await api('/api/settings/llm/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(formBody()),
          });
          if (r && r.ok) {
            const msg = `连接成功 · ${r.latencyMs}ms · ${r.model || ''}${r.message ? ` · ${r.message}` : ''}`;
            if (resultEl) resultEl.textContent = msg;
            toast('LLM 连接成功');
          } else {
            const msg = r.message || r.code || '测试失败';
            if (resultEl) resultEl.textContent = msg;
            toast(msg);
          }
        } catch (err) {
          if (resultEl) resultEl.textContent = err.message || '测试失败';
          toast(err.message || '测试失败');
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = '测试连接';
        }
      });
    }

    const clearBtn = $('#btn-llm-clear-key');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('确定清除已保存的 API Key？')) return;
        try {
          const r = await api('/api/settings/llm', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(formBody({ clearKey: true })),
          });
          if (r && r.ok) {
            toast('API Key 已清除');
            await renderSettings('llm');
          } else toast(r.message || '清除失败');
        } catch (err) {
          toast(err.message || '清除失败');
        }
      });
    }

    const briefForm = $('#brief-prompt-form');
    if (briefForm) {
      briefForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (briefRo) return;
        const fd = new FormData(briefForm);
        const body = {
          systemPrompt: String(fd.get('systemPrompt') || ''),
          userPromptTemplate: String(fd.get('userPromptTemplate') || ''),
          temperature: parseFloat(String(fd.get('temperature') || '0.3')),
          maxTokens: parseInt(String(fd.get('maxTokens') || '1800'), 10),
        };
        try {
          const r = await api('/api/settings/business-brief', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (r && r.ok) {
            toast('业务解读提示词已保存');
            await renderSettings('prompts');
          } else toast(r.message || r.code || '保存失败');
        } catch (err) {
          toast(err.message || '保存失败');
        }
      });
    }
    const resetBrief = $('#btn-brief-prompt-reset');
    if (resetBrief) {
      resetBrief.addEventListener('click', async () => {
        if (!confirm('恢复内置默认提示词？将删除 data/settings.business-brief.json')) return;
        try {
          const r = await api('/api/settings/business-brief/reset', { method: 'POST' });
          if (r && r.ok) {
            toast('已恢复默认提示词');
            await renderSettings('prompts');
          } else toast(r.message || '恢复失败');
        } catch (err) {
          toast(err.message || '恢复失败');
        }
      });
    }
  }

  /** 极简 Markdown → HTML（日报足够；不做完整 CommonMark） */
  function renderMarkdown(md) {
    const escHtml = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const inline = (s) => {
      let t = escHtml(s);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(
        /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      );
      return t;
    };
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;
    let inPre = false;
    let preBuf = [];

    const closeLists = () => {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        if (inPre) {
          out.push(`<pre class="md-pre"><code>${escHtml(preBuf.join('\n'))}</code></pre>`);
          preBuf = [];
          inPre = false;
        } else {
          closeLists();
          inPre = true;
        }
        continue;
      }
      if (inPre) {
        preBuf.push(line);
        continue;
      }
      if (!line.trim()) {
        closeLists();
        continue;
      }
      if (/^###\s+/.test(line)) {
        closeLists();
        out.push(`<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`);
        continue;
      }
      if (/^##\s+/.test(line)) {
        closeLists();
        out.push(`<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`);
        continue;
      }
      if (/^#\s+/.test(line)) {
        closeLists();
        out.push(`<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`);
        continue;
      }
      if (/^>\s?/.test(line)) {
        closeLists();
        out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        if (inOl) {
          out.push('</ol>');
          inOl = false;
        }
        if (!inUl) {
          out.push('<ul>');
          inUl = true;
        }
        out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
        continue;
      }
      if (/^\d+\.\s+/.test(line)) {
        if (inUl) {
          out.push('</ul>');
          inUl = false;
        }
        if (!inOl) {
          out.push('<ol>');
          inOl = true;
        }
        out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`);
        continue;
      }
      if (/^---+$/.test(line.trim()) || /^--+$/.test(line.trim())) {
        closeLists();
        out.push('<hr />');
        continue;
      }
      closeLists();
      // 日报习惯行：■ 1. ...
      if (/^■\s+/.test(line) || /^_{1}.+_{1}$/.test(line.trim())) {
        out.push(`<p class="md-item">${inline(line)}</p>`);
      } else {
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeLists();
    if (inPre) {
      out.push(`<pre class="md-pre"><code>${escHtml(preBuf.join('\n'))}</code></pre>`);
    }
    return out.join('\n');
  }

  async function renderReports() {
    setNav('reports');
    setHeader('日报');
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载日报列表…');

    const data = await api('/api/reports');
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>`;
      return;
    }
    const list = data.reports || [];
    content.innerHTML = `
      <div class="actions mb">
        <button type="button" class="btn primary" id="btn-gen-report">生成今日日报</button>
      </div>
      <div class="panel">
        <h2>历史日报 <span class="meta">${list.length}</span></h2>
        ${
          list.length
            ? `<div class="list">${list
                .map(
                  (r) => `<a class="list-item" href="#/reports/${encodeURIComponent(r.date)}">
                    <div class="item-main">
                      <div class="item-title">${esc(r.date)}</div>
                      <div class="item-sub">${esc(r.mtime || '')} · ${esc(r.size || 0)} bytes</div>
                    </div>
                    <div class="item-side"><span class="faint" style="font-size:12px">查看 →</span></div>
                  </a>`,
                )
                .join('')}</div>`
            : empty('还没有日报', '点上方「生成今日日报」')
        }
      </div>
    `;
    const gen = $('#btn-gen-report');
    if (gen) {
      gen.onclick = async () => {
        gen.disabled = true;
        gen.textContent = '生成中…';
        try {
          const r = await api('/api/reports/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (r.ok) {
            toast(`已生成 ${r.date}`);
            location.hash = `#/reports/${encodeURIComponent(r.date)}`;
          } else {
            toast(r.message || r.code || '生成失败');
            gen.disabled = false;
            gen.textContent = '生成今日日报';
          }
        } catch (e) {
          toast(e.message || '生成失败');
          gen.disabled = false;
          gen.textContent = '生成今日日报';
        }
      };
    }
  }

  async function renderReport(date) {
    setNav('reports');
    setHeader(`日报 ${date}`);
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载日报…');

    const data = await api(`/api/reports/${encodeURIComponent(date)}`);
    if (!data.ok) {
      content.innerHTML = `
        <div class="err">${esc(data.message || data.code)}</div>
        <div class="actions mt">
          <button type="button" class="btn primary" id="btn-gen-this">生成该日日报</button>
          <a class="btn ghost" href="#/reports">返回列表</a>
        </div>`;
      const b = $('#btn-gen-this');
      if (b) {
        b.onclick = async () => {
          b.disabled = true;
          const r = await api('/api/reports/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ date }),
          });
          if (r.ok) {
            toast('已生成');
            await renderReport(date);
          } else {
            toast(r.message || '失败');
            b.disabled = false;
          }
        };
      }
      return;
    }

    const agentWrap = [
      `以下是 ${date} 的 RPA 诊断日报，请据此优先排查失败应用；需要改代码时先让我提供 xbot_robot 路径。`,
      '',
      data.markdown || '',
    ].join('\n');
    setActiveHandoff({ agentPrompt: agentWrap });

    content.innerHTML = `
      <div class="crumb"><a href="#/reports">日报</a> / ${esc(date)}</div>
      <div class="actions mb">
        <button type="button" class="btn primary" id="btn-copy-agent-md">复制全文</button>
        <button type="button" class="btn ghost" id="btn-regen">重新生成</button>
      </div>
      <article class="panel report-md">${renderMarkdown(data.markdown)}</article>
    `;
    const regen = $('#btn-regen');
    if (regen) {
      regen.onclick = async () => {
        regen.disabled = true;
        regen.textContent = '生成中…';
        const r = await api('/api/reports/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ date }),
        });
        if (r.ok) {
          toast('已重新生成');
          await renderReport(date);
        } else {
          toast(r.message || '失败');
          regen.disabled = false;
          regen.textContent = '重新生成';
        }
      };
    }
    const copyAgent = $('#btn-copy-agent-md');
    if (copyAgent) {
      copyAgent.onclick = async () => {
        const ok = await copyText(agentWrap, '日报已复制');
        if (ok) flashCopied(copyAgent);
      };
    }
  }

  async function refreshRuntime() {
    try {
      const h = await api('/health');
      if (h && h.ok) {
        const und = h.undiagnosed ?? 0;
        rtPill.textContent = und > 0 ? `运行中 · ${und} 未诊断` : '运行中';
        rtPill.className = 'status ok';
        if (rtDetail) {
          rtDetail.textContent = [
            `pid ${h.pid}`,
            `queue ${h.queueDepth ?? 0}`,
            h.lastPollAt ? `poll ${relTime(h.lastPollAt)}` : 'poll —',
          ].join('\n');
        }
      } else {
        rtPill.textContent = '服务异常';
        rtPill.className = 'status err';
      }
    } catch {
      rtPill.textContent = '无法连接';
      rtPill.className = 'status err';
      if (rtDetail) rtDetail.textContent = '请确认 service 已启动';
    }
  }

  async function copyText(text, okMsg) {
    const p = String(text || '');
    if (!p) {
      toast('无内容可复制');
      return false;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(p);
      } else {
        const ta = document.createElement('textarea');
        ta.value = p;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (okMsg !== null) toast(okMsg || '已复制');
      return true;
    } catch {
      toast('复制失败，请手动选择路径');
      return false;
    }
  }

  function empty(title, body = '', ctaHtml = '') {
    return `<div class="empty"><strong>${esc(title)}</strong>${
      body ? `<p>${esc(body)}</p>` : ''
    }${ctaHtml ? `<div class="empty-cta">${ctaHtml}</div>` : ''}</div>`;
  }

  function renderStages(stages) {
    if (!stages?.length) return '<div class="muted">无阶段信息</div>';
    return stages
      .map((s) => {
        if (typeof s === 'string') return `<div class="stage"><div class="t">${esc(s)}</div></div>`;
        if (Array.isArray(s.stages)) {
          const flow = s.flow || s.name || '流程';
          const items = s.stages
            .map((x) => esc(typeof x === 'string' ? x : x.name || JSON.stringify(x)))
            .join(' → ');
          return `<div class="stage"><div class="t">${esc(flow)}</div><div class="d">${items}</div></div>`;
        }
        const title = s.name || s.title || s.flow || '阶段';
        const desc = s.description || s.summary || '';
        return `<div class="stage"><div class="t">${esc(title)}</div>${
          desc ? `<div class="d">${esc(desc)}</div>` : ''
        }</div>`;
      })
      .join('');
  }

  function formatFlowRole(x) {
    if (typeof x === 'string') return x;
    const name = x.name || x.filename || '流程';
    const role = x.role || x.kind || '';
    const blocks = x.blockCount != null ? `${x.blockCount} 块` : '';
    return [name, role, blocks].filter(Boolean).join(' · ');
  }

  function extractMermaidSource(mg) {
    if (!mg) return '';
    if (mg.body?.trim()) return String(mg.body).trim();
    let src = String(mg.mermaid || '').trim();
    if (!src) return '';
    const m = src.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
    return m ? m[1].trim() : src;
  }

  /**
   * @param {HTMLElement} container
   * @param {string} source
   * @param {{ compact?: boolean, scale?: number, imgClass?: string }} [opts]
   *   compact: 业务图用更小间距 + 限宽，避免撑满一屏
   */
  async function renderMermaidInto(container, source, opts = {}) {
    if (!container || !source) return null;
    if (typeof mermaid === 'undefined') {
      container.innerHTML = `<div class="muted">未加载 Mermaid 库（需要访问 CDN）</div>
        <div class="pre mt">${esc(source)}</div>`;
      return null;
    }
    const compact = !!opts.compact;
    try {
      // htmlLabels:false → 原生 SVG 文字，栅格化后不易截断/空白
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        flowchart: {
          htmlLabels: false,
          curve: compact ? 'linear' : 'basis',
          // 业务图限宽 + 中等纵向间距（比调用图紧，比过小版略松）
          useMaxWidth: compact,
          padding: compact ? 10 : 16,
          nodeSpacing: compact ? 26 : 50,
          rankSpacing: compact ? 32 : 50,
        },
      });
      const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const { svg } = await mermaid.render(id, source);
      const scale = opts.scale != null ? opts.scale : compact ? 1.5 : 2;
      const pngUrl = await svgMarkupToPngDataUrl(svg, scale);
      const imgClass = opts.imgClass || (compact ? 'graph-img graph-img-biz' : 'graph-img');
      if (!pngUrl) {
        // 栅格失败时仍展示 SVG，避免整页空白
        container.innerHTML = svg;
        container.dataset.graphPng = '';
        return null;
      }
      container.innerHTML = `<img class="${imgClass}" src="${pngUrl}" alt="流程图" draggable="false" />`;
      container.dataset.graphPng = pngUrl;
      return pngUrl;
    } catch (e) {
      container.innerHTML = `<div class="err">流程图渲染失败：${esc(e.message || e)}</div>
        <div class="pre mt">${esc(source)}</div>`;
      container.dataset.graphPng = '';
      return null;
    }
  }

  /**
   * Mermaid SVG 字符串 → PNG data URL（高清 2x）
   * @param {string} svgMarkup
   * @param {number} [scale]
   * @returns {Promise<string|null>}
   */
  function svgMarkupToPngDataUrl(svgMarkup, scale = 2) {
    return new Promise((resolve) => {
      try {
        let markup = String(svgMarkup || '').trim();
        if (!markup) {
          resolve(null);
          return;
        }
        // 保证命名空间，否则 Image 解码可能失败
        if (!/xmlns\s*=/.test(markup)) {
          markup = markup.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        }
        if (!/xmlns:xlink/.test(markup) && /xlink:/.test(markup)) {
          markup = markup.replace(
            /<svg\b/i,
            '<svg xmlns:xlink="http://www.w3.org/1999/xlink"',
          );
        }

        // 解析宽高
        let w = 0;
        let h = 0;
        const vb = markup.match(/viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i);
        if (vb) {
          w = parseFloat(vb[3]);
          h = parseFloat(vb[4]);
        }
        if (!(w > 0 && h > 0)) {
          const wm = markup.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i);
          const hm = markup.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i);
          if (wm && hm) {
            w = parseFloat(wm[1]);
            h = parseFloat(hm[1]);
          }
        }
        if (!(w > 0 && h > 0)) {
          w = 1200;
          h = 800;
        }
        // 写死像素宽高，避免 100% 导致 canvas 尺寸为 0
        markup = markup
          .replace(/\swidth\s*=\s*["'][^"']*["']/i, '')
          .replace(/\sheight\s*=\s*["'][^"']*["']/i, '')
          .replace(
            /<svg\b/i,
            `<svg width="${w}" height="${h}"`,
          );

        const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          try {
            const cw = Math.max(1, Math.ceil(w * scale));
            const ch = Math.max(1, Math.ceil(h * scale));
            // 过大保护（约 32MP）
            const maxPx = 16000000;
            let s = scale;
            if (cw * ch > maxPx) {
              s = Math.sqrt(maxPx / (w * h));
            }
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.ceil(w * s));
            canvas.height = Math.max(1, Math.ceil(h * s));
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              URL.revokeObjectURL(url);
              resolve(null);
              return;
            }
            ctx.fillStyle = '#faf9f7';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(s, 0, 0, s, 0, 0);
            ctx.drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/png');
            URL.revokeObjectURL(url);
            resolve(dataUrl);
          } catch {
            URL.revokeObjectURL(url);
            resolve(null);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(null);
        };
        img.src = url;
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 全屏查看 PNG + 放大缩小（只缩放图片像素，不重排节点）
   * @param {string|null} pngUrl
   * @param {string} [title]
   */
  function openGraphFullscreen(pngUrl, title = '流程图') {
    closeGraphFullscreen();
    if (!pngUrl) {
      toast('流程图图片尚未生成');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'graph-fs';
    overlay.className = 'graph-fs';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = `
      <div class="graph-fs-panel">
        <div class="graph-fs-bar">
          <div class="graph-fs-title">${esc(title)}</div>
          <div class="actions graph-fs-tools">
            <button type="button" class="btn sm" data-fs-zoom="out" title="缩小">−</button>
            <span class="graph-fs-zoom-label" data-fs-zoom-label>100%</span>
            <button type="button" class="btn sm" data-fs-zoom="in" title="放大">+</button>
            <button type="button" class="btn sm ghost" data-fs-zoom="fit" title="适应窗口">适应</button>
            <button type="button" class="btn sm ghost" data-fs-zoom="reset" title="原始大小">1:1</button>
            <a class="btn sm ghost" href="${pngUrl}" download="flowchart.png">下载</a>
            <button type="button" class="btn sm" data-graph-fs-close>关闭</button>
          </div>
        </div>
        <div class="graph-fs-body" data-fs-body>
          <div class="graph-fs-host" id="graph-fs-host">
            <img class="graph-fs-img" data-fs-img src="${pngUrl}" alt="${esc(title)}" draggable="false" />
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add('graph-fs-open');

    const body = overlay.querySelector('[data-fs-body]');
    const img = overlay.querySelector('[data-fs-img]');
    const label = overlay.querySelector('[data-fs-zoom-label]');
    let scale = 1;
    let natW = 0;
    let natH = 0;
    const MIN = 0.25;
    const MAX = 6;
    const STEP = 0.25;

    function applyScale() {
      if (!natW || !natH) return;
      const w = Math.max(1, Math.round(natW * scale));
      const h = Math.max(1, Math.round(natH * scale));
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      if (label) label.textContent = `${Math.round(scale * 100)}%`;
    }

    function zoomTo(next, anchorX, anchorY) {
      const prev = scale;
      scale = Math.min(MAX, Math.max(MIN, +next.toFixed(3)));
      if (scale === prev || !body) {
        applyScale();
        return;
      }
      // 以视口中心或指针为锚，缩放后尽量保持该点不动
      const rect = body.getBoundingClientRect();
      const px = anchorX != null ? anchorX - rect.left : rect.width / 2;
      const py = anchorY != null ? anchorY - rect.top : rect.height / 2;
      const contentX = (body.scrollLeft + px) / prev;
      const contentY = (body.scrollTop + py) / prev;
      applyScale();
      body.scrollLeft = contentX * scale - px;
      body.scrollTop = contentY * scale - py;
    }

    function zoomBy(delta, ax, ay) {
      zoomTo(scale + delta, ax, ay);
    }

    function fit() {
      if (!natW || !body) return;
      const pad = 32;
      const availW = Math.max(body.clientWidth - pad, 80);
      const availH = Math.max(body.clientHeight - pad, 80);
      const s = Math.min(availW / natW, availH / natH, 1);
      scale = Math.min(MAX, Math.max(MIN, s));
      applyScale();
      // 居中
      body.scrollLeft = Math.max(0, (natW * scale - body.clientWidth) / 2);
      body.scrollTop = Math.max(0, (natH * scale - body.clientHeight) / 2);
    }

    function reset() {
      scale = 1;
      applyScale();
      if (body) {
        body.scrollLeft = 0;
        body.scrollTop = 0;
      }
    }

    function onReady() {
      natW = img.naturalWidth || img.width || 800;
      natH = img.naturalHeight || img.height || 600;
      // 默认 1:1，方便直接看清节点文字
      reset();
    }

    if (img.complete && img.naturalWidth) onReady();
    else img.onload = onReady;

    overlay.querySelectorAll('[data-fs-zoom]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const act = btn.getAttribute('data-fs-zoom');
        if (act === 'in') zoomBy(STEP);
        else if (act === 'out') zoomBy(-STEP);
        else if (act === 'fit') fit();
        else if (act === 'reset') reset();
      });
    });

    // Ctrl/⌘ + 滚轮缩放
    body.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          zoomBy(e.deltaY > 0 ? -STEP : STEP, e.clientX, e.clientY);
        }
      },
      { passive: false },
    );

    // 拖拽平移（按住空白/图片拖动滚动）
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, a')) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      body.classList.add('is-panning');
      try {
        body.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });
    body.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      body.scrollLeft -= e.clientX - lastX;
      body.scrollTop -= e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endPan = (e) => {
      if (!dragging) return;
      dragging = false;
      body.classList.remove('is-panning');
      try {
        body.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };
    body.addEventListener('pointerup', endPan);
    body.addEventListener('pointercancel', endPan);

    const close = () => closeGraphFullscreen();
    overlay.querySelector('[data-graph-fs-close]').onclick = close;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay._onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomBy(STEP);
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomBy(-STEP);
      }
      if (e.key === '0') {
        e.preventDefault();
        fit();
      }
    };
    window.addEventListener('keydown', overlay._onKey);
  }

  function closeGraphFullscreen() {
    const overlay = document.getElementById('graph-fs');
    if (!overlay) return;
    if (overlay._onKey) window.removeEventListener('keydown', overlay._onKey);
    overlay.remove();
    document.body.classList.remove('graph-fs-open');
  }

  function listBlock(title, items, mapper) {
    if (!items?.length) return '';
    return `<div class="panel">
      <h2>${esc(title)} <span class="meta">${items.length}</span></h2>
      <ul class="plain-list">${items.map((it) => `<li>${esc(mapper(it))}</li>`).join('')}</ul>
    </div>`;
  }

  // ── Home ──
  async function renderHome() {
    setNav('home');
    setHeader('总览');
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载总览…');

    const data = await api('/api/overview');
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>`;
      return;
    }

    const la = data.localApps || {};
    const q = data.queue || {};
    const problems = data.problemApps || [];
    const cross = data.crossAppGroups || [];
    const und = q.undiagnosed ?? 0;
    const recent = getRecentApps();

    if (la.usersRoot) setActiveHandoff({ path: la.usersRoot });

    content.innerHTML = `
      ${firstRunTipHtml()}
      <div class="metrics" aria-label="摘要">
        <div class="metric">
          <div class="label">本机应用</div>
          <div class="value">${esc(la.count ?? 0)}</div>
          <div class="hint">有失败 ${esc(problems.length)}</div>
        </div>
        <div class="metric">
          <div class="label">失败指纹</div>
          <div class="value">${esc(q.depth ?? 0)}</div>
          <div class="hint">未诊断 ${esc(und)}</div>
        </div>
        <div class="metric">
          <div class="label">跨应用根因</div>
          <div class="value">${esc(cross.length)}</div>
          <div class="hint">≥2 应用同特征</div>
        </div>
      </div>

      ${
        recent.length
          ? `<div class="panel mb">
        <h2>最近打开 <span class="meta">${recent.length}</span></h2>
        <div class="chip-row">
          ${recent
            .map(
              (r) =>
                `<a class="chip" href="#/apps/${encodeURIComponent(r.robotUuid)}">${esc(
                  r.name || r.robotUuid,
                )}</a>`,
            )
            .join('')}
        </div>
      </div>`
          : ''
      }

      ${
        cross.length
          ? `<div class="panel mb">
        <h2>跨应用根因 <span class="meta">${cross.length}</span></h2>
        <div class="list">${cross
          .map((g) => {
            // unknown-flow / no-flow 是指纹占位，不是真实流程名；不展示内部 errorSignature
            const flowLabel =
              g.flowName && !/^(unknown-flow|no-flow|调度层)$/i.test(String(g.flowName).trim())
                ? g.flowName
                : '';
            const title =
              g.rootCauseHint ||
              [flowLabel, g.errorType, g.elementName].filter(Boolean).join(' · ') ||
              String(g.errorSignature || '')
                .replace(/^unknown-flow\|/i, '')
                .replace(/^no-flow\|/i, '')
                .replace(/^调度层\|/i, '')
                .replace(/\|-/g, '')
                .replace(/\|/g, ' · ') ||
              '跨应用同类失败';
            const apps = (g.affectedApps || [])
              .map((a) => {
                const task = String(a.taskName || '').trim();
                const app = String(a.robotName || a.robotUuid || '').trim();
                if (task && app && task !== app) return `${task}（${app}）`;
                return task || app;
              })
              .map((s) => esc(s))
              .join('、');
            const sampleHref = g.sampleFingerprint
              ? `#/findings/${encodeURIComponent(g.sampleFingerprint)}`
              : '';
            return sampleHref
              ? `<a class="list-item" href="${sampleHref}">
              <div class="item-main">
                <div class="item-title">${esc(title)}</div>
                <div class="item-sub wrap">${esc(g.appCount)} 个 · ${apps}</div>
              </div>
              <div class="item-side">
                <div class="badges"><span class="badge danger">${esc(g.totalCount)} 条</span></div>
                <span class="item-go">样例 →</span>
              </div>
            </a>`
              : `<div class="list-item">
              <div class="item-main">
                <div class="item-title">${esc(title)}</div>
                <div class="item-sub wrap">${esc(g.appCount)} 个 · ${apps}</div>
              </div>
              <div class="item-side">
                <div class="badges"><span class="badge danger">${esc(g.totalCount)} 条</span></div>
              </div>
            </div>`;
          })
          .join('')}</div>
      </div>`
          : ''
      }

      <div class="panel">
        <h2>需要关注 <span class="meta">${problems.length}</span></h2>
        ${
          problems.length
            ? `<div class="list">${problems
                .map((p) => {
                  const href = `#/apps/${encodeURIComponent(p.robotUuid)}`;
                  const appName = String(p.robotName || p.robotUuid || '').trim();
                  const taskName = String(p.taskName || '').trim();
                  const title = taskName || appName;
                  const appLine =
                    taskName && appName && taskName !== appName ? `应用 · ${appName}` : '';
                  const time = p.lastSeen ? relTime(p.lastSeen) : '';
                  const sub = [appLine, time].filter(Boolean).join(' · ');
                  return `<a class="list-item" href="${href}">
                    <div class="item-main">
                      <div class="item-title">${esc(title)}</div>
                      ${sub ? `<div class="item-sub">${esc(sub)}</div>` : ''}
                    </div>
                    <div class="item-side">
                      <div class="badges">
                        <span class="badge danger">${esc(p.failureCount)} 失败</span>
                        ${
                          p.undiagnosedCount
                            ? `<span class="badge warn">${esc(p.undiagnosedCount)} 未诊断</span>`
                            : ''
                        }
                      </div>
                      <span class="item-go">打开 →</span>
                    </div>
                  </a>`;
                })
                .join('')}</div>`
            : empty(
                '暂无失败',
                '',
                '<a class="btn sm primary" href="#/apps">浏览全部应用</a>',
              )
        }
        <div class="actions mt">
          <a class="btn" href="#/apps">全部应用</a>
        </div>
      </div>
    `;

    bindFirstRunTip();
  }

  // ── Apps ──
  async function renderApps() {
    setNav('apps');
    setHeader('应用');
    setActiveHandoff();
    content.innerHTML = loadingHtml('扫描本机应用…');

    const data = await api('/api/apps');
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>`;
      return;
    }

    const apps = data.apps || [];
    const problemCount = apps.filter((a) => a.failureCount > 0).length;
    content.innerHTML = `
      <div class="search">
        <input type="search" id="app-filter" placeholder="搜索应用名、任务名、客户端或 UUID（按 / 聚焦）" autocomplete="off" aria-label="搜索应用" />
        <span class="count" id="app-count">${apps.length} · ${problemCount} 有失败</span>
      </div>
      <div class="panel">
        <div class="list" id="apps-list"></div>
      </div>
    `;

    const listEl = $('#apps-list');
    const filterEl = $('#app-filter');
    const countEl = $('#app-count');

    function appListMeta(a) {
      const bits = [];
      if (a.robotClientName) bits.push(String(a.robotClientName));
      if (a.remoteOnly) bits.push('仅云端');
      if (a.flowCount > 0) bits.push(`${a.flowCount} 流程`);
      if (a.version) bits.push(`v${a.version}`);
      if (a.lastErrorType) bits.push(String(a.lastErrorType));
      else if (a.lastFlowName && !/^(unknown-flow|no-flow)$/i.test(String(a.lastFlowName))) {
        bits.push(String(a.lastFlowName));
      }
      if (a.lastFailureAt) bits.push(`失败 ${relTime(a.lastFailureAt)}`);
      else if (a.packageMtime) bits.push(`更新 ${relTime(a.packageMtime)}`);
      return bits.join(' · ');
    }

    /**
     * 列表标题：优先调度任务名；与应用名不同时副标题显示应用名
     */
    function appListTitles(a) {
      const appName = String(a.name || a.robotUuid || '').trim();
      const task = String(a.taskName || '').trim();
      const extraTasks = Array.isArray(a.taskNames)
        ? a.taskNames.map((t) => String(t || '').trim()).filter((t) => t && t !== task && t !== appName)
        : [];
      if (task) {
        return {
          title: task,
          appLine: task !== appName ? appName : '',
          moreTasks: extraTasks.length ? `另 ${extraTasks.length} 个任务` : '',
        };
      }
      return { title: appName, appLine: '', moreTasks: '' };
    }

    function paint(filter = '') {
      const q = filter.trim().toLowerCase();
      const rows = apps.filter((a) => {
        if (!q) return true;
        const taskBits = [a.taskName, ...(Array.isArray(a.taskNames) ? a.taskNames : [])];
        return [
          a.name,
          a.description,
          a.robotUuid,
          a.xbotDir,
          a.userId,
          a.robotClientName,
          a.robotClientUuid,
          a.lastErrorType,
          a.lastFlowName,
          ...taskBits,
        ]
          .map((x) => String(x || '').toLowerCase())
          .some((s) => s.includes(q));
      });
      if (countEl) {
        countEl.textContent = q
          ? `${rows.length} / ${apps.length}`
          : `${apps.length} · ${problemCount} 有失败`;
      }

      if (!rows.length) {
        listEl.innerHTML = empty(
          '没有匹配的应用',
          q ? '' : '未扫到本机应用，且 queue 暂无失败应用',
        );
        return;
      }

      listEl.innerHTML = rows
        .map((a) => {
          const href = `#/apps/${encodeURIComponent(a.robotUuid)}`;
          const { title, appLine, moreTasks } = appListTitles(a);
          const meta = appListMeta(a);
          return `<a class="list-item" href="${href}">
            <div class="item-main">
              <div class="item-title">${esc(title)}</div>
              ${
                appLine
                  ? `<div class="item-sub">应用 · ${esc(appLine)}${
                      moreTasks ? ` · <span class="faint">${esc(moreTasks)}</span>` : ''
                    }</div>`
                  : moreTasks
                    ? `<div class="item-sub faint">${esc(moreTasks)}</div>`
                    : ''
              }
              ${meta ? `<div class="item-sub faint">${esc(meta)}</div>` : ''}
            </div>
            <div class="item-side">
              <div class="badges">
                ${
                  a.failureCount
                    ? `<span class="badge danger">${esc(a.failureCount)} 失败</span>`
                    : ''
                }
                ${
                  a.undiagnosedCount
                    ? `<span class="badge warn">${esc(a.undiagnosedCount)} 未诊断</span>`
                    : ''
                }
                ${
                  a.remoteOnly
                    ? `<span class="badge">云端</span>`
                    : !a.failureCount && a.flowCount
                      ? `<span class="badge">${esc(a.flowCount)} 流程</span>`
                      : ''
                }
              </div>
              <span class="item-go">打开 →</span>
            </div>
          </a>`;
        })
        .join('');
    }

    paint();
    filterEl.addEventListener('input', () => paint(filterEl.value));
    filterEl.focus();
  }

  // ── App detail ──
  async function renderApp(robotUuid, tab = 'overview') {
    setNav('apps');
    setHeader('应用', '');
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载应用…');

    const [detail, agents] = await Promise.all([
      api(`/api/apps/${encodeURIComponent(robotUuid)}`),
      loadAgents(),
    ]);
    if (!detail.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(detail.message || detail.code)}</div>
        <p class="mt"><a href="#/apps">返回应用列表</a></p>`;
      return;
    }

    pushRecentApp(robotUuid, detail.name || robotUuid);

    const agentPrompt = buildAgentPrompt({
      mode: 'develop',
      name: detail.name || robotUuid,
      xbotDir: detail.xbotDir || '',
      robotUuid,
    });
    setActiveHandoff({ path: detail.xbotDir || '', agentPrompt });

    setHeader(
      detail.name || robotUuid,
      `${detail.failureCount || 0} 失败 · ${detail.undiagnosedCount || 0} 未诊断`,
    );

    content.innerHTML = `
      <div class="crumb"><a href="#/apps">应用</a> / <span class="mono">${esc(robotUuid)}</span></div>

      ${handoffBarHtml({
        xbotDir: detail.xbotDir || '',
        agentPrompt,
        pathLabel: '本地路径',
        robotUuid,
        agents,
      })}
      <div id="open-hint" class="hint mb"></div>

      <div class="tabs" role="tablist" aria-label="应用分区">
        <button type="button" role="tab" id="tab-overview" class="tab ${
          tab === 'overview' ? 'active' : ''
        }" data-tab="overview" aria-selected="${tab === 'overview'}" aria-controls="tab-body" tabindex="${
          tab === 'overview' ? '0' : '-1'
        }">概览</button>
        <button type="button" role="tab" id="tab-flow" class="tab ${
          tab === 'flow' ? 'active' : ''
        }" data-tab="flow" aria-selected="${tab === 'flow'}" aria-controls="tab-body" tabindex="${
          tab === 'flow' ? '0' : '-1'
        }">业务流程</button>
        <button type="button" role="tab" id="tab-impl" class="tab ${
          tab === 'impl' ? 'active' : ''
        }" data-tab="impl" aria-selected="${tab === 'impl'}" aria-controls="tab-body" tabindex="${
          tab === 'impl' ? '0' : '-1'
        }">实现流程</button>
        <button type="button" role="tab" id="tab-failures" class="tab ${
          tab === 'failures' ? 'active' : ''
        }" data-tab="failures" aria-selected="${tab === 'failures'}" aria-controls="tab-body" tabindex="${
          tab === 'failures' ? '0' : '-1'
        }">相关问题</button>
      </div>
      <div id="tab-body" role="tabpanel" aria-labelledby="tab-${esc(tab)}"></div>
    `;

    bindCopyButtons(content);
    bindOpenAgentControls(content, { robotUuid, prompt: agentPrompt });

    const tabOrder = ['overview', 'flow', 'impl', 'failures'];
    content.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.onclick = () => {
        location.hash = `#/apps/${encodeURIComponent(robotUuid)}/${btn.getAttribute('data-tab')}`;
      };
      btn.onkeydown = (e) => {
        const i = tabOrder.indexOf(btn.getAttribute('data-tab'));
        if (i < 0) return;
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabOrder[(i + 1) % tabOrder.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          next = tabOrder[(i - 1 + tabOrder.length) % tabOrder.length];
        } else if (e.key === 'Home') next = tabOrder[0];
        else if (e.key === 'End') next = tabOrder[tabOrder.length - 1];
        if (!next) return;
        e.preventDefault();
        sessionStorage.setItem('rpa_wb_focus_tab', next);
        location.hash = `#/apps/${encodeURIComponent(robotUuid)}/${next}`;
      };
    });

    const tabBody = $('#tab-body');
    if (tab === 'failures') renderAppFailures(tabBody, detail, robotUuid);
    else if (tab === 'flow') await renderAppBusinessFlow(robotUuid, detail);
    else if (tab === 'impl') await renderAppImplFlow(robotUuid, detail, false);
    else renderAppOverview(tabBody, detail, robotUuid);
  }

  function renderAppOverview(tabBody, detail, robotUuid) {
    const fails = detail.failures || [];
    tabBody.innerHTML = `
      <div class="stack">
        <div class="panel">
          <h2>信息</h2>
          <div class="kv">
            <div class="k">应用</div><div class="v">${esc(detail.name)}</div>
            ${
              detail.taskName && String(detail.taskName).trim() !== String(detail.name || '').trim()
                ? `<div class="k">任务</div><div class="v">${esc(detail.taskName)}</div>`
                : ''
            }
            ${
              Array.isArray(detail.taskNames) && detail.taskNames.length > 1
                ? `<div class="k">相关任务</div><div class="v">${esc(
                    detail.taskNames.slice(0, 6).join('、'),
                  )}${detail.taskNames.length > 6 ? '…' : ''}</div>`
                : ''
            }
            ${
              detail.robotClientName
                ? `<div class="k">客户端</div><div class="v">${esc(detail.robotClientName)}</div>`
                : ''
            }
            <div class="k">UUID</div><div class="v mono">${esc(detail.robotUuid)}</div>
            <div class="k">账号</div><div class="v mono">${esc(detail.userId || '—')}</div>
            <div class="k">来源</div><div class="v mono">${esc(detail.resolve?.source || '')} ${esc(
              detail.resolve?.reason || '',
            )}</div>
            <div class="k">最近失败</div><div class="v">${esc(relTime(detail.lastFailureAt))}</div>
          </div>
        </div>
        <div class="panel">
          <h2>最近失败 <span class="meta">${Math.min(5, fails.length)}/${fails.length}</span></h2>
          ${
            fails.length
              ? `<div class="list">${fails
                  .slice(0, 5)
                  .map((f) =>
                    failureRowHtml(f, {
                      extraSub: `<div class="item-sub wrap">${esc(f.errorType || '')} · ${esc(
                        (f.rawRemark || '').slice(0, 120),
                      )}</div>`,
                    }),
                  )
                  .join('')}</div>
                <p class="hint">
                  <a href="#/apps/${encodeURIComponent(robotUuid)}/failures">全部问题</a>
                </p>`
              : empty('暂无失败')
          }
        </div>
      </div>
    `;
  }

  function renderAppFailures(tabBody, detail) {
    const fails = detail.failures || [];
    tabBody.innerHTML = `
      <div class="panel">
        <h2>相关问题 <span class="meta">${fails.length}</span></h2>
        ${
          fails.length
            ? `<div class="list">${fails
                .map((f) =>
                  failureRowHtml(f, {
                    extraSub: `<div class="item-sub">${esc(f.flowName || '未知流程')} · ${esc(
                      f.errorType || '',
                    )} · ${esc(relTime(f.lastSeen))}</div>
                    <div class="item-sub wrap">${esc((f.rawRemark || '').slice(0, 240))}</div>`,
                  }),
                )
                .join('')}</div>`
            : empty('无失败记录')
        }
      </div>`;
  }

  async function renderFinding(fingerprint) {
    setNav('apps');
    setHeader('问题详情', fingerprint);
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载问题…');

    const [data, agents] = await Promise.all([
      api(`/api/findings/${encodeURIComponent(fingerprint)}`),
      loadAgents(),
    ]);
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>
        <p class="mt"><a href="#/apps">返回应用</a></p>`;
      return;
    }

    const f = data.finding || {};
    const d = data.diagnosis || {};
    const k = data.kb || {};
    const g = data.guidance || null;
    const triage = data.triage || {};
    const canPreview = triage.canPreviewFix === true;
    const patches = data.patches || [];
    const robotUuid = f.robotUuid || '';
    const xbotDir = data.xbotDir || '';
    const appName = data.appName || f.robotName || robotUuid;

    if (robotUuid) pushRecentApp(robotUuid, appName);

    const agentPrompt = buildAgentPrompt({
      mode: 'fix',
      name: appName,
      xbotDir,
      robotUuid,
      fingerprint,
      flowName: f.flowName,
      lineNumber: f.lineNumber,
      errorType: f.errorType,
      rawRemark: f.rawRemark,
      rootCause: d.rootCause || k.rootCause,
      suggestion: d.suggestion || k.solution,
      guidanceTitle: g && g.title,
      fixClass: triage.fixClass || (g && g.fixClass),
      fixability: triage.fixability || (g && g.fixability),
    });
    setActiveHandoff({ path: xbotDir, agentPrompt });

    setHeader(
      f.robotName || fingerprint,
      `${f.errorType || ''} · ${f.diagnosed ? '已诊断' : '未诊断'}${
        g && g.title ? ` · ${g.title}` : ''
      }`,
    );

    content.innerHTML = `
      <div class="crumb">
        <a href="#/apps">应用</a>
        ${robotUuid ? ` / <a href="#/apps/${encodeURIComponent(robotUuid)}">${esc(f.robotName || robotUuid)}</a>` : ''}
        / 问题
      </div>

      ${handoffBarHtml({
        xbotDir,
        agentPrompt,
        pathLabel: '本地路径',
        robotUuid,
        agents,
      })}
      <div id="open-hint" class="hint mb"></div>

      <div class="panel">
        <div class="badges" style="justify-content:flex-start;margin-bottom:10px">
          ${f.diagnosed ? '<span class="badge ok">已诊断</span>' : '<span class="badge warn">未诊断</span>'}
          ${g && g.title ? `<span class="badge">${esc(g.title)}</span>` : ''}
          ${f.occurrenceCount ? `<span class="badge">${esc(f.occurrenceCount)} 次</span>` : ''}
        </div>
        <p class="summary-line" style="margin-bottom:8px">${esc((f.rawRemark || '').slice(0, 400) || '无备注')}</p>
        <div class="kv">
          <div class="k">指纹</div><div class="v mono">${esc(fingerprint)}</div>
          <div class="k">流程</div><div class="v">${esc(f.flowName || '—')} L${esc(f.lineNumber || '?')}</div>
          <div class="k">错误</div><div class="v">${esc(f.errorType || '—')}</div>
          <div class="k">分诊</div><div class="v">${esc(triage.fixClass || '—')} / ${esc(triage.fixability || '—')}</div>
          <div class="k">最近</div><div class="v">${esc(relTime(f.lastSeen))}</div>
        </div>
        <div class="actions mt">
          ${
            f.diagnosed
              ? `<button type="button" class="btn" data-action="diagnose" data-fp="${esc(fingerprint)}">重新诊断</button>`
              : `<button type="button" class="btn primary" data-action="diagnose" data-fp="${esc(fingerprint)}">诊断</button>`
          }
          ${
            canPreview
              ? `<button type="button" class="btn ghost" data-action="fix-dry-run" data-fp="${esc(fingerprint)}">预览修复</button>`
              : ''
          }
        </div>
      </div>

      ${renderGuidanceBlock(g)}

      ${
        d.rootCause || k.rootCause
          ? `<div class="panel mt">
          <h2>诊断结论</h2>
          <div class="kv">
            <div class="k">根因</div><div class="v">${esc(d.rootCause || k.rootCause || '—')}</div>
            <div class="k">位置</div><div class="v">${esc(d.location || k.location || '—')}</div>
            <div class="k">建议</div><div class="v">${esc(d.suggestion || k.solution || '—')}</div>
          </div>
          ${k.id ? `<p class="hint mt">KB：${esc(k.id)}</p>` : ''}
        </div>`
          : ''
      }

      ${
        patches.length
          ? `<div class="panel mt">
        <h2>相关补丁 <span class="meta">${patches.length}</span></h2>
        <div class="list">${patches
          .map(
            (p) => `<div class="list-item">
              <div class="item-main">
                <div class="item-title mono">${esc(p.patchId)}</div>
                <div class="item-sub">${esc(p.status)} · ${esc(p.fixerId || '')}</div>
              </div>
              <div class="item-side">
                <button type="button" class="btn sm ghost" data-patch="${esc(p.patchId)}">diff</button>
              </div>
            </div>`,
          )
          .join('')}</div>
        <div id="patch-diff-host" class="mt"></div>
      </div>`
          : ''
      }
    `;

    bindCopyButtons(content);
    bindOpenAgentControls(content, { robotUuid, prompt: agentPrompt });
    bindActionButtons(content);
    content.querySelectorAll('[data-patch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-patch');
        const host = $('#patch-diff-host');
        if (!host) return;
        host.innerHTML = loadingHtml('加载 diff…');
        const pd = await api(`/api/patches/${encodeURIComponent(id)}`);
        if (!pd.ok) {
          host.innerHTML = `<div class="err">${esc(pd.message || pd.code)}</div>`;
          return;
        }
        host.innerHTML = `<div class="pre">${esc(pd.diff || '(empty diff)')}</div>`;
      });
    });
  }

  /** 业务流程 Tab：LLM 业务解读 + 业务图（不展示 call graph） */
  async function renderAppBusinessFlow(robotUuid, detail) {
    const tabBody = $('#tab-body');
    if (!tabBody) return;

    tabBody.innerHTML = `
      <div class="panel" id="business-brief-panel">
        <div class="graph-bar">
          <div>
            <h2 style="margin:0">业务解读 <span class="badge warn">LLM</span></h2>
          </div>
          <div class="actions">
            <button type="button" class="btn sm primary" id="btn-business-brief">生成解读</button>
            <button type="button" class="btn sm ghost" id="btn-business-brief-refresh" title="忽略缓存重新生成">重新生成</button>
          </div>
        </div>
        <div id="business-brief-body" class="mt">
          <p class="faint">加载中…</p>
        </div>
      </div>
    `;

    async function renderBriefInto(el, data) {
      if (!el) return;
      if (!data || data.ok === false) {
        el.innerHTML = `<div class="err">${esc((data && (data.message || data.code)) || '解读失败')}</div>`;
        return;
      }
      if (!data.brief) {
        el.innerHTML = `<p class="faint">尚未生成</p>`;
        return;
      }
      const b = data.brief || {};
      const conf =
        b.confidence != null && Number.isFinite(Number(b.confidence))
          ? `置信 ${Math.round(Number(b.confidence) * 100)}%`
          : '';
      const metaBits = [
        data.stale ? '结构已更新' : '',
        data.model || '',
        data.generatedAt ? formatTime(data.generatedAt) : '',
        conf,
      ].filter(Boolean);

      const steps = Array.isArray(b.businessFlow) ? b.businessFlow.filter(Boolean) : [];
      const systems = Array.isArray(b.systems) ? b.systems.filter(Boolean) : [];
      const objects = Array.isArray(b.dataObjects) ? b.dataObjects.filter(Boolean) : [];
      const risks = Array.isArray(b.risks) ? b.risks.filter(Boolean) : [];
      const questions = Array.isArray(b.openQuestions) ? b.openQuestions.filter(Boolean) : [];
      const tech = Array.isArray(b.techHighlights) ? b.techHighlights.filter(Boolean) : [];
      const fd = b.flowDiagram || data.flowDiagram || null;
      const bizMermaid = fd && fd.mermaid ? String(fd.mermaid).trim() : '';
      const graphModeLabel =
        fd && fd.hasBranch
          ? '主路径 + 推断分支'
          : fd && fd.mode === 'chain'
            ? '主路径'
            : fd && fd.mode
              ? '业务图'
              : '';

      const chips = (items) =>
        items.length
          ? `<div class="brief-chips">${items.map((x) => `<span class="brief-chip">${esc(x)}</span>`).join('')}</div>`
          : '<span class="brief-empty">—</span>';

      const softList = (items, cls = '') =>
        items.length
          ? `<ul class="brief-list ${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
          : '';

      el.innerHTML = `
        <article class="brief">
          <header class="brief-hero">
            <h3 class="brief-title">${esc(b.title || '业务解读')}</h3>
            ${
              b.purpose
                ? `<p class="brief-purpose">${esc(b.purpose)}</p>`
                : ''
            }
            ${
              metaBits.length
                ? `<p class="brief-meta">${esc(metaBits.join(' · '))}</p>`
                : ''
            }
          </header>

          ${
            bizMermaid
              ? `<section class="brief-section brief-section-diagram" aria-label="业务流程图">
            <div class="brief-diagram-bar">
              <div class="brief-label">业务流程图 ${
                graphModeLabel ? `<span class="brief-count">${esc(graphModeLabel)}</span>` : ''
              }${
                fd && fd.hasBranch
                  ? ' <span class="badge warn">分支为推测</span>'
                  : ''
              }</div>
              <div class="actions">
                <button type="button" class="btn sm ghost" id="btn-biz-graph-fs">全屏</button>
              </div>
            </div>
            <div class="graph graph-biz">
              <div class="graph-host" id="biz-mermaid-host"><div class="muted">渲染中…</div></div>
            </div>
            ${
              fd && fd.hasBranch
                ? `<p class="brief-diagram-note">实线为主路径；虚线带条件为推断分支，非正式业务定稿。</p>`
                : ''
            }
          </section>`
              : ''
          }

          ${
            steps.length
              ? `<section class="brief-section brief-section-primary" aria-label="业务步骤">
            <div class="brief-label">业务步骤 <span class="brief-count">${steps.length}</span></div>
            <ol class="brief-steps">
              ${steps
                .map(
                  (s, i) =>
                    `<li><span class="brief-step-n" aria-hidden="true">${i + 1}</span><span class="brief-step-t">${esc(s)}</span></li>`,
                )
                .join('')}
            </ol>
          </section>`
              : ''
          }

          ${
            systems.length || objects.length
              ? `<section class="brief-section brief-section-context" aria-label="系统与对象">
            <div class="brief-context">
              ${
                systems.length
                  ? `<div class="brief-context-col">
                <div class="brief-label">涉及系统</div>
                ${chips(systems)}
              </div>`
                  : ''
              }
              ${
                objects.length
                  ? `<div class="brief-context-col">
                <div class="brief-label">业务对象</div>
                ${chips(objects)}
              </div>`
                  : ''
              }
            </div>
          </section>`
              : ''
          }

          ${
            risks.length || questions.length
              ? `<section class="brief-section brief-section-flags" aria-label="风险与待确认">
            <div class="brief-flags">
              ${
                risks.length
                  ? `<div class="brief-flag brief-flag-risk">
                <div class="brief-label">风险 <span class="brief-count">${risks.length}</span></div>
                ${softList(risks)}
              </div>`
                  : ''
              }
              ${
                questions.length
                  ? `<div class="brief-flag brief-flag-q">
                <div class="brief-label">待业务确认 <span class="brief-count">${questions.length}</span></div>
                ${softList(questions)}
              </div>`
                  : ''
              }
            </div>
          </section>`
              : ''
          }

          ${
            tech.length
              ? `<details class="brief-tech">
            <summary>实现要点 <span class="brief-count">${tech.length}</span></summary>
            ${softList(tech, 'brief-list-tech')}
          </details>`
              : ''
          }
        </article>
      `;

      if (bizMermaid) {
        const host = el.querySelector('#biz-mermaid-host');
        const pngUrl = await renderMermaidInto(host, bizMermaid, { compact: true });
        const title = b.title || '业务流程图';
        const openFs = () => {
          const url = (host && host.dataset.graphPng) || pngUrl;
          openGraphFullscreen(url, title);
        };
        const fsBtn = el.querySelector('#btn-biz-graph-fs');
        if (fsBtn) fsBtn.onclick = openFs;
        if (host) {
          host.style.cursor = 'zoom-in';
          host.title = '点击全屏';
          host.addEventListener('click', openFs);
        }
      }
    }

    async function runBusinessBrief(force) {
      const bodyEl = $('#business-brief-body');
      const btn = $('#btn-business-brief');
      const btn2 = $('#btn-business-brief-refresh');
      if (bodyEl) bodyEl.innerHTML = loadingHtml(force ? '重新生成业务解读…' : '生成业务解读…');
      [btn, btn2].forEach((b) => {
        if (b) b.disabled = true;
      });
      try {
        const data = await api(`/api/apps/${encodeURIComponent(robotUuid)}/business-brief`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: !!force }),
        });
        await renderBriefInto(bodyEl, data);
        if (data && data.ok && data.brief) {
          toast(data.cached ? '已加载保存的解读' : '业务解读已生成并保存');
        } else toast((data && data.message) || '解读失败');
      } catch (e) {
        if (bodyEl) bodyEl.innerHTML = `<div class="err">${esc(e.message || e)}</div>`;
        toast(e.message || '解读失败');
      } finally {
        [btn, btn2].forEach((b) => {
          if (b) b.disabled = false;
        });
      }
    }

    const briefBtn = $('#btn-business-brief');
    if (briefBtn) briefBtn.onclick = () => runBusinessBrief(false);
    const briefRefresh = $('#btn-business-brief-refresh');
    if (briefRefresh) briefRefresh.onclick = () => runBusinessBrief(true);

    // 进入页面自动加载本机已保存解读（不调 LLM）
    (async () => {
      const bodyEl = $('#business-brief-body');
      try {
        const data = await api(`/api/apps/${encodeURIComponent(robotUuid)}/business-brief`);
        await renderBriefInto(bodyEl, data);
      } catch {
        if (bodyEl) {
          bodyEl.innerHTML = '<p class="faint">尚未生成</p>';
        }
      }
    })();
  }

  /** 实现流程 Tab：rpa-skill understand 调用图与结构明细 */
  async function renderAppImplFlow(robotUuid, detail, forceRefresh) {
    const tabBody = $('#tab-body');
    if (!tabBody) return;
    tabBody.innerHTML = `<div class="panel">${loadingHtml(
      `正在解析实现流程${forceRefresh ? '（刷新）' : ''}…`,
    )}</div>`;

    const u = await api(
      `/api/apps/${encodeURIComponent(robotUuid)}/understand${forceRefresh ? '?refresh=1' : ''}`,
    );
    if (!u.ok) {
      tabBody.innerHTML = `<div class="panel"><div class="err">解析失败：${esc(u.message || u.code)}</div>
        <div class="actions mt"><button type="button" class="btn sm" data-refresh-flow>重新解析</button></div></div>`;
      const rb = tabBody.querySelector('[data-refresh-flow]');
      if (rb) rb.onclick = () => renderAppImplFlow(robotUuid, detail, true);
      return;
    }
    const r = u.result || {};
    if (!r.ok) {
      tabBody.innerHTML = `<div class="panel"><div class="err">understand 失败：${esc(
        r.reason || r.error || JSON.stringify(r),
      )}</div></div>`;
      return;
    }

    const mg = r.mermaidGraph || null;
    const mermaidSrc = extractMermaidSource(mg);
    const graphMeta = mg
      ? [
          mg.truncated ? `已截断 ${mg.omitted || 0}` : null,
          mg.edgeCount != null ? `${mg.edgeCount} 边` : null,
          mg.nodeCount != null ? `${mg.nodeCount} 节点` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

    const edges = (r.callGraph && r.callGraph.edges) || [];

    tabBody.innerHTML = `
      <div class="panel" id="impl-call-graph-panel">
        <div class="graph-bar">
          <div>
            <h2 style="margin:0">${esc(r.projectName || detail.name || '实现调用图')}</h2>
            <p class="hint" style="margin-top:4px">${u.cached ? '缓存' : '实时 rpa-skill'} · ${esc(
              graphMeta || (mermaidSrc ? 'call graph' : '无图'),
            )}</p>
          </div>
          <div class="actions">
            ${
              mermaidSrc
                ? `<button type="button" class="btn sm primary" id="btn-graph-fs">全屏查看</button>`
                : ''
            }
            <button type="button" class="btn sm ghost" data-refresh-flow>重新解析</button>
          </div>
        </div>
        ${r.summary ? `<p class="summary-line">${esc(r.summary)}</p>` : ''}
        ${
          mermaidSrc
            ? `<div class="graph graph-hero">
                <div class="graph-host" id="mermaid-host"><div class="muted">渲染中…</div></div>
              </div>
              <details class="raw"><summary>Mermaid 源码</summary><div class="pre mt">${esc(mermaidSrc)}</div></details>`
            : empty('没有调用图')
        }
      </div>

      <details class="panel mt fold">
        <summary>阶段与流程清单</summary>
        <div class="grid-2 mt">
          <div>
            <h2>阶段</h2>
            ${renderStages(r.stages)}
          </div>
          <div>
            <h2>流程 <span class="meta">${(r.flowRoles || []).length}</span></h2>
            ${(r.flowRoles || []).length
              ? `<ul class="plain-list">${(r.flowRoles || [])
                  .map((it) => `<li>${esc(formatFlowRole(it))}</li>`)
                  .join('')}</ul>`
              : '<div class="muted">无</div>'}
            <h2 class="mt">业务对象 <span class="meta">${(r.businessObjects || []).length}</span></h2>
            ${(r.businessObjects || []).length
              ? `<ul class="plain-list">${(r.businessObjects || [])
                  .map(
                    (x) =>
                      `<li>${esc(typeof x === 'string' ? x : x.name || JSON.stringify(x))}</li>`,
                  )
                  .join('')}</ul>`
              : '<div class="muted">无</div>'}
          </div>
        </div>
      </details>

      ${
        edges.length
          ? `<details class="panel mt fold">
              <summary>调用关系 <span class="meta">${Math.min(40, edges.length)}</span></summary>
              <table class="table mt">
                <thead><tr><th>类型</th><th>从</th><th>到</th></tr></thead>
                <tbody>
                  ${edges
                    .slice(0, 40)
                    .map(
                      (e) => `<tr>
                        <td class="mono">${esc(e.type || '')}</td>
                        <td>${esc(e.from || '')}</td>
                        <td>${esc(e.to || '')}${e.toKind ? ` <span class="badge">${esc(e.toKind)}</span>` : ''}</td>
                      </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </details>`
          : ''
      }

      ${
        (r.rules || []).length
          ? `<details class="panel mt fold">
              <summary>规则 / 推断</summary>
              <ul class="plain-list mt">${(r.rules || [])
                .map(
                  (x) =>
                    `<li>${esc(typeof x === 'string' ? x : x.rule || x.text || JSON.stringify(x))}</li>`,
                )
                .join('')}</ul>
            </details>`
          : ''
      }

      <details class="panel mt fold raw">
        <summary>原始 JSON</summary>
        <div class="pre mt">${esc(JSON.stringify(r, null, 2))}</div>
      </details>
    `;

    const refreshBtn = tabBody.querySelector('[data-refresh-flow]');
    if (refreshBtn) refreshBtn.onclick = () => renderAppImplFlow(robotUuid, detail, true);

    if (mermaidSrc) {
      const preview = $('#mermaid-host');
      const pngUrl = await renderMermaidInto(preview, mermaidSrc);
      const title = `${r.projectName || detail.name || '应用'} · 实现调用图`;
      const openFs = () => {
        const url = (preview && preview.dataset.graphPng) || pngUrl;
        openGraphFullscreen(url, title);
      };
      const fsBtn = $('#btn-graph-fs');
      if (fsBtn) fsBtn.onclick = openFs;
      if (preview) {
        preview.style.cursor = 'zoom-in';
        preview.title = '点击全屏查看 PNG';
        preview.addEventListener('click', openFs);
      }
    }
  }

  async function route() {
    await refreshRuntime();
    const r = parseRoute();
    try {
      if (r.name === 'finding') await renderFinding(r.fingerprint);
      else if (r.name === 'reports') await renderReports();
      else if (r.name === 'report') await renderReport(r.date);
      else if (r.name === 'settings') await renderSettings(r.tab);
      else if (r.name === 'apps') await renderApps();
      else if (r.name === 'app') {
        const tab = normalizeAppTab(r.tab);
        await renderApp(r.robotUuid, tab);
      } else await renderHome();
    } catch (e) {
      content.innerHTML = `<div class="err">错误：${esc(e.message || e)}</div>`;
    }

    // Prefer restoring tab focus when we just keyboard-navigated tabs
    const wantTab = sessionStorage.getItem('rpa_wb_focus_tab');
    if (
      wantTab &&
      r.name === 'app' &&
      (normalizeAppTab(r.tab) === wantTab || (!r.tab && wantTab === 'overview'))
    ) {
      focusActiveTab(wantTab);
      sessionStorage.removeItem('rpa_wb_focus_tab');
      return;
    }

    const active = document.activeElement;
    const keep =
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'BUTTON' ||
        active.tagName === 'A' ||
        active.getAttribute('role') === 'tab');
    if (!keep) {
      try {
        content.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  window.addEventListener('hashchange', () => route());
  $('#btn-refresh').addEventListener('click', () => route());

  const helpBtn = $('#btn-help');
  if (helpBtn) helpBtn.addEventListener('click', () => showHelpTip());

  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-open-agent-wrap]')) return;
    closeAllAgentMenus();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllAgentMenus();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const tip = $('#first-run-tip');
      if (tip) {
        try {
          localStorage.setItem('rpa_wb_tip_dismissed', '1');
        } catch {
          // ignore
        }
        tip.remove();
      }
      return;
    }

    const tag = (e.target && e.target.tagName) || '';
    const typing =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (e.target && e.target.isContentEditable);

    // c = 复制路径；Shift+C = 复制 Agent 提示
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (e.shiftKey && activeAgentPrompt) {
        e.preventDefault();
        copyText(activeAgentPrompt, 'Agent 提示已复制');
        return;
      }
      if (!e.shiftKey && activeCopyPath) {
        e.preventDefault();
        copyText(activeCopyPath, '路径已复制');
        return;
      }
    }

    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing) return;
    const input = $('#app-filter');
    if (input) {
      e.preventDefault();
      input.focus();
      return;
    }
    if (location.hash !== '#/apps') {
      e.preventDefault();
      location.hash = '#/apps';
    }
  });

  route();
})();
