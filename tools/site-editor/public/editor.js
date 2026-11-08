/* site-editor — in-page editing overlay.
 *
 * Injected into every HTML page served by server.mjs. It never touches the page's own
 * scripts; it adds a hover/click affordance over text runs and maps each run back to
 * its source (HTML text span, or a string literal in assets/main.js / assets/arch.js).
 */
(() => {
  'use strict';

  const CFG = window.__SITE_EDIT__;
  if (!CFG || !CFG.token) return;

  const EDIT = '/__edit';
  const CLIENT_ID = 'tab-' + Math.random().toString(36).slice(2, 10);
  const PLAINTEXT_OK = (() => {
    try {
      const d = document.createElement('div');
      d.setAttribute('contenteditable', 'plaintext-only');
      return d.isContentEditable;
    } catch {
      return false;
    }
  })();

  // Text inside real controls stays a control: clicking it must keep working. Links
  // are *not* in this list — their labels are copy, and Alt+click still follows them.
  const CONTROL_SELECTOR = [
    'button', 'select', 'input', 'textarea', 'option', '[role="button"]',
    '.lang__btn', '#theme-toggle', '.nav-toggle',
  ].join(',');

  const state = {
    manifest: null,
    hover: null,
    active: null,
    busy: false,
    editMode: true,
    lastPoint: null,
    suppressClick: false,
  };

  const ui = {};

  /* --------------------------------------------------------------- utilities */

  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const child of [].concat(children)) if (child) node.appendChild(child);
    }
    return node;
  }

  async function api(path, options = {}) {
    const res = await fetch(EDIT + path, {
      ...options,
      headers: {
        'x-edit-token': CFG.token,
        'x-edit-client': CLIENT_ID,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return body || {};
  }

  const langOf = () =>
    ((document.documentElement.lang || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en');

  function currentPage() {
    return (CFG.pages || []).find((p) => p.file === CFG.file) || null;
  }

  function textNodesIn(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) { out.push(n); n = walker.nextNode(); }
    return out;
  }

  function wrap(node) {
    const span = document.createElement('span');
    span.className = 'se-run';
    node.parentNode.insertBefore(span, node);
    span.appendChild(node);
    return span;
  }

  function unwrap(span) {
    if (!span || !span.parentNode) return;
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }

  function caretRangeAt(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function textNodeAt(x, y) {
    const range = caretRangeAt(x, y);
    if (!range) return null;
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) return node;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const after = node.childNodes[range.startOffset];
    if (after && after.nodeType === Node.TEXT_NODE) return after;
    const before = node.childNodes[range.startOffset - 1];
    if (before && before.nodeType === Node.TEXT_NODE) return before;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  }

  /* ---------------------------------------------------------------- mapping */

  function markerUnit(node) {
    let prev = node.previousSibling;
    const parent = node.parentElement;
    if ((!prev || prev.nodeType !== Node.COMMENT_NODE) && parent && parent.classList.contains('se-run')) {
      prev = parent.previousSibling;
    }
    if (!prev || prev.nodeType !== Node.COMMENT_NODE) return null;
    const m = /^dsh-e(\d+)-(\d+)$/.exec(prev.data || '');
    if (!m) return null;
    return { kind: 'html', file: CFG.file, run: Number(m[1]), line: Number(m[2]) };
  }

  function i18nUnit(node) {
    const parent = node.parentElement;
    const host = parent && parent.closest('[data-block]');
    if (!host || !state.manifest) return null;
    const key = host.getAttribute('data-block');
    const lang = langOf();
    const bag = state.manifest.i18n[lang];
    if (!bag || !bag[key]) return null;
    const run = textNodesIn(host).indexOf(node);
    if (run < 0) return null;
    return { kind: 'i18n', key, lang, run, file: bag[key].file };
  }

  function tableUnit(node) {
    const parent = node.parentElement;
    const td = parent && parent.closest('td');
    if (!td) return null;
    const table = td.closest('table');
    if (!table) return null;
    const isComponents = table.classList.contains('table--components');
    const isMatrix = table.classList.contains('table--matrix');
    if (!isComponents && !isMatrix) return null;
    const tbody = table.tBodies[0];
    if (!tbody) return null;
    const rows = Array.from(tbody.rows);
    const row = td.closest('tr');
    const rowIndex = rows.indexOf(row);
    if (rowIndex < 0) return null;
    const cellIndex = Array.from(row.cells).indexOf(td);
    const run = textNodesIn(td).indexOf(node);
    if (run < 0) return null;
    const lang = langOf();

    if (isMatrix) {
      if (cellIndex !== 0) return null; // ● / — / rw are derived from booleans, not source text
      return {
        kind: 'js', file: 'assets/arch.js', root: 'PRESETS',
        path: [rowIndex, 'surface', lang], run, lang,
      };
    }

    let groupIndex = -1;
    let compIndex = -1;
    for (let i = 0; i <= rowIndex; i += 1) {
      if (rows[i].classList.contains('table-group')) { groupIndex += 1; compIndex = -1; }
      else compIndex += 1;
    }
    if (row.classList.contains('table-group')) {
      if (cellIndex !== 0) return null;
      return {
        kind: 'js', file: 'assets/arch.js', root: 'GROUPS',
        path: [groupIndex, lang], run, lang,
      };
    }
    const field = ['name', 'role', 'tools', 'work', 'version'][cellIndex];
    if (!field) return null;
    const path = [compIndex, field];
    if (field === 'role' || field === 'work') path.push(lang);
    return { kind: 'js', file: 'assets/arch.js', root: 'COMPONENTS', path, run, lang };
  }

  function resolveUnit(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    if (!(node.nodeValue || '').trim()) return null;
    const parent = node.parentElement;
    if (!parent) return null;
    if (parent.closest('.se-ui')) return null;
    if (parent.closest(CONTROL_SELECTOR)) return null;
    return markerUnit(node) || tableUnit(node) || i18nUnit(node);
  }

  function labelOf(unit, node) {
    if (!unit) return '';
    let label = '';
    if (unit.kind === 'html') label = unit.file + ' · 第 ' + unit.line + ' 行';
    else if (unit.kind === 'i18n') label = (unit.file || '字典') + ' · ' + unit.lang + ' · ' + unit.key;
    else if (unit.kind === 'js') label = unit.file + ' · ' + unit.root + '[' + unit.path.join('.') + ']';
    if (node && node.parentElement && node.parentElement.closest('a[href], area[href]')) {
      label += ' · Ctrl+点击 打开链接';
    }
    return label;
  }

  /* -------------------------------------------------------------------- UI */

  function buildUi() {
    const siteName = document.querySelector('.brand span, .site-brand span');
    const bar = h('div', { class: 'se-ui se-bar' });
    ui.bar = bar;

    ui.stateDot = h('i', { class: 'se-dot' });
    ui.stateText = h('b', { class: 'se-state-text', text: '编辑模式' });
    ui.fileText = h('span', { class: 'se-file', text: CFG.file });
    bar.appendChild(h('div', { class: 'se-row' }, [
      ui.stateDot, ui.stateText, h('span', { class: 'se-grow' }), ui.fileText,
    ]));

    const pages = h('div', { class: 'se-row se-pages' });
    for (const page of CFG.pages || []) {
      const here = page.file === CFG.file;
      pages.appendChild(h('a', {
        class: 'se-chip' + (here ? ' is-here' : ''),
        href: page.href,
        text: page.label,
        'aria-current': here ? 'page' : null,
      }));
    }
    bar.appendChild(pages);

    const current = currentPage();
    if (current && current.hasLang) {
      const langs = h('div', { class: 'se-row se-langs' });
      ui.langBtns = {};
      for (const lang of ['en', 'zh']) {
        const btn = h('button', {
          class: 'se-lang-btn',
          type: 'button',
          text: lang === 'zh' ? '中文' : 'EN',
          onclick: () => switchLang(lang),
        });
        ui.langBtns[lang] = btn;
        langs.appendChild(btn);
      }
      bar.appendChild(langs);
    }

    ui.status = h('div', { class: 'se-status', text: '点任意文字直接改 · 回车保存 · Esc 取消' });
    bar.appendChild(ui.status);

    const actions = h('div', { class: 'se-row se-actions' });
    actions.appendChild(h('button', {
      class: 'se-btn', type: 'button', text: '撤销上次保存',
      onclick: () => doUndo(),
    }));
    actions.appendChild(h('button', {
      class: 'se-btn', type: 'button', text: '查看改动',
      onclick: () => showDiff(),
    }));
    actions.appendChild(h('a', {
      class: 'se-btn se-btn--link', href: '?plain=1', target: '_blank', rel: 'noopener',
      title: '打开不带编辑层的原样页面',
      text: '原样预览',
    }));
    ui.toggleBtn = h('button', {
      class: 'se-btn se-btn--ghost', type: 'button', text: '退出编辑',
      onclick: () => toggleMode(),
    });
    actions.appendChild(ui.toggleBtn);
    bar.appendChild(actions);

    document.body.appendChild(bar);

    ui.panel = h('div', { class: 'se-ui se-panel', hidden: true }, [
      h('div', { class: 'se-panel-src' }),
      h('div', { class: 'se-panel-actions' }, [
        h('button', {
          class: 'se-btn se-btn--primary', type: 'button', text: '保存',
          onmousedown: (e) => e.preventDefault(),
          onclick: () => commitActive(),
        }),
        h('button', {
          class: 'se-btn', type: 'button', text: '取消',
          onmousedown: (e) => e.preventDefault(),
          onclick: () => cancelActive(),
        }),
        h('span', { class: 'se-kbd', text: '回车保存 · Esc 取消' }),
      ]),
      h('div', { class: 'se-panel-msg' }),
    ]);
    document.body.appendChild(ui.panel);
    ui.panelSrc = ui.panel.querySelector('.se-panel-src');
    ui.panelMsgEl = ui.panel.querySelector('.se-panel-msg');

    ui.toast = h('div', { class: 'se-ui se-toast', hidden: true }, [
      h('span', { class: 'se-toast-msg' }),
      h('button', {
        class: 'se-btn se-btn--ghost', type: 'button', text: '撤销',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => doUndo(),
      }),
      h('button', {
        class: 'se-btn se-btn--ghost', type: 'button', text: '×',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { ui.toast.hidden = true; },
      }),
    ]);
    document.body.appendChild(ui.toast);
    ui.toastMsg = ui.toast.querySelector('.se-toast-msg');

    ui.modal = h('div', { class: 'se-ui se-modal', hidden: true }, [
      h('div', { class: 'se-modal-card' }, [
        h('div', { class: 'se-modal-head' }, [
          h('b', { text: '工作区改动（git diff site/）' }),
          h('button', {
            class: 'se-btn se-btn--ghost', type: 'button', text: '关闭',
            onclick: () => { ui.modal.hidden = true; },
          }),
        ]),
        h('pre', { class: 'se-diff' }),
      ]),
    ]);
    document.body.appendChild(ui.modal);
    ui.diffPre = ui.modal.querySelector('.se-diff');
    ui.modal.addEventListener('click', (e) => {
      if (e.target === ui.modal) ui.modal.hidden = true;
    });

    void siteName;
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text || '点任意文字直接改 · 回车保存 · Esc 取消';
  }

  function panelMsg(text, kind) {
    if (!ui.panelMsgEl) return;
    ui.panelMsgEl.textContent = text || '';
    ui.panelMsgEl.classList.toggle('is-error', kind === 'err');
  }

  const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th,figcaption,blockquote,dd,dt,summary,label';

  function anchorRect(span) {
    const block = span.closest(BLOCK_SELECTOR);
    const own = span.getBoundingClientRect();
    if (block) {
      const rect = block.getBoundingClientRect();
      // A short block (a heading, a list item) reads better as the anchor; for tall
      // paragraphs the line itself is the useful anchor.
      if (rect.height > 0 && rect.height <= 240) return rect;
    }
    return own;
  }

  function placePanel() {
    if (!state.active) return;
    const rect = anchorRect(state.active.span);
    const box = ui.panel.getBoundingClientRect();
    const width = box.width || 360;
    const height = box.height || 90;
    let left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    let top = rect.bottom + 10;
    if (top + height + 8 > window.innerHeight) {
      const above = rect.top - height - 10;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
    }
    ui.panel.style.left = left + 'px';
    ui.panel.style.top = top + 'px';
  }

  function showToast(message, withUndo) {
    if (!ui.toast) return;
    ui.toastMsg.textContent = message;
    ui.toast.querySelectorAll('.se-btn--ghost')[0].style.display = withUndo === false ? 'none' : '';
    ui.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { ui.toast.hidden = true; }, 6000);
  }

  function flash(message) {
    try { sessionStorage.setItem('se:flash', message); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------- hover/edit */

  function updateHover() {
    const point = state.lastPoint;
    if (!point || !state.editMode || state.active) return;
    if (state.hover && state.hover.node && state.hover.node.isConnected) {
      const again = textNodeAt(point.x, point.y);
      if (again === state.hover.node) return;
    }
    const node = textNodeAt(point.x, point.y);
    const unit = node ? resolveUnit(node) : null;
    if (!unit) { clearHover(); return; }
    if (state.hover && state.hover.node === node) return;
    clearHover();
    const span = wrap(node);
    span.classList.add('is-hover');
    state.hover = { node, unit, span };
    document.body.classList.add('se-hovering');
    setStatus(labelOf(unit, node));
  }

  function clearHover() {
    if (state.hover) {
      if (state.hover.span && state.hover.span.isConnected) unwrap(state.hover.span);
      state.hover = null;
      document.body.classList.remove('se-hovering');
      setStatus('');
    }
  }

  function ensureRunSpan(node) {
    const parent = node.parentElement;
    if (parent && parent.classList.contains('se-run')) return parent;
    return wrap(node);
  }

  function beginEdit(node, unit, x, y) {
    if (state.active) return;
    lastRange = caretRangeAt(x, y);
    const span = ensureRunSpan(node);
    if (state.hover && state.hover.span === span) state.hover = null;
    span.classList.remove('is-hover');
    span.classList.add('is-editing');
    span.setAttribute('contenteditable', PLAINTEXT_OK ? 'plaintext-only' : 'true');
    span.setAttribute('tabindex', '-1');

    state.active = { node, span, unit, original: node.nodeValue || '' };
    document.body.classList.add('se-editing');

    ui.panelSrc.textContent = labelOf(unit, node);
    panelMsg('');
    ui.panel.hidden = false;
    placePanel();

    span.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    try {
      if (lastRange && lastRange.startContainer === node) selection.addRange(lastRange);
    } catch { /* ignore */ }
    if (!selection.rangeCount) {
      const range = document.createRange();
      range.selectNodeContents(span);
      range.collapse(false);
      selection.addRange(range);
    }
  }

  let lastRange = null;

  function normalizeSpan(span, text) {
    if (span.textContent !== text) span.textContent = text;
    else if (span.childNodes.length !== 1 || span.firstChild.nodeType !== Node.TEXT_NODE) {
      span.textContent = text;
    }
  }

  function finishEdit() {
    const active = state.active;
    if (!active) return;
    const { span } = active;
    const text = span.textContent;
    span.textContent = text;
    span.removeAttribute('contenteditable');
    span.removeAttribute('tabindex');
    span.classList.remove('is-editing', 'is-hover');
    unwrap(span);
    state.active = null;
    ui.panel.hidden = true;
    document.body.classList.remove('se-editing');
    setStatus('');
  }

  function cancelActive() {
    if (!state.active) return;
    const { span, original } = state.active;
    normalizeSpan(span, original);
    finishEdit();
  }

  async function commitActive() {
    const active = state.active;
    if (!active) return true;
    if (state.busy) return false;
    const next = active.span.textContent;
    if (next === active.original) { finishEdit(); return true; }

    state.busy = true;
    panelMsg('保存中…');
    try {
      const result = await api('/save', {
        method: 'POST',
        body: JSON.stringify({ ...active.unit, old: active.original, new: next }),
      });
      state.busy = false;
      const label = (result.file || active.unit.file) + (result.line ? ':' + result.line : '');
      const kind = active.unit.kind;
      finishEdit();
      if (kind === 'html') {
        showToast('已写入 ' + label + ' — 刷新后仍在', true);
      } else {
        flash('已写入 ' + label + ' — 刷新后仍在');
        sessionStorage.setItem('se:scroll', String(window.scrollY));
        setTimeout(() => location.reload(), 650);
      }
      return true;
    } catch (err) {
      state.busy = false;
      panelMsg(err.message || '保存失败', 'err');
      return false;
    }
  }

  /* ------------------------------------------------------------- interaction */

  function onClickCapture(event) {
    if (!state.editMode || state.suppressClick) return;
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.se-ui')) return;

    if (target.closest(CONTROL_SELECTOR)) {
      if (state.active) commitActive();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      if (state.active) commitActive();
      return; // Ctrl/Shift+click keeps the browser's native link behaviour
    }

    const node = textNodeAt(event.clientX, event.clientY);
    const unit = node ? resolveUnit(node) : null;
    if (!unit) {
      if (state.active) commitActive();
      if (node && (node.nodeValue || '').trim()) {
        setStatus('这段文字暂不支持就地编辑（由脚本生成，或在按钮/控件内）');
      } else {
        setStatus('');
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (state.active) {
      if (state.active.node === node) return;
      commitActive().then((ok) => {
        if (ok && node.isConnected) beginEdit(node, unit, event.clientX, event.clientY);
      });
      return;
    }
    beginEdit(node, unit, event.clientX, event.clientY);
  }

  function onPointerMove(event) {
    if (!state.editMode || state.active) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.se-ui')) { clearHover(); return; }
    state.lastPoint = { x: event.clientX, y: event.clientY };
    if (onPointerMove.queued) return;
    onPointerMove.queued = true;
    requestAnimationFrame(() => {
      onPointerMove.queued = false;
      updateHover();
    });
  }

  function onKeyDown(event) {
    if (!state.active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelActive();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      commitActive();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S' || event.key === 'Enter')) {
      event.preventDefault();
      event.stopPropagation();
      commitActive();
    }
  }

  function toggleMode() {
    if (state.editMode && state.active) commitActive();
    state.editMode = !state.editMode;
    document.body.classList.toggle('se-edit-off', !state.editMode);
    ui.stateText.textContent = state.editMode ? '编辑模式' : '浏览模式';
    ui.stateDot.classList.toggle('is-off', !state.editMode);
    ui.toggleBtn.textContent = state.editMode ? '退出编辑' : '进入编辑';
    setStatus(state.editMode ? '' : '浏览模式：点击恢复编辑');
    if (!state.editMode) clearHover();
  }

  function switchLang(lang) {
    if (!ui.langBtns) return;
    const button = document.querySelector('.lang__btn[data-lang="' + lang + '"]');
    if (!button) return;
    if (state.active) cancelActive();
    clearHover();
    state.suppressClick = true;
    button.click();
    setTimeout(() => { state.suppressClick = false; }, 60);
    setTimeout(() => { updateLangButtons(); setStatus(''); }, 80);
  }

  function updateLangButtons() {
    if (!ui.langBtns) return;
    const current = langOf();
    for (const [lang, btn] of Object.entries(ui.langBtns)) {
      btn.classList.toggle('is-on', lang === current);
      btn.setAttribute('aria-pressed', lang === current ? 'true' : 'false');
    }
  }

  /* ------------------------------------------------------------------ extras */

  async function doUndo() {
    try {
      const result = await api('/undo', { method: 'POST', body: '{}' });
      flash('已撤销 ' + (result.file || '') + (result.line ? ':' + result.line : ''));
      sessionStorage.setItem('se:scroll', String(window.scrollY));
      location.reload();
    } catch (err) {
      showToast('撤销失败：' + (err.message || err), false);
    }
  }

  async function showDiff() {
    ui.modal.hidden = false;
    ui.diffPre.textContent = '读取中…';
    try {
      const result = await api('/diff');
      const head = result.status ? result.status : '';
      ui.diffPre.textContent = [head, result.diff || '（没有未提交的改动）'].filter(Boolean).join('\n');
    } catch (err) {
      ui.diffPre.textContent = '读取失败：' + (err.message || err);
    }
  }

  function restoreScrollAndFlash() {
    try {
      const y = sessionStorage.getItem('se:scroll');
      if (y) { sessionStorage.removeItem('se:scroll'); window.scrollTo(0, Number(y)); }
      const message = sessionStorage.getItem('se:flash');
      if (message) { sessionStorage.removeItem('se:flash'); showToast(message, true); }
    } catch { /* ignore */ }
  }

  function connectEvents() {
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', () => { if (state.active) placePanel(); }, { passive: true });
    window.addEventListener('resize', () => { if (state.active) placePanel(); });

    if (window.EventSource) {
      try {
        const source = new EventSource(EDIT + '/events?client=' + encodeURIComponent(CLIENT_ID));
        source.onmessage = (event) => {
          let data = null;
          try { data = JSON.parse(event.data); } catch { return; }
          if (!data || data.type !== 'change') return;
          if (state.active) { setStatus('文件已在别处改动：先保存或取消当前编辑'); return; }
          if (document.hidden) return;
          try { sessionStorage.setItem('se:scroll', String(window.scrollY)); } catch { /* ignore */ }
          location.reload();
        };
      } catch { /* ignore */ }
    }
  }

  async function loadManifest() {
    try {
      state.manifest = await api('/manifest');
    } catch (err) {
      setStatus('编辑器未就绪：' + (err.message || err));
    }
    updateLangButtons();
  }

  function boot() {
    buildUi();
    restoreScrollAndFlash();
    connectEvents();
    loadManifest();
    document.body.classList.add('se-edit-on');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
