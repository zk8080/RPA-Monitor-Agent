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

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
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

  function relTime(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso).slice(0, 19);
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 60) return `${Math.max(sec, 0)} 秒前`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
    return `${Math.floor(sec / 86400)} 天前`;
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
    if (pageDesc) pageDesc.textContent = desc || '';
    document.title = title ? `${title} · RPA Workbench` : 'RPA Workbench';
    const kicker = document.getElementById('page-kicker');
    if (kicker) {
      const route = parseRoute();
      kicker.textContent =
        route.name === 'apps'
          ? 'Catalog'
          : route.name === 'app'
            ? 'Application'
            : route.name === 'finding'
              ? 'Finding'
              : route.name === 'reports' || route.name === 'report'
                ? 'Reports'
                : 'Workspace';
    }
  }

  function firstRunTipHtml() {
    try {
      if (localStorage.getItem('rpa_wb_tip_dismissed') === '1') return '';
    } catch {
      // ignore
    }
    return `<div class="tip" id="first-run-tip" role="note">
      <p><strong>怎么用：</strong>从「需要关注」或「应用」进入流程 → 看调用图 → <strong>复制路径</strong>，用 Coding Agent 打开本地工程。侧栏可看 Agent 是否在跑。</p>
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
      tab === 'flow' ? 'tab-flow' : tab === 'failures' ? 'tab-failures' : 'tab-overview';
    const el = document.getElementById(id);
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }

  function failureActionsHtml(f, robotUuid) {
    const fp = f.fingerprint || '';
    const remark = f.rawRemark || '';
    const diag = f.lastDiagnosis;
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
        ${f.fixStatus ? `<span class="badge">${esc(f.fixStatus)}</span>` : ''}
        ${f.occurrenceCount ? `<span class="badge">${esc(f.occurrenceCount)} 次</span>` : ''}
      </div>
      ${
        diag && diag.rootCause
          ? `<div class="item-sub wrap" style="max-width:220px;text-align:right">${esc(
              String(diag.rootCause).slice(0, 80),
            )}</div>`
          : f.guidance && f.guidance.summary
            ? `<div class="item-sub wrap" style="max-width:220px;text-align:right">${esc(
                String(f.guidance.summary).slice(0, 80),
              )}</div>`
            : ''
      }
      <div class="item-actions">
        <a class="btn sm primary" href="#/findings/${encodeURIComponent(fp)}">详情</a>
        <button type="button" class="btn sm" data-action="diagnose" data-fp="${esc(fp)}">诊断</button>
        ${
          canPreview
            ? `<button type="button" class="btn sm" data-action="fix-dry-run" data-fp="${esc(fp)}">预览修复</button>`
            : ''
        }
        <button type="button" class="btn sm" data-copy="${esc(fp)}" data-copy-msg="指纹已复制">复制指纹</button>
        ${
          remark
            ? `<button type="button" class="btn sm" data-copy="${esc(remark)}" data-copy-msg="备注已复制">复制备注</button>`
            : ''
        }
        <a class="btn sm" href="#/apps/${encodeURIComponent(robotUuid)}/flow">流程图</a>
      </div>
    </div>`;
  }

  function renderGuidanceBlock(g) {
    if (!g) return '';
    const steps = (g.steps || [])
      .map((s, i) => `<li>${esc(i + 1)}. ${esc(s)}</li>`)
      .join('');
    return `<div class="panel guidance-panel">
      <h2>修复建议 · ${esc(g.title || '')}</h2>
      <p class="summary-line" style="margin-bottom:12px">${esc(g.summary || '')}</p>
      ${steps ? `<ul class="plain-list">${steps}</ul>` : ''}
      <p class="hint mt">${esc(g.cta || '')}
        ${g.fixClass ? ` · 分诊 ${esc(g.fixClass)}/${esc(g.fixability || '')}` : ''}</p>
    </div>`;
  }

  function bindCopyButtons(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-copy]').forEach((btn) => {
      if (btn._copyBound) return;
      btn._copyBound = true;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const msg = btn.getAttribute('data-copy-msg') || '已复制';
        copyText(btn.getAttribute('data-copy'), msg);
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
      btn.textContent = action === 'diagnose' ? '诊断中…' : '生成中…';
    }
    try {
      const path =
        action === 'diagnose'
          ? `/api/findings/${encodeURIComponent(fingerprint)}/diagnose`
          : `/api/findings/${encodeURIComponent(fingerprint)}/fix-dry-run`;
      const r = await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ useLlm: false, force: action === 'fix-dry-run' }),
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
    return { name: 'home' };
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
    setHeader('日报', 'data/reports 下的诊断日报（含 maintain 节）');
    content.innerHTML = '<div class="loading">加载日报列表…</div>';

    const data = await api('/api/reports');
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>`;
      return;
    }
    const list = data.reports || [];
    content.innerHTML = `
      <div class="actions mb">
        <button type="button" class="btn primary" id="btn-gen-report">生成今日日报</button>
        <span class="hint">来自 ${esc(data.reportsDir || 'data/reports')}</span>
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
            : empty('还没有日报文件', '点击「生成今日日报」，或运行 node monitor/report.js')
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
    setHeader(`日报 ${date}`, 'Markdown 渲染');
    content.innerHTML = '<div class="loading">加载日报…</div>';

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

    content.innerHTML = `
      <div class="crumb"><a href="#/reports">日报</a> / ${esc(date)}</div>
      <div class="actions mb">
        <button type="button" class="btn" id="btn-regen">重新生成</button>
        <button type="button" class="btn ghost" id="btn-copy-md">复制 Markdown</button>
        <a class="btn ghost" href="#/reports">全部日报</a>
      </div>
      <article class="panel report-md">${renderMarkdown(data.markdown)}</article>
      <details class="panel mt fold">
        <summary>原始 Markdown</summary>
        <div class="pre mt">${esc(data.markdown)}</div>
      </details>
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
    const copyMd = $('#btn-copy-md');
    if (copyMd) copyMd.onclick = () => copyText(data.markdown, 'Markdown 已复制');
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
      toast(okMsg || '已复制');
      return true;
    } catch {
      toast('复制失败，请手动选择路径');
      return false;
    }
  }

  function empty(title, body) {
    return `<div class="empty"><strong>${esc(title)}</strong><p>${esc(body)}</p></div>`;
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

  async function renderMermaidInto(container, source) {
    if (!container || !source) return;
    if (typeof mermaid === 'undefined') {
      container.innerHTML = `<div class="muted">未加载 Mermaid 库（需要访问 CDN）</div>
        <div class="pre mt">${esc(source)}</div>`;
      return;
    }
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        flowchart: { htmlLabels: true, curve: 'basis' },
      });
      const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const { svg } = await mermaid.render(id, source);
      container.innerHTML = svg;
    } catch (e) {
      container.innerHTML = `<div class="err">流程图渲染失败：${esc(e.message || e)}</div>
        <div class="pre mt">${esc(source)}</div>`;
    }
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
    setHeader('总览', '从失败应用进入流程，或浏览本机全部应用');
    content.innerHTML = '<div class="loading">加载中…</div>';

    const data = await api('/api/overview');
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>`;
      return;
    }

    const rt = data.runtime || {};
    const la = data.localApps || {};
    const q = data.queue || {};
    const problems = data.problemApps || [];
    const cross = data.crossAppGroups || [];
    const und = q.undiagnosed ?? 0;

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
        cross.length
          ? `<div class="panel mb">
        <h2>跨应用根因 <span class="meta">${cross.length}</span></h2>
        <div class="list">${cross
          .map((g) => {
            const title =
              g.rootCauseHint ||
              [g.flowName, g.errorType, g.elementName].filter(Boolean).join(' · ') ||
              g.errorSignature;
            const apps = (g.affectedApps || [])
              .map((a) => esc(a.robotName || a.robotUuid))
              .join('、');
            return `<div class="list-item">
              <div class="item-main">
                <div class="item-title">${esc(title)}</div>
                <div class="item-sub wrap">${esc(g.appCount)} 个应用 · ${esc(apps)}</div>
                <div class="item-sub mono">${esc(g.errorSignature)}</div>
              </div>
              <div class="item-side">
                <div class="badges"><span class="badge danger">${esc(g.totalCount)} 条</span></div>
                <div class="item-actions">
                  ${
                    g.sampleFingerprint
                      ? `<a class="btn sm primary" href="#/findings/${encodeURIComponent(
                          g.sampleFingerprint,
                        )}">样例详情</a>`
                      : ''
                  }
                </div>
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
                .map(
                  (p) => `<a class="list-item" href="#/apps/${encodeURIComponent(p.robotUuid)}/flow">
                    <div class="item-main">
                      <div class="item-title">${esc(p.robotName || p.robotUuid)}</div>
                      <div class="item-sub">${esc(relTime(p.lastSeen))}</div>
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
                      <div class="item-actions">
                        <span class="faint" style="font-size:12px">看流程 →</span>
                      </div>
                    </div>
                  </a>`,
                )
                .join('')}</div>`
            : empty('没有需要处理的失败', 'queue 为空，或 Agent 尚未 poll。可先浏览全部应用。')
        }
        <div class="actions mt">
          <a class="btn primary" href="#/apps">浏览全部应用</a>
          <button type="button" class="btn" id="btn-copy-root">复制 ShadowBot 根路径</button>
        </div>
        <p class="hint mono">${esc(la.usersRoot || '')}</p>
      </div>
    `;

    const btn = $('#btn-copy-root');
    if (btn) btn.onclick = () => copyText(la.usersRoot, '已复制根目录路径');
    bindFirstRunTip();
  }

  // ── Apps ──
  async function renderApps() {
    setNav('apps');
    setHeader('应用', '搜索本机流程，打开路径或查看调用图');
    content.innerHTML = '<div class="loading">扫描本机应用…</div>';

    const data = await api('/api/apps');
    if (!data.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(data.message || data.code)}</div>`;
      return;
    }

    const apps = data.apps || [];
    const problemCount = apps.filter((a) => a.failureCount > 0).length;
    content.innerHTML = `
      <div class="search">
        <input type="search" id="app-filter" placeholder="搜索名称、UUID 或路径（按 / 聚焦）" autocomplete="off" aria-label="搜索应用" />
        <span class="count" id="app-count">${apps.length} · ${problemCount} 有失败</span>
      </div>
      <div class="panel">
        <div class="list" id="apps-list"></div>
      </div>
    `;

    const listEl = $('#apps-list');
    const filterEl = $('#app-filter');
    const countEl = $('#app-count');

    function paint(filter = '') {
      const q = filter.trim().toLowerCase();
      const rows = apps.filter((a) => {
        if (!q) return true;
        return [a.name, a.robotUuid, a.xbotDir, a.userId]
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
          q ? '换个关键词试试' : '未扫到 xbot_robot，请确认本机已安装影刀并登录过。',
        );
        return;
      }

      listEl.innerHTML = rows
        .map((a) => {
          const href = `#/apps/${encodeURIComponent(a.robotUuid)}`;
          return `<div class="list-item">
            <a class="item-main" href="${href}" style="color:inherit;text-decoration:none">
              <div class="item-title">${esc(a.name || a.robotUuid)}</div>
              <div class="item-sub">${esc(shortPath(a.xbotDir, 56))}</div>
            </a>
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
              </div>
              <div class="faint" style="font-size:11px">${
                a.lastFailureAt ? esc(relTime(a.lastFailureAt)) : ''
              }</div>
              <div class="item-actions">
                <a class="btn sm" href="${href}/flow">流程图</a>
                <button type="button" class="btn sm" data-copy="${esc(a.xbotDir || '')}">复制路径</button>
              </div>
            </div>
          </div>`;
        })
        .join('');

      listEl.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyText(btn.getAttribute('data-copy'), '路径已复制');
        });
      });
    }

    paint();
    filterEl.addEventListener('input', () => paint(filterEl.value));
    filterEl.focus();
  }

  // ── App detail ──
  async function renderApp(robotUuid, tab = 'overview') {
    setNav('apps');
    setHeader('应用', '');
    content.innerHTML = '<div class="loading">加载中…</div>';

    const detail = await api(`/api/apps/${encodeURIComponent(robotUuid)}`);
    if (!detail.ok) {
      content.innerHTML = `<div class="err">加载失败：${esc(detail.message || detail.code)}</div>
        <p class="mt"><a href="#/apps">返回应用列表</a></p>`;
      return;
    }

    setHeader(
      detail.name || robotUuid,
      `${detail.failureCount || 0} 失败 · ${detail.undiagnosedCount || 0} 未诊断 · 复制路径后用 Coding Agent 打开`,
    );

    content.innerHTML = `
      <div class="crumb"><a href="#/apps">应用</a> / <span class="mono">${esc(robotUuid)}</span></div>

      <div class="detail-top">
        <div style="min-width:0;flex:1">
          <div class="badges" style="justify-content:flex-start">
            ${
              detail.failureCount
                ? `<span class="badge danger">${esc(detail.failureCount)} 失败</span>`
                : ''
            }
            ${
              detail.undiagnosedCount
                ? `<span class="badge warn">${esc(detail.undiagnosedCount)} 未诊断</span>`
                : ''
            }
            ${
              detail.resolve?.source
                ? `<span class="badge">${esc(detail.resolve.source)}</span>`
                : ''
            }
          </div>
          <div class="path" id="path-text">${esc(detail.xbotDir || '未解析到路径')}</div>
          <div id="open-hint" class="hint"></div>
        </div>
        <div class="actions">
          <button type="button" class="btn primary" id="btn-copy">复制路径</button>
          <button type="button" class="btn" id="btn-open">打开文件夹</button>
          <button type="button" class="btn ghost" id="btn-refresh-understand">刷新解析</button>
        </div>
      </div>

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
        <button type="button" role="tab" id="tab-failures" class="tab ${
          tab === 'failures' ? 'active' : ''
        }" data-tab="failures" aria-selected="${tab === 'failures'}" aria-controls="tab-body" tabindex="${
          tab === 'failures' ? '0' : '-1'
        }">相关问题</button>
      </div>
      <div id="tab-body" role="tabpanel" aria-labelledby="tab-${
        tab === 'failures' ? 'failures' : tab === 'flow' ? 'flow' : 'overview'
      }"></div>
    `;

    const tabOrder = ['overview', 'flow', 'failures'];
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
        // remember we navigated by keyboard so route restores focus to tab
        sessionStorage.setItem('rpa_wb_focus_tab', next);
        location.hash = `#/apps/${encodeURIComponent(robotUuid)}/${next}`;
      };
    });

    $('#btn-copy').onclick = () => copyText(detail.xbotDir, '路径已复制');
    $('#btn-open').onclick = async () => {
      const hint = $('#open-hint');
      const openBtn = $('#btn-open');
      hint.textContent = '正在打开…';
      if (openBtn) {
        openBtn.disabled = true;
        openBtn.classList.add('busy');
      }
      try {
        const r = await api(`/api/apps/${encodeURIComponent(robotUuid)}/open-folder`, {
          method: 'POST',
        });
        if (r.ok) {
          const opened = r.opened || detail.xbotDir || '';
          hint.innerHTML = `已请求在资源管理器中打开。若无窗口，请用「复制路径」再粘贴。<span class="mono"> ${esc(
            opened,
          )}</span>`;
          toast('已请求打开文件夹');
          // 不自动写入剪贴板，避免冲掉用户正在用的内容
        } else {
          hint.innerHTML = `<span class="err">打开失败：${esc(r.message || r.code)}</span>
            ${detail.xbotDir ? ' 已可复制下方路径。' : ''}`;
          toast(r.message || '打开失败');
          // 失败时才主动复制，方便兜底
          if (detail.xbotDir) await copyText(detail.xbotDir, '路径已复制（打开失败时的兜底）');
        }
      } finally {
        if (openBtn) {
          openBtn.disabled = false;
          openBtn.classList.remove('busy');
        }
      }
    };
    $('#btn-refresh-understand').onclick = async () => {
      sessionStorage.setItem('rpa_wb_focus_tab', 'flow');
      history.replaceState(null, '', `#/apps/${encodeURIComponent(robotUuid)}/flow`);
      content.querySelectorAll('[data-tab]').forEach((b) => {
        const on = b.getAttribute('data-tab') === 'flow';
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      await renderAppFlow(robotUuid, detail, true);
      focusActiveTab('flow');
    };

    const tabBody = $('#tab-body');
    if (tab === 'failures') renderAppFailures(tabBody, detail, robotUuid);
    else if (tab === 'flow') await renderAppFlow(robotUuid, detail, false);
    else renderAppOverview(tabBody, detail, robotUuid);
  }

  function renderAppOverview(tabBody, detail, robotUuid) {
    const fails = detail.failures || [];
    tabBody.innerHTML = `
      <div class="grid-2">
        <div class="panel">
          <h2>信息</h2>
          <div class="kv">
            <div class="k">名称</div><div class="v">${esc(detail.name)}</div>
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
                  .map(
                    (f) => `<div class="list-item">
                      <div class="item-main">
                        <div class="item-title mono">${esc(f.fingerprint)}</div>
                        <div class="item-sub wrap">${esc(f.errorType || '')} · ${esc(
                          (f.rawRemark || '').slice(0, 120),
                        )}</div>
                      </div>
                      ${failureActionsHtml(f, robotUuid)}
                    </div>`,
                  )
                  .join('')}</div>
                <p class="hint">
                  <a href="#/apps/${encodeURIComponent(robotUuid)}/failures">全部问题</a>
                  ·
                  <a href="#/apps/${encodeURIComponent(robotUuid)}/flow">业务流程</a>
                </p>`
              : empty('暂无失败', '可直接查看业务流程。')
          }
        </div>
      </div>
    `;
    bindCopyButtons(tabBody);
    bindActionButtons(tabBody);
  }

  function renderAppFailures(tabBody, detail, robotUuid) {
    const fails = detail.failures || [];
    tabBody.innerHTML = `
      <div class="panel">
        <h2>相关问题 <span class="meta">${fails.length}</span></h2>
        ${
          fails.length
            ? `<div class="list">${fails
                .map(
                  (f) => `<div class="list-item">
                    <div class="item-main">
                      <div class="item-title mono">${esc(f.fingerprint)}</div>
                      <div class="item-sub">${esc(f.flowName || '未知流程')} · ${esc(
                        f.errorType || '',
                      )} · ${esc(relTime(f.lastSeen))}</div>
                      <div class="item-sub wrap">${esc((f.rawRemark || '').slice(0, 240))}</div>
                    </div>
                    ${failureActionsHtml(f, robotUuid)}
                  </div>`,
                )
                .join('')}</div>`
            : empty('无失败记录', 'data/queue 中没有该应用条目。')
        }
      </div>`;
    bindCopyButtons(tabBody);
    bindActionButtons(tabBody);
  }

  async function renderFinding(fingerprint) {
    setNav('apps');
    setHeader('问题详情', fingerprint);
    content.innerHTML = '<div class="loading">加载中…</div>';

    const data = await api(`/api/findings/${encodeURIComponent(fingerprint)}`);
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
        / <span class="mono">${esc(fingerprint)}</span>
      </div>

      <div class="detail-top">
        <div style="min-width:0;flex:1">
          <div class="badges" style="justify-content:flex-start">
            ${f.diagnosed ? '<span class="badge ok">已诊断</span>' : '<span class="badge warn">未诊断</span>'}
            ${g && g.title ? `<span class="badge">${esc(g.title)}</span>` : ''}
            ${
              canPreview
                ? '<span class="badge ok">可预览修</span>'
                : '<span class="badge">需人工</span>'
            }
            ${f.fixStatus ? `<span class="badge">${esc(f.fixStatus)}</span>` : ''}
            ${f.occurrenceCount ? `<span class="badge">${esc(f.occurrenceCount)} 次</span>` : ''}
          </div>
          <div class="path mono">${esc(fingerprint)}</div>
          <p class="hint">${esc((f.rawRemark || '').slice(0, 400))}</p>
        </div>
        <div class="actions">
          <button type="button" class="btn primary" data-action="diagnose" data-fp="${esc(fingerprint)}">诊断</button>
          ${
            canPreview
              ? `<button type="button" class="btn" data-action="fix-dry-run" data-fp="${esc(fingerprint)}">预览修复</button>`
              : ''
          }
          ${
            robotUuid
              ? `<a class="btn ghost" href="#/apps/${encodeURIComponent(robotUuid)}/flow">流程图</a>`
              : ''
          }
        </div>
      </div>

      ${renderGuidanceBlock(g)}

      <div class="grid-2 mt">
        <div class="panel">
          <h2>诊断结论</h2>
          ${
            d.rootCause || k.rootCause
              ? `<div class="kv">
                  <div class="k">根因</div><div class="v">${esc(d.rootCause || k.rootCause || '—')}</div>
                  <div class="k">位置</div><div class="v">${esc(d.location || k.location || '—')}</div>
                  <div class="k">建议</div><div class="v">${esc(d.suggestion || k.solution || '—')}</div>
                  <div class="k">置信度</div><div class="v">${esc(d.confidence != null ? d.confidence : k.confidence ?? '—')}</div>
                  <div class="k">类别</div><div class="v">${esc(d.errorCategory || k.errorCategory || '—')}</div>
                </div>`
              : empty('尚未诊断', '点击「诊断」生成结构化结论（规则，默认不调 LLM）。也可先看上方修复建议。')
          }
          ${k.id ? `<p class="hint mt">KB：${esc(k.id)} · ${esc(k.status || '')}</p>` : ''}
        </div>
        <div class="panel">
          <h2>元数据</h2>
          <div class="kv">
            <div class="k">应用</div><div class="v">${esc(f.robotName || '')}</div>
            <div class="k">UUID</div><div class="v mono">${esc(robotUuid)}</div>
            <div class="k">流程</div><div class="v">${esc(f.flowName || '—')} L${esc(f.lineNumber || '?')}</div>
            <div class="k">错误</div><div class="v">${esc(f.errorType || '—')}</div>
            <div class="k">分诊</div><div class="v">${esc(triage.fixClass || '—')} / ${esc(triage.fixability || '—')}</div>
            <div class="k">最近</div><div class="v">${esc(relTime(f.lastSeen))}</div>
            <div class="k">补丁</div><div class="v mono">${esc(f.lastPatchId || '—')}</div>
          </div>
        </div>
      </div>

      <div class="panel mt">
        <h2>相关补丁 <span class="meta">${patches.length}</span></h2>
        ${
          patches.length
            ? `<div class="list">${patches
                .map(
                  (p) => `<div class="list-item">
                    <div class="item-main">
                      <div class="item-title mono">${esc(p.patchId)}</div>
                      <div class="item-sub">${esc(p.status)} · ${esc(p.fixerId || '')} · ${esc(
                        p.createdAt || '',
                      )}</div>
                    </div>
                    <div class="item-side">
                      <div class="badges">
                        ${p.dryRun !== false && p.status === 'planned' ? '<span class="badge">dry-run</span>' : ''}
                        <span class="badge">${esc(p.status)}</span>
                      </div>
                      <div class="item-actions">
                        <button type="button" class="btn sm" data-patch="${esc(p.patchId)}">看 diff</button>
                      </div>
                    </div>
                  </div>`,
                )
                .join('')}</div>
              <div id="patch-diff-host" class="mt"></div>`
            : empty('暂无补丁', '可点「预览修复」生成 dry-run patch（不写盘）。')
        }
      </div>
      <div id="action-result" class="panel mt" style="display:none"></div>
    `;

    bindActionButtons(content);
    content.querySelectorAll('[data-patch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-patch');
        const host = $('#patch-diff-host');
        if (!host) return;
        host.innerHTML = '<div class="loading">加载 diff…</div>';
        const pd = await api(`/api/patches/${encodeURIComponent(id)}`);
        if (!pd.ok) {
          host.innerHTML = `<div class="err">${esc(pd.message || pd.code)}</div>`;
          return;
        }
        host.innerHTML = `
          <h2 style="margin:0 0 8px;font-size:13px;color:var(--text-3)">${esc(id)}</h2>
          <div class="pre">${esc(pd.diff || '(empty diff)')}</div>
          <p class="hint">写盘请用 CLI：node monitor/agent.js maintain fix --fingerprint … --apply</p>`;
      });
    });
  }

  async function renderAppFlow(robotUuid, detail, forceRefresh) {
    const tabBody = $('#tab-body');
    if (!tabBody) return;
    tabBody.innerHTML = `<div class="panel"><div class="loading">正在解析流程${forceRefresh ? '（刷新）' : ''}…</div></div>`;

    const u = await api(
      `/api/apps/${encodeURIComponent(robotUuid)}/understand${forceRefresh ? '?refresh=1' : ''}`,
    );
    if (!u.ok) {
      tabBody.innerHTML = `<div class="panel"><div class="err">解析失败：${esc(u.message || u.code)}</div>
        <p class="hint">检查 rpaSkillPath 与本机 xbot 目录后，点「刷新解析」。</p></div>`;
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
      <div class="panel">
        <div class="graph-bar">
          <div>
            <h2 style="margin:0">${esc(r.projectName || detail.name || '流程图')}</h2>
            <p class="hint" style="margin-top:4px">${u.cached ? '缓存' : '实时 rpa-skill'} · ${esc(
              graphMeta || (mermaidSrc ? 'call graph' : '无图'),
            )}</p>
          </div>
          <div class="actions">
            ${mermaidSrc ? '<button type="button" class="btn sm" id="btn-copy-mmd">复制 Mermaid</button>' : ''}
          </div>
        </div>
        ${r.summary ? `<p class="summary-line">${esc(r.summary)}</p>` : ''}
        ${
          mermaidSrc
            ? `<div class="graph graph-hero"><div class="graph-host" id="mermaid-host"><div class="muted">渲染中…</div></div></div>
               <details class="raw"><summary>Mermaid 源码</summary><div class="pre mt">${esc(mermaidSrc)}</div></details>`
            : empty('没有流程图', '点「刷新解析」重新生成。')
        }
      </div>

      <details class="panel mt fold">
        <summary>业务阶段与流程清单</summary>
        <div class="grid-2 mt">
          <div>
            <h2>业务阶段</h2>
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

    const copyMmd = $('#btn-copy-mmd');
    if (copyMmd) copyMmd.onclick = () => copyText(mermaidSrc, 'Mermaid 已复制');
    if (mermaidSrc) await renderMermaidInto($('#mermaid-host'), mermaidSrc);
  }

  async function route() {
    await refreshRuntime();
    const r = parseRoute();
    try {
      if (r.name === 'finding') await renderFinding(r.fingerprint);
      else if (r.name === 'reports') await renderReports();
      else if (r.name === 'report') await renderReport(r.date);
      else if (r.name === 'apps') await renderApps();
      else if (r.name === 'app') {
        const tab = r.tab === 'flow' || r.tab === 'failures' ? r.tab : 'overview';
        await renderApp(r.robotUuid, tab);
      } else await renderHome();
    } catch (e) {
      content.innerHTML = `<div class="err">错误：${esc(e.message || e)}</div>`;
    }

    // Prefer restoring tab focus when we just keyboard-navigated tabs
    const wantTab = sessionStorage.getItem('rpa_wb_focus_tab');
    if (wantTab && r.name === 'app' && (r.tab === wantTab || (!r.tab && wantTab === 'overview'))) {
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
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
