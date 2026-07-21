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

  /**
   * 「处理完成」引导填写弹层：原因/方案均可空
   * @param {{ rootCause?: string, solution?: string }} [preset]
   * @returns {Promise<{ ok: boolean, rootCause?: string, solution?: string }>}
   */
  function openResolveDialog(preset = {}) {
    return new Promise((resolve) => {
      const existing = document.getElementById('resolve-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'resolve-dialog';
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'resolve-dialog-title');
      overlay.innerHTML = `
        <div class="modal-card">
          <h2 id="resolve-dialog-title" class="modal-title">处理完成</h2>
          <p class="hint modal-lead">将移出优先处理列表。同指纹再次失败会拉回待处理。原因与方案<strong>选填</strong>，建议随手记一句方便日后对照。</p>
          <label class="field">
            <span class="field-label">问题原因 <span class="faint">（选填）</span></span>
            <textarea id="resolve-root" class="input" rows="2" placeholder="例：页面改版导致元素找不到 / 上游 Excel 缺列">${esc(
              preset.rootCause || '',
            )}</textarea>
          </label>
          <label class="field">
            <span class="field-label">处理方案 <span class="faint">（选填）</span></span>
            <textarea id="resolve-sol" class="input" rows="2" placeholder="例：已更新选择器并重跑 / 已联系业务补数据">${esc(
              preset.solution || '',
            )}</textarea>
          </label>
          <div class="modal-actions">
            <button type="button" class="btn ghost" data-resolve-cancel>取消</button>
            <button type="button" class="btn primary" data-resolve-ok>确认完成</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const rootEl = overlay.querySelector('#resolve-root');
      const solEl = overlay.querySelector('#resolve-sol');
      const finish = (result) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish({ ok: false });
        }
      };
      document.addEventListener('keydown', onKey);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish({ ok: false });
      });
      overlay.querySelector('[data-resolve-cancel]')?.addEventListener('click', () => {
        finish({ ok: false });
      });
      overlay.querySelector('[data-resolve-ok]')?.addEventListener('click', () => {
        finish({
          ok: true,
          rootCause: rootEl ? rootEl.value : '',
          solution: solEl ? solEl.value : '',
        });
      });

      // 聚焦第一个空框，引导填写
      requestAnimationFrame(() => {
        if (rootEl && !String(rootEl.value || '').trim()) rootEl.focus();
        else if (solEl) solEl.focus();
        else rootEl?.focus();
      });
    });
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
   * S27a：从服务端拉取瘦身交接提示词（业务在 lib/handoff.js）
   * fix 默认不含诊断；includeDiagnose=true 时附带 Monitor 判断。
   * develop 可 POST focusNodes / taskNote；includeCandidates 拉节点候选。
   * @param {{
   *   mode?: 'fix'|'develop',
   *   fingerprint?: string,
   *   robotUuid?: string,
   *   includeDiagnose?: boolean,
   *   taskNote?: string,
   *   focusNodes?: object[],
   *   includeCandidates?: boolean,
   * }} opts
   * @returns {Promise<{ ok: boolean, markdown?: string, message?: string, includeDiagnose?: boolean, candidates?: object[] }>}
   */
  async function fetchHandoff(opts = {}) {
    try {
      if (opts.mode === 'fix' || opts.fingerprint) {
        const fp = opts.fingerprint;
        if (!fp) return { ok: false, message: '缺少 fingerprint' };
        const q = opts.includeDiagnose ? '?includeDiagnose=1' : '';
        return await api(`/api/findings/${encodeURIComponent(fp)}/handoff${q}`);
      }
      const robotUuid = opts.robotUuid;
      if (!robotUuid) return { ok: false, message: '缺少 robotUuid' };
      const needPost =
        opts.includeCandidates ||
        (opts.focusNodes && opts.focusNodes.length) ||
        (opts.taskNote && String(opts.taskNote).trim());
      if (needPost) {
        return await api(`/api/apps/${encodeURIComponent(robotUuid)}/handoff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            taskNote: opts.taskNote || '',
            focusNodes: opts.focusNodes || [],
            includeCandidates: opts.includeCandidates === true,
          }),
        });
      }
      const q = opts.includeCandidates ? '?includeCandidates=1' : '';
      return await api(`/api/apps/${encodeURIComponent(robotUuid)}/handoff${q}`);
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  }

  /**
   * 应用页：复制提示 / 打开 Agent 前选聚焦节点（数据来自 understand flowRoles）
   * @param {{ robotUuid: string, appName?: string, presetTaskNote?: string }} opts
   * @returns {Promise<{ ok: boolean, markdown?: string, focusNodes?: object[], taskNote?: string }>}
   */
  function openHandoffFocusDialog(opts = {}) {
    const robotUuid = opts.robotUuid;
    if (!robotUuid) {
      return Promise.resolve({ ok: false });
    }
    return new Promise((resolve) => {
      const existing = document.getElementById('handoff-focus-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'handoff-focus-dialog';
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'handoff-focus-title');
      overlay.innerHTML = `
        <div class="modal-card modal-card-lg">
          <h2 id="handoff-focus-title" class="modal-title">复制交接提示</h2>
          <p class="hint modal-lead">勾选要实现/分析的<strong>流程节点</strong>（来自实现流程），Agent 会优先深读这些节点，而不是整库概览。不选则复制通用维护提示。</p>
          <div id="handoff-focus-status" class="hint mb">正在加载节点…</div>
          <div class="handoff-focus-toolbar" hidden>
            <label class="handoff-focus-search">
              <span class="sr-only">筛选节点</span>
              <input type="search" id="handoff-focus-filter" class="input" placeholder="筛选节点名称…" autocomplete="off"/>
            </label>
            <div class="handoff-focus-bulk">
              <button type="button" class="btn sm ghost" data-focus-all>全选</button>
              <button type="button" class="btn sm ghost" data-focus-none>清空</button>
              <span class="meta" id="handoff-focus-count">已选 0</span>
            </div>
          </div>
          <div id="handoff-focus-list" class="handoff-focus-list" role="group" aria-label="聚焦节点" hidden></div>
          <label class="field">
            <span class="field-label">本次需求 <span class="faint">（选填）</span></span>
            <textarea id="handoff-focus-note" class="input" rows="2" placeholder="例：分析「NMPA-获批通知」的循环与写回逻辑；评估空值是否会导致跳过">${esc(
              opts.presetTaskNote || '',
            )}</textarea>
          </label>
          <div class="modal-actions">
            <button type="button" class="btn ghost" data-focus-cancel>取消</button>
            <button type="button" class="btn primary" data-focus-ok>复制提示</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const statusEl = overlay.querySelector('#handoff-focus-status');
      const listEl = overlay.querySelector('#handoff-focus-list');
      const toolbar = overlay.querySelector('.handoff-focus-toolbar');
      const countEl = overlay.querySelector('#handoff-focus-count');
      const filterEl = overlay.querySelector('#handoff-focus-filter');
      const noteEl = overlay.querySelector('#handoff-focus-note');
      const okBtn = overlay.querySelector('[data-focus-ok]');

      /** @type {object[]} */
      let candidates = [];

      const finish = (result) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish({ ok: false });
        }
      };
      document.addEventListener('keydown', onKey);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish({ ok: false });
      });
      overlay.querySelector('[data-focus-cancel]')?.addEventListener('click', () => {
        finish({ ok: false });
      });

      function updateCount() {
        if (!countEl || !listEl) return;
        const n = listEl.querySelectorAll('input[type="checkbox"]:checked').length;
        countEl.textContent = `已选 ${n}`;
      }

      function selectedNodes() {
        if (!listEl) return [];
        const boxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
        const out = [];
        boxes.forEach((box) => {
          const idx = Number(box.getAttribute('data-idx'));
          if (Number.isFinite(idx) && candidates[idx]) out.push(candidates[idx]);
        });
        return out;
      }

      function renderList(filter = '') {
        if (!listEl) return;
        const q = String(filter || '').trim().toLowerCase();
        const rows = candidates
          .map((n, idx) => {
            const label = n.name || n.filename || `节点${idx + 1}`;
            const hay = [
              label,
              n.filename,
              n.kind,
              n.role,
              n.pyFile,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            if (q && !hay.includes(q)) return '';
            const bits = [];
            if (n.kind) bits.push(n.kind);
            if (n.blockCount != null) bits.push(`${n.blockCount} 块`);
            if (n.filename && n.filename !== n.name) bits.push(n.filename);
            if (n.pyFile) bits.push(n.pyFile);
            const meta = bits.length ? bits.join(' · ') : '';
            const role = n.role ? `<div class="handoff-focus-role">${esc(n.role)}</div>` : '';
            return `<label class="handoff-focus-item">
              <input type="checkbox" data-idx="${idx}" />
              <span class="handoff-focus-body">
                <span class="handoff-focus-name">${esc(label)}</span>
                ${meta ? `<span class="handoff-focus-meta">${esc(meta)}</span>` : ''}
                ${role}
              </span>
            </label>`;
          })
          .filter(Boolean)
          .join('');
        listEl.innerHTML =
          rows ||
          `<div class="muted" style="padding:8px 4px">${
            candidates.length ? '无匹配节点' : '暂无节点'
          }</div>`;
        listEl.querySelectorAll('input[type="checkbox"]').forEach((box) => {
          box.addEventListener('change', updateCount);
        });
        updateCount();
      }

      overlay.querySelector('[data-focus-all]')?.addEventListener('click', () => {
        listEl?.querySelectorAll('input[type="checkbox"]').forEach((b) => {
          b.checked = true;
        });
        updateCount();
      });
      overlay.querySelector('[data-focus-none]')?.addEventListener('click', () => {
        listEl?.querySelectorAll('input[type="checkbox"]').forEach((b) => {
          b.checked = false;
        });
        updateCount();
      });
      filterEl?.addEventListener('input', () => renderList(filterEl.value));

      okBtn?.addEventListener('click', async () => {
        if (okBtn) {
          okBtn.disabled = true;
          okBtn.textContent = '生成中…';
        }
        const focusNodes = selectedNodes();
        const taskNote = noteEl ? noteEl.value : '';
        try {
          const res = await fetchHandoff({
            mode: 'develop',
            robotUuid,
            focusNodes,
            taskNote,
          });
          if (!res.ok || !res.markdown) {
            toast(res.message || '生成提示失败');
            if (okBtn) {
              okBtn.disabled = false;
              okBtn.textContent = '复制提示';
            }
            return;
          }
          finish({
            ok: true,
            markdown: res.markdown,
            focusNodes,
            taskNote,
          });
        } catch (e) {
          toast(e.message || '生成提示失败');
          if (okBtn) {
            okBtn.disabled = false;
            okBtn.textContent = '复制提示';
          }
        }
      });

      // 加载候选节点：优先 handoff includeCandidates（走 understand 缓存）
      (async () => {
        try {
          const res = await fetchHandoff({
            mode: 'develop',
            robotUuid,
            includeCandidates: true,
          });
          candidates = Array.isArray(res.candidates) ? res.candidates : [];
          if (!candidates.length) {
            // 再试 understand 接口，客户端本地抽 flowRoles
            const u = await api(`/api/apps/${encodeURIComponent(robotUuid)}/understand`);
            const r = u && u.result;
            if (u && u.ok && r && r.ok !== false && Array.isArray(r.flowRoles)) {
              candidates = r.flowRoles.map((fr) => {
                if (typeof fr === 'string') return { name: fr, kind: 'flow' };
                return {
                  name: fr.name || fr.filename || '',
                  filename: fr.filename || '',
                  kind: fr.kind || (fr.pyFile ? 'code' : 'visual'),
                  role: fr.role || '',
                  blockCount: fr.blockCount,
                  pyFile: fr.pyFile || '',
                };
              }).filter((n) => n.name);
            }
          }
          if (statusEl) {
            if (candidates.length) {
              statusEl.textContent = `共 ${candidates.length} 个节点可选（来自实现流程）· 应用 ${opts.appName || robotUuid}`;
            } else {
              statusEl.textContent =
                '未解析到节点（可仍复制通用提示，或先打开「实现流程」触发解析）';
            }
          }
          if (toolbar) toolbar.hidden = !candidates.length;
          if (listEl) {
            listEl.hidden = !candidates.length;
            if (candidates.length) renderList('');
          }
        } catch (e) {
          if (statusEl) {
            statusEl.textContent = `加载节点失败：${e.message || e}。仍可复制通用提示。`;
          }
        }
        requestAnimationFrame(() => {
          if (filterEl && candidates.length) filterEl.focus();
          else noteEl?.focus();
        });
      })();
    });
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
   * 主路径交接条：路径可点复制；复制瘦身提示词；在 Agent 打开（自动带提示词）
   * @param {{
   *   xbotDir?: string,
   *   agentPrompt?: string,
   *   pathLabel?: string,
   *   compact?: boolean,
   *   robotUuid?: string,
   *   agents?: object[]|null,
   *   showCopyPrompt?: boolean,
   *   showDiagnoseToggle?: boolean,
   *   includeDiagnose?: boolean,
   * }} opts
   */
  function handoffBarHtml({
    xbotDir = '',
    agentPrompt = '',
    pathLabel = '本地路径',
    compact = false,
    robotUuid = '',
    agents = null,
    showCopyPrompt = true,
    showDiagnoseToggle = false,
    includeDiagnose = false,
  } = {}) {
    const path = String(xbotDir || '');
    const prompt = String(agentPrompt || '');
    if (!path && !prompt) return '';
    const openMenu =
      robotUuid && path && agents && agents.length
        ? openAgentMenuHtml({ robotUuid, xbotDir: path, agents, prompt })
        : '';
    const copyPromptBtn =
      showCopyPrompt && prompt
        ? `<button type="button" class="btn sm ghost" id="btn-copy-handoff" title="复制给 Coding Agent 的提示词（应用页可选聚焦节点）">复制提示</button>`
        : '';
    const diagToggle = showDiagnoseToggle
      ? `<label class="handoff-toggle" title="默认不附带，避免给 Coding Agent 噪音">
          <input type="checkbox" id="chk-handoff-diagnose" ${includeDiagnose ? 'checked' : ''}/>
          含诊断
        </label>`
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
        <div class="handoff-actions">
          ${diagToggle}
          ${copyPromptBtn}
          ${openMenu || ''}
        </div>
      </div>
      <p class="hint handoff-hint">交接提示默认精简；应用页复制时可勾选聚焦节点。打开 Agent 时会自动复制到剪贴板。</p>
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
    const bucketLabel = f.bucketLabel || '';
    const bucketCls =
      f.actionable === 'ops' ? 'badge warn' : f.actionable === 'dev' ? 'badge ok' : 'badge';
    const soft =
      f.failureKind === 'soft'
        ? '<span class="badge warn" title="成功抽检：任务状态成功，但日志末尾有错误">抽检命中</span>'
        : '';
    const ws = f.workStatus || 'open';
    const workBadge =
      ws === 'resolved'
        ? '<span class="badge ok" title="处理完成">已处理</span>'
        : ws === 'snoozed'
          ? '<span class="badge warn" title="稍后处理">稍后</span>'
          : ws === 'ignored'
            ? '<span class="badge" title="不再提醒">不提醒</span>'
            : '';
    // 已处理：不再强调未诊断 / 次数（历史仍可在详情看）
    const showDiag = ws !== 'resolved';
    const showOcc = ws !== 'resolved' && f.occurrenceCount;
    return `<div class="item-side">
      <div class="badges">
        ${workBadge}
        ${soft}
        ${
          showDiag
            ? f.diagnosed
              ? '<span class="badge ok">已诊断</span>'
              : '<span class="badge warn">未诊断</span>'
            : ''
        }
        ${bucketLabel ? `<span class="${bucketCls}" title="技术分流">${esc(bucketLabel)}</span>` : ''}
        ${fixLabel && ws !== 'resolved' ? `<span class="badge">${esc(fixLabel)}</span>` : ''}
        ${
          ws === 'resolved'
            ? ''
            : canPreview
              ? '<span class="badge ok">可预览修</span>'
              : f.fixability === 'manual'
                ? '<span class="badge">需人工</span>'
                : ''
        }
        ${showOcc ? `<span class="badge">${esc(f.occurrenceCount)} 次</span>` : ''}
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
    if (parts[0] === 'poll-runs' && parts[1]) {
      return { name: 'poll-run', id: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === 'poll-runs' || parts[0] === 'pull-logs' || parts[0] === 'polls') {
      return { name: 'poll-runs' };
    }
    if (parts[0] === 'apps' && parts[1]) {
      return {
        name: 'app',
        robotUuid: decodeURIComponent(parts[1]),
        tab: parts[2] || 'overview',
      };
    }
    if (parts[0] === 'apps') return { name: 'apps' };
    if (parts[0] === 'settings') {
      let tab = 'llm';
      if (parts[1] === 'prompts' || parts[1] === 'brief') tab = 'prompts';
      else if (parts[1] === 'dingtalk' || parts[1] === 'notify') tab = 'dingtalk';
      else if (
        parts[1] === 'success-check' ||
        parts[1] === 'spotcheck' ||
        parts[1] === 'soft-fail' ||
        parts[1] === 'soft'
      ) {
        tab = 'success-check';
      }
      return { name: 'settings', tab };
    }
    return { name: 'home' };
  }

  function pollTriggerLabel(t) {
    const m = {
      boot: '启动',
      interval: '定时',
      manual: '手动',
      cli: 'CLI',
      unknown: '未知',
    };
    return m[t] || t || '未知';
  }

  function isErrorLogLevel(level, text) {
    const s = `${level || ''} ${text || ''}`;
    return /错误|error|err|exception|fail/i.test(s);
  }

  async function renderSettings(tabHint) {
    const route = parseRoute();
    const allowedTabs = new Set(['llm', 'prompts', 'dingtalk', 'success-check']);
    const tab =
      tabHint && allowedTabs.has(tabHint)
        ? tabHint
        : route.name === 'settings' && route.tab && allowedTabs.has(route.tab)
          ? route.tab
          : 'llm';

    setNav('settings');
    setHeader('设置');
    activeCopyPath = '';
    activeAgentPrompt = '';
    content.innerHTML = loadingHtml('加载设置…');

    const [data, briefCfg, dtCfg, scCfg] = await Promise.all([
      api('/api/settings/llm'),
      api('/api/settings/business-brief'),
      api('/api/settings/dingtalk'),
      api('/api/settings/success-check'),
    ]);
    if (!data || data.ok === false) {
      content.innerHTML = `<div class="err">加载失败：${esc(data && (data.message || data.code))}</div>`;
      return;
    }

    const locked = data.envLocked || {};
    const ro = data.settingsEnabled === false;
    const briefRo = ro || (briefCfg && briefCfg.settingsEnabled === false);
    const dt = dtCfg && dtCfg.ok !== false ? dtCfg : { ok: false };
    const dtRo = ro || dt.settingsEnabled === false;
    const sc = scCfg && scCfg.ok !== false ? scCfg : { ok: false, appChoices: [] };
    const scRo = ro || sc.settingsEnabled === false;
    const scEnv = sc.envLocked || {};
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
        <button type="button" role="tab" class="tab ${tab === 'dingtalk' ? 'active' : ''}"
          data-settings-tab="dingtalk" aria-selected="${tab === 'dingtalk'}">钉钉晨报</button>
        <button type="button" role="tab" class="tab ${tab === 'success-check' ? 'active' : ''}"
          data-settings-tab="success-check" aria-selected="${tab === 'success-check'}">成功抽检</button>
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
      </div>

      <div id="settings-pane-dingtalk" class="settings-pane ${tab === 'dingtalk' ? 'is-active' : ''}" role="tabpanel" ${
        tab === 'dingtalk' ? '' : 'hidden'
      }>
        <div class="panel settings-panel">
          <p class="meta mb">
            ${dt.enabled ? '已启用' : '未启用'}
            · ${dt.webhookConfigured ? '已配置 Webhook' : '未配置 Webhook'}
            ${dt.updatedAt ? `· ${esc(formatTime(dt.updatedAt))}` : ''}
          </p>
          <p class="hint mb">
            每天在 <strong>日报 cron 之后</strong>固定推送一条晨间摘要（默认约 9:05）。
            <strong>无异常也会发</strong>，便于区分「服务挂了」与「真无失败」。
            ${dt.scheduleHint ? `<br/>${esc(dt.scheduleHint)}` : ''}
          </p>
          ${
            dtRo
              ? `<div class="tip mb">settingsEnabled=false，当前只读。</div>`
              : ''
          }
          ${
            dt.lastSendAt
              ? `<p class="meta mb">上次推送：${esc(formatTime(dt.lastSendAt))} · ${
                  dt.lastSendOk ? '<span class="badge ok">成功</span>' : `<span class="badge danger">失败</span> ${esc(dt.lastSendError || '')}`
                }</p>`
              : ''
          }
          <form id="dingtalk-form" class="settings-form" autocomplete="off">
            <label class="field field-check">
              <input name="enabled" type="checkbox" ${dt.enabled ? 'checked' : ''} ${dtRo ? 'disabled' : ''} />
              <span>启用每日钉钉晨报</span>
            </label>
            <label class="field">
              <span class="field-label">Webhook URL</span>
              <input name="webhookUrl" type="url" class="field-input" value=""
                placeholder="${esc(
                  dt.webhookMasked
                    ? `已保存 ${dt.webhookMasked} · 留空不修改`
                    : 'https://oapi.dingtalk.com/robot/send?access_token=…',
                )}"
                ${dtRo ? 'readonly' : ''} />
            </label>
            <label class="field">
              <span class="field-label">加签 Secret（可选）</span>
              <input name="secret" type="password" class="field-input" value=""
                placeholder="${esc(
                  dt.secretMasked ? `已保存 ${dt.secretMasked} · 留空不修改` : 'SEC…（机器人安全设置·加签）',
                )}"
                ${dtRo ? 'readonly' : ''} />
            </label>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">时间窗（天，1=滚动 24h）</span>
                <input name="recentDays" type="number" min="0" max="30" step="1" class="field-input"
                  value="${esc(dt.recentDays != null ? dt.recentDays : 1)}" ${dtRo ? 'readonly' : ''} />
              </label>
              <label class="field">
                <span class="field-label">最多列出条数</span>
                <input name="topN" type="number" min="1" max="30" step="1" class="field-input"
                  value="${esc(dt.topN != null ? dt.topN : 8)}" ${dtRo ? 'readonly' : ''} />
              </label>
            </div>
            <label class="field">
              <span class="field-label">@ 手机号（钉钉绑定手机，逗号分隔）</span>
              <input name="atMobilesText" type="text" class="field-input"
                value="${esc(dt.atMobilesText || '')}"
                placeholder="13800138000, 13900139000"
                ${dtRo ? 'readonly' : ''} />
            </label>
            <label class="field field-check">
              <input name="atAll" type="checkbox" ${dt.atAll ? 'checked' : ''} ${dtRo ? 'disabled' : ''} />
              <span>@所有人</span>
            </label>
            <label class="field field-check">
              <input name="atAlways" type="checkbox" ${dt.atAlways !== false ? 'checked' : ''} ${dtRo ? 'disabled' : ''} />
              <span>无异常时也 @（推荐：避免漏看「服务是否还活着」）</span>
            </label>
            <p class="hint">机器人安全设置若开了「自定义关键词」，请包含「RPA」或关掉关键词；@ 手机号须是群成员且与钉钉账号绑定一致。</p>
            <div class="settings-actions">
              <button type="submit" class="btn primary" id="btn-dt-save" ${dtRo ? 'disabled' : ''}>保存</button>
              <button type="button" class="btn" id="btn-dt-test" ${dtRo ? 'disabled' : ''}>发送测试</button>
              <button type="button" class="btn ghost" id="btn-dt-clear" ${dtRo ? 'disabled' : ''}>清除密钥</button>
            </div>
            <p id="dingtalk-test-result" class="meta mt" role="status"></p>
            <p class="hint mt">「发送测试」会立即推送一条当前晨报（不要求已启用开关）。请先保存 Webhook 与 @ 设置。</p>
          </form>
        </div>
      </div>

      <div id="settings-pane-success-check" class="settings-pane ${
        tab === 'success-check' ? 'is-active' : ''
      }" role="tabpanel" ${tab === 'success-check' ? '' : 'hidden'}>
        <div class="panel settings-panel">
          <p class="meta mb">
            ${sc.enabled !== false ? '已启用' : '已关闭'}
            · 来源 <code>${esc(sc.source || 'default')}</code>
            ${sc.updatedAt ? `· ${esc(formatTime(sc.updatedAt))}` : ''}
            ${
              sc.allowlistMode
                ? `· 限定 ${esc((sc.robotUuidAllowlist || []).length)} 个应用`
                : '· 全部应用（受每轮上限）'
            }
          </p>
          <p class="hint mb">
            ${esc(sc.productHint || '对状态成功的任务抽查末尾日志，发现被流程吞掉的错误。')}
          </p>
          ${
            scRo
              ? `<div class="tip mb">settingsEnabled=false，当前只读。</div>`
              : ''
          }
          <form id="success-check-form" class="settings-form" autocomplete="off">
            <label class="field field-check">
              <input name="enabled" type="checkbox" ${sc.enabled !== false ? 'checked' : ''} ${
                scRo || scEnv.enabled ? 'disabled' : ''
              } />
              <span>启用成功抽检 ${scEnv.enabled ? '<span class="field-lock">环境变量锁定</span>' : ''}</span>
            </label>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">每轮最多抽检条数 ${
                  scEnv.maxPerPoll ? '<span class="field-lock">环境变量</span>' : ''
                }</span>
                <input name="maxPerPoll" type="number" min="0" max="200" step="1" class="field-input"
                  value="${esc(sc.maxPerPoll != null ? sc.maxPerPoll : 25)}"
                  ${scRo || scEnv.maxPerPoll ? 'readonly' : ''} />
              </label>
              <label class="field">
                <span class="field-label">每应用每轮上限</span>
                <input name="maxPerAppPerPoll" type="number" min="0" max="50" step="1" class="field-input"
                  value="${esc(sc.maxPerAppPerPoll != null ? sc.maxPerAppPerPoll : 5)}"
                  ${scRo ? 'readonly' : ''} />
              </label>
            </div>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">查看末尾日志条数</span>
                <input name="tailSize" type="number" min="1" max="50" step="1" class="field-input"
                  value="${esc(sc.tailSize != null ? sc.tailSize : 10)}" ${scRo ? 'readonly' : ''} />
              </label>
              <label class="field">
                <span class="field-label">请求间隔 ms（防限流）</span>
                <input name="minIntervalMs" type="number" min="0" max="5000" step="10" class="field-input"
                  value="${esc(sc.minIntervalMs != null ? sc.minIntervalMs : 220)}"
                  ${scRo ? 'readonly' : ''} />
              </label>
            </div>
            <div class="field sc-picker-block">
              <span class="field-label">只抽检这些应用</span>
              <p class="hint mb">
                表格中<strong>不勾选任何行</strong> = 不限定（全部可抽检，仍受每轮上限）。勾选后<strong>仅</strong>抽检已选应用。
              </p>
              <div class="sc-table-panel" id="sc-picker" data-readonly="${scRo ? '1' : '0'}">
                <div class="sc-table-toolbar">
                  <input
                    type="search"
                    class="field-input sc-table-filter"
                    id="sc-table-filter"
                    placeholder="筛选表格（应用名 / UUID）…"
                    autocomplete="off"
                    ${scRo ? 'disabled' : ''}
                  />
                  <div class="sc-table-actions">
                    <button type="button" class="btn sm ghost" id="btn-sc-check-visible" ${scRo ? 'disabled' : ''}>
                      勾选当前筛选
                    </button>
                    <button type="button" class="btn sm ghost" id="btn-sc-clear" ${scRo ? 'disabled' : ''}>
                      清空勾选
                    </button>
                  </div>
                </div>
                <p class="meta sc-mode-hint" id="sc-mode-hint" aria-live="polite"></p>
                <div class="sc-table-scroll">
                  <table class="sc-table" id="sc-table">
                    <thead>
                      <tr>
                        <th class="sc-col-check" scope="col">
                          <span class="sr-only">选择</span>
                        </th>
                        <th scope="col">应用</th>
                        <th scope="col">robotUuid</th>
                      </tr>
                    </thead>
                    <tbody id="sc-table-body"></tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="settings-actions">
              <button type="submit" class="btn primary" ${scRo ? 'disabled' : ''}>保存</button>
            </div>
            <p id="success-check-result" class="meta mt" role="status"></p>
          </form>
        </div>
      </div>`;

    const settingsTabHash = {
      llm: '#/settings/llm',
      prompts: '#/settings/prompts',
      dingtalk: '#/settings/dingtalk',
      'success-check': '#/settings/success-check',
    };

    // 切换 Tab：改 hash，避免整页堆叠
    content.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-settings-tab') || 'llm';
        const hash = settingsTabHash[next] || '#/settings/llm';
        if (location.hash === hash) {
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
      ['llm', 'prompts', 'dingtalk', 'success-check'].forEach((id) => {
        const pane = $(`#settings-pane-${id}`);
        if (!pane) return;
        const on = id === next;
        pane.classList.toggle('is-active', on);
        if (on) pane.removeAttribute('hidden');
        else pane.setAttribute('hidden', '');
      });
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

    // 钉钉晨报
    const dtForm = $('#dingtalk-form');
    const dtResult = $('#dingtalk-test-result');
    function dingtalkBody({ clearSecrets = false } = {}) {
      if (!dtForm) return {};
      const fd = new FormData(dtForm);
      const body = {
        enabled: dtForm.querySelector('[name=enabled]')?.checked === true,
        recentDays: parseInt(String(fd.get('recentDays') || '1'), 10),
        topN: parseInt(String(fd.get('topN') || '8'), 10),
        atMobilesText: String(fd.get('atMobilesText') || '').trim(),
        atAll: dtForm.querySelector('[name=atAll]')?.checked === true,
        atAlways: dtForm.querySelector('[name=atAlways]')?.checked !== false,
      };
      if (clearSecrets) {
        body.clearWebhook = true;
        body.clearSecret = true;
        body.webhookUrl = '__CLEAR__';
        body.secret = '__CLEAR__';
      } else {
        const w = String(fd.get('webhookUrl') || '').trim();
        const s = String(fd.get('secret') || '');
        if (w) body.webhookUrl = w;
        if (s.trim()) body.secret = s.trim();
      }
      return body;
    }
    if (dtForm) {
      dtForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (dtRo) return;
        const btn = $('#btn-dt-save');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '保存中…';
        }
        try {
          const r = await api('/api/settings/dingtalk', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(dingtalkBody()),
          });
          if (r && r.ok) {
            toast('钉钉设置已保存');
            await renderSettings('dingtalk');
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
    const dtTest = $('#btn-dt-test');
    if (dtTest) {
      dtTest.addEventListener('click', async () => {
        dtTest.disabled = true;
        dtTest.textContent = '发送中…';
        if (dtResult) dtResult.textContent = '';
        try {
          // 若表单填了新 webhook，先保存再测
          if (!dtRo) {
            await api('/api/settings/dingtalk', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(dingtalkBody()),
            });
          }
          const r = await api('/api/settings/dingtalk/test', { method: 'POST' });
          if (r && r.ok) {
            const msg = `已发送${r.stats && r.stats.healthy ? '（无异常）' : `（失败 ${r.stats?.total ?? '?'}）`}`;
            if (dtResult) dtResult.textContent = msg;
            toast(msg);
            await renderSettings('dingtalk');
          } else {
            const msg = r.message || r.code || '发送失败';
            if (dtResult) dtResult.textContent = msg;
            toast(msg);
          }
        } catch (err) {
          if (dtResult) dtResult.textContent = err.message || '发送失败';
          toast(err.message || '发送失败');
        } finally {
          dtTest.disabled = false;
          dtTest.textContent = '发送测试';
        }
      });
    }
    const dtClear = $('#btn-dt-clear');
    if (dtClear) {
      dtClear.addEventListener('click', async () => {
        if (!confirm('清除已保存的 Webhook 与 Secret？')) return;
        try {
          const r = await api('/api/settings/dingtalk', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(dingtalkBody({ clearSecrets: true })),
          });
          if (r && r.ok) {
            toast('已清除 Webhook / Secret');
            await renderSettings('dingtalk');
          } else toast(r.message || '清除失败');
        } catch (err) {
          toast(err.message || '清除失败');
        }
      });
    }

    // 成功抽检：表格勾选（可筛选）
    const scForm = $('#success-check-form');
    const scResult = $('#success-check-result');
    const scCatalog = (sc.appChoices || []).map((a) => ({
      robotUuid: String(a.robotUuid || ''),
      name: String(a.name || a.robotUuid || ''),
    }));
    /** @type {Set<string>} */
    const scSelected = new Set(
      (sc.robotUuidAllowlist || []).map(String).filter((id) => id),
    );
    /** 当前筛选后可见的 uuid（用于「勾选当前筛选」） */
    let scVisibleIds = [];

    function updateScHint() {
      const hint = $('#sc-mode-hint');
      if (!hint) return;
      const vis = scVisibleIds.length;
      const total = scCatalog.length;
      if (!scSelected.size) {
        hint.textContent = `未限定 · 显示 ${vis}/${total} 个应用 · 全部可抽检`;
      } else {
        hint.textContent = `已勾选 ${scSelected.size} 个 · 显示 ${vis}/${total} 个应用`;
      }
    }

    function renderScTable() {
      const tbody = $('#sc-table-body');
      if (!tbody) return;
      const q = String($('#sc-table-filter')?.value || '')
        .trim()
        .toLowerCase();
      const rows = scCatalog.filter((a) => {
        if (!a.robotUuid) return false;
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) || a.robotUuid.toLowerCase().includes(q)
        );
      });
      scVisibleIds = rows.map((a) => a.robotUuid);

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="sc-table-empty">${
          q ? '无匹配应用' : '暂无应用'
        }</td></tr>`;
        updateScHint();
        return;
      }

      tbody.innerHTML = rows
        .map((a) => {
          const checked = scSelected.has(a.robotUuid);
          return `<tr class="sc-row${checked ? ' is-checked' : ''}" data-id="${esc(a.robotUuid)}">
            <td class="sc-col-check">
              <input type="checkbox" class="sc-row-check" value="${esc(a.robotUuid)}"
                ${checked ? 'checked' : ''} ${scRo ? 'disabled' : ''}
                aria-label="选择 ${esc(a.name)}" />
            </td>
            <td class="sc-col-name">${esc(a.name)}</td>
            <td class="sc-col-id"><code>${esc(a.robotUuid)}</code></td>
          </tr>`;
        })
        .join('');

      if (!scRo) {
        tbody.querySelectorAll('.sc-row-check').forEach((box) => {
          box.addEventListener('change', () => {
            const id = box.value;
            if (box.checked) scSelected.add(id);
            else scSelected.delete(id);
            const tr = box.closest('tr');
            if (tr) tr.classList.toggle('is-checked', box.checked);
            updateScHint();
          });
        });
        // 点行也可切换（除了点 checkbox 本身）
        tbody.querySelectorAll('tr.sc-row').forEach((tr) => {
          tr.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('input')) return;
            const box = tr.querySelector('.sc-row-check');
            if (!box || box.disabled) return;
            box.checked = !box.checked;
            box.dispatchEvent(new Event('change'));
          });
        });
      }
      updateScHint();
    }

    renderScTable();

    const scFilter = $('#sc-table-filter');
    if (scFilter) {
      scFilter.addEventListener('input', () => renderScTable());
    }

    const btnScVisible = $('#btn-sc-check-visible');
    if (btnScVisible && !scRo) {
      btnScVisible.addEventListener('click', () => {
        scVisibleIds.forEach((id) => scSelected.add(id));
        renderScTable();
      });
    }

    const btnScClear = $('#btn-sc-clear');
    if (btnScClear && !scRo) {
      btnScClear.addEventListener('click', () => {
        scSelected.clear();
        renderScTable();
      });
    }

    if (scForm) {
      scForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = scForm.querySelector('button[type=submit]');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '保存中…';
        }
        if (scResult) scResult.textContent = '';
        try {
          const fd = new FormData(scForm);
          const ids = [...scSelected];
          const body = {
            enabled: scForm.querySelector('[name=enabled]')?.checked === true,
            maxPerPoll: parseInt(String(fd.get('maxPerPoll') || '25'), 10),
            maxPerAppPerPoll: parseInt(String(fd.get('maxPerAppPerPoll') || '5'), 10),
            tailSize: parseInt(String(fd.get('tailSize') || '10'), 10),
            minIntervalMs: parseInt(String(fd.get('minIntervalMs') || '220'), 10),
            robotUuidAllowlist: ids,
          };
          if (!ids.length) body.clearAllowlist = true;
          const r = await api('/api/settings/success-check', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (r && r.ok) {
            toast('成功抽检设置已保存');
            if (scResult) {
              scResult.textContent = r.allowlistMode
                ? `已限定 ${(r.robotUuidAllowlist || []).length} 个应用`
                : '未限定应用（全量抽检，受每轮上限）';
            }
            await renderSettings('success-check');
          } else {
            toast(r.message || r.code || '保存失败');
            if (scResult) scResult.textContent = r.message || r.code || '保存失败';
          }
        } catch (err) {
          toast(err.message || '保存失败');
          if (scResult) scResult.textContent = err.message || '保存失败';
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = '保存';
          }
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

  async function renderPollRuns() {
    setNav('poll-runs');
    setHeader('拉取日志', '每次 poll 从影刀拉到的失败任务步骤日志');
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载拉取记录…');

    const data = await api('/api/poll-runs?limit=50');
    if (!data || data.ok === false) {
      content.innerHTML = `<div class="err">加载失败：${esc(data && (data.message || data.code))}</div>`;
      return;
    }
    const list = data.runs || [];
    content.innerHTML = `
      <div class="actions mb">
        <button type="button" class="btn primary" id="btn-poll-from-runs">立即拉取</button>
        <span class="meta">保留最近约 50 次 · 仅失败任务日志</span>
      </div>
      <div class="panel">
        <h2>拉取记录 <span class="meta">${list.length}</span></h2>
        ${
          list.length
            ? `<div class="list">${list
                .map((r) => {
                  const st = r.stats || {};
                  const sub = [
                    pollTriggerLabel(r.trigger),
                    `扫描 ${st.scanned ?? 0}`,
                    `失败 ${st.failed ?? 0}`,
                    `有日志 ${r.logJobCount ?? 0}`,
                    r.logErrorCount ? `拉取失败 ${r.logErrorCount}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return `<a class="list-item" href="#/poll-runs/${encodeURIComponent(r.id)}">
                    <div class="item-main">
                      <div class="item-title">${esc(formatTime(r.finishedAt || r.startedAt))}</div>
                      <div class="item-sub">${esc(sub)}</div>
                    </div>
                    <div class="item-side">
                      <span class="badge">${esc(pollTriggerLabel(r.trigger))}</span>
                      <span class="faint" style="font-size:12px">查看 →</span>
                    </div>
                  </a>`;
                })
                .join('')}</div>`
            : empty(
                '还没有拉取记录',
                '点上方「立即拉取」，或等定时 poll 跑完后会出现在这里',
              )
        }
      </div>
    `;
    const btn = $('#btn-poll-from-runs');
    if (btn) {
      btn.onclick = () => triggerPollNow(btn);
    }
  }

  async function renderPollRun(id) {
    setNav('poll-runs');
    setHeader('拉取详情', id);
    setActiveHandoff();
    content.innerHTML = loadingHtml('加载该次日志…');

    const data = await api(`/api/poll-runs/${encodeURIComponent(id)}`);
    if (!data || !data.ok) {
      content.innerHTML = `
        <div class="err">${esc((data && (data.message || data.code)) || '加载失败')}</div>
        <div class="actions mt">
          <a class="btn ghost" href="#/poll-runs">返回列表</a>
        </div>`;
      return;
    }
    const run = data.run || {};
    const st = run.stats || {};
    const win = run.window || {};
    const jobs = run.jobs || [];

    const metaBits = [
      `触发：${pollTriggerLabel(run.trigger)}`,
      `结束：${formatTime(run.finishedAt)}`,
      `扫描 ${st.scanned ?? 0}`,
      `失败 ${st.failed ?? 0}`,
      `新入队 ${st.enqueued ?? 0}`,
      `更新 ${st.updated ?? 0}`,
      `有日志 ${run.logJobCount ?? 0}`,
    ];
    if (win.triggerTimeBegin) {
      metaBits.push(`时间窗 ${win.triggerTimeBegin} → ${win.triggerTimeEnd}`);
    }

    content.innerHTML = `
      <div class="actions mb">
        <a class="btn ghost" href="#/poll-runs">← 返回列表</a>
        <button type="button" class="btn" id="btn-poll-again">再拉一次</button>
      </div>
      <div class="panel mb">
        <h2>摘要</h2>
        <p class="meta">${metaBits.map((x) => esc(x)).join(' · ')}</p>
        <p class="meta mono-id">id: ${esc(run.id)}</p>
      </div>
      <div class="panel">
        <h2>失败任务日志 <span class="meta">${jobs.length}</span></h2>
        ${
          jobs.length
            ? `<div class="poll-job-list">${jobs
                .map((j, idx) => {
                  const logs = j.logs || [];
                  const errCount = logs.filter((l) => isErrorLogLevel(l.level, l.text)).length;
                  const statusBits = [];
                  if (j.logFetchError) statusBits.push(`日志拉取失败`);
                  else if (j.logSkipped) statusBits.push('未拉日志');
                  else statusBits.push(`${logs.length} 行`);
                  if (errCount) statusBits.push(`${errCount} 错误行`);
                  // 影刀术语：应用 = robotName；机器人 = robotClientName（运行端）
                  const appName = String(j.robotName || '').trim();
                  const robotClient = String(j.robotClientName || '').trim();
                  const taskName = String(j.taskName || '').trim();
                  const title =
                    appName || taskName || robotClient || j.jobUuid || j.fingerprint || `job ${idx + 1}`;
                  const sub = [
                    robotClient ? `机器人 ${robotClient}` : '',
                    taskName && taskName !== appName ? taskName : '',
                    j.flowName || '',
                    j.errorType || '',
                    j.failureAt ? formatTime(j.failureAt) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const logHtml = j.logFetchError
                    ? `<div class="err sm">拉取错误：${esc(j.logFetchError)}</div>`
                    : j.logSkipped
                      ? `<div class="meta">本轮关闭了日志补全（--no-enrich）</div>`
                      : logs.length
                        ? `<div class="job-log-lines" role="log">${logs
                            .map((l) => {
                              const err = isErrorLogLevel(l.level, l.text);
                              const loc = [l.flowName, l.lineNumber].filter(Boolean).join(':');
                              const meta = [loc, l.time].filter(Boolean).join(' · ');
                              return `<div class="job-log-line${err ? ' is-error' : ''}">
                                <span class="job-log-level">${esc(l.level || '—')}</span>
                                <div class="job-log-main">
                                  ${meta ? `<div class="job-log-meta">${esc(meta)}</div>` : ''}
                                  <div class="job-log-text">${esc(l.text || '')}</div>
                                </div>
                              </div>`;
                            })
                            .join('')}</div>`
                        : `<div class="meta">无步骤日志</div>`;
                  const fpLink = j.fingerprint
                    ? `<a class="btn sm ghost" href="#/findings/${encodeURIComponent(j.fingerprint)}">问题详情</a>`
                    : '';
                  const appLink = j.robotUuid
                    ? `<a class="btn sm ghost" href="#/apps/${encodeURIComponent(j.robotUuid)}">应用</a>`
                    : '';
                  return `<details class="poll-job" ${idx === 0 ? 'open' : ''}>
                    <summary>
                      <span class="poll-job-title">${esc(title)}</span>
                      <span class="poll-job-meta">${esc(
                        [robotClient ? `机器人 ${robotClient}` : '', ...statusBits]
                          .filter(Boolean)
                          .join(' · '),
                      )}</span>
                    </summary>
                    <div class="poll-job-body">
                      ${sub ? `<p class="item-sub">${esc(sub)}</p>` : ''}
                      ${j.remark ? `<p class="poll-job-remark">${esc(j.remark)}</p>` : ''}
                      <div class="kv mb">
                        <div class="k">应用</div><div class="v">${esc(appName || '—')}</div>
                        <div class="k">机器人</div><div class="v">${esc(robotClient || '—')}</div>
                        ${
                          taskName && taskName !== appName
                            ? `<div class="k">任务</div><div class="v">${esc(taskName)}</div>`
                            : ''
                        }
                        <div class="k">jobUuid</div><div class="v mono">${esc(j.jobUuid || '—')}</div>
                        ${
                          j.fingerprint
                            ? `<div class="k">指纹</div><div class="v mono">${esc(j.fingerprint)}</div>`
                            : ''
                        }
                      </div>
                      <div class="actions mb sm-actions">${fpLink}${appLink}</div>
                      ${logHtml}
                    </div>
                  </details>`;
                })
                .join('')}</div>`
            : empty('本次无失败任务', '没有可展示的 job 日志')
        }
      </div>
    `;
    const again = $('#btn-poll-again');
    if (again) again.onclick = () => triggerPollNow(again);
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

  /** 手动触发 poll（POST /api/poll），与定时轮询同一逻辑 */
  async function triggerPollNow(btn) {
    const el = btn || $('#btn-poll-now') || $('#btn-poll-home');
    if (el && el.disabled) return;
    const idleLabel =
      el && el.id === 'btn-poll-home' ? '立即拉取' : el && el.id === 'btn-poll-now' ? '立即拉取' : '立即拉取';
    if (el) {
      el.disabled = true;
      el.textContent = '拉取中…';
      el.classList.add('busy');
    }
    toast('正在从影刀拉取最新记录（可能需数十秒）…', 8000);
    let pollOk = false;
    try {
      const r = await api('/api/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (r && r.ok) {
        pollOk = true;
        const s = r.stats || {};
        // 注意：stats.failed = 影刀失败任务数，不是「本次请求失败」
        const parts = [
          '拉取完成',
          `扫描 ${s.scanned ?? 0}`,
          `失败任务 ${s.failed ?? 0}`,
          `新入队 ${s.enqueued ?? 0}`,
          `更新 ${s.updated ?? 0}`,
        ];
        if (s.urgent) parts.push(`紧急 ${s.urgent}`);
        if (s.truncated) parts.push('已达翻页上限');
        if (s.soft && s.soft.enabled !== false) {
          parts.push(
            `成功抽检 ${s.soft.audited ?? 0}（命中 ${s.soft.softHit ?? 0}）`,
          );
        }
        if (r.pollRun && r.pollRun.id) {
          parts.push(`日志 ${r.pollRun.logJobCount ?? 0} 条已归档`);
        }
        toast(parts.join(' · '), 5000);
        // 刷新 UI 失败不应掩盖「拉取已成功」（lastPollAt 已更新）
        try {
          await refreshRuntime();
          const h = location.hash || '';
          // 在「拉取日志」页：跳到本次详情；在总览：刷新当前页
          if (h.startsWith('#/poll-runs') && r.pollRun && r.pollRun.id) {
            location.hash = `#/poll-runs/${encodeURIComponent(r.pollRun.id)}`;
          } else if (h === '' || h === '#' || h === '#/' || h.startsWith('#/poll-runs')) {
            await route();
          }
        } catch (refreshErr) {
          toast(
            `拉取已成功，但页面刷新失败：${refreshErr.message || refreshErr}。可点顶部「刷新」`,
            6000,
          );
        }
      } else {
        const msg = (r && (r.message || r.code)) || '未知错误';
        toast(`拉取未完成：${msg}`, 6000);
      }
    } catch (e) {
      // 网络中断等：若服务端已跑完 poll，时间可能已变；提示以接口为准
      toast(`拉取未完成：${e.message || '网络或服务异常'}`, 6000);
    } finally {
      if (el) {
        el.disabled = false;
        el.textContent = idleLabel;
        el.classList.remove('busy');
      }
    }
    return pollOk;
  }

  /** 触发浏览器下载文本文件 */
  function downloadTextFile(filename, text, mime = 'text/markdown;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.md';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /**
   * 从 API 拉取 Markdown 并下载
   * @param {string} apiPath
   * @param {string} [fallbackName]
   */
  async function downloadMarkdownFromApi(apiPath, fallbackName = 'export.md') {
    const data = await api(apiPath);
    if (!data || !data.ok || !data.markdown) {
      throw new Error((data && data.message) || '导出失败');
    }
    downloadTextFile(data.filename || fallbackName, data.markdown);
    return data;
  }

  /**
   * 将工作台 Tab 克隆为「文档式」打印页 → 另存为 PDF
   * - 去掉工具栏 / badge / 源码折叠等 screen chrome
   * - 单标题，避免 h1 + graph-bar + brief-title 三重标题
   * - 图解除 max-height，避免 PDF 裁切
   * @param {string} title
   * @param {string|HTMLElement} source
   */
  function printFlowDocument(title, source) {
    const node =
      typeof source === 'string' ? document.querySelector(source) : source;
    if (!node) {
      toast('没有可打印的内容');
      return;
    }

    const clone = node.cloneNode(true);

    // 去掉工作台 chrome（不是文档内容）
    clone
      .querySelectorAll(
        [
          '.btn',
          '.actions',
          '.no-print',
          '.graph-bar',
          '.badge',
          'details.raw',
          '.loading-block',
          '.skeleton-stack',
          '.loading-label',
        ].join(','),
      )
      .forEach((el) => el.remove());

    // 仅展开「内容型」details；源码 / 原始 JSON 已删
    clone.querySelectorAll('details').forEach((d) => {
      d.open = true;
      d.removeAttribute('style');
    });

    // 业务解读：用 brief 标题作文档标题，避免页眉 + brief-title 重复
    let docTitle = String(title || document.title || '导出').trim();
    const briefTitleEl = clone.querySelector('.brief-title');
    if (briefTitleEl) {
      const t = (briefTitleEl.textContent || '').trim();
      if (t) docTitle = t;
      briefTitleEl.remove();
    }

    // 交互残留（全屏缩放）对打印无意义
    clone.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));
    clone.querySelectorAll('[style]').forEach((el) => {
      const s = el.getAttribute('style') || '';
      if (/cursor\s*:/i.test(s)) {
        el.style.cursor = 'default';
      }
    });
    clone.querySelectorAll('.graph-host').forEach((el) => {
      el.style.cursor = 'default';
    });

    // 空壳 panel 清理：去掉只剩空白的容器边距噪音（保留有内容的）
    clone.querySelectorAll('.panel').forEach((p) => {
      if (!(p.textContent || '').trim() && !p.querySelector('img, svg, table, canvas')) {
        p.remove();
      }
    });

    const bodyHtml = clone.innerHTML.replace(/<\/script/gi, '<\\/script');
    if (!bodyHtml.trim()) {
      toast('没有可打印的内容');
      return;
    }

    const cssHref = `${window.location.origin}/styles.css`;
    // 与 DESIGN.md 对齐的打印文档样式（屏幕 chrome 已剥离）
    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(docTitle)}</title>
  <link rel="stylesheet" href="${esc(cssHref)}" />
  <style>
    /* 文档页：白底、冷静排版，服务归档而非工作台 UI */
    html, body {
      background: #fff !important;
      color: #0f172a;
    }
    body.print-export {
      margin: 0;
      padding: 24px 28px 40px;
      max-width: 920px;
      font-family: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body.print-export .print-export-head {
      margin: 0 0 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(15, 23, 42, 0.12);
    }
    body.print-export .print-export-head h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.03em;
      line-height: 1.25;
      color: #0f172a;
      text-wrap: balance;
    }
    body.print-export .print-export-body {
      min-width: 0;
    }

    /* 去掉卡片阴影 / 多余边框，变成连续文档 */
    body.print-export .panel {
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      padding: 0 0 18px !important;
      margin: 0 0 4px !important;
    }
    body.print-export details.panel,
    body.print-export details.fold {
      margin: 16px 0 0 !important;
      padding: 14px 0 0 !important;
      border-top: 1px solid rgba(15, 23, 42, 0.08) !important;
    }
    body.print-export details > summary {
      list-style: none;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #64748b;
      margin: 0 0 10px;
      cursor: default;
    }
    body.print-export details > summary::-webkit-details-marker { display: none; }

    body.print-export .btn,
    body.print-export .actions,
    body.print-export .badge,
    body.print-export .graph-bar,
    body.print-export .no-print { display: none !important; }

    /* 业务解读：页眉已是标题，hero 只留目的与元信息 */
    body.print-export .brief { gap: 18px; }
    body.print-export .brief-hero {
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(15, 23, 42, 0.08);
    }
    body.print-export .brief-purpose {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      color: #334155;
      max-width: 68ch;
      text-wrap: pretty;
    }
    body.print-export .brief-meta {
      margin: 10px 0 0;
      font-size: 12px;
      color: #64748b;
    }
    body.print-export .brief-label {
      color: #64748b;
    }
    body.print-export .brief-diagram-note {
      font-size: 12px;
      color: #64748b;
    }

    /* 图：打印取消屏幕限高，完整出图 */
    body.print-export .graph,
    body.print-export .graph.graph-biz,
    body.print-export .graph.graph-hero {
      max-height: none !important;
      min-height: 0 !important;
      overflow: visible !important;
      background: #fafbfc !important;
      border: 1px solid rgba(15, 23, 42, 0.08) !important;
      box-shadow: none !important;
      padding: 12px !important;
      page-break-inside: avoid;
    }
    body.print-export .graph-host {
      max-height: none !important;
      min-height: 0 !important;
      overflow: visible !important;
      cursor: default !important;
    }
    body.print-export .graph-host img,
    body.print-export img.graph-img,
    body.print-export img.graph-img-biz {
      display: block;
      max-width: 100% !important;
      max-height: none !important;
      width: auto !important;
      height: auto !important;
      margin: 0 auto;
    }

    body.print-export .summary-line {
      margin: 0 0 14px;
      max-width: 72ch;
      color: #475569;
    }
    body.print-export .table { font-size: 12px; }
    body.print-export .plain-list { margin: 0; }
    body.print-export h2 {
      break-after: avoid;
      page-break-after: avoid;
    }
    body.print-export .brief-steps li,
    body.print-export .brief-list li,
    body.print-export .plain-list li {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    @page {
      margin: 14mm 14mm 16mm;
    }
    @media print {
      body.print-export {
        padding: 0;
        max-width: none;
      }
      body.print-export .print-export-head {
        margin-bottom: 14px;
      }
      /* 大图允许跨页，避免整页留白 */
      body.print-export .graph {
        page-break-inside: auto;
      }
    }
  </style>
</head>
<body class="print-export">
  <header class="print-export-head">
    <h1>${esc(docTitle)}</h1>
  </header>
  <div class="print-export-body">${bodyHtml}</div>
  <script>
    (function () {
      var printed = false;
      function goPrint() {
        if (printed) return;
        printed = true;
        try { window.focus(); window.print(); } catch (e) {}
      }
      function whenImagesReady(cb) {
        var imgs = Array.prototype.slice.call(document.images || []);
        var settled = false;
        var finish = function () {
          if (settled) return;
          settled = true;
          cb();
        };
        if (!imgs.length) { finish(); return; }
        var left = imgs.length;
        var done = function () {
          left -= 1;
          if (left <= 0) finish();
        };
        imgs.forEach(function (img) {
          if (img.complete) done();
          else {
            img.addEventListener('load', done);
            img.addEventListener('error', done);
          }
        });
        setTimeout(finish, 4000);
      }
      function start() {
        whenImagesReady(function () { setTimeout(goPrint, 120); });
      }
      if (document.readyState === 'complete') start();
      else window.addEventListener('load', start);
    })();
  <\/script>
</body>
</html>`;

    let url;
    try {
      const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
      url = URL.createObjectURL(blob);
    } catch (e) {
      toast(`无法生成打印页：${e.message || e}`);
      return;
    }

    const w = window.open(url, '_blank');
    if (!w) {
      URL.revokeObjectURL(url);
      toast('浏览器拦截了弹窗，请允许本站弹窗后重试，或使用导出 Markdown');
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
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
    const priority = data.priorityQueue || [];
    const und = q.undiagnosed ?? 0;
    const byBucket = q.byBucket || {};
    const devCount =
      q.devActionable ??
      (byBucket.code || 0) + (byBucket.element || 0) + (byBucket.data_config || 0);
    const opsCount = q.opsNoise ?? (byBucket.env_robot || 0) + (byBucket.schedule || 0);
    const recent = getRecentApps();

    if (la.usersRoot) setActiveHandoff({ path: la.usersRoot });

    function bucketBadgeHtml(item) {
      if (!item || !item.bucketLabel) return '';
      const cls =
        item.actionable === 'ops'
          ? 'badge warn'
          : item.actionable === 'dev'
            ? 'badge ok'
            : 'badge';
      return `<span class="${cls}" title="技术分流">${esc(item.bucketLabel)}</span>`;
    }

    function matchBucketFilter(item, filter) {
      if (!filter || filter === 'all') return true;
      if (filter === 'dev') {
        return (
          item.actionable === 'dev' ||
          item.bucket === 'code' ||
          item.bucket === 'element' ||
          item.bucket === 'data_config'
        );
      }
      if (filter === 'ops') {
        return (
          item.actionable === 'ops' ||
          item.bucket === 'env_robot' ||
          item.bucket === 'schedule'
        );
      }
      return item.bucket === filter;
    }

    function renderPriorityList(filter) {
      const filtered = priority.filter((item) => matchBucketFilter(item, filter));
      if (!filtered.length) {
        const pTags = q.priorityTags || (data.appMeta && data.appMeta.priorityTags) || [];
        const tagMode = (q.priorityScope || data.appMeta?.priorityScope) === 'tags' || pTags.length > 0;
        return empty(
          filter === 'dev' ? '暂无可开发优先项' : '暂无优先项',
          filter === 'dev'
            ? '当前优先队列里没有代码/配置类失败（多为环境或调度）'
            : tagMode
              ? pTags.length
                ? `优先池标签「${pTags.join('、')}」下，近窗没有待处理失败；可给应用打业务标签或调整池子`
                : '已开启标签优先池但未选标签'
              : '近窗内没有待处理失败，或均已稍后/处理完成/不再提醒',
          '<a class="btn sm" href="#/apps">浏览应用</a>',
        );
      }
      return `<div class="list">${filtered
        .map((item, idx) => {
          const href = `#/findings/${encodeURIComponent(item.fingerprint)}`;
          // 影刀术语：应用 = robotName；机器人 = robotClientName（运行端）
          const appName = String(item.robotName || '').trim();
          const appUuid = String(item.robotUuid || '').trim();
          const appLabel = appName || appUuid || '';
          const robotClient = String(item.robotClientName || '').trim();
          const taskName = String(item.taskName || '').trim();
          const flow =
            item.flowName && !/^(unknown-flow|no-flow|调度层)$/i.test(String(item.flowName).trim())
              ? String(item.flowName).trim()
              : '';
          const errType = String(item.errorType || '').trim();

          // 标题 = 流程 · 错误 · 应用名（便于识别是哪个应用的问题）
          const titleParts = [];
          if (flow) titleParts.push(flow);
          if (errType) titleParts.push(errType);
          if (appLabel && !titleParts.includes(appLabel)) titleParts.push(appLabel);
          const title =
            titleParts.join(' · ') ||
            String(item.fingerprint || '').slice(0, 48) ||
            '失败';

          const time = item.lastSeen ? relTime(item.lastSeen) : '';
          const occ = item.occurrenceCount > 1 ? `${item.occurrenceCount} 次` : '';
          // 副行：机器人（客户端）/ 任务 / 时间
          const subBits = [];
          if (robotClient) subBits.push(`机器人 ${robotClient}`);
          if (taskName && taskName !== appLabel) subBits.push(taskName);
          if (time) subBits.push(time);
          if (occ) subBits.push(occ);
          const sub = subBits.join(' · ');

          const softBadge =
            item.failureKind === 'soft'
              ? '<span class="badge warn" title="成功抽检：任务状态成功，日志末尾有错误">抽检命中</span>'
              : '';
          const badges =
            softBadge +
            bucketBadgeHtml(item) +
            (item.reasonLabels || [])
              .map((lab, i) => {
                const reason = (item.reasons && item.reasons[i]) || '';
                const cls =
                  reason === 'undiagnosed' || reason === 'regressed'
                    ? 'badge warn'
                    : reason === 'cross_app'
                      ? 'badge danger'
                      : reason === 'can_preview'
                        ? 'badge ok'
                        : reason === 'recent_open'
                          ? 'badge faint'
                          : 'badge';
                return `<span class="${cls}">${esc(lab)}</span>`;
              })
              .join('');
          return `<a class="list-item" href="${href}">
            <div class="item-main">
              <div class="item-title item-title-priority"><span class="priority-rank">${idx + 1}</span>${esc(title)}</div>
              ${sub ? `<div class="item-sub item-sub-priority">${esc(sub)}</div>` : ''}
            </div>
            <div class="item-side">
              <div class="badges">${badges}</div>
              <span class="item-go">处理 →</span>
            </div>
          </a>`;
        })
        .join('')}</div>`;
    }

    // chip 数字 = 今日优先列表内计数；UI 只保留三档（细 bucket 仍在 badge/API）
    function countInPriority(filter) {
      return priority.filter((item) => matchBucketFilter(item, filter)).length;
    }
    const bucketChipDefs = [
      { id: 'all', label: `全部 ${priority.length}` },
      { id: 'dev', label: `可开发 ${countInPriority('dev')}` },
      { id: 'ops', label: `环境/调度 ${countInPriority('ops')}` },
    ];

    let priorityFilter = 'all';
    try {
      const saved = localStorage.getItem('rpa_wb_bucket_filter');
      if (saved && bucketChipDefs.some((c) => c.id === saved)) priorityFilter = saved;
    } catch {
      // ignore
    }

    // 失败指纹副文案：仅描述「全 queue」，不与下方优先列表并列成第二套大数字
    const queueHintParts = [
      und > 0 ? `未诊断 ${und}` : null,
      devCount > 0 ? `可开发 ${devCount}` : null,
      opsCount > 0 ? `环境/调度 ${opsCount}` : null,
      (byBucket.unknown || 0) > 0 ? `未分类 ${byBucket.unknown || 0}` : null,
    ].filter(Boolean);
    const queueHint =
      queueHintParts.length > 0
        ? queueHintParts.join(' · ')
        : '当前无失败指纹';

    let priorityTags = Array.isArray(q.priorityTags)
      ? q.priorityTags.slice()
      : Array.isArray(data.appMeta && data.appMeta.priorityTags)
        ? data.appMeta.priorityTags.slice()
        : [];
    const tagCatalog = Array.isArray(data.appMeta && data.appMeta.tagCatalog)
      ? data.appMeta.tagCatalog
      : [];
    const suggestedTags = Array.isArray(data.appMeta && data.appMeta.suggestedTags)
      ? data.appMeta.suggestedTags
      : ['PV', '招募', '财务', '运营', '测试', '核心'];
    // 池子可选标签 = 建议 + 目录 + 当前已选
    const poolTagOptions = [];
    const poolSeen = new Set();
    for (const t of [...suggestedTags, ...tagCatalog, ...priorityTags]) {
      const s = String(t || '').trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (poolSeen.has(k)) continue;
      poolSeen.add(k);
      poolTagOptions.push(s);
    }
    const priorityPanel = `
      <div class="panel mb panel-priority">
        <h2>优先处理 <span class="meta" id="priority-count">${countInPriority(priorityFilter)}</span><span class="meta faint"> / ${priority.length}</span></h2>
        <div class="priority-pool-config mb-sm" id="priority-tag-pool" role="group" aria-label="优先池业务标签">
          ${poolTagOptions
            .map((t, i) => {
              const on = priorityTags.some((x) => String(x).toLowerCase() === t.toLowerCase());
              const id = `pool-tag-${i}`;
              return `<label class="pool-check" for="${id}">
                <input type="checkbox" id="${id}" data-pool-tag="${esc(t)}" ${on ? 'checked' : ''}/>
                <span>${esc(t)}</span>
              </label>`;
            })
            .join('')}
          <label class="pool-check pool-check-all">
            <input type="checkbox" data-pool-all ${priorityTags.length === 0 ? 'checked' : ''}/>
            <span>全部</span>
          </label>
        </div>
        <div class="chip-row bucket-filters mb-sm" role="toolbar" aria-label="今日优先分流筛选">
          ${bucketChipDefs
            .map(
              (c) =>
                `<button type="button" class="chip bucket-chip ${
                  c.id === priorityFilter ? 'active' : ''
                }" data-bucket-filter="${esc(c.id)}">${esc(c.label)}</button>`,
            )
            .join('')}
        </div>
        <div id="priority-list-host">${renderPriorityList(priorityFilter)}</div>
      </div>`;

    content.innerHTML = `
      ${firstRunTipHtml()}
      <div class="metrics" aria-label="摘要">
        <div class="metric">
          <div class="label">本机应用</div>
          <div class="value">${esc(la.count ?? 0)}</div>
          <div class="hint">有失败 ${esc(problems.length)}</div>
        </div>
        <div class="metric" title="queue 全部失败指纹；下方今日优先只是其中 Top 10">
          <div class="label">失败指纹</div>
          <div class="value">${esc(q.depth ?? 0)}</div>
          <div class="hint">${esc(queueHint)}</div>
        </div>
        <div class="metric">
          <div class="label">跨应用根因</div>
          <div class="value">${esc(cross.length)}</div>
          <div class="hint">≥2 应用同特征</div>
        </div>
      </div>

      <div class="actions mb home-poll-actions">
        <button type="button" class="btn primary" id="btn-poll-home" title="立即从影刀 OpenAPI 拉最新运行记录（与定时 poll 相同，不自动诊断）">立即拉取</button>
        <span class="hint" id="poll-home-hint">看到影刀后台有新失败时可手动拉一轮；成功后会更新 poll 时间。默认最近 24h，可能需数十秒。</span>
      </div>

      ${priorityPanel}

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
    const pollHome = $('#btn-poll-home');
    if (pollHome) {
      pollHome.onclick = () => triggerPollNow(pollHome);
    }

    // S27b：优先队列分流筛选
    content.querySelectorAll('[data-bucket-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-bucket-filter') || 'all';
        priorityFilter = id;
        try {
          localStorage.setItem('rpa_wb_bucket_filter', id);
        } catch {
          // ignore
        }
        content.querySelectorAll('[data-bucket-filter]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-bucket-filter') === id);
        });
        const host = $('#priority-list-host');
        if (host) host.innerHTML = renderPriorityList(id);
        const cnt = $('#priority-count');
        if (cnt) {
          const n = priority.filter((item) => matchBucketFilter(item, id)).length;
          cnt.textContent = String(n);
        }
      });
    });

    // 优先池业务标签（checkbox，服务端持久化）
    async function savePriorityTags(nextTags) {
      content.querySelectorAll('#priority-tag-pool input').forEach((b) => {
        b.disabled = true;
      });
      try {
        const r = await api('/api/settings/app-meta', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ priorityTags: nextTags }),
        });
        if (!r.ok) {
          toast(r.message || '保存失败');
          content.querySelectorAll('#priority-tag-pool input').forEach((b) => {
            b.disabled = false;
          });
          return;
        }
        await renderHome();
      } catch (e) {
        toast(e.message || '保存失败');
        content.querySelectorAll('#priority-tag-pool input').forEach((b) => {
          b.disabled = false;
        });
      }
    }

    content.querySelectorAll('[data-pool-tag]').forEach((box) => {
      box.addEventListener('change', () => {
        const next = [];
        content.querySelectorAll('[data-pool-tag]').forEach((el) => {
          if (el.checked) next.push(el.getAttribute('data-pool-tag') || '');
        });
        savePriorityTags(next.filter(Boolean));
      });
    });
    const allBox = content.querySelector('[data-pool-all]');
    if (allBox) {
      allBox.addEventListener('change', () => {
        if (allBox.checked) {
          savePriorityTags([]);
        } else if (!priorityTags.length) {
          // 取消「全部」且当前无选：保持全部，避免空状态卡死
          allBox.checked = true;
        }
      });
    }
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
    const tagCatalog = Array.isArray(data.tagCatalog) ? data.tagCatalog : [];
    const suggestedTags = Array.isArray(data.suggestedTags)
      ? data.suggestedTags
      : ['PV', '招募', '财务'];
    const filterTags = [];
    const ftSeen = new Set();
    for (const t of [...suggestedTags, ...tagCatalog]) {
      const s = String(t || '').trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (ftSeen.has(k)) continue;
      ftSeen.add(k);
      filterTags.push(s);
    }
    let listScope = 'all'; // all | tag:xxx
    try {
      const saved = localStorage.getItem('rpa_wb_app_list_scope');
      if (saved === 'all' || (saved && saved.startsWith('tag:'))) {
        listScope = saved;
      }
    } catch {
      // ignore
    }

    content.innerHTML = `
      <div class="search">
        <input type="search" id="app-filter" placeholder="搜索应用名、任务名、业务标签或 UUID（按 / 聚焦）" autocomplete="off" aria-label="搜索应用" />
        <span class="count" id="app-count">${apps.length} · ${problemCount} 有失败</span>
      </div>
      <div class="chip-row mb-sm" role="toolbar" aria-label="按业务标签筛选">
        <button type="button" class="chip app-scope-chip ${listScope === 'all' ? 'active' : ''}" data-app-scope="all">全部</button>
        ${filterTags
          .slice(0, 16)
          .map((t) => {
            const id = `tag:${t}`;
            return `<button type="button" class="chip app-scope-chip ${
              listScope === id ? 'active' : ''
            }" data-app-scope="${esc(id)}">${esc(t)}</button>`;
          })
          .join('')}
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
        if (listScope.startsWith('tag:')) {
          const want = listScope.slice(4).toLowerCase();
          const tags = Array.isArray(a.tags) ? a.tags : [];
          if (!tags.some((t) => String(t).toLowerCase() === want)) return false;
        }
        if (!q) return true;
        const taskBits = [a.taskName, ...(Array.isArray(a.taskNames) ? a.taskNames : [])];
        const tagBits = Array.isArray(a.tags) ? a.tags : [];
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
          ...tagBits,
        ]
          .map((x) => String(x || '').toLowerCase())
          .some((s) => s.includes(q));
      });
      if (countEl) {
        countEl.textContent = q
          ? `${rows.length} / ${apps.length}`
          : `${rows.length} · ${problemCount} 有失败`;
      }

      if (!rows.length) {
        listEl.innerHTML = empty(
          '没有匹配的应用',
          listScope.startsWith('tag:')
            ? '该业务标签下暂无应用，打开应用详情添加标签'
            : q
              ? ''
              : '未扫到本机应用，且 queue 暂无失败应用',
        );
        return;
      }

      listEl.innerHTML = rows
        .map((a) => {
          const href = `#/apps/${encodeURIComponent(a.robotUuid)}`;
          const { title, appLine, moreTasks } = appListTitles(a);
          const meta = appListMeta(a);
          const tags = Array.isArray(a.tags) ? a.tags : [];
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
              ${
                tags.length
                  ? `<div class="item-sub tags-line">${tags
                      .map((t) => `<span class="tag-chip">${esc(t)}</span>`)
                      .join('')}</div>`
                  : ''
              }
            </div>
            <div class="item-side">
              <div class="badges">
                ${
                  a.failureCount
                    ? `<span class="badge danger">${esc(a.failureCount)} 待处理</span>`
                    : ''
                }
                ${
                  a.undiagnosedCount
                    ? `<span class="badge warn">${esc(a.undiagnosedCount)} 未诊断</span>`
                    : ''
                }
                ${
                  a.resolvedCount && !a.failureCount
                    ? `<span class="badge ok">${esc(a.resolvedCount)} 已处理</span>`
                    : a.resolvedCount
                      ? `<span class="badge">${esc(a.resolvedCount)} 已处理</span>`
                      : ''
                }
                ${
                  a.remoteOnly
                    ? `<span class="badge">云端</span>`
                    : !a.failureCount && !a.resolvedCount && a.flowCount
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
    content.querySelectorAll('[data-app-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        listScope = btn.getAttribute('data-app-scope') || 'all';
        try {
          localStorage.setItem('rpa_wb_app_list_scope', listScope);
        } catch {
          // ignore
        }
        content.querySelectorAll('[data-app-scope]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-app-scope') === listScope);
        });
        paint(filterEl.value);
      });
    });
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

    const handoffRes = await fetchHandoff({ mode: 'develop', robotUuid });
    const agentPrompt = handoffRes.ok ? handoffRes.markdown || '' : '';
    setActiveHandoff({ path: detail.xbotDir || '', agentPrompt });

    setHeader(
      detail.name || robotUuid,
      [
        `${detail.failureCount || 0} 待处理`,
        detail.undiagnosedCount ? `${detail.undiagnosedCount} 未诊断` : null,
        detail.resolvedCount ? `${detail.resolvedCount} 已处理` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );

    content.innerHTML = `
      <div class="crumb"><a href="#/apps">应用</a> / <span class="mono">${esc(robotUuid)}</span></div>

      ${handoffBarHtml({
        xbotDir: detail.xbotDir || '',
        agentPrompt,
        pathLabel: '本地路径',
        robotUuid,
        agents,
        showCopyPrompt: true,
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
    const copyHandoffApp = $('#btn-copy-handoff');
    if (copyHandoffApp) {
      copyHandoffApp.onclick = async () => {
        const picked = await openHandoffFocusDialog({
          robotUuid,
          appName: detail.name || robotUuid,
        });
        if (!picked.ok || !picked.markdown) return;
        const ok = await copyText(
          picked.markdown,
          picked.focusNodes && picked.focusNodes.length
            ? `已复制（聚焦 ${picked.focusNodes.length} 节点）`
            : '开发提示已复制',
        );
        if (ok) {
          flashCopied(copyHandoffApp);
          setActiveHandoff({ path: detail.xbotDir || '', agentPrompt: picked.markdown });
          // 同步给后续「打开 Agent」
          bindOpenAgentControls(content, { robotUuid, prompt: picked.markdown });
        }
      };
    }
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
    let tags = Array.isArray(detail.tags) ? detail.tags.slice() : [];
    const suggested = ['PV', '招募', '财务', '运营', '测试', '核心'];

    function tagsHtml() {
      if (!tags.length) {
        return '<span class="muted">暂无业务标签</span>';
      }
      return tags
        .map(
          (t) =>
            `<span class="tag-chip removable" data-tag="${esc(t)}" title="点击移除">${esc(
              t,
            )} <span aria-hidden="true">×</span></span>`,
        )
        .join('');
    }

    function suggestHtml() {
      return suggested
        .filter((s) => !tags.some((t) => String(t).toLowerCase() === s.toLowerCase()))
        .map(
          (s) =>
            `<button type="button" class="chip sm suggest-tag" data-suggest-tag="${esc(s)}">+ ${esc(
              s,
            )}</button>`,
        )
        .join('');
    }

    tabBody.innerHTML = `
      <div class="stack">
        <div class="panel panel-app-meta">
          <div class="graph-bar">
            <div>
              <h2 style="margin:0">业务标签</h2>
              <p class="hint" style="margin-top:4px">如 PV / 招募 / 财务。总览优先池可勾选这些标签，只看你维护的业务线。</p>
            </div>
          </div>
          <div class="app-tags-row" id="app-tags-row">${tagsHtml()}</div>
          <div class="chip-row mb-sm" id="app-tag-suggest">${suggestHtml()}</div>
          <div class="app-tag-add">
            <input type="text" id="app-tag-input" class="input" maxlength="32" placeholder="自定义标签" autocomplete="off" />
            <button type="button" class="btn sm" id="btn-app-tag-add">添加</button>
          </div>
        </div>
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
                ? `<div class="k">机器人</div><div class="v">${esc(detail.robotClientName)}</div>`
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

    async function saveMeta(patch, okMsg) {
      try {
        const r = await api(`/api/apps/${encodeURIComponent(robotUuid)}/meta`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!r.ok) {
          toast(r.message || '保存失败');
          return null;
        }
        tags = Array.isArray(r.tags) ? r.tags.slice() : [];
        detail.tags = tags;
        if (okMsg) toast(okMsg);
        return r;
      } catch (e) {
        toast(e.message || '保存失败');
        return null;
      }
    }

    function refreshTagsUi() {
      const row = tabBody.querySelector('#app-tags-row');
      if (row) row.innerHTML = tagsHtml();
      const sug = tabBody.querySelector('#app-tag-suggest');
      if (sug) sug.innerHTML = suggestHtml();
      bindTagRemove();
      bindSuggest();
    }

    function bindTagRemove() {
      tabBody.querySelectorAll('.tag-chip.removable').forEach((el) => {
        el.onclick = async (e) => {
          e.preventDefault();
          const t = el.getAttribute('data-tag');
          if (!t) return;
          const r = await saveMeta({ removeTags: [t] }, `已移除「${t}」`);
          if (r) refreshTagsUi();
        };
      });
    }

    function bindSuggest() {
      tabBody.querySelectorAll('[data-suggest-tag]').forEach((btn) => {
        btn.onclick = async () => {
          const t = btn.getAttribute('data-suggest-tag');
          if (!t) return;
          const r = await saveMeta({ addTags: [t] }, `已添加「${t}」`);
          if (r) refreshTagsUi();
        };
      });
    }

    const addBtn = tabBody.querySelector('#btn-app-tag-add');
    const tagInput = tabBody.querySelector('#app-tag-input');
    const doAdd = async () => {
      const t = tagInput ? String(tagInput.value || '').trim() : '';
      if (!t) {
        toast('请输入标签');
        return;
      }
      const r = await saveMeta({ addTags: [t] }, `已添加「${t}」`);
      if (r) {
        if (tagInput) tagInput.value = '';
        refreshTagsUi();
      }
    };
    if (addBtn) addBtn.onclick = doAdd;
    if (tagInput) {
      tagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doAdd();
        }
      });
    }
    bindTagRemove();
    bindSuggest();
  }

  function renderAppFailures(tabBody, detail) {
    const fails = detail.failures || [];
    function matchFailFilter(f, filter) {
      if (!filter || filter === 'all') return true;
      if (filter === 'dev') {
        return (
          f.actionable === 'dev' ||
          f.bucket === 'code' ||
          f.bucket === 'element' ||
          f.bucket === 'data_config'
        );
      }
      if (filter === 'ops') {
        return f.actionable === 'ops' || f.bucket === 'env_robot' || f.bucket === 'schedule';
      }
      return f.bucket === filter;
    }
    function listHtml(filter) {
      const list = fails.filter((f) => matchFailFilter(f, filter));
      if (!list.length) {
        return empty(filter === 'dev' ? '无代码/配置类失败' : '无失败记录');
      }
      return `<div class="list">${list
        .map((f) =>
          failureRowHtml(f, {
            extraSub: `<div class="item-sub">${esc(f.flowName || '未知流程')} · ${esc(
              f.errorType || '',
            )} · ${esc(relTime(f.lastSeen))}</div>
            <div class="item-sub wrap">${esc((f.rawRemark || '').slice(0, 240))}</div>`,
          }),
        )
        .join('')}</div>`;
    }
    const chips = [
      { id: 'all', label: '全部' },
      { id: 'dev', label: '可开发' },
      { id: 'ops', label: '环境/调度' },
    ];
    let filter = 'all';
    tabBody.innerHTML = `
      <div class="panel">
        <h2>相关问题 <span class="meta" id="app-fail-count">${fails.length}</span></h2>
        ${
          fails.length
            ? `<div class="chip-row bucket-filters mb-sm" role="toolbar" aria-label="分流筛选">
                ${chips
                  .map(
                    (c) =>
                      `<button type="button" class="chip bucket-chip ${
                        c.id === filter ? 'active' : ''
                      }" data-app-bucket="${esc(c.id)}">${esc(c.label)}</button>`,
                  )
                  .join('')}
              </div>
              <div id="app-fail-list">${listHtml(filter)}</div>`
            : empty('无失败记录')
        }
      </div>`;
    tabBody.querySelectorAll('[data-app-bucket]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filter = btn.getAttribute('data-app-bucket') || 'all';
        tabBody.querySelectorAll('[data-app-bucket]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-app-bucket') === filter);
        });
        const host = tabBody.querySelector('#app-fail-list');
        if (host) host.innerHTML = listHtml(filter);
        const cnt = tabBody.querySelector('#app-fail-count');
        if (cnt) cnt.textContent = String(fails.filter((f) => matchFailFilter(f, filter)).length);
      });
    });
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

    const work = data.work || {};
    const workStatus = work.status || f.workStatus || 'open';
    const workLabel = work.label || '待处理';
    const snoozeDays = work.defaultSnoozeDays || 3;
    const resolutionRoot = work.rootCause || '';
    const resolutionSol = work.solution || '';
    const hasResolutionNote = !!(resolutionRoot || resolutionSol);

    const hasDiagText = !!(d.rootCause || k.rootCause || d.suggestion || k.solution);
    let includeDiagnose = false;
    let handoffRes = await fetchHandoff({
      mode: 'fix',
      fingerprint,
      includeDiagnose,
    });
    let agentPrompt = handoffRes.ok ? handoffRes.markdown || '' : '';
    setActiveHandoff({ path: xbotDir, agentPrompt });

    const isSoft = f.failureKind === 'soft' || data.failureKind === 'soft';
    setHeader(
      f.robotName || appName || fingerprint,
      [
        isSoft ? '抽检命中' : '',
        f.errorType || '',
        // 影刀语境：机器人 = 运行客户端，不是应用名
        f.robotClientName ? `机器人 ${f.robotClientName}` : '',
        f.diagnosed ? '已诊断' : '未诊断',
        g && g.title ? g.title : '',
        workLabel,
      ]
        .filter(Boolean)
        .join(' · '),
    );

    const workBadgeCls =
      workStatus === 'ignored'
        ? 'badge'
        : workStatus === 'snoozed'
          ? 'badge warn'
          : workStatus === 'resolved'
            ? 'badge ok'
            : 'badge ok';

    content.innerHTML = `
      <div class="crumb">
        <a href="#/apps">应用</a>
        ${robotUuid ? ` / <a href="#/apps/${encodeURIComponent(robotUuid)}">${esc(f.robotName || robotUuid)}</a>` : ''}
        / 问题
      </div>
      ${
        isSoft
          ? `<div class="tip" role="note"><p><strong>成功抽检命中</strong>：影刀任务状态为成功，但步骤日志<strong>末尾</strong>出现错误（常见于流程 try-catch 吞掉）。请结合日志与流程排查，勿仅凭任务成功判断业务正常。</p></div>`
          : ''
      }

      ${handoffBarHtml({
        xbotDir,
        agentPrompt,
        pathLabel: '本地路径',
        robotUuid,
        agents,
        showCopyPrompt: true,
        showDiagnoseToggle: hasDiagText,
        includeDiagnose,
      })}
      <div id="open-hint" class="hint mb"></div>

      <div class="panel">
        <div class="badges" style="justify-content:flex-start;margin-bottom:10px">
          ${f.diagnosed ? '<span class="badge ok">已诊断</span>' : '<span class="badge warn">未诊断</span>'}
          <span class="${workBadgeCls}" title="处置态：仅影响优先处理列表">${esc(workLabel)}</span>
          ${
            work.ignoredStillFailing
              ? '<span class="badge warn" title="忽略后仍有新失败 job">忽略后仍失败</span>'
              : ''
          }
          ${
            work.reopenedBy === 'new_job'
              ? '<span class="badge warn">新失败已拉回</span>'
              : work.reopenedBy === 'regressed'
                ? '<span class="badge danger">修复复发</span>'
                : ''
          }
          ${
            data.bucket && data.bucket.label
              ? `<span class="badge ${
                  data.bucket.actionable === 'ops'
                    ? 'warn'
                    : data.bucket.actionable === 'dev'
                      ? 'ok'
                      : ''
                }" title="${esc(data.bucket.reason || '技术分流')}">${esc(data.bucket.label)}</span>`
              : ''
          }
          ${g && g.title ? `<span class="badge">${esc(g.title)}</span>` : ''}
          ${f.occurrenceCount ? `<span class="badge">${esc(f.occurrenceCount)} 次</span>` : ''}
        </div>
        <p class="summary-line" style="margin-bottom:8px">${esc((f.rawRemark || '').slice(0, 400) || '无备注')}</p>
        <div class="kv">
          <div class="k">应用</div><div class="v">${esc(f.robotName || appName || '—')}${
            robotUuid
              ? ` <span class="mono faint" style="font-size:12px">(${esc(robotUuid)})</span>`
              : ''
          }</div>
          <div class="k">机器人</div><div class="v">${esc(
            f.robotClientName || data.robotClientName || '—',
          )}${
            f.robotClientUuid || data.robotClientUuid
              ? ` <span class="mono faint" style="font-size:12px">(${esc(
                  f.robotClientUuid || data.robotClientUuid,
                )})</span>`
              : ''
          }</div>
          <div class="k">任务</div><div class="v">${esc(f.taskName || data.taskName || '—')}</div>
          <div class="k">错误</div><div class="v">${esc(f.errorType || '—')}</div>
          ${
            f.elementName
              ? `<div class="k">原因</div><div class="v">${esc(f.elementName)}</div>`
              : ''
          }
          <div class="k">流程</div><div class="v">${
            f.flowName
              ? `${esc(f.flowName)} L${esc(f.lineNumber || '?')}`
              : '<span class="hint">调度层（无流程/行号）</span>'
          }</div>
          <div class="k">指纹</div><div class="v mono">${esc(fingerprint)}</div>
          <div class="k">处置</div><div class="v">${esc(workLabel)}${
            work.snoozedUntil ? ` · 至 ${esc(relTime(work.snoozedUntil))}` : ''
          }${
            workStatus === 'resolved' && work.resolvedAt
              ? ` · ${esc(relTime(work.resolvedAt))}`
              : ''
          }</div>
          <div class="k">分流</div><div class="v">${esc(
            (data.bucket && data.bucket.label) || '—',
          )}${
            data.bucket && data.bucket.actionable === 'ops'
              ? ' <span class="hint">（优先查环境/调度，勿先改代码）</span>'
              : ''
          }</div>
          <div class="k">分诊</div><div class="v">${esc(triage.fixClass || '—')} / ${esc(triage.fixability || '—')}</div>
          <div class="k">最近</div><div class="v">${esc(relTime(f.lastSeen || f.lastFailureAt))}</div>
        </div>
        <div class="finding-toolbar" role="toolbar" aria-label="问题操作">
          <div class="finding-toolbar-primary">
            ${
              f.diagnosed
                ? `<button type="button" class="btn" data-action="diagnose" data-fp="${esc(fingerprint)}">重新诊断</button>`
                : `<button type="button" class="btn primary" data-action="diagnose" data-fp="${esc(fingerprint)}">诊断</button>`
            }
            ${
              canPreview
                ? `<button type="button" class="btn" data-action="fix-dry-run" data-fp="${esc(fingerprint)}">预览修复</button>`
                : ''
            }
          </div>
          <div class="finding-toolbar-status">
            <span class="finding-toolbar-label" title="只影响优先处理列表，不删 queue、不改代码">处置</span>
            ${
              workStatus === 'resolved'
                ? `<div class="work-terminal" role="group" aria-label="处理完成（终态）">
              <span class="seg-btn is-active" data-work="resolved" data-fp="${esc(
                fingerprint,
              )}" aria-pressed="true" title="终态：可点此补充原因/方案">处理完成</span>
              <button
                type="button"
                class="btn sm ghost"
                data-work="resolved"
                data-fp="${esc(fingerprint)}"
                data-resolve-edit="1"
                title="补充或修改原因/方案"
              >补充说明</button>
              <button
                type="button"
                class="btn sm ghost"
                data-work="open"
                data-fp="${esc(fingerprint)}"
                data-reopen="1"
                title="误标时可恢复；同指纹新失败也会自动拉回"
              >恢复待处理</button>
            </div>`
                : `<div class="seg" role="group" aria-label="优先列表处置">
              <button
                type="button"
                class="seg-btn${workStatus === 'open' ? ' is-active' : ''}"
                data-work="open"
                data-fp="${esc(fingerprint)}"
                aria-pressed="${workStatus === 'open' ? 'true' : 'false'}"
                title="进入优先处理"
              >待处理</button>
              <button
                type="button"
                class="seg-btn${workStatus === 'snoozed' ? ' is-active' : ''}"
                data-work="snoozed"
                data-fp="${esc(fingerprint)}"
                aria-pressed="${workStatus === 'snoozed' ? 'true' : 'false'}"
                title="默认 ${snoozeDays} 天；期间新失败会拉回待处理"
              >稍后 ${esc(snoozeDays)} 天</button>
              <button
                type="button"
                class="seg-btn"
                data-work="resolved"
                data-fp="${esc(fingerprint)}"
                aria-pressed="false"
                title="标记已处理（终态）；可记原因/方案。同指纹新失败会拉回待处理"
              >处理完成</button>
              <button
                type="button"
                class="seg-btn${workStatus === 'ignored' ? ' is-active' : ''}"
                data-work="ignored"
                data-fp="${esc(fingerprint)}"
                aria-pressed="${workStatus === 'ignored' ? 'true' : 'false'}"
                title="不再进优先列表；新失败默认不拉回（修复复发除外）"
              >不再提醒</button>
            </div>`
            }
          </div>
        </div>
      </div>

      ${
        hasResolutionNote
          ? `<div class="panel mt panel-resolution">
          <h2>处理说明 ${
            workStatus === 'resolved'
              ? '<span class="meta">已完成</span>'
              : '<span class="meta faint">历史</span>'
          }</h2>
          <div class="kv">
            <div class="k">问题原因</div><div class="v">${esc(resolutionRoot || '—')}</div>
            <div class="k">处理方案</div><div class="v">${esc(resolutionSol || '—')}</div>
          </div>
          ${
            work.resolvedAt
              ? `<p class="hint mt">记录于 ${esc(relTime(work.resolvedAt))}</p>`
              : ''
          }
        </div>`
          : ''
      }

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

    function bindFindingHandoffControls() {
      const copyBtn = $('#btn-copy-handoff');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          if (!agentPrompt) {
            toast('暂无交接提示');
            return;
          }
          const ok = await copyText(agentPrompt, '修复提示已复制');
          if (ok) flashCopied(copyBtn);
        };
      }
      const chk = $('#chk-handoff-diagnose');
      if (chk) {
        chk.onchange = async () => {
          includeDiagnose = !!chk.checked;
          handoffRes = await fetchHandoff({
            mode: 'fix',
            fingerprint,
            includeDiagnose,
          });
          agentPrompt = handoffRes.ok ? handoffRes.markdown || '' : '';
          setActiveHandoff({ path: xbotDir, agentPrompt });
          bindOpenAgentControls(content, { robotUuid, prompt: agentPrompt });
          toast(includeDiagnose ? '已含诊断结论' : '已用精简提示');
        };
      }
      bindOpenAgentControls(content, { robotUuid, prompt: agentPrompt });
    }
    bindFindingHandoffControls();

    content.querySelectorAll('[data-work]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        // 终态徽章（span）也可点开补充说明
        if (btn.tagName === 'SPAN' && btn.getAttribute('data-work') !== 'resolved') return;

        const st = btn.getAttribute('data-work');
        const fp = btn.getAttribute('data-fp') || fingerprint;
        if (!st || !fp) return;

        // 已完成终态：禁止走旧 segment 改到 snoozed/ignored（UI 已隐藏；双保险）
        if (workStatus === 'resolved' && st !== 'resolved' && st !== 'open') {
          toast('处理完成是终态，不能改为稍后/不再提醒');
          return;
        }

        const alreadyActive =
          btn.classList.contains('is-active') || btn.getAttribute('aria-pressed') === 'true';
        const isEditResolved =
          st === 'resolved' &&
          (workStatus === 'resolved' ||
            btn.getAttribute('data-resolve-edit') === '1' ||
            alreadyActive);
        // 非终态：已选中 open/snoozed/ignored 不重复提交
        if (alreadyActive && st !== 'resolved' && btn.getAttribute('data-reopen') !== '1') return;

        const group =
          btn.closest('.seg') || btn.closest('.work-terminal') || content;
        const siblings = group.querySelectorAll('button[data-work], [data-work].seg-btn');

        let body = {
          status: st,
          snoozeDays: st === 'snoozed' ? snoozeDays : undefined,
        };

        if (st === 'resolved') {
          const form = await openResolveDialog({
            rootCause: resolutionRoot,
            solution: resolutionSol,
          });
          if (!form.ok) return;
          body = {
            status: 'resolved',
            rootCause: form.rootCause,
            solution: form.solution,
          };
        }

        if (st === 'open' && workStatus === 'resolved') {
          // 恢复待处理：无需弹层
        }

        siblings.forEach((b) => {
          if (b.tagName === 'BUTTON') b.disabled = true;
        });
        try {
          const r = await api(`/api/findings/${encodeURIComponent(fp)}/work-status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (r.ok) {
            if (st === 'snoozed') {
              toast(`已稍后处理 ${snoozeDays} 天`);
            } else if (st === 'ignored') {
              toast('已不再提醒（不进优先列表）');
            } else if (st === 'resolved') {
              const filled = !!(
                String(body.rootCause || '').trim() || String(body.solution || '').trim()
              );
              toast(
                isEditResolved
                  ? filled
                    ? '处理说明已更新'
                    : '仍为处理完成（未记原因）'
                  : filled
                    ? '已标为处理完成'
                    : '已标为处理完成（未记原因，可点「补充说明」）',
              );
            } else if (st === 'open' && workStatus === 'resolved') {
              toast('已恢复待处理');
            } else {
              toast('已恢复待处理');
            }
            await renderFinding(fp);
          } else {
            toast(r.message || r.code || '设置失败');
            siblings.forEach((b) => {
              if (b.tagName === 'BUTTON') b.disabled = false;
            });
          }
        } catch (e) {
          toast(e.message || '设置失败');
          siblings.forEach((b) => {
            if (b.tagName === 'BUTTON') b.disabled = false;
          });
        }
      });
    });

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
            <button type="button" class="btn sm ghost" id="btn-biz-export-md" title="导出 Markdown" disabled>导出 MD</button>
            <button type="button" class="btn sm ghost" id="btn-biz-export-pdf" title="打印 / 另存为 PDF" disabled>导出 PDF</button>
            <button type="button" class="btn sm primary" id="btn-business-brief">生成解读</button>
            <button type="button" class="btn sm ghost" id="btn-business-brief-refresh" title="忽略缓存重新生成">重新生成</button>
          </div>
        </div>
        <div id="business-brief-body" class="mt">
          <p class="faint">加载中…</p>
        </div>
      </div>
    `;

    function setBizExportEnabled(on) {
      ['#btn-biz-export-md', '#btn-biz-export-pdf'].forEach((sel) => {
        const b = $(sel);
        if (b) b.disabled = !on;
      });
    }

    async function renderBriefInto(el, data) {
      if (!el) return;
      if (!data || data.ok === false) {
        setBizExportEnabled(false);
        el.innerHTML = `<div class="err">${esc((data && (data.message || data.code)) || '解读失败')}</div>`;
        return;
      }
      if (!data.brief) {
        setBizExportEnabled(false);
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
        <article class="brief" data-has-brief="1">
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
      setBizExportEnabled(true);
    }

    async function runBusinessBrief(force) {
      const bodyEl = $('#business-brief-body');
      const btn = $('#btn-business-brief');
      const btn2 = $('#btn-business-brief-refresh');
      if (bodyEl) bodyEl.innerHTML = loadingHtml(force ? '重新生成业务解读…' : '生成业务解读…');
      setBizExportEnabled(false);
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
        } else {
          setBizExportEnabled(false);
          toast((data && data.message) || '解读失败');
        }
      } catch (e) {
        setBizExportEnabled(false);
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

    const bizMdBtn = $('#btn-biz-export-md');
    if (bizMdBtn) {
      bizMdBtn.onclick = async () => {
        bizMdBtn.disabled = true;
        try {
          await downloadMarkdownFromApi(
            `/api/apps/${encodeURIComponent(robotUuid)}/export/business`,
            '业务解读.md',
          );
          toast('已导出 Markdown');
        } catch (e) {
          toast(e.message || '导出失败');
        } finally {
          setBizExportEnabled(true);
        }
      };
    }
    const bizPdfBtn = $('#btn-biz-export-pdf');
    if (bizPdfBtn) {
      bizPdfBtn.onclick = () => {
        const bodyEl = $('#business-brief-body');
        const t =
          (bodyEl && bodyEl.querySelector('.brief-title')?.textContent) ||
          detail.name ||
          '业务解读';
        printFlowDocument(`业务解读 · ${t}`, '#business-brief-panel');
      };
    }

    // 进入页面自动加载本机已保存解读（不调 LLM）
    (async () => {
      const bodyEl = $('#business-brief-body');
      try {
        const data = await api(`/api/apps/${encodeURIComponent(robotUuid)}/business-brief`);
        if (data && data.ok && data.brief) {
          await renderBriefInto(bodyEl, data);
        } else {
          setBizExportEnabled(false);
          if (bodyEl) bodyEl.innerHTML = '<p class="faint">尚未生成</p>';
        }
      } catch {
        setBizExportEnabled(false);
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
      <div id="impl-flow-export-root">
      <div class="panel" id="impl-call-graph-panel">
        <div class="graph-bar">
          <div>
            <h2 style="margin:0">${esc(r.projectName || detail.name || '实现调用图')}</h2>
            <p class="hint" style="margin-top:4px">${u.cached ? '缓存' : '实时 rpa-skill'} · ${esc(
              graphMeta || (mermaidSrc ? 'call graph' : '无图'),
            )}</p>
          </div>
          <div class="actions">
            <button type="button" class="btn sm ghost" id="btn-impl-export-md" title="导出 Markdown">导出 MD</button>
            <button type="button" class="btn sm ghost" id="btn-impl-export-pdf" title="打印 / 另存为 PDF">导出 PDF</button>
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

      <details class="panel mt fold raw no-print">
        <summary>原始 JSON</summary>
        <div class="pre mt">${esc(JSON.stringify(r, null, 2))}</div>
      </details>
      </div>
    `;

    const refreshBtn = tabBody.querySelector('[data-refresh-flow]');
    if (refreshBtn) refreshBtn.onclick = () => renderAppImplFlow(robotUuid, detail, true);

    const implMdBtn = $('#btn-impl-export-md');
    if (implMdBtn) {
      implMdBtn.onclick = async () => {
        implMdBtn.disabled = true;
        try {
          await downloadMarkdownFromApi(
            `/api/apps/${encodeURIComponent(robotUuid)}/export/impl`,
            '实现流程.md',
          );
          toast('已导出 Markdown');
        } catch (e) {
          toast(e.message || '导出失败');
        } finally {
          implMdBtn.disabled = false;
        }
      };
    }
    const implPdfBtn = $('#btn-impl-export-pdf');
    if (implPdfBtn) {
      implPdfBtn.onclick = () => {
        const t = r.projectName || detail.name || '实现流程';
        printFlowDocument(`实现流程 · ${t}`, '#impl-flow-export-root');
      };
    }

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
      else if (r.name === 'poll-runs') await renderPollRuns();
      else if (r.name === 'poll-run') await renderPollRun(r.id);
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

  const pollNowBtn = $('#btn-poll-now');
  if (pollNowBtn) {
    pollNowBtn.addEventListener('click', () => triggerPollNow(pollNowBtn));
  }

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
