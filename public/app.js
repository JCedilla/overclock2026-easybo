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
    step: 1, saved: false, saving: false, savedId: null, savedTitle: '',
    file: null, previewUrl: '', previewType: '', fileName: '',
    processing: false, stage: 'reading', error: '',
    docId: null, text: '', corrections: {}, editWord: null, showText: false,
    fields: { title: '', category: CATEGORIES[1], referenceNo: '', amountPaid: 0, balanceDue: 0, deadline: '', summary: '', studyNotes: [] },
    uncertain: {}, confirmed: {}, checklist: []
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
    const n = (x) => `${x} day${x === 1 ? '' : 's'}`;
    if (days < 0) return { days, label: `Overdue by ${n(-days)}`, cls: 'badge-danger', icon: 'alert-circle' };
    if (days === 0) return { days, label: 'Due today', cls: 'badge-danger', icon: 'alert-circle' };
    if (days <= 7) return { days, label: `Due soon: ${n(days)} left`, cls: 'badge-warn', icon: 'clock' };
    return { days, label: `${n(days)} left`, cls: 'badge-muted', icon: 'calendar' };
  }
  // Status = color + icon + word (never color alone)
  const dueBadge = (m) => (m ? `<span class="badge ${m.cls}"><i data-lucide="${m.icon}"></i>${esc(m.label)}</span>` : '');
  const pesoTile = (n) => '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(Number(n) || 0) ? 0 : 2, maximumFractionDigits: 2 });
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
  // action: optional { label, fn } shown as a button (used for Undo)
  function toast(msg, type = 'ok', action = null) {
    const ico = { ok: 'check-circle-2', error: 'alert-circle', warn: 'info' }[type] || 'info';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i data-lucide="${ico}"></i><span style="flex:1">${esc(msg)}</span>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}`;
    const dismiss = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); };
    if (action) $('.toast-action', el).addEventListener('click', () => { dismiss(); action.fn(); });
    $('#toasts').appendChild(el);
    icons();
    setTimeout(dismiss, action ? 8000 : type === 'error' ? 6000 : 3500);
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
    // A finished scan should not greet the student again next time they open Scan
    if (state.view === 'scanner' && view !== 'scanner' && state.scan.saved) resetScan();
    state.view = view;
    if (push && location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    $$('.nav-item[data-view], .tab-item[data-view]').forEach((a) => {
      const on = a.dataset.view === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
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
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('easybo.theme', t);
    // Rebuild the button content: Lucide replaces <i> tags with <svg>, so swap the whole thing.
    $('#themeBtn').innerHTML = `<i data-lucide="${t === 'dark' ? 'sun' : 'moon'}"></i><span>${t === 'dark' ? 'Light theme' : 'Dark theme'}</span>`;
    // (button lives in the Demo tools popover)
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
    $('#demoBtn').title = state.mock ? 'Demo tools (Mock Mode on)' : 'Demo tools';
  }

  // ───────── View 1: Home ─────────
  const isPaymentTask = (t, r) => Number(r?.balanceDue) > 0 && /bayad|bayaran|pay|balance|₱|cashier/i.test(t.text);

  function nextStepHtml() {
    const t = allTasks().filter((x) => !x.done).sort(sortByDeadline)[0];

    if (!state.records.length) {
      return `
        <section class="card next-card" aria-labelledby="nextTitle">
          <p class="eyebrow">Next step</p>
          <h2 id="nextTitle" class="next-title">Wala ka pang documents. Scan your first receipt or memo.</h2>
          <p class="next-from">We will read it and list what you need to do.</p>
          <div class="next-actions"><button class="btn btn-primary btn-lg" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan a document</button></div>
        </section>`;
    }
    if (!t) {
      return `
        <section class="card next-card caught-up" aria-labelledby="nextTitle">
          <p class="eyebrow"><i data-lucide="check-circle-2" style="vertical-align:-3px"></i> Next step</p>
          <h2 id="nextTitle" class="next-title">You're all caught up</h2>
          <p class="next-from">Walang kailangang gawin ngayon. Pahinga muna! Got a new paper? Scan it and we'll add it to your list.</p>
          <div class="next-actions"><button class="btn btn-primary btn-lg" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan a document</button></div>
        </section>`;
    }

    const rec = state.records.find((r) => r.id === t.recordId);
    const m = dueMeta(t.deadline);
    const pay = isPaymentTask(t, rec);
    const viewLabel = rec?.category === 'Receipt & Tuition' ? 'View receipt' : 'View document';
    return `
      <section class="card next-card" aria-labelledby="nextTitle">
        <p class="eyebrow">Next step</p>
        <h2 id="nextTitle" class="next-title">${esc(t.text)}</h2>
        <div class="next-meta">${m ? `${dueBadge(m)}<span>Before ${esc(fmtDay(t.deadline))}</span>` : '<span>No deadline set</span>'}</div>
        <p class="next-from">From: ${esc(t.recordTitle)}</p>
        <div class="next-actions">
          <button class="btn btn-primary btn-lg" data-action="${pay ? 'mark-paid' : 'mark-done'}" data-rec="${esc(t.recordId)}" data-task="${esc(t.id)}" type="button">
            <i data-lucide="${pay ? 'badge-check' : 'check'}"></i>${pay ? 'Mark as paid' : 'Mark as done'}
          </button>
          <button class="link-btn" data-action="open-record" data-id="${esc(t.recordId)}" type="button">${viewLabel}</button>
        </div>
      </section>`;
  }

  function viewDashboard() {
    const s = stats();
    const st = student();
    const recent = state.records.slice(0, 3);
    const paidDocs = state.records.filter((r) => Number(r.amountPaid) > 0).length;
    const owing = s.balance > 0;

    return `
      <div class="page-head">
        <div>
          <h1 class="page-title">Magandang araw, ${esc(st.first)}</h1>
          <p class="page-sub">Ito ang kailangan mong gawin ngayon.</p>
        </div>
      </div>

      ${nextStepHtml()}

      <section class="tiles" aria-label="Where you stand">
        <div class="tile">
          <div class="tile-label"><span class="dot ok" aria-hidden="true"></span>Paid so far</div>
          <div class="tile-value">${pesoTile(s.paid)}</div>
          <div class="tile-foot">${paidDocs ? `From ${paidDocs} receipt${paidDocs === 1 ? '' : 's'}` : 'No payments recorded yet'}</div>
        </div>
        <div class="tile">
          <div class="tile-label"><span class="dot ${owing ? 'warn' : 'ok'}" aria-hidden="true"></span>Still to pay</div>
          <div class="tile-value">${pesoTile(s.balance)}</div>
          <div class="tile-foot">${owing ? (s.nextDue ? `Due ${esc(fmtDay(s.nextDue))}` : 'No due date yet') : 'Nothing to pay'}</div>
        </div>
        <div class="tile">
          <div class="tile-label"><span class="dot ${s.tasks && s.pct === 100 ? 'ok' : 'indigo'}" aria-hidden="true"></span>Clearance</div>
          <div class="tile-value">${s.tasks ? `${s.done} of ${s.tasks} done` : 'Not started'}</div>
          <div class="progress ${s.pct === 100 ? 'ok' : ''}" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Clearance progress"><span style="width:${s.pct}%"></span></div>
        </div>
      </section>

      <section class="card" aria-labelledby="recentTitle">
        <div class="list-head">
          <h2 id="recentTitle" class="card-title">Recent documents</h2>
          ${recent.length ? '<button class="link-btn" data-action="goto" data-view="vault" type="button">See all</button>' : ''}
        </div>
        ${recent.length ? recent.map((r) => `
          <button class="doc-row" data-action="open-record" data-id="${esc(r.id)}" type="button">
            <span class="doc-main">
              <div class="doc-title">${esc(r.title)}</div>
              <div class="doc-sub"><span class="ref">${esc(r.referenceNo)}</span> · ${esc(r.createdAt || '')}</div>
            </span>
            <i data-lucide="chevron-right" aria-hidden="true"></i>
          </button>`).join('') : `<p class="card-sub">Your scanned receipts and memos will show up here.</p>`}
      </section>`;
  }

  function taskRow(t) {
    const m = dueMeta(t.deadline);
    return `
      <label class="task ${t.done ? 'done' : ''}">
        <input type="checkbox" ${t.done ? 'checked' : ''} data-action="toggle-task" data-rec="${esc(t.recordId)}" data-task="${esc(t.id)}" aria-label="${esc(t.text)}" />
        <span class="task-body">
          <div class="task-text">${esc(t.text)}</div>
          <div class="task-meta"><span>${esc(t.recordTitle)}</span>${t.done ? '<span class="badge badge-ok"><i data-lucide="check"></i>Done</span>' : dueBadge(m)}</div>
        </span>
      </label>`;
  }
  function emptyState(icon, title, text, cta, view, action) {
    const attrs = action ? `data-action="${action}"` : `data-action="goto" data-view="${view}"`;
    return `<div class="empty"><p class="empty-title">${esc(title)}</p><p>${esc(text)}</p><button class="btn btn-primary" ${attrs} type="button">${esc(cta)}</button></div>`;
  }

  async function markTask(recId, taskId, paid) {
    const snapshot = JSON.stringify(state.records);
    const rec = state.records.find((r) => r.id === recId);
    const task = rec?.tasks.find((x) => x.id === taskId);
    if (!task) return;
    task.done = true;
    if (paid && Number(rec.balanceDue) > 0) {
      rec.amountPaid = (Number(rec.amountPaid) || 0) + Number(rec.balanceDue);
      rec.balanceDue = 0;
    }
    renderView();
    await syncRecords();
    toast(paid ? 'Marked as paid. Salamat!' : 'Nice! Marked as done.', 'ok', {
      label: 'Undo',
      fn: async () => { state.records = JSON.parse(snapshot); renderView(); await syncRecords(); }
    });
  }

  // ───────── View 2: Scan (1 Upload, 2 Check, 3 Save) ─────────
  const STEP_LABELS = ['Upload', 'Check', 'Save'];
  const FIELD_NAMES = ['title', 'category', 'referenceNo', 'amountPaid', 'balanceDue', 'deadline'];
  const MAX_CHIPS = 300;

  function viewScanner() {
    const sc = state.scan;
    const current = sc.saved ? 4 : sc.step;
    const stepper = STEP_LABELS.map((label, i) => {
      const n = i + 1;
      const cls = n < current ? 'done' : n === current ? 'active' : '';
      return `<li class="step ${cls}" ${n === current ? 'aria-current="step"' : ''}><span class="step-n">${n < current ? '✓' : n}</span><span>${label}</span></li>${n < 3 ? '<li class="step-line" aria-hidden="true"></li>' : ''}`;
    }).join('');
    const sub = sc.saved ? 'All done.' : { 1: 'Add a photo or PDF of your receipt or memo.', 2: 'Here is what we found. Check it against your paper.', 3: 'Almost done. Review and save.' }[sc.step];
    const body = sc.saved ? scanSaved() : sc.step === 1 ? scanStep1() : sc.step === 2 ? scanStep2() : scanStep3();
    return `
      <div class="page-head"><div><h1 class="page-title">Scan a document</h1><p class="page-sub">${sub}</p></div></div>
      <ol class="stepper" aria-label="Progress">${stepper}</ol>
      ${body}`;
  }

  function previewHtml(sc) {
    if (!sc.previewUrl) return `<div class="preview-empty"><i data-lucide="file-image"></i><div>No photo added</div></div>`;
    if (sc.previewType === 'application/pdf') return `<iframe src="${esc(sc.previewUrl)}" title="PDF preview"></iframe>`;
    if (sc.previewType === 'image/tiff') return `<div class="preview-empty"><i data-lucide="file-image"></i><div>This file type cannot be previewed here.<br>We can still read it.</div></div>`;
    return `<img src="${esc(sc.previewUrl)}" alt="Preview of ${esc(sc.fileName)}" />`;
  }

  // ── Step 1: Upload ──
  function scanStep1() {
    return `
      <div class="scan-narrow">
        <label class="dropzone dropzone-lg" id="dropzone">
          <i data-lucide="upload-cloud"></i>
          <p class="dropzone-title">Drag a photo or PDF of your receipt here, or tap to choose</p>
          <p class="dropzone-sub">JPG, PNG, WebP, TIFF or PDF. Up to 10 MB.</p>
          <input id="fileInput" type="file" accept=".pdf,image/png,image/jpeg,image/webp,image/tiff" />
        </label>
        <div class="card">
          <h2 class="card-title">For a clear scan</h2>
          <ul class="hint-list">
            <li><i data-lucide="sun"></i><span>Use good lighting. Avoid shadows and glare.</span></li>
            <li><i data-lucide="file"></i><span>Lay the paper flat and smooth out wrinkles.</span></li>
            <li><i data-lucide="scan"></i><span>Fit the whole paper in the photo, with all four corners showing.</span></li>
          </ul>
        </div>
        <div class="center"><button class="link-btn" data-action="skip-upload" type="button">No file? Type the details yourself</button></div>
      </div>`;
  }

  // ── Step 2: Check ──
  const stageText = (sc) => (sc.stage === 'organizing' ? 'Finding the amounts and dates…' : 'Reading your document… Sandali lang!');

  function scanStep2() {
    const sc = state.scan;
    const left = `
      <div class="card sticky-card">
        <div class="card-head"><h2 class="card-title">Your document</h2></div>
        <div class="preview-box">${previewHtml(sc)}</div>
      </div>`;

    if (sc.processing) {
      return `
        <div class="split">${left}
          <div class="card" aria-busy="true">
            <div class="row" style="color:var(--brand);margin-bottom:8px"><span class="spinner"></span><strong id="stageText">${stageText(sc)}</strong></div>
            <p class="card-sub">This can take up to 20 seconds. Please keep this page open.</p>
            <div class="skel-stack" style="margin-top:24px">
              ${'<div><div class="skeleton" style="width:35%;height:14px;margin-bottom:8px"></div><div class="skeleton" style="height:44px"></div></div>'.repeat(5)}
            </div>
          </div>
        </div>`;
    }
    if (sc.error) {
      return `
        <div class="split">${left}
          <div class="card">
            <span class="badge badge-danger"><i data-lucide="alert-circle"></i>Could not read</span>
            <h2 class="card-title" style="margin-top:12px">We couldn't read this file</h2>
            <p class="card-sub" style="margin:8px 0 24px">${esc(sc.error)}</p>
            <div class="next-actions">
              <button class="btn btn-primary" data-action="retry-process" type="button"><i data-lucide="refresh-cw"></i>Try again</button>
              <button class="link-btn" data-action="scan-reset" type="button">Choose another file</button>
            </div>
          </div>
        </div>`;
    }

    const f = sc.fields;
    const catOptions = CATEGORIES.map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const money = (name, label) => fieldWrap(name, label, `<div class="money-input"><span aria-hidden="true">₱</span><input id="f_${name}" class="input" type="number" inputmode="decimal" step="0.01" min="0" data-field="${name}" value="${esc(f[name])}" /></div>`);

    return `
      <div class="split">${left}
        <div class="stack">
          ${bannerHtml()}
          <div class="card">
            <div class="form-grid two">
              ${fieldWrap('title', 'Document title', `<input id="f_title" class="input" data-field="title" value="${esc(f.title)}" />`, 'span-2')}
              ${fieldWrap('category', 'Type', `<select id="f_category" class="select" data-field="category">${catOptions}</select>`, 'span-2')}
              ${fieldWrap('referenceNo', 'Reference no.', `<input id="f_referenceNo" class="input ref-input" data-field="referenceNo" value="${esc(f.referenceNo)}" autocomplete="off" />`, 'span-2')}
              ${money('amountPaid', 'Amount paid')}
              ${money('balanceDue', 'Balance due')}
              ${fieldWrap('deadline', 'Deadline', `<input id="f_deadline" class="input" type="date" data-field="deadline" value="${esc(f.deadline)}" />`, 'span-2')}
            </div>
          </div>
          ${sc.text.trim() ? `
          <details class="disclose" data-detail="showText" ${sc.showText || sc.editWord ? 'open' : ''}>
            <summary>View scanned text</summary>
            <div class="disclose-body">
              <p class="card-sub">Tap a word that looks wrong and type the right one. Fixing a word helps the scanner get better.</p>
              <div id="wordArea" class="word-area">${wordAreaHtml()}</div>
            </div>
          </details>` : ''}
        </div>
      </div>
      <div class="footer-bar">
        <button class="btn btn-ghost" data-action="scan-reset" type="button"><i data-lucide="rotate-ccw"></i>Start over</button>
        <button class="btn btn-primary" data-action="scan-next" type="button">Looks right, continue<i data-lucide="arrow-right"></i></button>
      </div>`;
  }

  function fieldWrap(name, label, control, span = '') {
    const flagged = isFlagged(name);
    return `
      <div class="field ${span} ${flagged ? 'flag' : ''}" data-wrap="${name}">
        <div class="field-top"><label for="f_${name}">${label}</label><span class="flag-tag" ${flagged ? '' : 'hidden'}><i data-lucide="alert-triangle"></i>Please check</span></div>
        ${control}
      </div>`;
  }

  // A field is amber when it is empty, or the scanner looked unsure and the student has not touched it yet.
  function isFlagged(name) {
    const sc = state.scan;
    if (String(sc.fields[name] ?? '').trim() === '') return true;
    return !!sc.uncertain[name] && !sc.confirmed[name];
  }
  const flaggedCount = () => FIELD_NAMES.filter(isFlagged).length;
  function bannerHtml() {
    const n = flaggedCount();
    return n
      ? `<div class="banner warn" id="flagBanner" role="status"><i data-lucide="alert-triangle"></i><div><strong>Please check these details before saving.</strong><div>${n} ${n === 1 ? 'field is' : 'fields are'} marked in amber.</div></div></div>`
      : `<div class="banner ok" id="flagBanner" role="status"><i data-lucide="check-circle-2"></i><div><strong>Everything is filled in.</strong><div>Please still take a quick look before saving.</div></div></div>`;
  }
  function refreshFlags() {
    FIELD_NAMES.forEach((n) => {
      const w = $(`[data-wrap="${n}"]`);
      if (!w) return;
      const on = isFlagged(n);
      w.classList.toggle('flag', on);
      const tag = $('.flag-tag', w); if (tag) tag.hidden = !on;
    });
    const b = $('#flagBanner');
    if (b) { b.outerHTML = bannerHtml(); icons(); }
  }
  function syncFieldInputs() {
    FIELD_NAMES.forEach((n) => { const el = $(`#f_${n}`); if (el && el !== document.activeElement) el.value = state.scan.fields[n]; });
  }

  // Heuristics for "the scanner may have got this wrong"
  function numberInText(n, text) {
    if (!Number.isFinite(n)) return false;
    if (n === 0) return true;
    return [n.toLocaleString('en-US'), String(n), n.toLocaleString('en-US', { minimumFractionDigits: 2 })].some((s) => text.includes(s));
  }
  // Mostly-digit chunks that also contain letters (like 2O26) are classic scanner mix-ups.
  function refLooksOff(ref) {
    if (!ref) return true;
    return ref.split(/[-\s]+/).some((tok) => {
      const d = (tok.match(/\d/g) || []).length, l = (tok.match(/[A-Za-z]/g) || []).length;
      return d > 0 && l > 0 && l < d;
    });
  }
  const toNum = (v) => (v === undefined || v === null || v === '' ? NaN : Number(String(v).replace(/[^\d.\-]/g, '')));

  function applyStructured(s, text) {
    const sc = state.scan;
    const paid = toNum(s.amountPaid), due = toNum(s.balanceDue);
    const ref = s.referenceNo && !/^(n\/a|none|verified-doc)$/i.test(String(s.referenceNo).trim()) ? String(s.referenceNo).trim() : '';
    sc.fields = {
      title: String(s.title || '').trim(),
      category: CATEGORIES.includes(s.category) ? s.category : CATEGORIES[1],
      referenceNo: ref,
      amountPaid: Number.isFinite(paid) ? paid : 0,
      balanceDue: Number.isFinite(due) ? due : 0,
      deadline: parseDay(s.deadline) ? s.deadline : '',
      summary: String(s.taglishSummary || '').trim(),
      studyNotes: Array.isArray(s.studyNotes) ? s.studyNotes.map(String) : []
    };
    sc.checklist = (Array.isArray(s.checklist) ? s.checklist : []).map((t) => ({ text: String(t) }));
    const flat = text.replace(/\s+/g, '').toLowerCase();
    const u = {};
    if (!CATEGORIES.includes(s.category)) u.category = true;
    if (ref && (refLooksOff(ref) || !flat.includes(ref.replace(/\s+/g, '').toLowerCase()))) u.referenceNo = true;
    if (!Number.isFinite(paid) || !numberInText(paid, text)) u.amountPaid = true;
    if (!Number.isFinite(due) || !numberInText(due, text)) u.balanceDue = true;
    sc.uncertain = u;
    sc.confirmed = {};
  }

  // ── Scanned text as tappable words ──
  function wordAreaHtml() {
    const sc = state.scan;
    let idx = 0;
    return sc.text.split(/\r?\n/).map((line) => {
      const toks = line.match(/\S+/g);
      if (!toks) return '';
      return `<div class="word-line">${toks.map((w) => {
        const i = idx++;
        if (i >= MAX_CHIPS) return '';
        const fixed = sc.corrections[i] !== undefined;
        const ed = sc.editWord && sc.editWord.index === i ? sc.editWord : null;
        const chip = `<button type="button" class="word-chip ${fixed ? 'fixed' : ''} ${ed ? 'editing' : ''}" data-action="edit-word" data-index="${i}" aria-label="Fix the word ${esc(w)}">${fixed ? '<i data-lucide="check"></i>' : ''}<span>${esc(w)}</span></button>`;
        const editor = ed ? `
          <form class="word-editor" data-form="word">
            <label for="wordInput">The scanner read “${esc(ed.original)}”. What should it say?</label>
            <div class="word-editor-row">
              <input id="wordInput" class="input" value="${esc(ed.text)}" maxlength="512" autocomplete="off" />
              <button class="btn btn-ok btn-sm" type="submit" ${ed.busy ? 'disabled' : ''}>${ed.busy ? '<span class="spinner"></span>' : '<i data-lucide="check"></i>'}Confirm fix</button>
              <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-word">Cancel</button>
            </div>
          </form>` : '';
        return chip + editor;
      }).join('')}</div>`;
    }).join('') + (idx > MAX_CHIPS ? `<p class="card-sub">Showing the first ${MAX_CHIPS} words.</p>` : '');
  }
  function refreshWords() {
    const a = $('#wordArea'); if (!a) return;
    a.innerHTML = wordAreaHtml(); icons();
    const inp = $('#wordInput'); if (inp) { inp.focus(); inp.select(); }
  }
  function replaceToken(text, index, word) {
    let i = 0;
    return text.replace(/\S+/g, (m) => (i++ === index ? word : m));
  }
  function openWord(index) {
    const sc = state.scan;
    let i = 0, original = '';
    sc.text.replace(/\S+/g, (m) => { if (i++ === index) original = m; return m; });
    if (!original) return;
    sc.editWord = { index, original, text: sc.corrections[index] ?? original, busy: false };
    refreshWords();
  }
  async function saveWord() {
    const sc = state.scan, ed = sc.editWord;
    if (!ed || ed.busy) return;
    const text = ($('#wordInput').value || '').trim();
    if (!text) { toast('Type the correct word first.', 'warn'); return; }
    if (text === ed.original) { sc.editWord = null; refreshWords(); return; }
    ed.busy = true; ed.text = text; refreshWords();
    try {
      await postJson('/api/ocr/correct', { documentId: sc.docId || 'mock-doc', pageNumber: 1, wordIndex: ed.index, text });
      sc.text = replaceToken(sc.text, ed.index, text);
      sc.corrections[ed.index] = text;
      applyCorrectionToFields(ed.original, text);
      sc.editWord = null;
      toast('Thanks! Fixing words helps the scanner get better.');
    } catch (e) {
      ed.busy = false; toast(e.message, 'error');
    }
    refreshWords(); syncFieldInputs(); refreshFlags();
  }
  // Keep the form in step with a corrected word
  function applyCorrectionToFields(orig, fixed) {
    const sc = state.scan, f = sc.fields;
    ['title', 'referenceNo'].forEach((n) => { if (String(f[n]).includes(orig)) f[n] = String(f[n]).split(orig).join(fixed); });
    if (f.referenceNo) sc.uncertain.referenceNo = refLooksOff(f.referenceNo);
    const clean = (s) => Number(String(s).replace(/[^\d.]/g, ''));
    ['amountPaid', 'balanceDue'].forEach((n) => {
      if (Number.isFinite(clean(orig)) && clean(orig) === Number(f[n]) && Number.isFinite(clean(fixed))) {
        f[n] = clean(fixed); sc.uncertain[n] = !numberInText(f[n], sc.text);
      }
    });
  }

  // ── Step 3: Save ──
  function scanStep3() {
    const sc = state.scan, f = sc.fields;
    const m = dueMeta(f.deadline);
    const items = sc.checklist.map((it, i) => `
      <li class="check-row">
        <label class="sr-only" for="chk_${i}">Step ${i + 1}</label>
        <input id="chk_${i}" class="input" data-check="${i}" value="${esc(it.text)}" maxlength="200" />
        <button class="icon-btn" data-action="remove-check" data-index="${i}" type="button" aria-label="Remove step ${i + 1}"><i data-lucide="trash-2"></i></button>
      </li>`).join('');
    return `
      <div class="stack scan-narrow wide">
        <section class="card" aria-labelledby="sumTitle">
          <p class="eyebrow">Summary</p>
          <h2 id="sumTitle" class="next-title" style="max-width:none">${esc(f.title)}</h2>
          <div class="row" style="margin-bottom:16px"><span class="badge badge-brand"><i data-lucide="${CATEGORY_ICON[f.category] || 'file-text'}"></i>${esc(f.category)}</span></div>
          <dl class="summary-grid">
            <div><dt>Reference no.</dt><dd class="ref">${esc(f.referenceNo || 'None')}</dd></div>
            <div><dt>Amount paid</dt><dd>${pesoTile(f.amountPaid)}</dd></div>
            <div><dt>Balance due</dt><dd>${pesoTile(f.balanceDue)}</dd></div>
            <div><dt>Deadline</dt><dd>${esc(fmtDay(f.deadline))}</dd>${m ? `<div style="margin-top:6px">${dueBadge(m)}</div>` : ''}</div>
          </dl>
          ${f.summary ? `<hr class="divider" /><h3 class="card-title" style="font-size:16px">What this means</h3><p style="margin:6px 0 0;max-width:70ch">${richText(f.summary)}</p>` : ''}
        </section>

        <section class="card" aria-labelledby="todoTitle">
          <h2 id="todoTitle" class="card-title">Your to-do list</h2>
          <p class="card-sub" style="margin-bottom:16px">We found these steps. Edit them, remove any you don't need, or add your own.</p>
          ${items ? `<ul class="check-edit">${items}</ul>` : '<p class="card-sub">No steps found. Add one if you need to.</p>'}
          <div style="margin-top:12px"><button class="btn btn-ghost btn-sm" data-action="add-check" type="button"><i data-lucide="plus"></i>Add a step</button></div>
        </section>

        <div class="footer-bar">
          <button class="btn btn-ghost" data-action="scan-back" type="button"><i data-lucide="arrow-left"></i>Back</button>
          <button class="btn btn-primary btn-lg" data-action="save-scan" type="button" ${sc.saving ? 'disabled' : ''}>${sc.saving ? '<span class="spinner"></span>' : '<i data-lucide="shield-check"></i>'}Save to My Documents</button>
        </div>
      </div>`;
  }

  function scanSaved() {
    const sc = state.scan;
    const n = sc.checklist.filter((c) => c.text.trim()).length;
    return `
      <div class="scan-narrow">
        <section class="card next-card caught-up" aria-labelledby="doneTitle">
          <p class="eyebrow"><i data-lucide="check-circle-2" style="vertical-align:-3px"></i> Saved</p>
          <h2 id="doneTitle" class="next-title">${esc(sc.savedTitle)} is in My Documents</h2>
          <p class="next-from">${n ? `We added ${n} ${n === 1 ? 'step' : 'steps'} to Clearance &amp; Payments.` : 'You can find it any time under My Documents.'}</p>
          <div class="next-actions">
            <button class="btn btn-primary btn-lg" data-action="scan-another" type="button"><i data-lucide="scan-line"></i>Scan another</button>
            <button class="link-btn" data-action="view-saved" type="button">View document</button>
          </div>
        </section>
      </div>`;
  }

  // ── Scan actions ──
  function clearPreview() { if (state.scan.previewUrl) URL.revokeObjectURL(state.scan.previewUrl); }
  function resetScan() { clearPreview(); state.scan = freshScan(); }

  function setFile(file) {
    if (!file) return;
    const type = file.type || '';
    if (!ACCEPT.includes(type)) { toast('That file type is not supported. Please use a photo or PDF.', 'error'); return; }
    if (file.size > MAX_BYTES) { toast('That file is over 10 MB. Please try a smaller photo.', 'error'); return; }
    resetScan();
    const sc = state.scan;
    sc.file = file; sc.fileName = file.name; sc.previewType = type; sc.previewUrl = URL.createObjectURL(file);
    processFile();
  }

  // Read the file, then fill in the form. Both calls happen behind one friendly loading screen.
  async function processFile() {
    const sc = state.scan;
    if (!sc.file) return;
    sc.step = 2; sc.processing = true; sc.error = ''; sc.stage = 'reading';
    renderView(); window.scrollTo({ top: 0 });
    try {
      const fd = new FormData();
      fd.append('document', sc.file);
      const data = await api('/api/ocr/upload', { method: 'POST', body: fd });
      sc.docId = data.documentId;
      const t = String(data.extractedText || '');
      sc.text = /^\(OCR completed, but no text/i.test(t) ? '' : t;
      sc.corrections = {};
    } catch (e) {
      sc.processing = false; sc.error = e.message; renderView(); return;
    }
    sc.stage = 'organizing';
    const st = $('#stageText'); if (st) st.textContent = stageText(sc);
    await organizeText();
    sc.processing = false;
    renderView(); // the banner on the Check step is the feedback; no toast needed
  }

  async function organizeText() {
    const sc = state.scan;
    const stem = sc.fileName.replace(/\.[^.]+$/, '');
    if (!sc.text.trim()) { applyStructured({ title: stem }, ''); return; }
    try {
      const data = await postJson('/api/chat/organize', { verifiedText: sc.text, fileName: sc.fileName || 'Student Document' });
      applyStructured(data.structured || {}, sc.text);
      if (!sc.fields.title) sc.fields.title = stem;
    } catch (e) {
      applyStructured({ title: stem }, '');
      toast(`We could not fill in the details: ${e.message}. Please type them in.`, 'error');
    }
  }

  function goToStep3() {
    const sc = state.scan;
    if (!String(sc.fields.title).trim()) { toast('Please add a title first.', 'warn'); const t = $('#f_title'); if (t) t.focus(); return; }
    sc.step = 3; renderView(); window.scrollTo({ top: 0 });
  }

  async function saveScan() {
    const sc = state.scan, f = sc.fields;
    if (sc.saving) return;
    sc.saving = true; renderView();
    const stamp = Date.now();
    const record = {
      id: uid('rec'),
      studentId: state.studentId,
      documentId: sc.docId || 'manual-' + stamp,
      title: String(f.title).trim(),
      category: f.category,
      referenceNo: String(f.referenceNo).trim() || 'N/A',
      amountPaid: Number(f.amountPaid) || 0,
      balanceDue: Number(f.balanceDue) || 0,
      deadline: parseDay(f.deadline) ? f.deadline : 'None',
      summary: f.summary,
      studyNotes: f.studyNotes,
      rawText: sc.text.trim(),
      fileName: sc.fileName,
      verified: true,
      createdAt: new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }),
      tasks: sc.checklist.map((c) => c.text.trim()).filter(Boolean).map((text, i) => ({ id: `t-${stamp}-${i}`, text, done: false }))
    };
    await addRecord(record);
    sc.saving = false; sc.saved = true; sc.savedId = record.id; sc.savedTitle = record.title;
    renderView(); window.scrollTo({ top: 0 });
    toast('Saved to My Documents.', 'ok', { label: 'View document', fn: () => viewSaved(record.id) });
  }
  function viewSaved(id) { setView('vault'); openRecord(id); }

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
          ${Number(r.balanceDue) > 0 ? '<span class="badge badge-warn"><i data-lucide="clock"></i>Balance due</span>' : '<span class="badge badge-ok"><i data-lucide="badge-check"></i>Verified</span>'}
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
    if (!state.records.length) return emptyState('folder-open', 'No documents yet', 'Scan a receipt or memo and it will show up here.', 'Scan a document', 'scanner');
    if (!list.length) return `<div class="empty"><i data-lucide="search-x"></i><p class="empty-title">No matches</p><p>Try a different search or category.</p></div>`;
    return `<div class="vault-grid">${list.map(recordCard).join('')}</div>`;
  }
  function viewVault() {
    const chips = ['ALL', ...CATEGORIES].map((c) =>
      `<button class="chip ${state.vaultCat === c ? 'active' : ''}" data-action="vault-cat" data-cat="${esc(c)}" type="button">${c === 'ALL' ? 'All' : esc(c)}</button>`).join('');
    return `
      <div class="page-head">
        <div><h1 class="page-title">My Documents</h1><p class="page-sub">Every receipt, memo and note in one place.</p></div>
        <div class="row"><button class="btn btn-ghost" data-action="quick-note" type="button"><i data-lucide="square-pen"></i>New note</button><button class="btn btn-primary" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan a document</button></div>
      </div>
      <div class="toolbar">
        <div class="search"><i data-lucide="search"></i><label class="sr-only" for="vaultSearch">Search documents</label><input id="vaultSearch" class="input" type="search" placeholder="Search by title, OR number or note" value="${esc(state.vaultQ)}" /></div>
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
        <div><div class="money-label">Deadline</div><div class="v">${esc(fmtDay(r.deadline))}</div><div style="margin-top:6px">${dueBadge(m)}</div></div>
      </div>
      ${r.summary ? `<h3 class="card-title" style="font-size:16px">What this means</h3><p style="margin:6px 0 14px">${richText(r.summary)}</p>` : ''}
      ${(r.studyNotes || []).length ? `<h3 class="card-title">Key notes</h3><ul class="note-list">${r.studyNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${(r.tasks || []).length ? `<h3 class="card-title" style="margin-top:14px">Checklist</h3>${r.tasks.map((t) => taskRow({ ...t, recordId: r.id, recordTitle: r.title, deadline: r.deadline })).join('')}` : ''}
      ${r.rawText ? `<details class="disclose"><summary>View scanned text</summary><div class="disclose-body"><div class="raw">${esc(r.rawText)}</div></div></details>` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="confirm-delete" data-id="${esc(r.id)}" type="button" style="color:var(--danger-ink)"><i data-lucide="trash-2"></i>Delete</button>
        <button class="btn btn-primary" data-action="close-modal" type="button">Done</button>
      </div>`, true);
  }
  function confirmDelete(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    openModal(`
      <h2 class="modal-title">Delete this document?</h2>
      <p class="card-sub" style="margin-top:8px"><strong>${esc(r.title)}</strong> and its checklist will be removed from My Documents. This cannot be undone.</p>
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
        <div><h1 class="page-title">Clearance &amp; Payments</h1><p class="page-sub">What to submit and what to pay, earliest deadline first.</p></div>
        <div class="chips">
          <button class="chip ${!showAll ? 'active' : ''}" data-action="tracker-show" data-show="pending" type="button">Pending (${s.pending})</button>
          <button class="chip ${showAll ? 'active' : ''}" data-action="tracker-show" data-show="all" type="button">All (${s.tasks})</button>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px">
        <div class="row" style="justify-content:space-between;margin-bottom:10px"><strong>${s.done} of ${s.tasks} done</strong><span class="mono" style="color:var(--muted)">${s.pct}%</span></div>
        <div class="progress ${s.pct === 100 ? 'ok' : ''}" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Overall clearance progress"><span style="width:${s.pct}%"></span></div>
      </div>
      ${groups.length ? `<div class="stack">${groups.map(({ r, tasks }) => {
        const m = dueMeta(r.deadline);
        return `<div class="card">
          <div class="group-head">
            <div><h2 class="group-title">${esc(r.title)}</h2><span class="rec-ref">${esc(r.referenceNo)}</span></div>
            ${m ? `<span class="badge ${m.cls}"><i data-lucide="${m.icon}"></i>${esc(fmtDay(r.deadline))} · ${esc(m.label)}</span>` : ''}
          </div>
          ${tasks.map((t) => taskRow({ ...t, recordId: r.id, recordTitle: r.title, deadline: null })).join('')}
        </div>`;
      }).join('')}</div>` : (s.tasks ? `<div class="empty"><i data-lucide="party-popper"></i><p class="empty-title">All requirements done</p><p>Nice work. Switch to "All" to review them.</p></div>`
        : emptyState('list-checks', 'No requirements yet', 'Scan a clearance memo and your to-do list builds itself.', 'Scan a document', 'scanner'))}`;
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
      <div class="page-head"><div><h1 class="page-title">Ask EasyBo</h1><p class="page-sub">Taglish or English. Answers use your own documents.</p></div></div>
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
            <h2 class="card-title" style="margin-bottom:10px">Ask about</h2>
            <div class="stack" style="gap:8px">
              <label class="radio-card"><input type="radio" name="scope" value="vault" ${state.chatScope === 'vault' ? 'checked' : ''} data-action="chat-scope" /><span><strong>All my documents</strong><div class="card-sub">${state.records.length} record${state.records.length === 1 ? '' : 's'} for ${esc(student().first)}</div></span></label>
              <label class="radio-card"><input type="radio" name="scope" value="doc" ${state.chatScope === 'doc' ? 'checked' : ''} data-action="chat-scope" /><span><strong>The paper I am scanning</strong><div class="card-sub">${state.scan.text.trim() ? 'Uses the paper on the Scan page' : 'No active scan'}</div></span></label>
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
      if (!e.target.closest('.popover-wrap')) closeDemo();
      return;
    }
    const a = el.dataset.action;
    switch (a) {
      case 'goto': setView(el.dataset.view); break;
      case 'toggle-theme': applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); break;
      case 'toggle-demo': { const pop = $('#demoPop'); const open = pop.hidden; pop.hidden = !open; el.setAttribute('aria-expanded', String(open)); break; }
      case 'mark-paid': markTask(el.dataset.rec, el.dataset.task, true); break;
      case 'mark-done': markTask(el.dataset.rec, el.dataset.task, false); break;
      case 'reset-demo': closeDemo(); confirmReset(); break;
      case 'confirm-reset': resetDemo(); break;
      case 'toggle-mock': {
        try {
          const d = await postJson('/api/config/mock', { mockMode: !state.mock });
          state.mock = d.mockMode; renderApiMode();
          toast(state.mock ? 'Mock Mode on. No credits will be used.' : 'Live Lumen API on.', state.mock ? 'warn' : 'ok');
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
      case 'skip-upload': { resetScan(); const sc = state.scan; sc.step = 2; applyStructured({}, ''); renderView(); break; }
      case 'scan-reset': resetScan(); renderView(); window.scrollTo({ top: 0 }); break;
      case 'retry-process': processFile(); break;
      case 'scan-next': goToStep3(); break;
      case 'scan-back': state.scan.step = Math.max(1, state.scan.step - 1); renderView(); window.scrollTo({ top: 0 }); break;
      case 'edit-word': openWord(Number(el.dataset.index)); break;
      case 'cancel-word': state.scan.editWord = null; refreshWords(); break;
      case 'add-check': { state.scan.checklist.push({ text: '' }); renderView(); const last = $$('[data-check]').pop(); if (last) last.focus(); break; }
      case 'remove-check': state.scan.checklist.splice(Number(el.dataset.index), 1); renderView(); break;
      case 'save-scan': saveScan(); break;
      case 'scan-another': resetScan(); renderView(); window.scrollTo({ top: 0 }); break;
      case 'view-saved': viewSaved(state.scan.savedId); break;      // chat
      case 'ask-preset': ask(el.dataset.q); break;
      case 'chat-scope': state.chatScope = el.value; break;
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'vaultSearch') { state.vaultQ = t.value; refreshVaultGrid(); }
    else if (t.dataset.field) { state.scan.fields[t.dataset.field] = t.value; state.scan.confirmed[t.dataset.field] = true; refreshFlags(); }
    else if (t.dataset.check !== undefined) { const it = state.scan.checklist[Number(t.dataset.check)]; if (it) it.text = t.value; }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'fileInput' && t.files[0]) setFile(t.files[0]);
    else if (t.dataset.field) { state.scan.fields[t.dataset.field] = t.value; state.scan.confirmed[t.dataset.field] = true; refreshFlags(); }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.dataset && e.target.dataset.form === 'word') {
      e.preventDefault(); saveWord();
    } else if (e.target.id === 'chatForm') {
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
      addRecord(rec).then(() => { toast('Note saved to My Documents.'); renderView(); });
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
    if (e.key === 'Escape') { closeModal(); closeDemo(); }
  });
  function closeDemo() { const p = $('#demoPop'); if (p && !p.hidden) { p.hidden = true; $('#demoBtn').setAttribute('aria-expanded', 'false'); } }

  function confirmReset() {
    openModal(`
      <h2 class="modal-title">Reset demo for ${esc(student().first)}?</h2>
      <p class="card-sub" style="margin-top:8px">This removes every document, note and checklist item for ${esc(student().name)} and clears the chat. Other students are not affected. You can bring sample documents back with Load Demo Data.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal" type="button">Cancel</button>
        <button class="btn btn-danger" data-action="confirm-reset" type="button"><i data-lucide="rotate-ccw"></i>Reset demo</button>
      </div>`);
  }
  async function resetDemo() {
    const snapshot = JSON.stringify(state.records);
    state.records = []; state.chat = []; resetScan();
    closeModal(); renderView();
    await syncRecords();
    toast('Demo reset.', 'ok', { label: 'Undo', fn: async () => { state.records = JSON.parse(snapshot); renderView(); await syncRecords(); } });
  }

  $('#studentSelect').addEventListener('change', async (e) => {
    state.studentId = e.target.value;
    localStorage.setItem('easybo.student', state.studentId);
    state.chat = []; resetScan();
    await loadRecords();
    toast(`Switched to ${student().name}.`);
    renderView(true);
  });
  // Remember which "View scanned text" style sections are open across re-renders (toggle doesn't bubble)
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.dataset && d.dataset.detail) state.scan[d.dataset.detail] = d.open;
  }, true);
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { push: false }));

  // ───────── Boot ─────────
  async function init() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
    renderStudentSelect();
    $('#viewRoot').innerHTML = `<div class="skel-stack" aria-busy="true"><div class="skeleton" style="height:28px;width:40%"></div><div class="skeleton" style="height:110px"></div></div>`;
    try {
      const cfg = await api('/api/config');
      state.mock = !!cfg.mockMode; state.hasKeys = !!cfg.hasKeys;
    } catch (_) { toast('Cannot reach the server. Please try again.', 'error'); }
    renderApiMode();
    if (!state.hasKeys && !state.mock) toast('No Lumen API keys found. Switch to Mock Mode to try the flow.', 'warn');
    await loadRecords();
    setView(location.hash.slice(1) || 'dashboard', { push: false });
  }
  init();
})();
