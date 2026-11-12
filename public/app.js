/* EasyBo Student Buddy: single-page frontend.
   Talks only to the existing server.js routes:
   /api/config, /api/config/mock, /api/ocr/upload, /api/ocr/correct,
   /api/chat/organize, /api/chat/ask, /api/records (GET/POST/PUT). */
(() => {
  'use strict';

  // ───────── Constants ─────────
  const STUDENTS = [
    { id: '2026-00142', name: 'Juan Dela Cruz', first: 'Juan', program: 'BSIT 1-A' },
    { id: '2026-00891', name: 'Maria Santos', first: 'Maria', program: 'BSCS 2-B' }
  ];
  const CATEGORIES = ['Receipt & Tuition', 'Enrollment & Clearance', 'Scholarship', 'Class Note & Memo'];
  const CATEGORY_ICON = {
    'Receipt & Tuition': 'receipt',
    'Enrollment & Clearance': 'clipboard-check',
    'Scholarship': 'award',
    'Class Note & Memo': 'sticky-note'
  };
  const VIEWS = ['dashboard', 'scanner', 'vault', 'tracker', 'buddy'];
  const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/tiff'];
  const MAX_BYTES = 10 * 1024 * 1024;

  // ───────── State ─────────
  const freshScan = () => ({
    step: 1, file: null, previewUrl: '', previewType: '', loading: false, organizing: false,
    docId: null, fileName: '', text: '', words: [], corrections: {}, popover: null,
    fields: { title: '', category: CATEGORIES[0], referenceNo: '', amountPaid: 0, balanceDue: 0, deadline: '', summary: '', studyNotes: '', checklist: '' }
  });

  const state = {
    studentId: localStorage.getItem('easybo.student') || STUDENTS[0].id,
    records: [],
    mock: false,
    hasKeys: true,
    view: 'dashboard',
    scan: freshScan(),
    chat: [],
    chatScope: 'vault',
    chatBusy: false,
    vaultQ: '',
    vaultCat: 'ALL',
    trackerShow: 'pending'
  };

  // ───────── Helpers ─────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const student = () => STUDENTS.find((s) => s.id === state.studentId) || STUDENTS[0];
  const icons = () => { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } }); };
  const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

  function parseDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(v + 'T00:00:00');
    return isNaN(d) ? null : d;
  }
  function fmtDay(v) {
    const d = parseDay(v);
    return d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : (v && v !== 'None' ? String(v) : 'No deadline');
  }
  function dueMeta(v) {
    const d = parseDay(v);
    if (!d) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    if (days < 0) return { days, label: `${-days}d overdue`, cls: 'badge-danger' };
    if (days === 0) return { days, label: 'Due today', cls: 'badge-danger' };
    if (days <= 7) return { days, label: `in ${days}d`, cls: 'badge-warn' };
    return { days, label: `in ${days}d`, cls: 'badge-muted' };
  }
  function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  // Escape first, then allow **bold** and line breaks only.
  function richText(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'); }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON body */ }
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `Request failed (${res.status})`);
    return data || {};
  }
  const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ───────── Toasts & modals ─────────
  function toast(msg, type = 'ok') {
    const ico = { ok: 'check-circle-2', error: 'alert-circle', warn: 'info' }[type] || 'info';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i data-lucide="${ico}"></i><span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    icons();
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); }, type === 'error' ? 6000 : 3500);
  }
  function openModal(html, wide = false) {
    $('#modalRoot').innerHTML = `<div class="modal-back" data-action="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    icons();
    const f = $('#modalRoot [autofocus], #modalRoot input, #modalRoot textarea, #modalRoot button');
    if (f) f.focus();
  }
  const closeModal = () => { $('#modalRoot').innerHTML = ''; };

  // ───────── Persistence (server first, localStorage fallback) ─────────
  const lsKey = () => `easybo.records.${state.studentId}`;
  function cacheLocal() { try { localStorage.setItem(lsKey(), JSON.stringify(state.records)); } catch (_) { /* quota */ } }
  function readLocal() { try { return JSON.parse(localStorage.getItem(lsKey()) || '[]'); } catch (_) { return []; } }

  async function loadRecords() {
    try {
      const data = await api(`/api/records?studentId=${encodeURIComponent(state.studentId)}`);
      state.records = Array.isArray(data.records) ? data.records : [];
      cacheLocal();
    } catch (_) {
      state.records = readLocal();
      toast('Server unreachable. Showing records saved on this device.', 'warn');
    }
  }
  async function syncRecords() {
    cacheLocal();
    try {
      await api('/api/records', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: state.studentId, records: state.records }) });
    } catch (_) {
      toast('Saved on this device only. Server sync failed.', 'warn');
    }
  }
  async function addRecord(record) {
    state.records.unshift(record);
    cacheLocal();
    try { await postJson('/api/records', { studentId: state.studentId, record }); }
    catch (_) { toast('Saved on this device only. Server sync failed.', 'warn'); }
  }

  // ───────── Derived data ─────────
  function allTasks() {
    const out = [];
    state.records.forEach((r) => (r.tasks || []).forEach((t) => out.push({ ...t, recordId: r.id, recordTitle: r.title, deadline: r.deadline })));
    return out;
  }
  function sortByDeadline(a, b) {
    const da = parseDay(a.deadline), db = parseDay(b.deadline);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return 0;
  }
  function stats() {
    const tasks = allTasks();
    const done = tasks.filter((t) => t.done).length;
    const due = state.records.filter((r) => Number(r.balanceDue) > 0 && parseDay(r.deadline)).sort(sortByDeadline)[0];
    return {
      total: state.records.length,
      paid: state.records.reduce((s, r) => s + (Number(r.amountPaid) || 0), 0),
      balance: state.records.reduce((s, r) => s + (Number(r.balanceDue) || 0), 0),
      nextDue: due ? due.deadline : null,
      tasks: tasks.length, done, pending: tasks.length - done,
      pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0
    };
  }

  // ───────── Routing & shell ─────────
  function setView(view, { push = true } = {}) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    state.view = view;
    if (push && location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    $$('.nav-item[data-view]').forEach((a) => {
      const on = a.dataset.view === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    closeSidebar();
    renderView(true);
    window.scrollTo({ top: 0 });
  }
  function renderView(animate = false) {
    const root = $('#viewRoot');
    const fn = { dashboard: viewDashboard, scanner: viewScanner, vault: viewVault, tracker: viewTracker, buddy: viewBuddy }[state.view];
    root.innerHTML = fn();
    if (animate) { root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter'); }
    updateNavBadge();
    icons();
    if (state.view === 'buddy') scrollChat();
  }
  function updateNavBadge() {
    const n = stats().pending;
    const el = $('#navPending');
    el.hidden = n === 0;
    el.textContent = n;
  }
  const openSidebar = () => { $('#sidebar').classList.add('open'); $('.scrim').hidden = false; };
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('.scrim').hidden = true; }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('easybo.theme', t);
    // Rebuild the button content: Lucide replaces <i> tags with <svg>, so swap the whole thing.
    $('#themeBtn').innerHTML = `<i data-lucide="${t === 'dark' ? 'sun' : 'moon'}"></i><span>${t === 'dark' ? 'Light theme' : 'Dark theme'}</span>`;
    icons();
  }

  function renderStudentSelect() {
    $('#studentSelect').innerHTML = STUDENTS.map((s) =>
      `<option value="${esc(s.id)}" ${s.id === state.studentId ? 'selected' : ''}>${esc(s.name)} • ${esc(s.id)} (${esc(s.program)})</option>`).join('');
  }
  function renderApiMode() {
    const sw = $('#mockSwitch');
    sw.setAttribute('aria-checked', String(state.mock));
    $('#apiModeLabel').textContent = state.mock ? 'Mock Mode (Credit Saver)' : 'Live Lumen API';
  }

  // ───────── View 1: Dashboard ─────────
  function viewDashboard() {
    const s = stats();
    const st = student();
    const upcoming = allTasks().filter((t) => !t.done).sort(sortByDeadline).slice(0, 6);
    const recent = state.records.slice(0, 3);
    const nextDue = s.nextDue ? `Next due ${fmtDay(s.nextDue)}` : 'No upcoming due date';

    return `
      <div class="page-head">
        <div>
          <h1 class="page-title">Magandang araw, ${esc(st.first)}!</h1>
          <p class="page-sub">Here is your 1st Semester clearance &amp; financial snapshot.</p>
        </div>
        <div class="row">
          <button class="btn btn-primary" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan New Document</button>
          <button class="btn btn-ghost" data-action="quick-note" type="button"><i data-lucide="square-pen"></i>New Quick Note</button>
        </div>
      </div>

      <section class="grid-4" aria-label="Key numbers">
        <div class="card metric">
          <div class="metric-top"><span>Organized records</span><span class="metric-ico brand"><i data-lucide="folder-check"></i></span></div>
          <div class="metric-value">${s.total}</div>
          <div class="metric-foot">Receipts, memos &amp; notes</div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span>Verified tuition &amp; fees paid</span><span class="metric-ico ok"><i data-lucide="badge-check"></i></span></div>
          <div class="metric-value mono ok">${peso(s.paid)}</div>
          <div class="metric-foot">From verified official receipts</div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span>Remaining balance due</span><span class="metric-ico warn"><i data-lucide="hourglass"></i></span></div>
          <div class="metric-value mono warn">${peso(s.balance)}</div>
          <div class="metric-foot">${esc(nextDue)}</div>
        </div>
        <div class="card metric">
          <div class="metric-top"><span>Clearance progress</span><span class="metric-ico brand"><i data-lucide="shield-check"></i></span></div>
          <div class="metric-value">${s.done} <span style="color:var(--faint);font-weight:600">of ${s.tasks}</span></div>
          <div class="progress ${s.pct === 100 ? 'ok' : ''}" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Clearance progress"><span style="width:${s.pct}%"></span></div>
          <div class="metric-foot">${s.tasks ? `${s.pct}% of requirements completed` : 'No requirements yet'}</div>
        </div>
      </section>

      <section class="grid-2" style="margin-top:20px">
        <div class="card">
          <div class="card-head">
            <div><h2 class="card-title">Upcoming deadlines &amp; urgent tasks</h2><p class="card-sub">Tick them off as you go</p></div>
            <button class="btn btn-ghost btn-sm" data-action="goto" data-view="tracker" type="button">View all</button>
          </div>
          ${upcoming.length ? upcoming.map(taskRow).join('') : emptyState('party-popper', 'You are all caught up', 'New tasks appear when you scan a memo or receipt.', 'Scan a document', 'scanner')}
        </div>
        <div class="card">
          <div class="card-head">
            <div><h2 class="card-title">Recent vault additions</h2><p class="card-sub">Your last three filed documents</p></div>
            <button class="btn btn-ghost btn-sm" data-action="goto" data-view="vault" type="button">Open vault</button>
          </div>
          ${recent.length ? recent.map((r) => `
            <button class="recent" data-action="open-record" data-id="${esc(r.id)}" type="button">
              <span class="recent-ico"><i data-lucide="${CATEGORY_ICON[r.category] || 'file-text'}"></i></span>
              <span class="recent-main"><div class="recent-title">${esc(r.title)}</div><div class="recent-sub"><span class="mono">${esc(r.referenceNo)}</span> • ${esc(r.createdAt || '')}</div></span>
              <i data-lucide="chevron-right" style="color:var(--faint)"></i>
            </button>`).join('') : emptyState('inbox', 'Nothing filed yet', 'Scanned receipts and memos will show up here.', 'Load Demo Data', null, 'load-demo')}
        </div>
      </section>`;
  }

  function taskRow(t) {
    const m = dueMeta(t.deadline);
    return `
      <label class="task ${t.done ? 'done' : ''}">
        <input type="checkbox" ${t.done ? 'checked' : ''} data-action="toggle-task" data-rec="${esc(t.recordId)}" data-task="${esc(t.id)}" aria-label="${esc(t.text)}" />
        <span class="task-body">
          <div class="task-text">${esc(t.text)}</div>
          <div class="task-meta"><span>${esc(t.recordTitle)}</span>${m ? `<span class="badge ${m.cls}">${esc(m.label)}</span>` : ''}</div>
        </span>
      </label>`;
  }
  function emptyState(icon, title, text, cta, view, action) {
    const attrs = action ? `data-action="${action}"` : `data-action="goto" data-view="${view}"`;
    return `<div class="empty"><i data-lucide="${icon}"></i><p class="empty-title">${esc(title)}</p><p>${esc(text)}</p><button class="btn btn-ghost btn-sm" ${attrs} type="button">${esc(cta)}</button></div>`;
  }

  // ───────── View 2: Scan & Verify Studio ─────────
  function viewScanner() {
    const sc = state.scan;
    const steps = ['Upload & preview', 'Verify text', 'Organize & file'];
    const stepper = steps.map((label, i) => {
      const n = i + 1;
      const cls = n < sc.step ? 'done' : n === sc.step ? 'active' : '';
      return `<div class="step ${cls}" ${n === sc.step ? 'aria-current="step"' : ''}><span class="step-n">${n < sc.step ? '✓' : n}</span><span>${label}</span></div>${n < 3 ? '<span class="step-line"></span>' : ''}`;
    }).join('');

    const body = sc.step === 1 ? scanStep1() : sc.step === 2 ? scanStep2() : scanStep3();
    return `
      <div class="page-head"><div><h1 class="page-title">Scan &amp; Verify Studio</h1><p class="page-sub">Read it, check it, then file it. Nothing is saved until you confirm.</p></div></div>
      <div class="stepper" aria-label="Progress">${stepper}</div>
      ${body}`;
  }

  function previewHtml(sc) {
    if (!sc.previewUrl) return `<div class="preview-empty"><i data-lucide="file-image"></i><div>Your document preview shows here</div></div>`;
    if (sc.previewType === 'application/pdf') return `<iframe src="${esc(sc.previewUrl)}" title="PDF preview"></iframe>`;
    if (sc.previewType === 'image/tiff') return `<div class="preview-empty"><i data-lucide="file-image"></i><div>TIFF preview is not supported by browsers.<br>OCR still works.</div></div>`;
    return `<img src="${esc(sc.previewUrl)}" alt="Preview of ${esc(sc.fileName)}" />`;
  }

  function scanStep1() {
    const sc = state.scan;
    return `
      <div class="split">
        <div class="card sticky-card">
          <div class="card-head"><h2 class="card-title">Live preview</h2>${sc.file ? `<span class="badge badge-muted mono">${esc(sc.previewType.split('/')[1] || 'file')}</span>` : ''}</div>
          <div class="preview-box">${previewHtml(sc)}</div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h2 class="card-title">Upload a receipt or memo</h2><p class="card-sub">PDF, PNG, JPG, WebP or TIFF, up to 10 MB</p></div></div>
            ${sc.loading ? `
              <div class="skel-stack" aria-busy="true">
                <div class="row" style="color:var(--brand)"><span class="spinner"></span><strong>Lumen OCR is reading your document…</strong></div>
                <div class="skeleton" style="width:92%"></div><div class="skeleton" style="width:78%"></div>
                <div class="skeleton" style="width:86%"></div><div class="skeleton" style="width:54%"></div>
                <div class="skeleton" style="width:70%"></div>
                <p class="card-sub">Uploading, then checking status until the pages are ready. This can take up to 20 seconds in live mode.</p>
              </div>` : sc.file ? `
              <div class="file-chip">
                <i data-lucide="${sc.previewType === 'application/pdf' ? 'file-text' : 'image'}"></i>
                <div style="flex:1;min-width:0"><div class="name">${esc(sc.fileName)}</div><div class="meta">${fmtBytes(sc.file.size)}</div></div>
                <button class="icon-btn" data-action="remove-file" type="button" aria-label="Remove file"><i data-lucide="x"></i></button>
              </div>
              <div class="footer-bar"><span class="card-sub">Looks good? Run the OCR.</span>
                <button class="btn btn-primary" data-action="run-ocr" type="button"><i data-lucide="scan-text"></i>Read with Lumen OCR</button></div>` : `
              <label class="dropzone" id="dropzone">
                <i data-lucide="upload-cloud"></i>
                <p class="dropzone-title">Drag &amp; drop a file here</p>
                <p class="dropzone-sub">or click to browse your device</p>
                <input id="fileInput" type="file" accept=".pdf,image/png,image/jpeg,image/webp,image/tiff" />
              </label>`}
          </div>
          ${sc.loading ? '' : `<div class="card">
            <h2 class="card-title">No file handy?</h2>
            <p class="card-sub" style="margin-bottom:12px">Paste text from a school announcement and skip straight to verification.</p>
            <button class="btn btn-ghost btn-sm" data-action="skip-upload" type="button"><i data-lucide="clipboard-paste"></i>Paste text instead</button>
          </div>`}
        </div>
      </div>`;
  }

  function scanStep2() {
    const sc = state.scan;
    const words = sc.words || [];
    const pop = sc.popover;
    const fixedCount = Object.keys(sc.corrections).length;
    return `
      <div class="split">
        <div class="card sticky-card">
          <div class="card-head"><div><h2 class="card-title">Original document</h2><p class="card-sub">${esc(sc.fileName || 'Pasted text')}</p></div></div>
          <div class="preview-box">${previewHtml(sc)}</div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head">
              <div><h2 class="card-title">Extracted text</h2><p class="card-sub">Edit anything the OCR got wrong.</p></div>
              <span class="badge badge-warn"><i data-lucide="user-check"></i>Needs your check</span>
            </div>
            <label class="sr-only" for="ocrText">Extracted OCR text</label>
            <textarea id="ocrText" class="textarea code" rows="13" data-bind="text" placeholder="Type or paste the document text here…">${esc(sc.text)}</textarea>
          </div>

          <div class="card">
            <div class="card-head">
              <div><h2 class="card-title">Word review</h2><p class="card-sub">Log fixes to Lumen's review API. ${fixedCount ? `<span class="mono" style="color:var(--ok)">${fixedCount} verified</span>` : ''}</p></div>
              <button class="btn btn-ghost btn-sm" data-action="open-fix" data-index="" type="button"><i data-lucide="pencil-line"></i>Fix a word</button>
            </div>
            ${words.length ? `<div class="word-chips">${words.map((w) => {
              const fixed = sc.corrections[w.wordIndex];
              return `<button type="button" class="word-chip ${fixed ? 'fixed' : ''}" data-action="open-fix" data-index="${w.wordIndex}">
                <span class="idx">#${w.wordIndex}</span><span>${esc(fixed ? fixed : w.text)}</span><i data-lucide="${fixed ? 'check' : 'pencil'}" style="width:13px;height:13px"></i></button>`;
            }).join('')}</div>` : `<p class="card-sub">No word-level sample came back. Use "Fix a word" and enter the word position if you need to log a correction.</p>`}
            ${pop ? fixPopover(pop) : ''}
          </div>
        </div>
      </div>
      <div class="footer-bar">
        <button class="btn btn-ghost" data-action="scan-back" type="button"><i data-lucide="arrow-left"></i>Back</button>
        <button class="btn btn-primary" data-action="organize" type="button"><i data-lucide="wand-sparkles"></i>Looks right. Organize with AI</button>
      </div>`;
  }

  function fixPopover(p) {
    return `
      <div class="review-pop" role="dialog" aria-label="Correct a word">
        <div class="form-grid" style="grid-template-columns:90px 1fr">
          <div class="field"><label for="fixIndex">Word #</label><input id="fixIndex" class="input mono" type="number" min="0" value="${esc(p.wordIndex)}" /></div>
          <div class="field"><label for="fixText">Correct text${p.original ? ` (OCR read “${esc(p.original)}”)` : ''}</label><input id="fixText" class="input mono" type="text" maxlength="512" value="${esc(p.text)}" autofocus /></div>
        </div>
        <div class="modal-actions" style="margin-top:12px">
          <button class="btn btn-ghost btn-sm" data-action="close-fix" type="button">Cancel</button>
          <button class="btn btn-ok btn-sm" data-action="save-fix" type="button" ${p.busy ? 'disabled' : ''}>${p.busy ? '<span class="spinner"></span>' : '<i data-lucide="check"></i>'}Confirm fix</button>
        </div>
      </div>`;
  }

  function scanStep3() {
    const sc = state.scan;
    const f = sc.fields;
    if (sc.organizing) {
      return `
        <div class="card" aria-busy="true">
          <div class="row" style="color:var(--brand);margin-bottom:16px"><span class="spinner"></span><strong>Lumen AI Chat is organizing your document…</strong></div>
          <div class="form-grid">${'<div class="field"><div class="skeleton" style="width:40%"></div><div class="skeleton" style="height:36px"></div></div>'.repeat(6)}</div>
          <div class="skel-stack" style="margin-top:18px"><div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:50px"></div></div>
        </div>`;
    }
    const opts = CATEGORIES.map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
    return `
      <div class="card">
        <div class="card-head">
          <div><h2 class="card-title">Review the filed record</h2><p class="card-sub">AI filled these in. Fix anything before saving.</p></div>
          <button class="btn btn-ghost btn-sm" data-action="organize" type="button"><i data-lucide="refresh-cw"></i>Re-run AI</button>
        </div>
        <div class="form-grid">
          <div class="field span-2"><label for="f_title">Title</label><input id="f_title" class="input" data-field="title" value="${esc(f.title)}" /></div>
          <div class="field"><label for="f_category">Category</label><select id="f_category" class="select" data-field="category">${opts}</select></div>
          <div class="field"><label for="f_ref">OR / Reference no.</label><input id="f_ref" class="input mono" data-field="referenceNo" value="${esc(f.referenceNo)}" /></div>
          <div class="field"><label for="f_paid">Amount paid (₱)</label><input id="f_paid" class="input mono" type="number" step="0.01" min="0" data-field="amountPaid" value="${esc(f.amountPaid)}" /></div>
          <div class="field"><label for="f_due">Balance due (₱)</label><input id="f_due" class="input mono" type="number" step="0.01" min="0" data-field="balanceDue" value="${esc(f.balanceDue)}" /></div>
          <div class="field"><label for="f_deadline">Deadline</label><input id="f_deadline" class="input mono" type="date" data-field="deadline" value="${esc(f.deadline)}" /></div>
          <div class="field span-3"><label for="f_summary">Taglish explanation</label><textarea id="f_summary" class="textarea" rows="3" data-field="summary">${esc(f.summary)}</textarea></div>
          <div class="field span-3" style="grid-column:span 3"><label for="f_notes">Study notes (one per line)</label><textarea id="f_notes" class="textarea" rows="3" data-field="studyNotes">${esc(f.studyNotes)}</textarea></div>
          <div class="field span-3"><label for="f_check">Action checklist (one per line)</label><textarea id="f_check" class="textarea" rows="4" data-field="checklist">${esc(f.checklist)}</textarea></div>
        </div>
      </div>
      <div class="footer-bar">
        <button class="btn btn-ghost" data-action="scan-back" type="button"><i data-lucide="arrow-left"></i>Back to text</button>
        <button class="btn btn-ok" data-action="save-record" type="button"><i data-lucide="shield-check"></i>Confirm &amp; save to vault</button>
      </div>`;
  }

  // Scanner actions
  function setFile(file) {
    if (!file) return;
    const type = file.type || '';
    if (!ACCEPT.includes(type)) { toast('Unsupported file. Use PDF, PNG, JPG, WebP or TIFF.', 'error'); return; }
    if (file.size > MAX_BYTES) { toast('That file is over 10 MB. Try a smaller scan.', 'error'); return; }
    clearPreview();
    const sc = state.scan;
    sc.file = file; sc.fileName = file.name; sc.previewType = type; sc.previewUrl = URL.createObjectURL(file);
    renderView();
  }
  function clearPreview() { if (state.scan.previewUrl) URL.revokeObjectURL(state.scan.previewUrl); }
  function resetScan() { clearPreview(); state.scan = freshScan(); }

  async function runOcr() {
    const sc = state.scan;
    if (!sc.file || sc.loading) return;
    sc.loading = true; renderView();
    try {
      const fd = new FormData();
      fd.append('document', sc.file);
      const data = await api('/api/ocr/upload', { method: 'POST', body: fd });
      sc.docId = data.documentId;
      sc.text = data.extractedText || '';
      sc.words = Array.isArray(data.wordsSample) ? data.wordsSample : [];
      sc.corrections = {};
      sc.step = 2;
      toast(data.mock ? 'Mock OCR complete (no credits used).' : 'OCR complete. Please verify the text.');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      sc.loading = false; renderView(); window.scrollTo({ top: 0 });
    }
  }

  function openFix(indexStr) {
    const sc = state.scan;
    syncTextFromDom();
    const idx = indexStr === '' || indexStr == null ? 0 : Number(indexStr);
    const w = sc.words.find((x) => x.wordIndex === idx);
    sc.popover = { wordIndex: idx, original: indexStr === '' ? '' : (w?.text || ''), text: indexStr === '' ? '' : (sc.corrections[idx] || w?.text || ''), busy: false };
    renderView();
    const input = $('#fixText'); if (input) { input.focus(); input.select(); }
  }
  async function saveFix() {
    const sc = state.scan, p = sc.popover;
    if (!p) return;
    const idx = Number($('#fixIndex').value);
    const text = $('#fixText').value.trim();
    if (!text) { toast('Enter the corrected text first.', 'warn'); return; }
    if (!Number.isInteger(idx) || idx < 0) { toast('Word # must be 0 or higher.', 'warn'); return; }
    p.busy = true; p.wordIndex = idx; p.text = text; renderView();
    try {
      await postJson('/api/ocr/correct', { documentId: sc.docId || 'mock-doc', pageNumber: 1, wordIndex: idx, text });
      const original = sc.words.find((x) => x.wordIndex === idx)?.text || p.original;
      if (original && sc.text.includes(original)) sc.text = sc.text.replace(original, text);
      sc.corrections[idx] = text;
      sc.popover = null;
      toast(`Word #${idx} verified and logged.`);
    } catch (e) {
      p.busy = false; toast(e.message, 'error');
    }
    renderView();
  }

  function syncTextFromDom() { const t = $('#ocrText'); if (t) state.scan.text = t.value; }

  async function organize() {
    const sc = state.scan;
    syncTextFromDom();
    if (!sc.text.trim()) { toast('Add some document text first.', 'warn'); return; }
    sc.step = 3; sc.organizing = true; renderView(); window.scrollTo({ top: 0 });
    try {
      const data = await postJson('/api/chat/organize', { verifiedText: sc.text, fileName: sc.fileName || 'Student Document' });
      const s = data.structured || {};
      sc.fields = {
        title: s.title || sc.fileName.replace(/\.[^.]+$/, '') || 'Untitled record',
        category: CATEGORIES.includes(s.category) ? s.category : CATEGORIES[1],
        referenceNo: s.referenceNo || 'N/A',
        amountPaid: Number(s.amountPaid) || 0,
        balanceDue: Number(s.balanceDue) || 0,
        deadline: parseDay(s.deadline) ? s.deadline : '',
        summary: s.taglishSummary || '',
        studyNotes: Array.isArray(s.studyNotes) ? s.studyNotes.join('\n') : '',
        checklist: Array.isArray(s.checklist) ? s.checklist.join('\n') : ''
      };
      toast('Organized. Review the details below.');
    } catch (e) {
      sc.fields.title = sc.fields.title || sc.fileName.replace(/\.[^.]+$/, '');
      toast(`AI could not organize this: ${e.message}. You can fill it in manually.`, 'error');
    } finally {
      sc.organizing = false; renderView();
    }
  }

  async function saveScanRecord() {
    const sc = state.scan, f = sc.fields;
    if (!f.title.trim()) { toast('Give the record a title.', 'warn'); return; }
    const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    const stamp = Date.now();
    const record = {
      id: uid('rec'),
      studentId: state.studentId,
      documentId: sc.docId || 'manual-' + stamp,
      title: f.title.trim(),
      category: f.category,
      referenceNo: f.referenceNo.trim() || 'N/A',
      amountPaid: Number(f.amountPaid) || 0,
      balanceDue: Number(f.balanceDue) || 0,
      deadline: parseDay(f.deadline) ? f.deadline : 'None',
      summary: f.summary.trim(),
      studyNotes: lines(f.studyNotes),
      rawText: sc.text.trim(),
      fileName: sc.fileName,
      verified: true,
      createdAt: new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }),
      tasks: lines(f.checklist).map((text, i) => ({ id: `t-${stamp}-${i}`, text, done: false }))
    };
    await addRecord(record);
    resetScan();
    toast('Saved to your vault.');
    setView('vault');
  }

  // ───────── View 3: Record Vault ─────────
  function filteredRecords() {
    const q = state.vaultQ.trim().toLowerCase();
    return state.records.filter((r) => {
      if (state.vaultCat !== 'ALL' && r.category !== state.vaultCat) return false;
      return !q || [r.title, r.referenceNo, r.summary, r.category].some((x) => String(x || '').toLowerCase().includes(q));
    });
  }
  function recordCard(r) {
    const m = dueMeta(r.deadline);
    const open = (r.tasks || []).filter((t) => !t.done).length;
    return `
      <button class="rec-card" data-action="open-record" data-id="${esc(r.id)}" type="button">
        <div class="row" style="justify-content:space-between">
          <span class="badge badge-brand"><i data-lucide="${CATEGORY_ICON[r.category] || 'file-text'}"></i>${esc(r.category)}</span>
          ${Number(r.balanceDue) > 0 ? '<span class="badge badge-warn">Balance due</span>' : '<span class="badge badge-ok"><i data-lucide="badge-check"></i>Verified</span>'}
        </div>
        <div><h3 class="rec-title">${esc(r.title)}</h3><div class="rec-ref">${esc(r.referenceNo)}</div></div>
        <p class="rec-summary">${esc(r.summary || 'No summary yet.')}</p>
        <div class="rec-money">
          <div><div class="money-label">Paid</div><div class="money-val ok">${peso(r.amountPaid)}</div></div>
          <div><div class="money-label">Balance</div><div class="money-val warn">${peso(r.balanceDue)}</div></div>
          <div style="margin-left:auto;text-align:right"><div class="money-label">${m ? 'Deadline' : 'Filed'}</div><div class="money-val" style="font-size:12.5px">${m ? esc(fmtDay(r.deadline)) : esc(r.createdAt || '')}</div></div>
        </div>
        ${open ? `<div class="card-sub">${open} open task${open > 1 ? 's' : ''}</div>` : ''}
      </button>`;
  }
  function vaultGridHtml() {
    const list = filteredRecords();
    if (!state.records.length) return emptyState('folder-open', 'Your vault is empty', 'Scan a receipt or memo, or load sample records to explore.', 'Load Demo Data', null, 'load-demo');
    if (!list.length) return `<div class="empty"><i data-lucide="search-x"></i><p class="empty-title">No matches</p><p>Try a different search or category.</p></div>`;
    return `<div class="vault-grid">${list.map(recordCard).join('')}</div>`;
  }
  function viewVault() {
    const chips = ['ALL', ...CATEGORIES].map((c) =>
      `<button class="chip ${state.vaultCat === c ? 'active' : ''}" data-action="vault-cat" data-cat="${esc(c)}" type="button">${c === 'ALL' ? 'All' : esc(c)}</button>`).join('');
    return `
      <div class="page-head">
        <div><h1 class="page-title">Record Vault</h1><p class="page-sub">Every receipt, memo and note, searchable by OR number.</p></div>
        <button class="btn btn-primary" data-action="goto" data-view="scanner" type="button"><i data-lucide="plus"></i>Add record</button>
      </div>
      <div class="toolbar">
        <div class="search"><i data-lucide="search"></i><label class="sr-only" for="vaultSearch">Search records</label><input id="vaultSearch" class="input" type="search" placeholder="Search title, OR no., notes…" value="${esc(state.vaultQ)}" /></div>
        <div class="chips" id="vaultChips">${chips}</div>
      </div>
      <div id="vaultGrid">${vaultGridHtml()}</div>`;
  }
  function refreshVaultGrid() {
    const g = $('#vaultGrid'); if (!g) return;
    g.innerHTML = vaultGridHtml();
    $$('#vaultChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.cat === state.vaultCat));
    icons();
  }

  function openRecord(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    const m = dueMeta(r.deadline);
    openModal(`
      <div class="modal-head">
        <div>
          <span class="badge badge-brand"><i data-lucide="${CATEGORY_ICON[r.category] || 'file-text'}"></i>${esc(r.category)}</span>
          <h2 class="modal-title" style="margin-top:8px">${esc(r.title)}</h2>
          <div class="rec-ref">${esc(r.referenceNo)} • Filed ${esc(r.createdAt || '')}</div>
        </div>
        <button class="icon-btn" data-action="close-modal" type="button" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="kv">
        <div><div class="money-label">Amount paid</div><div class="money-val ok v">${peso(r.amountPaid)}</div></div>
        <div><div class="money-label">Balance due</div><div class="money-val warn v">${peso(r.balanceDue)}</div></div>
        <div><div class="money-label">Deadline</div><div class="v mono">${esc(fmtDay(r.deadline))} ${m ? `<span class="badge ${m.cls}">${esc(m.label)}</span>` : ''}</div></div>
      </div>
      ${r.summary ? `<h3 class="card-title">What this means</h3><p style="margin:6px 0 14px">${richText(r.summary)}</p>` : ''}
      ${(r.studyNotes || []).length ? `<h3 class="card-title">Key notes</h3><ul class="note-list">${r.studyNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${(r.tasks || []).length ? `<h3 class="card-title" style="margin-top:14px">Checklist</h3>${r.tasks.map((t) => taskRow({ ...t, recordId: r.id, recordTitle: r.title, deadline: r.deadline })).join('')}` : ''}
      ${r.rawText ? `<h3 class="card-title" style="margin-top:14px">Verified text</h3><div class="raw">${esc(r.rawText)}</div>` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="confirm-delete" data-id="${esc(r.id)}" type="button" style="color:var(--danger)"><i data-lucide="trash-2"></i>Delete</button>
        <button class="btn btn-primary" data-action="close-modal" type="button">Done</button>
      </div>`, true);
  }
  function confirmDelete(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    openModal(`
      <h2 class="modal-title">Delete this record?</h2>
      <p class="card-sub" style="margin-top:8px"><strong>${esc(r.title)}</strong> and its checklist will be removed from your vault. This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal" type="button">Keep it</button>
        <button class="btn btn-danger" data-action="delete-record" data-id="${esc(id)}" type="button"><i data-lucide="trash-2"></i>Delete</button>
      </div>`);
  }

  // ───────── View 4: Clearance Tracker ─────────
  function viewTracker() {
    const s = stats();
    const showAll = state.trackerShow === 'all';
    const groups = state.records
      .map((r) => ({ r, tasks: (r.tasks || []).filter((t) => showAll || !t.done) }))
      .filter((g) => g.tasks.length)
      .sort((a, b) => sortByDeadline(a.r, b.r));
    return `
      <div class="page-head">
        <div><h1 class="page-title">Clearance Tracker</h1><p class="page-sub">Every requirement from every document, in deadline order.</p></div>
        <div class="chips">
          <button class="chip ${!showAll ? 'active' : ''}" data-action="tracker-show" data-show="pending" type="button">Pending (${s.pending})</button>
          <button class="chip ${showAll ? 'active' : ''}" data-action="tracker-show" data-show="all" type="button">All (${s.tasks})</button>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="justify-content:space-between;margin-bottom:10px"><strong>${s.done} of ${s.tasks} requirements completed</strong><span class="mono" style="color:var(--muted)">${s.pct}%</span></div>
        <div class="progress ${s.pct === 100 ? 'ok' : ''}" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Overall clearance progress"><span style="width:${s.pct}%"></span></div>
      </div>
      ${groups.length ? `<div class="stack">${groups.map(({ r, tasks }) => {
        const m = dueMeta(r.deadline);
        return `<div class="card">
          <div class="group-head">
            <div><h2 class="group-title">${esc(r.title)}</h2><span class="rec-ref">${esc(r.referenceNo)}</span></div>
            ${m ? `<span class="badge ${m.cls}"><i data-lucide="calendar-clock"></i>${esc(fmtDay(r.deadline))} • ${esc(m.label)}</span>` : ''}
          </div>
          ${tasks.map((t) => taskRow({ ...t, recordId: r.id, recordTitle: r.title, deadline: null })).join('')}
        </div>`;
      }).join('')}</div>` : (s.tasks ? `<div class="empty"><i data-lucide="party-popper"></i><p class="empty-title">All requirements done</p><p>Nice work. Switch to "All" to review them.</p></div>`
        : emptyState('list-checks', 'No requirements yet', 'Scan a clearance memo and the checklist builds itself.', 'Scan a document', 'scanner'))}`;
  }

  // ───────── View 5: Ask EasyBo ─────────
  const PROMPTS = [
    ['wallet', 'Magkano na lahat ng nabayaran ko at magkano pa ang kulang ko?'],
    ['list-checks', 'Ano ang mga kailangan kong ipasa bago ang deadline?'],
    ['languages', 'Ipaliwanag sa simpleng Taglish ang pinakabago kong dokumento.']
  ];
  function botGreeting() {
    return { role: 'bot', text: `Kumusta, ${student().first}! Ako si **EasyBo**, ang iyong record buddy. Tanungin mo ako tungkol sa mga resibo, balance, at requirements mo.` };
  }
  function msgHtml(m) {
    const cites = Array.isArray(m.citations) && m.citations.length ? `<div class="cites">Sources: ${m.citations.map((c) => esc(typeof c === 'string' ? c : (c.title || c.source || c.id || 'source'))).join(', ')}</div>` : '';
    return `<div class="msg ${m.role}">${richText(m.text)}${cites}</div>`;
  }
  function chatLogHtml() {
    const msgs = state.chat.length ? state.chat : [botGreeting()];
    const typing = state.chatBusy ? `<div class="msg bot" aria-label="EasyBo is typing"><div class="skel-stack" style="width:180px"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div></div>` : '';
    return msgs.map(msgHtml).join('') + typing;
  }
  function viewBuddy() {
    return `
      <div class="page-head"><div><h1 class="page-title">Ask EasyBo</h1><p class="page-sub">Taglish or English. Answers use your own verified records.</p></div></div>
      <div class="chat-layout">
        <div class="card chat-card">
          <div class="chat-log" id="chatLog" tabindex="0" aria-label="Conversation">${chatLogHtml()}</div>
          <form class="chat-input" id="chatForm">
            <label class="sr-only" for="chatInput">Your question</label>
            <input id="chatInput" class="input" autocomplete="off" placeholder="Hal. Ano ang OR number ng lab fee ko?" />
            <button class="btn btn-primary" type="submit" ${state.chatBusy ? 'disabled' : ''}><i data-lucide="send-horizontal"></i><span class="hide-sm">Send</span></button>
          </form>
        </div>
        <div class="stack">
          <div class="card">
            <h2 class="card-title" style="margin-bottom:10px">Context</h2>
            <div class="stack" style="gap:8px">
              <label class="radio-card"><input type="radio" name="scope" value="vault" ${state.chatScope === 'vault' ? 'checked' : ''} data-action="chat-scope" /><span><strong>Whole vault</strong><div class="card-sub">${state.records.length} record${state.records.length === 1 ? '' : 's'} for ${esc(student().first)}</div></span></label>
              <label class="radio-card"><input type="radio" name="scope" value="doc" ${state.chatScope === 'doc' ? 'checked' : ''} data-action="chat-scope" /><span><strong>Current scan</strong><div class="card-sub">${state.scan.text.trim() ? 'Uses the document in the scanner' : 'No active scan'}</div></span></label>
            </div>
          </div>
          <div class="card">
            <h2 class="card-title" style="margin-bottom:10px">Try asking</h2>
            <div class="stack" style="gap:8px">${PROMPTS.map(([ic, q]) => `<button class="prompt-btn" type="button" data-action="ask-preset" data-q="${esc(q)}"><i data-lucide="${ic}"></i><span>${esc(q)}</span></button>`).join('')}</div>
          </div>
        </div>
      </div>`;
  }
  function scrollChat() { const l = $('#chatLog'); if (l) l.scrollTop = l.scrollHeight; }
  function refreshChat() {
    const l = $('#chatLog'); if (!l) return;
    l.innerHTML = chatLogHtml(); scrollChat();
    const btn = $('#chatForm button[type=submit]'); if (btn) btn.disabled = state.chatBusy;
  }
  function buildContext() {
    if (state.chatScope === 'doc') return state.scan.text.trim() ? `CURRENT DOCUMENT:\n${state.scan.text.trim()}` : '';
    if (!state.records.length) return '';
    return 'SAVED VAULT RECORDS:\n' + state.records.map((r) =>
      `- [${r.category}] ${r.title} (Ref: ${r.referenceNo}, Paid: PHP ${r.amountPaid}, Balance Due: PHP ${r.balanceDue}, Deadline: ${r.deadline}): ${r.summary || ''}`).join('\n');
  }
  async function ask(question) {
    question = (question || '').trim();
    if (!question || state.chatBusy) return;
    state.chat.push({ role: 'user', text: question });
    state.chatBusy = true; refreshChat();
    try {
      const data = await postJson('/api/chat/ask', { question, contextText: buildContext() });
      state.chat.push({ role: 'bot', text: data.answer || 'Walang sagot na natanggap.', citations: data.citations });
    } catch (e) {
      state.chat.push({ role: 'bot', text: `Sorry, hindi ako nakasagot: ${e.message}` });
      toast(e.message, 'error');
    } finally {
      state.chatBusy = false; refreshChat();
    }
  }

  // ───────── Demo data & quick note ─────────
  function demoRecords() {
    const t = Date.now();
    const sid = state.studentId;
    return [
      { id: `demo-${sid}-1`, studentId: sid, documentId: 'demo-doc-1', title: '1st Sem Computer Lab & Misc Receipt', category: 'Receipt & Tuition', referenceNo: 'OR-2026-99412',
        amountPaid: 1250, balanceDue: 500, deadline: isoDay(12), verified: true, createdAt: 'Nov 12, 2026',
        summary: 'Opisyal na resibo para sa ₱1,250.00 Computer Lab deposit. May natitira pang ₱500.00 na dapat bayaran bago ang finals clearance.',
        studyNotes: ['OR-2026-99412 is your proof of payment.', 'Pay the ₱500.00 balance at the Cashier before the deadline.'],
        tasks: [{ id: `t-${t}-1`, text: 'Photocopy OR-2026-99412 for the Exam Permit', done: true }, { id: `t-${t}-2`, text: 'Pay the ₱500.00 balance at the Cashier', done: false }] },
      { id: `demo-${sid}-2`, studentId: sid, documentId: 'demo-doc-2', title: 'Final Exam Permit Requirements', category: 'Enrollment & Clearance', referenceNo: 'REG-MEMO-114',
        amountPaid: 0, balanceDue: 0, deadline: isoDay(5), verified: true, createdAt: 'Nov 10, 2026',
        summary: 'Memo mula sa Registrar: kumpletuhin ang tatlong requirements para makakuha ng Final Exam Permit.',
        studyNotes: ['Permit is required to enter every final exam.'],
        tasks: [{ id: `t-${t}-3`, text: 'Get Library & Computer Lab clearance slip signed', done: false }, { id: `t-${t}-4`, text: 'Updated COR with Adviser signature', done: false }, { id: `t-${t}-5`, text: 'Submit all papers to the Registrar', done: false }] },
      { id: `demo-${sid}-3`, studentId: sid, documentId: 'demo-doc-3', title: 'Academic Excellence Scholarship Notice', category: 'Scholarship', referenceNo: 'SCH-2026-031',
        amountPaid: 5000, balanceDue: 0, deadline: isoDay(30), verified: true, createdAt: 'Nov 3, 2026',
        summary: 'Na-approve ang scholarship mo ngayong semester. Kailangan lang i-renew ang form bago matapos ang buwan.',
        studyNotes: ['Keep your GWA at or above the required cutoff.'],
        tasks: [{ id: `t-${t}-6`, text: 'Submit scholarship renewal form', done: false }] },
      { id: `demo-${sid}-4`, studentId: sid, documentId: 'demo-doc-4', title: 'Intro to Computing: Week 12 Notes', category: 'Class Note & Memo', referenceNo: 'NOTE-012',
        amountPaid: 0, balanceDue: 0, deadline: 'None', verified: true, createdAt: 'Nov 8, 2026',
        summary: 'Review of networking basics: IP addressing, DNS and HTTP request flow.', studyNotes: ['DNS turns names into IP addresses.', 'HTTP is stateless.'], tasks: [] }
    ];
  }
  async function loadDemo() {
    const have = new Set(state.records.map((r) => r.id));
    const fresh = demoRecords().filter((r) => !have.has(r.id));
    if (!fresh.length) { toast('Demo data is already in this vault.', 'warn'); return; }
    state.records = [...fresh, ...state.records];
    await syncRecords();
    toast(`Added ${fresh.length} demo records for ${student().first}.`);
    renderView();
  }
  function quickNote() {
    openModal(`
      <div class="modal-head"><h2 class="modal-title">New quick note</h2><button class="icon-btn" data-action="close-modal" type="button" aria-label="Close"><i data-lucide="x"></i></button></div>
      <form id="noteForm" class="stack">
        <div class="field"><label for="noteTitle">Title</label><input id="noteTitle" class="input" required maxlength="120" placeholder="e.g., Reminder: submit COR" /></div>
        <div class="field"><label for="noteBody">Note</label><textarea id="noteBody" class="textarea" rows="5" placeholder="Write anything you want to remember…"></textarea></div>
        <div class="modal-actions"><button class="btn btn-ghost" data-action="close-modal" type="button">Cancel</button><button class="btn btn-primary" type="submit"><i data-lucide="save"></i>Save note</button></div>
      </form>`);
  }

  // ───────── Event wiring ─────────
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      if (!e.target.closest('.popover-wrap')) closePartner();
      return;
    }
    const a = el.dataset.action;
    switch (a) {
      case 'goto': setView(el.dataset.view); break;
      case 'open-sidebar': openSidebar(); break;
      case 'close-sidebar': closeSidebar(); break;
      case 'toggle-theme': applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); break;
      case 'toggle-partner': { const pop = $('#partnerPop'); const open = pop.hidden; pop.hidden = !open; el.setAttribute('aria-expanded', String(open)); break; }
      case 'toggle-mock': {
        try {
          const d = await postJson('/api/config/mock', { mockMode: !state.mock });
          state.mock = d.mockMode; renderApiMode();
          toast(state.mock ? 'Mock Mode on. No Lumen credits will be used.' : 'Live Lumen API on.', state.mock ? 'warn' : 'ok');
        } catch (err) { toast(err.message, 'error'); }
        break;
      }
      case 'load-demo': loadDemo(); break;
      case 'quick-note': quickNote(); break;
      case 'toggle-task': {
        e.stopPropagation();
        const rec = state.records.find((r) => r.id === el.dataset.rec);
        const t = rec?.tasks.find((x) => x.id === el.dataset.task);
        if (t) { t.done = el.checked; await syncRecords(); renderView(); if ($('#modalRoot .modal')) openRecord(rec.id); }
        break;
      }
      case 'open-record': openRecord(el.dataset.id); break;
      case 'confirm-delete': confirmDelete(el.dataset.id); break;
      case 'delete-record':
        state.records = state.records.filter((r) => r.id !== el.dataset.id);
        closeModal(); await syncRecords(); toast('Record deleted.'); renderView(); break;
      case 'close-modal': closeModal(); break;
      case 'modal-backdrop': if (e.target === el) closeModal(); break;
      case 'vault-cat': state.vaultCat = el.dataset.cat; refreshVaultGrid(); break;
      case 'tracker-show': state.trackerShow = el.dataset.show; renderView(); break;
      // scanner
      case 'remove-file': resetScan(); renderView(); break;
      case 'run-ocr': runOcr(); break;
      case 'skip-upload': state.scan.step = 2; renderView(); break;
      case 'scan-back': syncTextFromDom(); state.scan.step = Math.max(1, state.scan.step - 1); state.scan.popover = null; renderView(); break;
      case 'open-fix': openFix(el.dataset.index); break;
      case 'close-fix': state.scan.popover = null; renderView(); break;
      case 'save-fix': saveFix(); break;
      case 'organize': organize(); break;
      case 'save-record': saveScanRecord(); break;
      // chat
      case 'ask-preset': ask(el.dataset.q); break;
      case 'chat-scope': state.chatScope = el.value; break;
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'vaultSearch') { state.vaultQ = t.value; refreshVaultGrid(); }
    else if (t.dataset.bind === 'text') state.scan.text = t.value;
    else if (t.dataset.field) state.scan.fields[t.dataset.field] = t.value;
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'fileInput' && t.files[0]) setFile(t.files[0]);
    else if (t.dataset.field) state.scan.fields[t.dataset.field] = t.value;
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'chatForm') {
      e.preventDefault();
      const i = $('#chatInput'); const q = i.value; i.value = ''; ask(q);
    } else if (e.target.id === 'noteForm') {
      e.preventDefault();
      const title = $('#noteTitle').value.trim(), body = $('#noteBody').value.trim();
      if (!title) return;
      const rec = {
        id: uid('note'), studentId: state.studentId, documentId: 'note-' + Date.now(), title, category: 'Class Note & Memo', referenceNo: 'NOTE',
        amountPaid: 0, balanceDue: 0, deadline: 'None', summary: body, studyNotes: [], tasks: [], verified: true,
        createdAt: new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
      };
      closeModal();
      addRecord(rec).then(() => { toast('Note saved to your vault.'); renderView(); });
    }
  });
  // Drag & drop upload
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); // required for drop to fire; stops the browser opening the file
    const z = e.target.closest('#dropzone'); if (z) z.classList.add('over');
  });
  document.addEventListener('dragleave', (e) => { const z = e.target.closest('#dropzone'); if (z) z.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    const z = e.target.closest('#dropzone');
    if (z) { e.preventDefault(); z.classList.remove('over'); setFile(e.dataTransfer.files[0]); }
    else if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); // stop browser opening dropped files
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closePartner(); closeSidebar(); }
  });
  function closePartner() { const p = $('#partnerPop'); if (p && !p.hidden) { p.hidden = true; $('#partnerBtn').setAttribute('aria-expanded', 'false'); } }

  $('#studentSelect').addEventListener('change', async (e) => {
    state.studentId = e.target.value;
    localStorage.setItem('easybo.student', state.studentId);
    state.chat = []; resetScan();
    await loadRecords();
    toast(`Switched to ${student().name}.`);
    renderView(true);
  });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { push: false }));

  // ───────── Boot ─────────
  async function init() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    renderStudentSelect();
    $('#viewRoot').innerHTML = `<div class="skel-stack" aria-busy="true"><div class="skeleton" style="height:28px;width:40%"></div><div class="skeleton" style="height:110px"></div></div>`;
    try {
      const cfg = await api('/api/config');
      state.mock = !!cfg.mockMode; state.hasKeys = !!cfg.hasKeys;
    } catch (_) { toast('Cannot reach the server. Is it running?', 'error'); }
    renderApiMode();
    if (!state.hasKeys && !state.mock) toast('No Lumen API keys found. Switch to Mock Mode to try the flow.', 'warn');
    await loadRecords();
    setView(location.hash.slice(1) || 'dashboard', { push: false });
  }
  init();
})();
