/* EasyBo Student Buddy: single-page frontend.
   Talks only to the existing server.js routes:
   /api/config, /api/config/mock, /api/ocr/upload, /api/ocr/correct,
   /api/chat/organize, /api/chat/ask, /api/records (GET/POST/PUT). */
(() => {
  "use strict";

  // ───────── Constants ─────────
  // Demo student profiles: welcome screen buttons and the top-bar profile switcher
  const STUDENTS = [
    {
      id: "2026-00142",
      name: "Juan Dela Cruz",
      first: "Juan",
      program: "BSIT 1-A",
    },
    {
      id: "2026-00891",
      name: "Maria Santos",
      first: "Maria",
      program: "BSCS 2-B",
    },
  ];
  // Document types: the Type dropdown on the Check step and the My Documents filters
  const CATEGORIES = [
    "Receipt & Tuition",
    "Enrollment & Clearance",
    "Scholarship",
    "Class Note & Memo",
  ];
  // Icon shown next to each document type
  const CATEGORY_ICON = {
    "Receipt & Tuition": "receipt",
    "Enrollment & Clearance": "clipboard-check",
    Scholarship: "award",
    "Class Note & Memo": "sticky-note",
  };
  // The five pages, matched to the URL hash (#dashboard, #scanner, #vault, #tracker, #buddy)
  const VIEWS = ["dashboard", "scanner", "vault", "tracker", "buddy"];
  // Upload rules for the Scan page: allowed file types and the 10 MB limit
  const ACCEPT = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/tiff",
  ];
  const MAX_BYTES = 10 * 1024 * 1024;

  // ───────── State ─────────
  // Scan page: a blank scan (current step, file, scanned text, form fields, flags and file summary)
  const freshScan = () => ({
    step: 1,
    saved: false,
    saving: false,
    savedId: null,
    savedTitle: "",
    file: null,
    previewUrl: "",
    previewType: "",
    fileName: "",
    processing: false,
    stage: "reading",
    error: "",
    docId: null,
    text: "",
    corrections: {},
    editWord: null,
    showText: false,
    words: [],
    tokenMap: null,
    manual: false,
    attach: null,
    attachPromise: null,
    offline: false,
    fields: {
      title: "",
      category: CATEGORIES[1],
      referenceNo: "",
      amountPaid: 0,
      balanceDue: 0,
      deadline: "",
      summary: "",
      studyNotes: [],
    },
    uncertain: {},
    confirmed: {},
    checklist: [],
    // File summary shown on the Summary step: { overview, keyPoints[] } or null
    fileSummary: null,
    summaryBase: null, // field values the summary was made from (drives the "Update summary" button)
    summaryBusy: false,
    summaryFailed: false,
  });

  // App-wide state: selected student, saved records, current page, scan, chat, filters and open drawer
  const state = {
    studentId: localStorage.getItem("easybo.student") || STUDENTS[0].id,
    records: [],
    mock: false,
    hasKeys: true,
    view: "dashboard",
    scan: freshScan(),
    chat: [],
    chatBusy: false,
    vaultQ: "",
    vaultCat: "ALL",
    drawerId: null,
    cpTab: "payments",
  };

  // ───────── Helpers ─────────
  // DOM shortcuts: $ returns the first match, $$ returns every match as an array
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  // Security: escapes user, scanned or AI text before it goes into HTML (prevents script injection)
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  // Money: ₱ with two decimals (tables, drawer, chat answers)
  const peso = (n) =>
    "₱" +
    (Number(n) || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  // The currently selected demo student
  const student = () =>
    STUDENTS.find((s) => s.id === state.studentId) || STUDENTS[0];
  // Icons: turns <i data-lucide="..."> placeholders into SVG icons after each render
  const icons = () => {
    if (window.lucide)
      window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } });
  };
  // Unique IDs for records, payments and notes
  const uid = (p) =>
    `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  // Local calendar date as YYYY-MM-DD (toISOString would give the UTC date, a day off before 8am in PH)
  const pad2 = (n) => String(n).padStart(2, "0");
  const localIso = (d = new Date()) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const isoDay = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return localIso(d);
  };
  // Today as a short label ("Nov 13, 2026"), used as a record's Filed date
  const todayLabel = () =>
    new Date().toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  // Dates: parseDay reads "YYYY-MM-DD"; fmtDay shows it as "Nov 24, 2026" (or "No deadline")
  function parseDay(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(v + "T00:00:00");
    return isNaN(d) ? null : d;
  }
  function fmtDay(v) {
    const d = parseDay(v);
    return d
      ? d.toLocaleDateString("en-PH", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : v && v !== "None"
        ? String(v)
        : "No deadline";
  }
  // Deadline badges: overdue, due today, due soon (within 7 days) or days left
  function dueMeta(v) {
    const d = parseDay(v);
    if (!d) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    const n = (x) => `${x} day${x === 1 ? "" : "s"}`;
    if (days < 0)
      return {
        days,
        label: `Overdue by ${n(-days)}`,
        cls: "badge-danger",
        icon: "alert-circle",
      };
    if (days === 0)
      return {
        days,
        label: "Due today",
        cls: "badge-danger",
        icon: "alert-circle",
      };
    if (days <= 7)
      return {
        days,
        label: `Due soon: ${n(days)} left`,
        cls: "badge-warn",
        icon: "clock",
      };
    return {
      days,
      label: `${n(days)} left`,
      cls: "badge-muted",
      icon: "calendar",
    };
  }
  // Status = color + icon + word (never color alone)
  const dueBadge = (m) =>
    m
      ? `<span class="badge ${m.cls}"><i data-lucide="${m.icon}"></i>${esc(m.label)}</span>`
      : "";
  // Money for big stat tiles: drops ".00" on whole amounts
  const pesoTile = (n) =>
    "₱" +
    (Number(n) || 0).toLocaleString("en-PH", {
      minimumFractionDigits: Number.isInteger(Number(n) || 0) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  // File size as KB or MB
  function fmtBytes(b) {
    return b > 1048576
      ? (b / 1048576).toFixed(1) + " MB"
      : Math.max(1, Math.round(b / 1024)) + " KB";
  }
  // Escape first, then allow **bold** and line breaks only.
  function richText(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  // Students never see server or vendor wording. Technical detail goes to the console only.
  function plainError(raw, status) {
    const s = String(raw || "");
    if (/failed to fetch|networkerror|load failed|network request/i.test(s))
      return "We can't reach the server. Check your internet connection and try again.";
    if (/no file uploaded/i.test(s))
      return "Please choose a photo or PDF first.";
    if (
      /ocr failed|unprocess|could not read|no text/i.test(s) ||
      status === 422
    )
      return "We couldn't read that file. Try a clear, well-lit photo that shows the whole page.";
    if (/timed? ?out|too long/i.test(s))
      return "That took too long. Please try again.";
    if (/too large|file ?size|10 ?mib|limit/i.test(s) || status === 413)
      return "That file is too large. Please use a file under 10 MB.";
    return "Something went wrong on our side. Please try again later.";
  }
  // Network: calls a server route, turns failures into plain-language errors, returns the JSON body
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      console.warn(path, e);
      throw new Error(plainError(e.message));
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* non-JSON body */
    }
    if (!res.ok) {
      const raw =
        data?.error?.message ||
        data?.message ||
        `Request failed (${res.status})`;
      console.warn(path, res.status, raw);
      throw new Error(plainError(raw, res.status));
    }
    return data || {};
  }
  // Network: POST a JSON body to a server route
  const postJson = (path, body) =>
    api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // ───────── Toasts & modals ─────────
  // action: optional { label, fn } shown as a button (used for Undo)
  function toast(msg, type = "ok", action = null) {
    const ico =
      { ok: "check-circle-2", error: "alert-circle", warn: "info" }[type] ||
      "info";
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<i data-lucide="${ico}"></i><span style="flex:1">${esc(msg)}</span>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ""}`;
    const dismiss = () => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    };
    if (action)
      $(".toast-action", el).addEventListener("click", () => {
        dismiss();
        action.fn();
      });
    $("#toasts").appendChild(el);
    icons();
    setTimeout(dismiss, action ? 8000 : type === "error" ? 6000 : 3500);
  }
  // Dialogs: openModal shows a dialog and focuses its first control; closeModal removes it
  function openModal(html, wide = false) {
    $("#modalRoot").innerHTML =
      `<div class="modal-back" data-action="modal-backdrop"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div></div>`;
    icons();
    const f = $(
      "#modalRoot [autofocus], #modalRoot input, #modalRoot textarea, #modalRoot button",
    );
    if (f) f.focus();
  }
  const closeModal = () => {
    $("#modalRoot").innerHTML = "";
  };

  // ───────── Persistence (server first, localStorage fallback) ─────────
  // Every change is cached on this device first. If the server write fails, the student is marked
  // "unsynced"; on the next load the device copy wins and is pushed to the server, so nothing is lost.
  // Device storage keys: this student's cached records, and their "not yet synced" flag
  const lsKey = () => `easybo.records.${state.studentId}`;
  const dirtyKey = () => `easybo.unsynced.${state.studentId}`;
  const OFFLINE_MSG =
    "Saved on this device. It will sync when the connection is back.";
  // Device cache: saves this student's records (drops inline photos if storage is full)
  function cacheLocal() {
    try {
      localStorage.setItem(lsKey(), JSON.stringify(state.records));
      return true;
    } catch (_) {
      // Storage full: keep the records, drop inline photos from the device copy
      try {
        localStorage.setItem(
          lsKey(),
          JSON.stringify(
            state.records.map((r) =>
              /^data:/.test(r.image || "") ? { ...r, image: "" } : r,
            ),
          ),
        );
        return true;
      } catch (__) {
        return false;
      }
    }
  }
  // Device cache: reads this student's records back
  function readLocal() {
    try {
      return JSON.parse(localStorage.getItem(lsKey()) || "[]");
    } catch (_) {
      return [];
    }
  }
  // Offline sync flag: setDirty marks that the device copy still needs to reach the server; isDirty reads it
  function setDirty(on) {
    try {
      if (on) localStorage.setItem(dirtyKey(), "1");
      else localStorage.removeItem(dirtyKey());
    } catch (_) {
      /* ignore */
    }
  }
  function isDirty() {
    try {
      return localStorage.getItem(dirtyKey()) === "1";
    } catch (_) {
      return false;
    }
  }
  // Server sync: replaces this student's records on the server with the device copy
  const putAll = () =>
    api("/api/records", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: state.studentId,
        records: state.records,
      }),
    });

  // Startup and profile switch: loads records from the server, or from the device when offline/unsynced
  async function loadRecords() {
    if (isDirty()) {
      state.records = readLocal();
      try {
        await putAll();
        setDirty(false);
        toast("Changes you made while offline are now synced.");
      } catch (_) {
        toast("Still offline. Your documents are safe on this device.", "warn");
      }
      return;
    }
    try {
      const data = await api(
        `/api/records?studentId=${encodeURIComponent(state.studentId)}`,
      );
      state.records = Array.isArray(data.records) ? data.records : [];
      cacheLocal();
    } catch (_) {
      state.records = readLocal();
      toast(
        "We can't reach the server. Showing the documents saved on this device.",
        "warn",
      );
    }
  }
  // Returns true when the server has the change.
  async function syncRecords({ quiet = false } = {}) {
    cacheLocal();
    try {
      await putAll();
      setDirty(false);
      return true;
    } catch (_) {
      setDirty(true);
      if (!quiet) toast(OFFLINE_MSG, "warn");
      return false;
    }
  }
  // Saving a new document: stores it on the device first, then sends it to the server
  async function addRecord(record, { quiet = false } = {}) {
    state.records.unshift(record);
    if (isDirty()) return syncRecords({ quiet }); // device copy is ahead of the server: push everything
    cacheLocal();
    try {
      await postJson("/api/records", { studentId: state.studentId, record });
      return true;
    } catch (_) {
      setDirty(true);
      if (!quiet) toast(OFFLINE_MSG, "warn");
      return false;
    }
  }

  // ───────── Derived data ─────────
  // Checklist items from every record, each tagged with its document title and deadline
  function allTasks() {
    const out = [];
    state.records.forEach((r) =>
      (r.tasks || []).forEach((t) =>
        out.push({
          ...t,
          recordId: r.id,
          recordTitle: r.title,
          deadline: r.deadline,
        }),
      ),
    );
    return out;
  }
  // Sort helper: earliest deadline first, items without a deadline last
  function sortByDeadline(a, b) {
    const da = parseDay(a.deadline),
      db = parseDay(b.deadline);
    if (da && db) return da - db;
    if (da) return -1;
    if (db) return 1;
    return 0;
  }
  // Scholarship amounts are credits to the student, not payments made by the student.
  const isCredit = (r) => r.category === "Scholarship";
  // amountPaid is what the scanned paper says and never changes. Later payments are kept as their own entries.
  const paymentsOf = (r) => (Array.isArray(r.payments) ? r.payments : []);
  // Total paid on a document: the scanned amount plus later payments
  const paidTotal = (r) =>
    (Number(r.amountPaid) || 0) +
    paymentsOf(r).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  // Home tiles and nav badge: total paid and owed, next due date, clearance progress
  function stats() {
    const tasks = allTasks();
    const done = tasks.filter((t) => t.done).length;
    const due = state.records
      .filter((r) => Number(r.balanceDue) > 0 && parseDay(r.deadline))
      .sort(sortByDeadline)[0];
    return {
      total: state.records.length,
      paid: state.records.reduce(
        (s, r) => s + (isCredit(r) ? 0 : paidTotal(r)),
        0,
      ),
      balance: state.records.reduce(
        (s, r) => s + (Number(r.balanceDue) || 0),
        0,
      ),
      nextDue: due ? due.deadline : null,
      tasks: tasks.length,
      done,
      pending: tasks.length - done,
      pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    };
  }

  // ───────── Routing & shell ─────────
  // Navigation: switches page, updates the URL hash and highlights the active menu item
  function setView(view, { push = true } = {}) {
    if (!VIEWS.includes(view)) view = "dashboard";
    closeDrawer();
    // A finished scan should not greet the student again next time they open Scan
    if (state.view === "scanner" && view !== "scanner" && state.scan.saved)
      resetScan();
    state.view = view;
    if (push && location.hash !== "#" + view)
      history.replaceState(null, "", "#" + view);
    $$(".nav-item[data-view], .tab-item[data-view]").forEach((a) => {
      const on = a.dataset.view === view;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    renderView(true);
    window.scrollTo({ top: 0 });
  }
  // Rendering: draws the current page into the main area, then refreshes icons, badge and drawer
  function renderView(animate = false) {
    const root = $("#viewRoot");
    const fn = {
      dashboard: viewDashboard,
      scanner: viewScanner,
      vault: viewVault,
      tracker: viewTracker,
      buddy: viewBuddy,
    }[state.view];
    root.innerHTML = fn();
    if (animate) {
      root.classList.remove("enter");
      void root.offsetWidth;
      root.classList.add("enter");
    }
    updateNavBadge();
    icons();
    if (state.drawerId) renderDrawer();
    if (state.view === "buddy") scrollChat();
  }
  // Sidebar badge: number of unfinished checklist items
  function updateNavBadge() {
    const n = stats().pending;
    const el = $("#navPending");
    el.hidden = n === 0;
    el.textContent = n;
  }
  // Light/dark theme: applies and remembers the choice, updates the Demo tools button
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("easybo.theme", t);
    // Rebuild the button content: Lucide replaces <i> tags with <svg>, so swap the whole thing.
    $("#themeBtn").innerHTML =
      `<i data-lucide="${t === "dark" ? "sun" : "moon"}"></i><span>${t === "dark" ? "Light theme" : "Dark theme"}</span>`;
    // (button lives in the Demo tools popover)
    icons();
  }

  // Top bar: fills the student profile switcher
  function renderStudentSelect() {
    $("#studentSelect").innerHTML = STUDENTS.map(
      (s) =>
        `<option value="${esc(s.id)}" ${s.id === state.studentId ? "selected" : ""}>${esc(s.name)} · ${esc(s.program)}</option>`,
    ).join("");
  }
  // Demo tools: shows whether Mock Mode (no credits) or Live Lumen mode is on
  function renderApiMode() {
    const sw = $("#mockSwitch");
    sw.setAttribute("aria-checked", String(state.mock));
    $("#apiModeLabel").textContent = state.mock
      ? "Mock Mode (Credit Saver)"
      : "Live Lumen API";
    $("#demoBtn").title = state.mock
      ? "Demo tools (Mock Mode on)"
      : "Demo tools";
  }

  // ───────── View 1: Home ─────────
  // Is this checklist item a payment? Then its button says "Mark as paid" and records the payment.
  const isPaymentTask = (t, r) =>
    Number(r?.balanceDue) > 0 &&
    /bayad|bayaran|pay|balance|₱|cashier/i.test(t.text);

  // Home hero card: the most urgent unfinished task, "all caught up", or a prompt to scan the first document
  function nextStepHtml() {
    const t = allTasks()
      .filter((x) => !x.done)
      .sort(sortByDeadline)[0];

    if (!state.records.length) {
      return `
        <section class="card next-card" aria-labelledby="nextTitle">
          <p class="eyebrow">Next step</p>
          <h2 id="nextTitle" class="next-title">Scan your first document</h2>
          <p class="next-from">You have no documents yet. Upload a receipt or memo and we'll list what you need to do.</p>
          <div class="next-actions"><button class="btn btn-primary btn-lg" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan a document</button></div>
        </section>`;
    }
    if (!t) {
      return `
        <section class="card next-card caught-up" aria-labelledby="nextTitle">
          <p class="eyebrow"><i data-lucide="check-circle-2" style="vertical-align:-3px"></i> Next step</p>
          <h2 id="nextTitle" class="next-title">You're all caught up</h2>
          <p class="next-from">Nothing needs your attention right now. Got a new paper? Scan it and we'll add it to your list.</p>
          <div class="next-actions"><button class="btn btn-primary btn-lg" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan a document</button></div>
        </section>`;
    }

    const rec = state.records.find((r) => r.id === t.recordId);
    const m = dueMeta(t.deadline);
    const pay = isPaymentTask(t, rec);
    const viewLabel =
      rec?.category === "Receipt & Tuition" ? "View receipt" : "View document";
    return `
      <section class="card next-card" aria-labelledby="nextTitle">
        <p class="eyebrow">Next step</p>
        <h2 id="nextTitle" class="next-title">${esc(t.text)}</h2>
        <div class="next-meta">${m ? `${dueBadge(m)}<span>Before ${esc(fmtDay(t.deadline))}</span>` : "<span>No deadline set</span>"}</div>
        <p class="next-from">From: ${esc(t.recordTitle)}</p>
        <div class="next-actions">
          <button class="btn btn-primary btn-lg" data-action="${pay ? "mark-paid" : "mark-done"}" data-rec="${esc(t.recordId)}" data-task="${esc(t.id)}" type="button">
            <i data-lucide="${pay ? "badge-check" : "check"}"></i>${pay ? "Mark as paid" : "Mark as done"}
          </button>
          <button class="link-btn" data-action="open-record" data-id="${esc(t.recordId)}" type="button">${viewLabel}</button>
        </div>
      </section>`;
  }

  // Home page: greeting, next step, paid/owed/clearance tiles, recent documents and quick scan
  function viewDashboard() {
    const s = stats();
    const st = student();
    const recent = state.records.slice(0, 3);
    const paidDocs = state.records.filter(
      (r) => !isCredit(r) && Number(r.amountPaid) > 0,
    ).length;
    const owing = s.balance > 0;
    const greet = `
      <div class="page-head">
        <div>
          <h1 class="page-title greet">Good day, <span class="hl-name">${esc(st.first)}</span></h1>
          <p class="page-sub">Here's what needs your attention today.</p>
        </div>
      </div>`;

    if (!state.records.length) return greet + nextStepHtml();

    return `${greet}
      <div class="home-grid">
        <div class="home-main">
          ${nextStepHtml()}

          <section class="tiles" aria-label="Where you stand">
            <div class="tile tile-paid">
              <div class="tile-label"><span class="dot ok" aria-hidden="true"></span>Paid so far</div>
              <div class="tile-value">${pesoTile(s.paid)}</div>
              <div class="tile-foot">${paidDocs ? `From ${paidDocs} receipt${paidDocs === 1 ? "" : "s"}` : "No payments recorded yet"}</div>
            </div>
            <div class="tile tile-due">
              <div class="tile-label"><span class="dot ${owing ? "warn" : "ok"}" aria-hidden="true"></span>Still to pay</div>
              <div class="tile-value">${pesoTile(s.balance)}</div>
              <div class="tile-foot">${owing ? (s.nextDue ? `Due ${esc(fmtDay(s.nextDue))}` : "No due date yet") : "Nothing to pay"}</div>
            </div>
            <div class="tile tile-clear">
              <div class="tile-label"><span class="dot ${s.tasks && s.pct === 100 ? "ok" : "navy"}" aria-hidden="true"></span>Clearance</div>
              <div class="tile-value">${s.tasks ? `${s.done} of ${s.tasks} done` : "Not started"}</div>
              <div class="progress ${s.pct === 100 ? "ok" : ""}" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Clearance progress"><span style="width:${s.pct}%"></span></div>
            </div>
          </section>
        </div>

        <div class="home-side">
          <section class="card receipt recent-card" aria-labelledby="recentTitle">
            <div class="list-head">
              <h2 id="recentTitle" class="card-title">Recent documents</h2>
              ${recent.length ? '<button class="link-btn" data-action="goto" data-view="vault" type="button">See all</button>' : ""}
            </div>
            <span class="doc-perf ticket" aria-hidden="true"></span>
            ${recent
              .map(
                (r) => `
              <button class="doc-row" data-action="open-record" data-id="${esc(r.id)}" type="button">
                <span class="doc-main">
                  <div class="doc-title">${esc(r.title)}</div>
                  <div class="doc-sub"><span class="ref">${esc(r.referenceNo)}</span> · ${esc(r.createdAt || "")}</div>
                </span>
                ${stampHtml(docStatus(r))}
                <i data-lucide="chevron-right" aria-hidden="true"></i>
              </button>`,
              )
              .join("")}
          </section>

          <section class="card quick-scan" aria-labelledby="quickTitle">
            <h2 id="quickTitle" class="card-title">Quick scan</h2>
            <p class="card-sub">Got a new receipt? Drop it here and we'll read it right away.</p>
            <label class="dropzone dropzone-quick" id="dropzone">
              <i data-lucide="upload-cloud"></i>
              <span class="dz-title">Drag a photo or PDF here, or tap to choose</span>
              <span class="dz-sub">JPG, PNG, WebP, TIFF or PDF. Up to 10 MB.</span>
              <input id="fileInput" type="file" accept=".pdf,image/png,image/jpeg,image/webp,image/tiff" />
            </label>
            <button class="link-btn quick-ask" data-action="goto" data-view="buddy" type="button"><i data-lucide="message-circle"></i>Have a question? Ask EasyBo</button>
          </section>
        </div>
      </div>`;
  }

  // One checklist item: checkbox, text, document name and deadline badge (Home, drawer, Clearance)
  function taskRow(t, large = false) {
    const m = dueMeta(t.deadline);
    return `
      <label class="task ${t.done ? "done" : ""} ${large ? "task-lg" : ""}">
        <input type="checkbox" ${t.done ? "checked" : ""} data-action="toggle-task" data-rec="${esc(t.recordId)}" data-task="${esc(t.id)}" aria-label="${esc(t.text)}" />
        <span class="task-body">
          <div class="task-text">${esc(t.text)}</div>
          <div class="task-meta"><span>${esc(t.recordTitle)}</span>${t.done ? '<span class="badge badge-ok"><i data-lucide="check"></i>Done</span>' : dueBadge(m)}</div>
        </span>
      </label>`;
  }
  // Simple line art: a torn receipt, a folder, or a checklist. One sentence, one button.
  const SVG_OPEN =
    '<svg class="empty-art" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const EMPTY_ART = {
    receipt:
      SVG_OPEN +
      '<path d="M24 10H72V84L66 78L60 84L54 78L48 84L42 78L36 84L30 78L24 84Z"/><path d="M34 26H62M34 38H62" /><path d="M34 50H54" stroke-dasharray="3 5"/><path class="art-accent" d="M34 64L40 70L52 56" /></svg>',
    folder:
      SVG_OPEN +
      '<path d="M12 28A6 6 0 0 1 18 22H36L44 30H78A6 6 0 0 1 84 36V72A6 6 0 0 1 78 78H18A6 6 0 0 1 12 72Z"/><path d="M28 54H68" stroke-dasharray="3 5"/><path class="art-accent" d="M28 64H48" /></svg>',
    checklist:
      SVG_OPEN +
      '<rect x="18" y="16" width="14" height="14" rx="3"/><rect x="18" y="41" width="14" height="14" rx="3"/><rect x="18" y="66" width="14" height="14" rx="3"/><path d="M42 23H78M42 48H78M42 73H78" stroke-dasharray="3 5"/><path class="art-accent" d="M21 23L25 27L30 19" /></svg>',
  };
  // Empty states: picks the drawing for each page; emptyState adds one sentence and one button
  const ART_FOR = { "folder-open": "folder", "list-checks": "checklist" };
  function emptyState(icon, title, text, cta, view, action) {
    const attrs = action
      ? `data-action="${action}"`
      : `data-action="goto" data-view="${view}"`;
    return `<div class="empty">${EMPTY_ART[ART_FOR[icon] || "receipt"]}<p class="empty-title">${esc(title)}</p><p>${esc(text)}</p><button class="btn btn-primary" ${attrs} type="button">${esc(cta)}</button></div>`;
  }

  // "Mark as done" / "Mark as paid": completes a task, records the payment if any, offers Undo
  async function markTask(recId, taskId, paid) {
    const snapshot = JSON.stringify(state.records);
    const rec = state.records.find((r) => r.id === recId);
    const task = rec?.tasks.find((x) => x.id === taskId);
    if (!task) return;
    task.done = true;
    if (paid && Number(rec.balanceDue) > 0) {
      // Record the payment as its own entry; the receipt's own amount stays as scanned.
      const payment = {
        id: uid("pay"),
        amount: Number(rec.balanceDue),
        date: localIso(),
        note: "Balance paid",
      };
      rec.payments = [...paymentsOf(rec), payment];
      rec.balanceDue = 0;
      task.paymentId = payment.id;
    }
    renderView();
    await syncRecords();
    toast(paid ? "Marked as paid." : "Marked as done.", "ok", {
      label: "Undo",
      fn: async () => {
        state.records = JSON.parse(snapshot);
        renderView();
        await syncRecords();
      },
    });
  }

  // ───────── View 2: Scan (1 Upload, 2 Summary, 3 Check, 4 Save) ─────────
  // Step labels for the progress indicator. Step 5 is the "Saved" confirmation screen.
  const STEP_LABELS = ["Upload", "Summary", "Check", "Save"];
  // Check step form fields, and the most scanned words shown as tappable chips
  const FIELD_NAMES = [
    "title",
    "category",
    "referenceNo",
    "amountPaid",
    "balanceDue",
    "deadline",
  ];
  const MAX_CHIPS = 300;

  // Scan page: title, step indicator and the body for the current step
  function viewScanner() {
    const sc = state.scan;
    const current = sc.saved ? STEP_LABELS.length + 1 : sc.step;
    const stepper = STEP_LABELS.map((label, i) => {
      const n = i + 1;
      const cls = n < current ? "done" : n === current ? "active" : "";
      return `<li class="step ${cls}" ${n === current ? 'aria-current="step"' : ""}><span class="step-n">${n < current ? "✓" : n}</span><span>${label}</span></li>${n < STEP_LABELS.length ? '<li class="step-line" aria-hidden="true"></li>' : ""}`;
    }).join("");
    const sub = sc.saved
      ? "All done."
      : sc.step === 2 && sc.processing
        ? "One moment, we're reading your document."
        : {
            1: "Take a photo of your receipt or memo, or upload a file.",
            2: "Here's what your document says. Save it if you want to keep it.",
            3: "Here's what we read. Compare it with your paper.",
            4: "Almost done. Review the details, then save.",
          }[sc.step];
    const body = sc.saved
      ? scanSaved()
      : sc.step === 1
        ? scanStep1()
        : sc.step === 2
          ? scanSummary()
          : sc.step === 3
            ? scanStep2()
            : scanStep3();
    return `
      <div class="page-head"><div><h1 class="page-title">Scan a document</h1><p class="page-sub">${sub}</p></div></div>
      <ol class="stepper" aria-label="Progress">${stepper}</ol>
      ${body}`;
  }

  // Scan page: preview of the uploaded photo or PDF
  function previewHtml(sc) {
    if (!sc.previewUrl)
      return `<div class="preview-empty"><i data-lucide="file-image"></i><div>No photo added</div></div>`;
    if (sc.previewType === "application/pdf")
      return `<iframe src="${esc(sc.previewUrl)}" title="PDF preview"></iframe>`;
    if (sc.previewType === "image/tiff")
      return `<div class="preview-empty"><i data-lucide="file-image"></i><div>This file type cannot be previewed here.<br>We can still read it.</div></div>`;
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
        <div class="card sample-card">
          <h2 class="card-title">No paper with you?</h2>
          <p class="card-sub">Try a sample to see how EasyBo works.${state.mock ? "" : " <strong>Live mode is on, so a sample uses Lumen credits.</strong>"}</p>
          <div class="sample-row">
            ${Object.entries(SAMPLES)
              .map(
                ([k, s]) =>
                  `<button class="btn btn-ghost" data-action="try-sample" data-sample="${k}" type="button"><i data-lucide="${s.icon}"></i>${esc(s.label)}</button>`,
              )
              .join("")}
          </div>
        </div>
        <div class="center"><button class="link-btn" data-action="skip-upload" type="button">No file? Type the details yourself</button></div>
      </div>`;
  }

  // Sample papers drawn on a canvas, so the demo shows a real-looking photo and runs the real flow.
  // In Mock Mode the server returns matching text for these file names.
  const SAMPLES = {
    receipt: {
      label: "Sample receipt",
      icon: "receipt",
      file: "sample-receipt.png",
      sub: "OFFICE OF THE UNIVERSITY REGISTRAR & CASHIER",
      title: "OFFICIAL RECEIPT",
      stamp: "PAID",
      lines: [
        "Document Ref: OR-2026-99412",
        "Date: November 12, 2026",
        "Particulars: Computer Lab & miscellaneous deposit",
        "Amount Paid: PHP 1,250.00",
        "Remaining Balance Due: PHP 500.00",
        "Submission Deadline: November 24, 2026",
        "",
        "REQUIREMENTS FOR FINAL EXAM PERMIT:",
        "1. Signed Library & Computer Lab Clearance Slip",
        "2. Official Receipt (OR-2026-99412) photocopy",
        "3. Updated Certificate of Registration (COR) with Adviser Signature",
      ],
    },
    memo: {
      label: "Clearance memo",
      icon: "clipboard-check",
      file: "sample-clearance-memo.png",
      sub: "OFFICE OF THE UNIVERSITY REGISTRAR",
      title: "MEMORANDUM",
      lines: [
        "Memo No.: REG-MEMO-114",
        "Date: November 10, 2026",
        "SUBJECT: FINAL EXAM PERMIT AND CLEARANCE REQUIREMENTS",
        "To: All 1st Semester Students",
        "",
        "Please complete the following before exam week:",
        "1. Signed Library & Computer Lab Clearance Slip",
        "2. Updated Certificate of Registration (COR) with Adviser Signature",
        "3. Submit all papers to the Registrar's Office",
        "",
        "Deadline: November 20, 2026",
      ],
    },
    scholarship: {
      label: "Scholarship notice",
      icon: "award",
      file: "sample-scholarship.png",
      sub: "OFFICE OF STUDENT AFFAIRS AND SCHOLARSHIPS",
      title: "NOTICE OF SCHOLARSHIP AWARD",
      lines: [
        "Reference: SCH-2026-031",
        "Date: November 3, 2026",
        "SUBJECT: ACADEMIC EXCELLENCE SCHOLARSHIP, 1ST SEMESTER",
        "Scholarship Amount Credited: PHP 5,000.00",
        "",
        "To keep your scholarship:",
        "1. Submit the scholarship renewal form",
        "2. Maintain the required General Weighted Average (GWA)",
        "",
        "Deadline: November 30, 2026",
      ],
    },
  };
  // Sample papers: wraps long lines so they fit on the drawn page
  function wrapLine(line, max) {
    if (line.length <= max) return [line];
    const out = [];
    let cur = "";
    line.split(" ").forEach((w) => {
      if ((cur + " " + w).trim().length > max) {
        out.push(cur);
        cur = "   " + w;
      } else cur = (cur + " " + w).trim() === "" ? w : cur ? cur + " " + w : w;
    });
    if (cur) out.push(cur);
    return out;
  }
  // Sample papers: draws a realistic school paper on a canvas and returns it as a PNG file
  function sampleFile(key) {
    const s = SAMPLES[key];
    const W = 820,
      pad = 56,
      lh = 34;
    const lines = s.lines.flatMap((l) => wrapLine(l, 50));
    const H = pad * 2 + 150 + lines.length * lh + 40;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    g.fillStyle = "#FDFBF6";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "#D9CFBA";
    g.lineWidth = 2;
    g.strokeRect(14, 14, W - 28, H - 28);
    g.fillStyle = "#1B2A41";
    g.textAlign = "center";
    g.font = "700 32px Georgia, serif";
    g.fillText("SAMPLE STATE UNIVERSITY", W / 2, pad + 14);
    g.font = "600 18px Arial, sans-serif";
    g.fillText(s.sub, W / 2, pad + 46);
    g.font = "800 24px Arial, sans-serif";
    g.fillText(s.title, W / 2, pad + 92);
    g.setLineDash([8, 6]);
    g.beginPath();
    g.moveTo(pad, pad + 112);
    g.lineTo(W - pad, pad + 112);
    g.stroke();
    g.setLineDash([]);
    g.textAlign = "left";
    g.fillStyle = "#222";
    g.font = '22px "Courier New", monospace';
    lines.forEach((l, i) => g.fillText(l, pad, pad + 156 + i * lh));
    if (s.stamp) {
      g.save();
      g.translate(W - 170, pad + 250);
      g.rotate(-0.14);
      g.strokeStyle = "rgba(185,28,28,.85)";
      g.fillStyle = "rgba(185,28,28,.85)";
      g.lineWidth = 4;
      g.strokeRect(-86, -36, 172, 62);
      g.strokeRect(-80, -30, 160, 50);
      g.font = "800 32px Arial, sans-serif";
      g.textAlign = "center";
      g.fillText(s.stamp, 0, 6);
      g.restore();
    }
    return new Promise((res) =>
      c.toBlob(
        (b) => res(new File([b], s.file, { type: "image/png" })),
        "image/png",
      ),
    );
  }

  // A small copy of the original paper to keep with the record (images are shrunk; small PDFs kept as-is)
  async function makeAttachment(file) {
    if (
      /^image\/(png|jpeg|webp)$/.test(file.type) &&
      window.createImageBitmap
    ) {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 1100 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * s));
      c.height = Math.max(1, Math.round(bmp.height * s));
      const g = c.getContext("2d");
      g.fillStyle = "#FFFFFF";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return { dataUrl: c.toDataURL("image/jpeg", 0.72), kind: "image" };
    }
    if (file.type === "application/pdf" && file.size <= 3 * 1024 * 1024) {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      return { dataUrl, kind: "pdf" };
    }
    return null;
  }

  // Line up the words in the scanned text with the word list Lumen returned, so a fix is sent
  // for the right page and word position. Without a word list, the token position is used.
  function buildTokenMap(text, words) {
    if (!Array.isArray(words) || !words.length) return null;
    const toks = text.match(/\S+/g) || [];
    const map = [];
    let j = 0;
    for (let i = 0; i < toks.length && j < words.length; i++) {
      let k = j;
      const limit = Math.min(words.length, j + 8);
      while (k < limit && String(words[k].text || "").trim() !== toks[i]) k++;
      if (k < limit) {
        map[i] = words[k];
        j = k + 1;
      }
    }
    return map;
  }

  // Scan loading message: reading the file, then preparing the summary
  const stageText = (sc) =>
    sc.stage === "organizing"
      ? "Preparing your document summary…"
      : "Reading your document…";

  // Scan page: the "Your document" card shown beside the summary and the form
  const previewCard = (sc) => `
      <div class="card sticky-card scan-preview">
        <div class="card-head"><h2 class="card-title">Your document</h2></div>
        <div class="preview-box">${previewHtml(sc)}</div>
      </div>`;

  // A summary is usable when it has an overview; key points are optional.
  function normalizeFileSummary(fs) {
    if (!fs || typeof fs !== "object") return null;
    const overview = String(fs.overview || "").trim();
    const keyPoints = (Array.isArray(fs.keyPoints) ? fs.keyPoints : [])
      .map((p) => String(p).trim())
      .filter(Boolean)
      .slice(0, 5);
    return overview ? { overview, keyPoints } : null;
  }
  // File summary: overview paragraph plus key-point bullets (all text escaped)
  function fileSummaryHtml(fs) {
    return `<p class="fs-overview">${esc(fs.overview)}</p>${
      fs.keyPoints.length
        ? `<ul class="fs-points">${fs.keyPoints.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
        : ""
    }`;
  }

  // ── Step 2: Summary (read first, then choose to save or not) ──
  function scanSummary() {
    const sc = state.scan;
    if (sc.processing || sc.error) return scanStep2(); // same loading and error screens as before
    const fs = sc.fileSummary;
    return `
      <div class="split">${previewCard(sc)}
        <div class="stack">
          <section class="card fs-card" aria-labelledby="fsTitle">
            <p class="eyebrow"><i data-lucide="sparkles" style="vertical-align:-3px"></i> Summary</p>
            <h2 id="fsTitle" class="card-title">What this document is about</h2>
            ${
              fs
                ? fileSummaryHtml(fs)
                : `<div class="banner warn" role="status" style="margin-top:12px"><i data-lucide="alert-triangle"></i><div><strong>No summary available.</strong><div>We couldn't summarize this document. You can still save it and enter the details yourself.</div></div></div>`
            }
          </section>
          <section class="card fs-choice" aria-label="What to do with this document">
            <p class="card-sub" style="margin:0 0 16px">Want to keep this in My Documents? You'll review the details before it's saved.</p>
            <div class="next-actions">
              <button class="btn btn-primary btn-lg" data-action="summary-continue" type="button"><i data-lucide="folder-plus"></i>Save to My Documents</button>
              <button class="btn btn-ghost" data-action="scan-discard" type="button">Done, don't save</button>
            </div>
          </section>
        </div>
      </div>`;
  }

  // Did the student change anything the summary talks about since it was made?
  function summaryDirty(sc) {
    const b = sc.summaryBase;
    if (!b || !sc.fileSummary) return false;
    const f = sc.fields;
    const txt = (v) => String(v ?? "").trim();
    const num = (v) => Number(v) || 0;
    return (
      txt(f.title) !== b.title ||
      txt(f.category) !== b.category ||
      txt(f.deadline) !== b.deadline ||
      num(f.amountPaid) !== b.amountPaid ||
      num(f.balanceDue) !== b.balanceDue ||
      Object.keys(sc.corrections).length !== b.corrections
    );
  }
  // File summary: remembers the values the summary was made from, so "Update summary" knows what changed
  function setSummaryBase(sc) {
    const f = sc.fields;
    sc.summaryBase = {
      title: String(f.title ?? "").trim(),
      category: String(f.category ?? "").trim(),
      deadline: String(f.deadline ?? "").trim(),
      amountPaid: Number(f.amountPaid) || 0,
      balanceDue: Number(f.balanceDue) || 0,
      corrections: Object.keys(sc.corrections).length,
    };
  }
  // Check step: short summary card, with an "Update summary" button after the student changes something.
  function compactSummaryHtml() {
    const sc = state.scan;
    if (!sc.fileSummary) return "";
    const showBtn = sc.summaryBusy || sc.summaryFailed || summaryDirty(sc);
    return `
      <section class="card fs-compact" id="sumBox" aria-labelledby="fsMini">
        <h2 id="fsMini" class="card-title" style="font-size:16px">What this document is about</h2>
        <p class="fs-overview">${esc(sc.fileSummary.overview)}</p>
        ${sc.summaryBusy ? '<p class="card-sub" role="status"><span class="spinner"></span> Updating summary…</p>' : ""}
        ${sc.summaryFailed ? '<p class="fs-error" role="status"><i data-lucide="alert-circle"></i> Couldn\'t update the summary. Please try again.</p>' : ""}
        ${showBtn ? `<button class="btn btn-ghost btn-sm" data-action="update-summary" type="button" ${sc.summaryBusy ? "disabled" : ""}><i data-lucide="refresh-cw"></i>Update summary</button>` : ""}
      </section>`;
  }
  // Redraw only when the content changes, so a click on the button isn't lost
  // when leaving a field fires "change" right before the click.
  let lastSumHtml = "";
  function refreshSummaryBox() {
    const box = $("#sumBox");
    if (!box) return;
    const html = compactSummaryHtml();
    if (html === lastSumHtml && box.dataset.drawn) return;
    lastSumHtml = html;
    box.outerHTML = html;
    const fresh = $("#sumBox");
    if (fresh) fresh.dataset.drawn = "1";
    icons();
  }
  // "Update summary": asks the organizer again with the corrected text and replaces only the summary
  async function updateSummary() {
    const sc = state.scan;
    if (sc.summaryBusy || !sc.text.trim()) return;
    sc.summaryBusy = true;
    sc.summaryFailed = false;
    refreshSummaryBox();
    try {
      const data = await postJson("/api/chat/organize", {
        verifiedText: sc.text,
        fileName: sc.fileName || "Student Document",
        studentId: state.studentId,
      });
      const fs = normalizeFileSummary(
        data.structured && data.structured.fileSummary,
      );
      if (state.scan !== sc) return; // scan was reset meanwhile
      if (!fs) throw new Error("empty summary");
      sc.fileSummary = fs;
      sc.fields.summary = fs.overview;
      setSummaryBase(sc);
    } catch (_) {
      sc.summaryFailed = true;
    }
    sc.summaryBusy = false;
    refreshSummaryBox();
  }

  // ── Step 3: Check ──
  function scanStep2() {
    const sc = state.scan;
    const left = previewCard(sc);

    if (sc.processing) {
      return `
        <div class="split">${left}
          <div class="card" aria-busy="true">
            <div class="printer" aria-hidden="true"><div class="printer-slot"></div><div class="printer-window"><div class="printer-paper"><span></span><span class="short"></span><span></span><span class="short"></span><span></span></div></div></div>
            <div class="row" style="color:var(--brand);margin-bottom:8px;justify-content:center"><span class="spinner"></span><strong id="stageText">${stageText(sc)}</strong></div>
            <p class="card-sub" style="text-align:center;margin:0 auto">This takes about 20 seconds. Please keep this page open.</p>
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
              <button class="link-btn" data-action="scan-discard" type="button">Done, don't save</button>
            </div>
          </div>
        </div>`;
    }

    const f = sc.fields;
    const catOptions = CATEGORIES.map(
      (c) => `<option ${c === f.category ? "selected" : ""}>${esc(c)}</option>`,
    ).join("");
    const money = (name, label) =>
      fieldWrap(
        name,
        label,
        `<div class="money-input"><span aria-hidden="true">₱</span><input id="f_${name}" class="input" type="number" inputmode="decimal" step="0.01" min="0" data-field="${name}" value="${esc(f[name])}" /></div>`,
      );

    return `
      <div class="split">${left}
        <div class="stack">
          ${dupHtml()}
          ${bannerHtml()}
          ${compactSummaryHtml()}
          <div class="card">
            <div class="form-grid two">
              ${fieldWrap("title", "Document title", `<input id="f_title" class="input" data-field="title" value="${esc(f.title)}" />`, "span-2")}
              ${fieldWrap("category", "Type", `<select id="f_category" class="select" data-field="category">${catOptions}</select>`, "span-2")}
              ${fieldWrap("referenceNo", "Reference no.", `<input id="f_referenceNo" class="input ref-input" data-field="referenceNo" value="${esc(f.referenceNo)}" autocomplete="off" />`, "span-2")}
              ${money("amountPaid", "Amount paid")}
              ${money("balanceDue", "Balance due")}
              ${fieldWrap("deadline", "Deadline", `<input id="f_deadline" class="input" type="date" data-field="deadline" value="${esc(f.deadline)}" />`, "span-2")}
            </div>
          </div>
          ${
            sc.text.trim()
              ? `
          <details class="disclose" data-detail="showText" ${sc.showText || sc.editWord ? "open" : ""}>
            <summary>View scanned text</summary>
            <div class="disclose-body">
              <p class="card-sub">Tap a misread word and type the correct one. Each fix helps the scanner improve.</p>
              <div id="wordArea" class="word-area">${wordAreaHtml()}</div>
            </div>
          </details>`
              : ""
          }
        </div>
      </div>
      <div class="footer-bar">
        <button class="btn btn-ghost" data-action="scan-reset" type="button"><i data-lucide="rotate-ccw"></i>Start over</button>
        <button class="btn btn-primary" data-action="scan-next" type="button">Looks right, continue<i data-lucide="arrow-right"></i></button>
      </div>`;
  }

  // Check step: one form field with its "Please check" flag and "Looks right" button
  function fieldWrap(name, label, control, span = "") {
    const flagged = isFlagged(name);
    return `
      <div class="field ${span} ${flagged ? "flag" : ""}" data-wrap="${name}">
        <div class="field-top"><label for="f_${name}">${label}</label><span class="flag-group" ${flagged ? "" : "hidden"}><span class="flag-tag"><i data-lucide="alert-triangle"></i>Please check</span>${name === "title" ? "" : `<button type="button" class="flag-ok" data-action="confirm-field" data-field="${name}">Looks right</button>`}</span></div>
        ${control}
      </div>`;
  }

  // A field is amber when it is empty, or the scanner looked unsure and the student has not touched it yet.
  // The student clears a flag by fixing the value or by pressing "Looks right". A title is always required.
  // Typed-in documents (no scan) only need a title.
  function isFlagged(name) {
    const sc = state.scan;
    const empty = String(sc.fields[name] ?? "").trim() === "";
    if (name === "title") return empty;
    if (sc.manual) return false;
    if (sc.confirmed[name]) return false;
    return empty || !!sc.uncertain[name];
  }
  // Check step banner: how many fields still need checking, or an all-clear message
  const flaggedCount = () => FIELD_NAMES.filter(isFlagged).length;
  function bannerHtml() {
    const n = flaggedCount();
    return n
      ? `<div class="banner warn" id="flagBanner" role="status"><i data-lucide="alert-triangle"></i><div><strong>Please check before saving.</strong><div>${n} ${n === 1 ? "field is" : "fields are"} marked “Please check”. Fix the value, or press “Looks right” if it is correct.</div></div></div>`
      : `<div class="banner ok" id="flagBanner" role="status"><i data-lucide="check-circle-2"></i><div><strong>Everything is complete.</strong><div>Take one last look before saving.</div></div></div>`;
  }

  // ── Scanned-before check (same reference number, or same file and title) ──
  const canonRef = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/(?<=\d)O|O(?=\d)/g, "0");
  // Duplicate warning: a saved record with the same reference number, or the same file and title
  function findDuplicate(f, fileName) {
    const ref = canonRef(f.referenceNo);
    const usable = ref && !/^(N\/A|NOTE|NONE)$/.test(ref);
    return (
      state.records.find(
        (r) =>
          (usable && canonRef(r.referenceNo) === ref) ||
          (fileName &&
            r.fileName === fileName &&
            String(r.title).trim().toLowerCase() ===
              String(f.title).trim().toLowerCase()),
      ) || null
    );
  }
  // Duplicate warning banner (Check and Save steps)
  function dupHtml() {
    const sc = state.scan;
    const d = findDuplicate(sc.fields, sc.manual ? "" : sc.fileName);
    if (!d) return '<div id="dupBanner" hidden></div>';
    return `<div class="banner warn" id="dupBanner" role="status"><i data-lucide="copy"></i><div><strong>It looks like you already saved this.</strong><div>“${esc(d.title)}” (${esc(d.referenceNo)}) has been in My Documents since ${esc(d.createdAt || "earlier")}. Saving it again would count the payment and balance twice.</div><button class="link-btn" data-action="open-record" data-id="${esc(d.id)}" type="button">View the saved copy</button></div></div>`;
  }
  // Check step: redraws flags, banners and the summary box without redrawing the whole form
  function refreshFlags() {
    FIELD_NAMES.forEach((n) => {
      const w = $(`[data-wrap="${n}"]`);
      if (!w) return;
      const on = isFlagged(n);
      w.classList.toggle("flag", on);
      const g = $(".flag-group", w);
      if (g) g.hidden = !on;
    });
    const b = $("#flagBanner");
    if (b) b.outerHTML = bannerHtml();
    const d = $("#dupBanner");
    if (d) d.outerHTML = dupHtml();
    refreshSummaryBox();
    icons();
  }
  // Check step: copies field values back into the inputs after a word correction
  function syncFieldInputs() {
    FIELD_NAMES.forEach((n) => {
      const el = $(`#f_${n}`);
      if (el && el !== document.activeElement) el.value = state.scan.fields[n];
    });
  }

  // Heuristics for "the scanner may have got this wrong"
  function numberInText(n, text) {
    if (!Number.isFinite(n)) return false;
    if (n === 0) return true;
    return [
      n.toLocaleString("en-US"),
      String(n),
      n.toLocaleString("en-US", { minimumFractionDigits: 2 }),
    ].some((s) => text.includes(s));
  }
  // Mostly-digit chunks that also contain letters (like 2O26) are classic scanner mix-ups.
  function refLooksOff(ref) {
    if (!ref) return true;
    return ref.split(/[-\s]+/).some((tok) => {
      const d = (tok.match(/\d/g) || []).length,
        l = (tok.match(/[A-Za-z]/g) || []).length;
      return d > 0 && l > 0 && l < d;
    });
  }
  // Reads a number from organizer output such as "PHP 1,250.00"
  const toNum = (v) =>
    v === undefined || v === null || v === ""
      ? NaN
      : Number(String(v).replace(/[^\d.\-]/g, ""));

  // Fills the Check form and file summary from the organizer's answer, and flags values that look unsure
  function applyStructured(s, text) {
    const sc = state.scan;
    const paid = toNum(s.amountPaid),
      due = toNum(s.balanceDue);
    const ref =
      s.referenceNo &&
      !/^(n\/a|none|verified-doc)$/i.test(String(s.referenceNo).trim())
        ? String(s.referenceNo).trim()
        : "";
    sc.fields = {
      title: String(s.title || "").trim(),
      category: CATEGORIES.includes(s.category) ? s.category : CATEGORIES[1],
      referenceNo: ref,
      amountPaid: Number.isFinite(paid) ? paid : 0,
      balanceDue: Number.isFinite(due) ? due : 0,
      deadline: parseDay(s.deadline) ? s.deadline : "",
      summary: String(s.summary || s.taglishSummary || "").trim(), // taglishSummary: older server versions
      studyNotes: Array.isArray(s.studyNotes) ? s.studyNotes.map(String) : [],
    };
    sc.fileSummary = normalizeFileSummary(s.fileSummary);
    if (sc.fileSummary) sc.fields.summary = sc.fileSummary.overview;
    sc.summaryFailed = false;
    sc.checklist = (Array.isArray(s.checklist) ? s.checklist : []).map((t) => ({
      text: String(t),
    }));
    const flat = text.replace(/\s+/g, "").toLowerCase();
    const u = {};
    if (!CATEGORIES.includes(s.category)) u.category = true;
    if (
      ref &&
      (refLooksOff(ref) ||
        !flat.includes(ref.replace(/\s+/g, "").toLowerCase()))
    )
      u.referenceNo = true;
    if (!Number.isFinite(paid) || !numberInText(paid, text))
      u.amountPaid = true;
    if (!Number.isFinite(due) || !numberInText(due, text)) u.balanceDue = true;
    sc.uncertain = u;
    sc.confirmed = {};
  }

  // ── Scanned text as tappable words ──
  function wordAreaHtml() {
    const sc = state.scan;
    let idx = 0;
    return (
      sc.text
        .split(/\r?\n/)
        .map((line) => {
          const toks = line.match(/\S+/g);
          if (!toks) return "";
          return `<div class="word-line">${toks
            .map((w) => {
              const i = idx++;
              if (i >= MAX_CHIPS) return "";
              const fixed = sc.corrections[i] !== undefined;
              const ed =
                sc.editWord && sc.editWord.index === i ? sc.editWord : null;
              const chip = `<button type="button" class="word-chip ${fixed ? "fixed" : ""} ${ed ? "editing" : ""}" data-action="edit-word" data-index="${i}" aria-label="Fix the word ${esc(w)}">${fixed ? '<i data-lucide="check"></i>' : ""}<span>${esc(w)}</span></button>`;
              const editor = ed
                ? `
          <form class="word-editor" data-form="word">
            <label for="wordInput">The scanner read “${esc(ed.original)}”. What should it say?</label>
            <div class="word-editor-row">
              <input id="wordInput" class="input" value="${esc(ed.text)}" maxlength="512" autocomplete="off" />
              <button class="btn btn-ok btn-sm" type="submit" ${ed.busy ? "disabled" : ""}>${ed.busy ? '<span class="spinner"></span>' : '<i data-lucide="check"></i>'}Confirm fix</button>
              <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-word">Cancel</button>
            </div>
          </form>`
                : "";
              return chip + editor;
            })
            .join("")}</div>`;
        })
        .join("") +
      (idx > MAX_CHIPS
        ? `<p class="card-sub">Showing the first ${MAX_CHIPS} words.</p>`
        : "")
    );
  }
  // Word correction: redraws the scanned words and focuses the edit box
  function refreshWords() {
    const a = $("#wordArea");
    if (!a) return;
    a.innerHTML = wordAreaHtml();
    icons();
    const inp = $("#wordInput");
    if (inp) {
      inp.focus();
      inp.select();
    }
  }
  // Word correction: replaces the Nth word in the scanned text
  function replaceToken(text, index, word) {
    let i = 0;
    return text.replace(/\S+/g, (m) => (i++ === index ? word : m));
  }
  // Word correction: opens the edit box for the tapped word
  function openWord(index) {
    const sc = state.scan;
    let i = 0,
      original = "";
    sc.text.replace(/\S+/g, (m) => {
      if (i++ === index) original = m;
      return m;
    });
    if (!original) return;
    sc.editWord = {
      index,
      original,
      text: sc.corrections[index] ?? original,
      busy: false,
    };
    refreshWords();
  }
  // Word correction: sends the fix to Lumen OCR review, then updates the text and the form
  async function saveWord() {
    const sc = state.scan,
      ed = sc.editWord;
    if (!ed || ed.busy) return;
    const text = ($("#wordInput").value || "").trim();
    if (!text) {
      toast("Type the correct word first.", "warn");
      return;
    }
    if (text === ed.original) {
      sc.editWord = null;
      refreshWords();
      return;
    }
    ed.busy = true;
    ed.text = text;
    refreshWords();
    try {
      // Send the fix to the scanner only when we know which word it is; otherwise keep it in EasyBo only.
      const w = sc.tokenMap ? sc.tokenMap[ed.index] : null;
      if (!sc.tokenMap || w) {
        await postJson("/api/ocr/correct", {
          documentId: sc.docId || "mock-doc",
          pageNumber: w ? Number(w.pageNumber) || 1 : 1,
          wordIndex: w ? Number(w.wordIndex) : ed.index,
          text,
        });
      }
      sc.text = replaceToken(sc.text, ed.index, text);
      sc.corrections[ed.index] = text;
      applyCorrectionToFields(ed.original, text);
      sc.editWord = null;
      toast("Thanks! This fix helps the scanner improve.");
    } catch (e) {
      ed.busy = false;
      toast(e.message, "error");
    }
    refreshWords();
    syncFieldInputs();
    refreshFlags();
  }
  // Keep the form in step with a corrected word
  function applyCorrectionToFields(orig, fixed) {
    const sc = state.scan,
      f = sc.fields;
    ["title", "referenceNo"].forEach((n) => {
      if (String(f[n]).includes(orig))
        f[n] = String(f[n]).split(orig).join(fixed);
    });
    if (f.referenceNo) sc.uncertain.referenceNo = refLooksOff(f.referenceNo);
    const clean = (s) => Number(String(s).replace(/[^\d.]/g, ""));
    ["amountPaid", "balanceDue"].forEach((n) => {
      if (
        Number.isFinite(clean(orig)) &&
        clean(orig) === Number(f[n]) &&
        Number.isFinite(clean(fixed))
      ) {
        f[n] = clean(fixed);
        sc.uncertain[n] = !numberInText(f[n], sc.text);
      }
    });
  }

  // ── Step 3: Save ──
  function scanStep3() {
    const sc = state.scan,
      f = sc.fields;
    const m = dueMeta(f.deadline);
    const items = sc.checklist
      .map(
        (it, i) => `
      <li class="check-row">
        <label class="sr-only" for="chk_${i}">Step ${i + 1}</label>
        <input id="chk_${i}" class="input" data-check="${i}" value="${esc(it.text)}" maxlength="200" />
        <button class="icon-btn" data-action="remove-check" data-index="${i}" type="button" aria-label="Remove step ${i + 1}"><i data-lucide="trash-2"></i></button>
      </li>`,
      )
      .join("");
    return `
      <div class="stack scan-narrow wide">
        ${dupHtml()}
        <section class="card" aria-labelledby="sumTitle">
          <p class="eyebrow">Summary</p>
          <h2 id="sumTitle" class="next-title" style="max-width:none">${esc(f.title)}</h2>
          <div class="row" style="margin-bottom:16px"><span class="badge badge-brand"><i data-lucide="${CATEGORY_ICON[f.category] || "file-text"}"></i>${esc(f.category)}</span></div>
          <dl class="summary-grid">
            <div><dt>Reference no.</dt><dd class="ref">${esc(f.referenceNo || "None")}</dd></div>
            <div><dt>Amount paid</dt><dd>${pesoTile(f.amountPaid)}</dd></div>
            <div><dt>Balance due</dt><dd>${pesoTile(f.balanceDue)}</dd></div>
            <div><dt>Deadline</dt><dd>${esc(fmtDay(f.deadline))}</dd>${m ? `<div style="margin-top:6px">${dueBadge(m)}</div>` : ""}</div>
          </dl>
          ${
            sc.fileSummary
              ? `<hr class="divider" /><h3 class="card-title" style="font-size:16px">What this document is about</h3>${fileSummaryHtml(sc.fileSummary)}`
              : f.summary
                ? `<hr class="divider" /><h3 class="card-title" style="font-size:16px">What this means</h3><p style="margin:6px 0 0;max-width:70ch">${richText(f.summary)}</p>`
                : ""
          }
        </section>

        <section class="card" aria-labelledby="todoTitle">
          <h2 id="todoTitle" class="card-title">Your to-do list</h2>
          <p class="card-sub" style="margin-bottom:16px">We found these steps. Edit them, remove any you don't need, or add your own.</p>
          ${items ? `<ul class="check-edit">${items}</ul>` : '<p class="card-sub">No steps found. Add one if you need to.</p>'}
          <div style="margin-top:12px"><button class="btn btn-ghost btn-sm" data-action="add-check" type="button"><i data-lucide="plus"></i>Add a step</button></div>
        </section>

        <div class="footer-bar">
          <button class="btn btn-ghost" data-action="scan-back" type="button"><i data-lucide="arrow-left"></i>Back</button>
          <button class="btn btn-primary btn-lg" data-action="save-scan" type="button" ${sc.saving ? "disabled" : ""}>${sc.saving ? '<span class="spinner"></span>' : '<i data-lucide="shield-check"></i>'}Save to My Documents</button>
        </div>
      </div>`;
  }

  // Saved screen: confirmation, steps added, and buttons to scan another or view the document
  function scanSaved() {
    const sc = state.scan;
    const n = sc.checklist.filter((c) => c.text.trim()).length;
    return `
      <div class="scan-narrow">
        <section class="card next-card caught-up" aria-labelledby="doneTitle">
          <p class="eyebrow"><i data-lucide="check-circle-2" style="vertical-align:-3px"></i> Saved</p>
          <h2 id="doneTitle" class="next-title">${sc.offline ? "Saved on this device." : "Saved. Your document is safe."}</h2>
          ${sc.offline ? '<p class="next-from">The server is offline right now. We\'ll sync this when the connection is back.</p>' : ""}
          <p class="next-from">${n ? `We added ${n} ${n === 1 ? "step" : "steps"} to Clearance &amp; Payments.` : `${esc(sc.savedTitle)} is now in My Documents.`}</p>
          <div class="next-actions">
            <button class="btn btn-primary btn-lg" data-action="scan-another" type="button"><i data-lucide="scan-line"></i>Scan another</button>
            <button class="link-btn" data-action="view-saved" type="button">View document</button>
          </div>
        </section>
      </div>`;
  }

  // ── Scan actions ──
  // Frees the browser memory used by the file preview; resetScan starts a fresh scan at Upload
  function clearPreview() {
    if (state.scan.previewUrl) URL.revokeObjectURL(state.scan.previewUrl);
  }
  function resetScan() {
    clearPreview();
    state.scan = freshScan();
  }

  // Upload: checks type and size, prepares the preview and the copy kept with the record, then starts reading
  function setFile(file) {
    if (!file) return;
    const type = file.type || "";
    if (!ACCEPT.includes(type)) {
      toast(
        "That file type is not supported. Please use a photo or PDF.",
        "error",
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      toast("That file is over 10 MB. Please try a smaller photo.", "error");
      return;
    }
    resetScan();
    const sc = state.scan;
    sc.file = file;
    sc.fileName = file.name;
    sc.previewType = type;
    sc.previewUrl = URL.createObjectURL(file);
    sc.attachPromise = makeAttachment(file)
      .then((a) => {
        sc.attach = a;
        return a;
      })
      .catch(() => null);
    if (state.view !== "scanner") setView("scanner"); // dropped on the Home quick-scan card
    processFile();
  }

  // Read the file, then fill in the form. Both calls happen behind one friendly loading screen.
  async function processFile() {
    const sc = state.scan;
    if (!sc.file) return;
    sc.step = 2;
    sc.processing = true;
    sc.error = "";
    sc.stage = "reading";
    renderView();
    window.scrollTo({ top: 0 });
    try {
      const fd = new FormData();
      fd.append("document", sc.file);
      const data = await api("/api/ocr/upload", { method: "POST", body: fd });
      sc.docId = data.documentId;
      const t = String(data.extractedText || "");
      sc.text = /^\(OCR completed, but no text/i.test(t) ? "" : t;
      sc.corrections = {};
      sc.words =
        Array.isArray(data.words) && data.words.length
          ? data.words
          : Array.isArray(data.wordsSample)
            ? data.wordsSample
            : [];
      sc.tokenMap = buildTokenMap(sc.text, sc.words);
    } catch (e) {
      sc.processing = false;
      sc.error = e.message;
      renderView();
      return;
    }
    sc.stage = "organizing";
    const st = $("#stageText");
    if (st) st.textContent = stageText(sc);
    await organizeText();
    sc.processing = false;
    renderView(); // the banner on the Check step is the feedback; no toast needed
  }

  // One organizer call per scan: fills the form and the file summary together (no extra Lumen credits)
  async function organizeText() {
    const sc = state.scan;
    const stem = sc.fileName.replace(/\.[^.]+$/, "");
    if (!sc.text.trim()) {
      applyStructured({ title: stem }, "");
      return;
    }
    try {
      const data = await postJson("/api/chat/organize", {
        verifiedText: sc.text,
        fileName: sc.fileName || "Student Document",
        studentId: state.studentId,
      });
      applyStructured(data.structured || {}, sc.text);
      if (!sc.fields.title) sc.fields.title = stem;
      setSummaryBase(sc);
    } catch (e) {
      applyStructured({ title: stem }, "");
      toast(
        `We could not fill in the details: ${e.message}. Please type them in.`,
        "error",
      );
    }
  }

  // Check step → Save step. Nothing is saved while a field is still marked "Please check":
  // the student fixes it or confirms it with "Looks right".
  function goToStep3() {
    const sc = state.scan;
    const flagged = FIELD_NAMES.filter(isFlagged);
    if (flagged.length) {
      const first = flagged[0];
      toast(
        first === "title"
          ? "Please add a document title first."
          : `Please check ${flagged.length} ${flagged.length === 1 ? "field" : "fields"}: fix the value, or press “Looks right”.`,
        "warn",
      );
      const w = $(`[data-wrap="${first}"]`);
      if (w) {
        w.scrollIntoView({ block: "center", behavior: "smooth" });
        const inp = $("input, select", w);
        if (inp) inp.focus({ preventScroll: true });
      }
      return;
    }
    sc.step = 4;
    renderView();
    window.scrollTo({ top: 0 });
  }

  // Save step: builds the record (fields, summary, checklist, photo) and saves it to My Documents
  async function saveScan() {
    const sc = state.scan,
      f = sc.fields;
    if (sc.saving) return;
    sc.saving = true;
    renderView();
    const stamp = Date.now();
    const record = {
      id: uid("rec"),
      studentId: state.studentId,
      documentId: sc.docId || "manual-" + stamp,
      title: String(f.title).trim(),
      category: f.category,
      referenceNo: String(f.referenceNo).trim() || "N/A",
      amountPaid: Number(f.amountPaid) || 0,
      balanceDue: Number(f.balanceDue) || 0,
      deadline: parseDay(f.deadline) ? f.deadline : "None",
      summary: sc.fileSummary ? sc.fileSummary.overview : f.summary,
      ...(sc.fileSummary ? { fileSummary: sc.fileSummary } : {}),
      studyNotes: f.studyNotes,
      rawText: sc.text.trim(),
      fileName: sc.fileName,
      verified: true,
      corrections: Object.keys(sc.corrections).length,
      createdAt: todayLabel(),
      tasks: sc.checklist
        .map((c) => c.text.trim())
        .filter(Boolean)
        .map((text, i) => ({ id: `t-${stamp}-${i}`, text, done: false })),
    };
    // Keep the original paper with the record. Stored as a file on the server; inline if the server is unreachable.
    const att = sc.attach || (sc.attachPromise ? await sc.attachPromise : null);
    if (att) {
      record.imageKind = att.kind;
      try {
        record.image = (
          await postJson("/api/images", { dataUrl: att.dataUrl })
        ).url;
      } catch (_) {
        record.image = att.dataUrl;
      }
    }
    const ok = await addRecord(record, { quiet: true });
    sc.saving = false;
    sc.saved = true;
    sc.savedId = record.id;
    sc.savedTitle = record.title;
    sc.offline = !ok;
    renderView();
    window.scrollTo({ top: 0 });
    toast(
      ok ? "Saved. Your document is safe." : OFFLINE_MSG,
      ok ? "ok" : "warn",
      { label: "View document", fn: () => viewSaved(record.id) },
    );
  }
  // Opens My Documents with this document's drawer
  function viewSaved(id) {
    setView("vault");
    openRecord(id);
  }

  // ───────── View 3: My Documents ─────────
  // Receipts = money papers. Notes = memos, clearance papers and class notes.
  const DOC_GROUP = {
    "Receipt & Tuition": "RECEIPTS",
    Scholarship: "RECEIPTS",
    "Enrollment & Clearance": "NOTES",
    "Class Note & Memo": "NOTES",
  };
  // My Documents filter chips: All, Receipts, Notes
  const DOC_FILTERS = [
    ["ALL", "All"],
    ["RECEIPTS", "Receipts"],
    ["NOTES", "Notes"],
  ];

  // My Documents search: matches title, reference, summary, type, dates, file name and amounts
  function filteredRecords() {
    const q = state.vaultQ.trim().toLowerCase();
    return state.records.filter((r) => {
      if (state.vaultCat !== "ALL" && DOC_GROUP[r.category] !== state.vaultCat)
        return false;
      if (!q) return true;
      const digits = q.replace(/[₱,\s]/g, "");
      const amounts = [
        paidTotal(r),
        Number(r.balanceDue) || 0,
        Number(r.amountPaid) || 0,
      ]
        .filter((n) => n > 0)
        .map(String);
      return (
        [
          r.title,
          r.referenceNo,
          r.summary,
          r.category,
          r.createdAt,
          fmtDay(r.deadline),
          r.fileName,
        ].some((x) =>
          String(x || "")
            .toLowerCase()
            .includes(q),
        ) ||
        (/^\d+(\.\d+)?$/.test(digits) &&
          amounts.some((a) => a.includes(digits)))
      );
    });
  }

  // Status = color + icon + word
  function docStatus(r) {
    const tasks = r.tasks || [];
    const open = tasks.filter((t) => !t.done).length;
    const owing = Number(r.balanceDue) > 0;
    const m = dueMeta(r.deadline);
    if ((owing || open) && m && m.days < 0)
      return { icon: "alert-circle", tone: "overdue", stamp: "Overdue" };
    if (owing) return { icon: "clock", tone: "due", stamp: "Balance due" };
    if (open) return { icon: "clock", tone: "due", stamp: "To do" };
    if (paidTotal(r) > 0)
      return {
        icon: "check",
        tone: "paid",
        stamp: isCredit(r) ? "Credited" : "Paid",
      };
    return tasks.length
      ? { icon: "check", tone: "paid", stamp: "Done" }
      : { icon: "check", tone: "neutral", stamp: "Saved" };
  }
  // Stamp chip: bordered, uppercase, tilted. Color + icon + word, as the UX rules require.
  const stampHtml = (st) =>
    `<span class="stamp stamp-${st.tone}"><i data-lucide="${st.icon}"></i>${esc(st.stamp)}</span>`;

  // My Documents: one receipt-style document card
  function recordCard(r) {
    const st = docStatus(r);
    const paid = paidTotal(r),
      due = Number(r.balanceDue) || 0;
    const amount =
      paid > 0
        ? `${pesoTile(paid)} <small>${isCredit(r) ? "credited" : "paid"}</small>`
        : due > 0
          ? `${pesoTile(due)} <small>to pay</small>`
          : "";
    return `
      <button class="rec-card doc-card" data-action="open-record" data-id="${esc(r.id)}" type="button">
        <div class="doc-top">
          <span class="doc-type"><i data-lucide="${CATEGORY_ICON[r.category] || "file-text"}"></i>${esc(r.category)}</span>
          ${stampHtml(st)}
        </div>
        <h3 class="rec-title">${esc(r.title)}</h3>
        <div class="doc-ref">${/^(n\/a|note)?$/i.test(r.referenceNo || "") ? "&nbsp;" : esc(r.referenceNo)}</div>
        <span class="doc-perf" aria-hidden="true"></span>
        <div class="doc-meta"><span>${esc(r.createdAt || "")}</span>${amount ? `<span class="doc-amt">${amount}</span>` : ""}</div>
      </button>`;
  }

  // My Documents: the card grid, or an empty / no-match message
  function vaultGridHtml() {
    if (!state.records.length)
      return emptyState(
        "folder-open",
        "No documents yet",
        "Scan a receipt or memo and it will appear here.",
        "Scan your first document",
        "scanner",
      );
    const list = filteredRecords();
    if (!list.length)
      return `<div class="empty"><p class="empty-title">No matches</p><p>Try a different word, or show everything again.</p><button class="btn btn-ghost" data-action="clear-search" type="button">Clear search</button></div>`;
    return `<div class="vault-grid">${list.map(recordCard).join("")}</div>`;
  }

  // My Documents page: New note / Scan buttons, search box, filters and card grid
  function viewVault() {
    const has = state.records.length > 0;
    const chips = DOC_FILTERS.map(
      ([k, label]) =>
        `<button class="chip ${state.vaultCat === k ? "active" : ""}" data-action="vault-cat" data-cat="${k}" aria-pressed="${state.vaultCat === k}" type="button">${label}</button>`,
    ).join("");
    return `
      <div class="page-head">
        <div><h1 class="page-title">My Documents</h1><p class="page-sub">All your school papers, safe in one place.</p></div>
        <div class="row">
          <button class="btn ${has ? "btn-ghost" : "btn-ghost"}" data-action="quick-note" type="button"><i data-lucide="square-pen"></i>New note</button>
          ${has ? '<button class="btn btn-primary" data-action="goto" data-view="scanner" type="button"><i data-lucide="scan-line"></i>Scan a document</button>' : ""}
        </div>
      </div>
      ${
        has
          ? `<div class="toolbar">
        <div class="search"><i data-lucide="search"></i><label class="sr-only" for="vaultSearch">Search documents</label><input id="vaultSearch" class="input" type="search" placeholder="Search by title or OR number" value="${esc(state.vaultQ)}" /></div>
        <div class="chips" id="vaultChips">${chips}</div>
      </div>`
          : ""
      }
      <div id="vaultGrid">${vaultGridHtml()}</div>`;
  }
  // My Documents: redraws only the grid while the student types a search
  function refreshVaultGrid() {
    const g = $("#vaultGrid");
    if (!g) return;
    g.innerHTML = vaultGridHtml();
    $$("#vaultChips .chip").forEach((c) => {
      const on = c.dataset.cat === state.vaultCat;
      c.classList.toggle("active", on);
      c.setAttribute("aria-pressed", String(on));
    });
    icons();
  }

  // ── Right-side drawer ──
  let drawerOpener = null;
  // Document drawer: opens the side panel for a record
  function openRecord(id) {
    if (!state.records.find((x) => x.id === id)) return;
    if (!$("#drawerPanel")) {
      drawerOpener = document.activeElement;
      $("#drawerRoot").innerHTML =
        `<div class="drawer-back" data-action="drawer-backdrop"><aside class="drawer-panel" id="drawerPanel" role="dialog" aria-modal="true" aria-labelledby="drawerTitle" tabindex="-1"></aside></div>`;
      document.body.classList.add("no-scroll");
    }
    state.drawerId = id;
    renderDrawer();
    const close = $('#drawerPanel [data-action="close-drawer"]');
    if (close) close.focus();
  }
  // Document drawer: closes it and returns focus to where the student was
  function closeDrawer() {
    if (!$("#drawerPanel")) {
      state.drawerId = null;
      return;
    }
    const lastId = state.drawerId;
    state.drawerId = null;
    $("#drawerRoot").innerHTML = "";
    document.body.classList.remove("no-scroll");
    const back =
      drawerOpener && document.contains(drawerOpener)
        ? drawerOpener
        : $(`[data-action="open-record"][data-id="${lastId}"]`);
    if (back) back.focus();
    drawerOpener = null;
  }
  // Document drawer: photo, amounts, payment history, file summary, notes, checklist and scanned text
  function renderDrawer() {
    const panel = $("#drawerPanel");
    if (!panel) return;
    const r = state.records.find((x) => x.id === state.drawerId);
    if (!r) {
      closeDrawer();
      return;
    }
    const oldBody = $(".drawer-body", panel);
    const top = oldBody ? oldBody.scrollTop : 0;
    const st = docStatus(r),
      m = dueMeta(r.deadline);
    const tasks = r.tasks || [];
    panel.innerHTML = `
      <div class="drawer-head">
        <div class="drawer-titles">
          <div class="row">${stampHtml(st)}<span class="doc-type">${esc(r.category)}</span></div>
          <h2 id="drawerTitle" class="drawer-title">${esc(r.title)}</h2>
          <div class="drawer-sub"><span class="ref">${esc(r.referenceNo)}</span> · Filed ${esc(r.createdAt || "")}</div>
        </div>
        <div class="drawer-tools">
          <div class="menu-wrap">
            <button class="icon-btn" data-action="toggle-menu" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="More actions"><i data-lucide="ellipsis-vertical"></i></button>
            <div class="menu" role="menu" hidden>
              <button role="menuitem" class="menu-item" data-action="edit-doc" type="button"><i data-lucide="pencil"></i>Edit details</button>
              ${m ? '<button role="menuitem" class="menu-item" data-action="calendar-doc" type="button"><i data-lucide="calendar-plus"></i>Add deadline to calendar</button>' : ""}
              <button role="menuitem" class="menu-item" data-action="print-doc" type="button"><i data-lucide="printer"></i>Print</button>
              <button role="menuitem" class="menu-item" data-action="download-doc" type="button"><i data-lucide="download"></i>Download</button>
              <hr class="menu-sep" />
              <button role="menuitem" class="menu-item danger" data-action="confirm-delete" data-id="${esc(r.id)}" type="button"><i data-lucide="trash-2"></i>Delete</button>
            </div>
          </div>
          <button class="icon-btn" data-action="close-drawer" type="button" aria-label="Close"><i data-lucide="x"></i></button>
        </div>
      </div>
      <div class="drawer-body">
        ${photoHtml(r)}
        <dl class="summary-grid three">
          <div><dt>${isCredit(r) ? "Amount credited" : "Amount paid"}</dt><dd>${peso(paidTotal(r))}</dd></div>
          <div><dt>Balance due</dt><dd>${peso(r.balanceDue)}</dd></div>
          <div><dt>Deadline</dt><dd>${esc(fmtDay(r.deadline))}</dd>${m ? `<div style="margin-top:6px">${dueBadge(m)}</div>` : ""}</div>
        </dl>
        ${
          paymentsOf(r).length
            ? `<h3 class="drawer-h">Payment history</h3>
          <ul class="pay-list">
            <li><span>${esc(r.createdAt || "On this receipt")}</span><span>On this receipt</span><strong>${peso(r.amountPaid)}</strong></li>
            ${paymentsOf(r)
              .map(
                (p) =>
                  `<li><span>${esc(fmtDay(p.date))}</span><span>${esc(p.note || "Payment")}</span><strong>${peso(p.amount)}</strong></li>`,
              )
              .join("")}
          </ul>`
            : ""
        }
        ${
          normalizeFileSummary(r.fileSummary)
            ? `<h3 class="drawer-h">What this document is about</h3><div class="drawer-p">${fileSummaryHtml(normalizeFileSummary(r.fileSummary))}</div>`
            : r.summary
              ? `<h3 class="drawer-h">What this means</h3><p class="drawer-p">${richText(r.summary)}</p>`
              : ""
        }
        ${(r.studyNotes || []).length ? `<h3 class="drawer-h">Key notes</h3><ul class="note-list">${r.studyNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        ${tasks.length ? `<h3 class="drawer-h">Checklist</h3>${tasks.map((t) => taskRow({ ...t, recordId: r.id, recordTitle: "", deadline: null })).join("")}` : ""}
        ${r.rawText ? `<details class="disclose"><summary>View scanned text</summary><div class="disclose-body"><div class="raw">${esc(r.rawText)}</div></div></details>` : ""}
      </div>`;
    icons();
    const nb = $(".drawer-body", panel);
    if (nb) nb.scrollTop = top;
  }
  // The original paper, kept with the record so the student can compare it with what was read
  function photoHtml(r) {
    if (!r.image) return "";
    if (r.imageKind === "pdf") {
      return `<a class="doc-file" href="${esc(r.image)}" target="_blank" rel="noopener"><i data-lucide="file-text"></i><span><strong>Original PDF</strong><small>${esc(r.fileName || "document.pdf")}</small></span><i data-lucide="external-link"></i></a>`;
    }
    return `<figure class="doc-photo"><button type="button" data-action="view-photo" data-id="${esc(r.id)}" aria-label="View the original photo larger"><img src="${esc(r.image)}" alt="Original photo of ${esc(r.title)}" loading="lazy" /></button><figcaption>Original photo · tap to enlarge</figcaption></figure>`;
  }
  // Document drawer: shows the original photo full size
  function viewPhoto(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r || !r.image) return;
    openModal(
      `
      <div class="modal-head"><h2 class="modal-title">${esc(r.title)}</h2><button class="icon-btn" data-action="close-modal" type="button" aria-label="Close"><i data-lucide="x"></i></button></div>
      <img class="photo-full" src="${esc(r.image)}" alt="Original photo of ${esc(r.title)}" />`,
      true,
    );
  }

  // Edit a saved document's details
  function editDoc() {
    closeMenus();
    const r = state.records.find((x) => x.id === state.drawerId);
    if (!r) return;
    const opts = CATEGORIES.map(
      (c) => `<option ${c === r.category ? "selected" : ""}>${esc(c)}</option>`,
    ).join("");
    const ref = /^(n\/a|note)$/i.test(r.referenceNo || "") ? "" : r.referenceNo;
    openModal(`
      <div class="modal-head"><h2 class="modal-title">Edit details</h2><button class="icon-btn" data-action="close-modal" type="button" aria-label="Close"><i data-lucide="x"></i></button></div>
      <form id="editForm" class="form-grid two" data-id="${esc(r.id)}">
        <div class="field span-2"><label for="e_title">Document title</label><input id="e_title" class="input" required maxlength="160" value="${esc(r.title)}" /></div>
        <div class="field span-2"><label for="e_category">Type</label><select id="e_category" class="select">${opts}</select></div>
        <div class="field span-2"><label for="e_ref">Reference no.</label><input id="e_ref" class="input ref-input" maxlength="60" value="${esc(ref)}" autocomplete="off" /></div>
        <div class="field"><label for="e_paid">Amount on this paper (₱)</label><input id="e_paid" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(Number(r.amountPaid) || 0)}" /></div>
        <div class="field"><label for="e_due">Balance due (₱)</label><input id="e_due" class="input" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(Number(r.balanceDue) || 0)}" /></div>
        <div class="field span-2"><label for="e_deadline">Deadline</label><input id="e_deadline" class="input" type="date" value="${esc(parseDay(r.deadline) ? r.deadline : "")}" /></div>
        <div class="modal-actions span-2"><button class="btn btn-ghost" data-action="close-modal" type="button">Cancel</button><button class="btn btn-primary" type="submit"><i data-lucide="save"></i>Save changes</button></div>
      </form>`);
  }
  // Edit details: validates and saves the changes, with Undo
  async function saveEdit(form) {
    const r = state.records.find((x) => x.id === form.dataset.id);
    if (!r) {
      closeModal();
      return;
    }
    const title = $("#e_title").value.trim();
    const paid = Number($("#e_paid").value),
      due = Number($("#e_due").value);
    if (!title) {
      toast("Please add a title first.", "warn");
      $("#e_title").focus();
      return;
    }
    if (!(paid >= 0) || !(due >= 0)) {
      toast("Amounts must be 0 or more.", "warn");
      return;
    }
    const before = JSON.stringify(r);
    Object.assign(r, {
      title,
      category: $("#e_category").value,
      referenceNo: $("#e_ref").value.trim() || "N/A",
      amountPaid: paid,
      balanceDue: due,
      deadline: parseDay($("#e_deadline").value)
        ? $("#e_deadline").value
        : "None",
      edited: true,
    });
    closeModal();
    renderView();
    const ok = await syncRecords({ quiet: true });
    toast(ok ? "Details updated." : OFFLINE_MSG, ok ? "ok" : "warn", {
      label: "Undo",
      fn: async () => {
        const i = state.records.findIndex((x) => x.id === r.id);
        if (i >= 0) state.records[i] = JSON.parse(before);
        renderView();
        await syncRecords();
      },
    });
  }

  // All-day calendar event for the document's deadline (works with Google, Apple and Outlook calendars)
  function calendarDoc() {
    closeMenus();
    const r = state.records.find((x) => x.id === state.drawerId);
    if (!r || !parseDay(r.deadline)) return;
    const d = r.deadline.replace(/-/g, "");
    const next = parseDay(r.deadline);
    next.setDate(next.getDate() + 1);
    const icsEsc = (s) =>
      String(s)
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
    const todo = (r.tasks || [])
      .filter((t) => !t.done)
      .map((t) => "- " + t.text);
    const desc = [
      Number(r.balanceDue) > 0 ? `Balance due: ${peso(r.balanceDue)}` : "",
      ...todo,
      `Reference: ${r.referenceNo}`,
    ]
      .filter(Boolean)
      .join("\n");
    const now = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+/, "");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//EasyBo Student Buddy//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${r.id}@easybo`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${localIso(next).replace(/-/g, "")}`,
      `SUMMARY:${icsEsc("Deadline: " + r.title)}`,
      `DESCRIPTION:${icsEsc(desc)}`,
      "BEGIN:VALARM",
      "TRIGGER:-P1D",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEsc("Deadline tomorrow: " + r.title)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    downloadBlob(
      new Blob([ics], { type: "text/calendar;charset=utf-8" }),
      safeName(r.title) + ".ics",
    );
    toast(
      "Calendar file downloaded. Open it to add the deadline to your calendar.",
    );
  }
  // Downloads: safe file names, and a browser download for any file content
  const safeName = (s) =>
    String(s)
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "document";
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Closes any open "More actions" menu
  const closeMenus = () =>
    $$(".menu").forEach((mn) => {
      if (!mn.hidden) {
        mn.hidden = true;
        const b = $('[data-action="toggle-menu"]', mn.parentElement);
        if (b) b.setAttribute("aria-expanded", "false");
      }
    });

  // Print: prints only the open document
  function printDoc() {
    closeMenus();
    document.body.classList.add("printing");
    window.addEventListener(
      "afterprint",
      () => document.body.classList.remove("printing"),
      { once: true },
    );
    window.print();
  }
  // Download: saves the open document as a plain-text file
  function downloadDoc() {
    closeMenus();
    const r = state.records.find((x) => x.id === state.drawerId);
    if (!r) return;
    const lines = [
      r.title,
      "=".repeat(Math.min(60, r.title.length)),
      "",
      `Type: ${r.category}`,
      `Reference no.: ${r.referenceNo}`,
      `Filed: ${r.createdAt || ""}`,
      `Amount on this paper: ${peso(r.amountPaid)}`,
      `Balance due: ${peso(r.balanceDue)}`,
      `Deadline: ${fmtDay(r.deadline)}`,
      "",
    ];
    if (paymentsOf(r).length)
      lines.push(
        "Payments made later",
        ...paymentsOf(r).map(
          (p) =>
            `- ${fmtDay(p.date)}: ${peso(p.amount)} (${p.note || "payment"})`,
        ),
        "",
      );
    const rfs = normalizeFileSummary(r.fileSummary);
    if (rfs)
      lines.push(
        "What this document is about",
        rfs.overview,
        ...rfs.keyPoints.map((p) => `- ${p}`),
        "",
      );
    else if (r.summary) lines.push("What this means", r.summary, "");
    if ((r.studyNotes || []).length)
      lines.push("Key notes", ...r.studyNotes.map((n) => `- ${n}`), "");
    if ((r.tasks || []).length)
      lines.push(
        "Checklist",
        ...r.tasks.map((t) => `[${t.done ? "x" : " "}] ${t.text}`),
        "",
      );
    if (r.rawText) lines.push("Scanned text", r.rawText);
    downloadBlob(
      new Blob(["\uFEFF" + lines.join("\r\n")], {
        type: "text/plain;charset=utf-8",
      }),
      safeName(r.title) + ".txt",
    );
    toast("Downloaded.");
  }

  // Delete: asks for confirmation first
  function confirmDelete(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    closeMenus();
    openModal(`
      <h2 class="modal-title">Delete this document?</h2>
      <p class="card-sub" style="margin-top:8px"><strong>${esc(r.title)}</strong> and its checklist will be removed from My Documents. You can undo this for a few seconds.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal" type="button">Keep it</button>
        <button class="btn btn-danger" data-action="delete-record" data-id="${esc(id)}" type="button"><i data-lucide="trash-2"></i>Delete</button>
      </div>`);
  }

  // ───────── View 4: Clearance & Payments (two tabs) ─────────
  const OFFICES = ["Cashier", "Library", "Registrar"];
  const OFFICE_ICON = {
    Cashier: "wallet",
    Library: "library",
    Registrar: "file-check",
  };
  // Clearance: which office (Cashier, Library, Registrar) a checklist item belongs to
  function officeOf(t) {
    if (OFFICES.includes(t.office)) return t.office;
    const s = String(t.text || "");
    if (/library|computer lab|\blab\b/i.test(s)) return "Library";
    if (
      /cashier|bayad|bayaran|\bpay\b|payment|balance|₱|tuition|\bfee/i.test(s)
    )
      return "Cashier";
    return "Registrar";
  }

  // Clearance & Payments page: Payments and Clearance tabs
  function viewTracker() {
    const tab = state.cpTab;
    const tabs = [
      ["payments", "Payments"],
      ["clearance", "Clearance"],
    ]
      .map(
        ([k, label]) =>
          `<button role="tab" id="tab-${k}" class="tab" aria-selected="${tab === k}" aria-controls="panel-${k}" tabindex="${tab === k ? 0 : -1}" data-action="cp-tab" data-tab="${k}" type="button">${label}</button>`,
      )
      .join("");
    return `
      <div class="page-head"><div><h1 class="page-title">Clearance &amp; Payments</h1><p class="page-sub">Your payments and requirements, all in one place.</p></div></div>
      <div class="tabs" role="tablist" aria-label="Clearance and payments">${tabs}</div>
      <div role="tabpanel" id="panel-${tab}" aria-labelledby="tab-${tab}" tabindex="0">${tab === "payments" ? paymentsPanel() : clearancePanel()}</div>`;
  }

  // Payments: one row per payment made, one row per balance still owed
  function paymentRows() {
    const rows = [];
    state.records.forEach((r) => {
      const paid = Number(r.amountPaid) || 0,
        due = Number(r.balanceDue) || 0;
      if (paid > 0)
        rows.push({
          kind: isCredit(r) ? "credit" : "paid",
          ts: Date.parse(r.createdAt) || 0,
          date: r.createdAt || "—",
          amount: paid,
          rec: r,
        });
      paymentsOf(r).forEach((p) => {
        const d = parseDay(p.date);
        rows.push({
          kind: "payment",
          ts: d ? d.getTime() : 0,
          date: d ? fmtDay(p.date) : "—",
          amount: Number(p.amount) || 0,
          rec: r,
        });
      });
      if (due > 0) {
        const d = parseDay(r.deadline);
        rows.push({
          kind: "due",
          ts: d ? d.getTime() : 0,
          date: d ? fmtDay(r.deadline) : "No date yet",
          amount: due,
          rec: r,
          meta: dueMeta(r.deadline),
        });
      }
    });
    return rows.sort((a, b) => b.ts - a.ts);
  }
  // Payments table: status badge (Paid, Credited, Overdue, Due soon, To pay)
  function paymentStatus(row) {
    if (row.kind === "paid" || row.kind === "payment")
      return '<span class="badge badge-ok"><i data-lucide="check"></i>Paid</span>';
    if (row.kind === "credit")
      return '<span class="badge badge-ok"><i data-lucide="check"></i>Credited</span>';
    const d = row.meta ? row.meta.days : null;
    if (d !== null && d < 0)
      return '<span class="badge badge-danger"><i data-lucide="alert-circle"></i>Overdue</span>';
    if (d !== null && d <= 7)
      return '<span class="badge badge-warn"><i data-lucide="clock"></i>Due soon</span>';
    return '<span class="badge badge-warn"><i data-lucide="clock"></i>To pay</span>';
  }
  // Payments tab: table of payments and balances, total paid, and a balance banner
  function paymentsPanel() {
    const rows = paymentRows();
    if (!rows.length)
      return emptyState(
        "wallet",
        "No payments recorded yet",
        "Scan a receipt to see your payments here.",
        "Scan your first document",
        "scanner",
      );
    const s = stats();
    const body = rows
      .map(
        (row) => `
      <tr>
        <td class="c-date" data-label="Date">${esc(row.date)}</td>
        <td class="c-desc"><button class="link-btn plain" data-action="open-record" data-id="${esc(row.rec.id)}" type="button">${esc(row.kind === "due" ? "Balance for " + row.rec.title : row.kind === "credit" ? "Scholarship credit: " + row.rec.title : row.kind === "payment" ? "Balance payment: " + row.rec.title : row.rec.title)}</button><div class="ref">${esc(row.rec.referenceNo)}</div></td>
        <td class="c-amt num">${peso(row.amount)}</td>
        <td class="c-status">${paymentStatus(row)}</td>
      </tr>`,
      )
      .join("");
    const note =
      s.balance > 0
        ? `<div class="banner warn" role="status"><i data-lucide="clock"></i><div><strong>You still need to pay ${peso(s.balance)}.</strong><div>${s.nextDue ? `Please pay at the Cashier by ${esc(fmtDay(s.nextDue))}. ${dueBadge(dueMeta(s.nextDue))}` : "Please pay at the Cashier."}</div></div></div>`
        : `<div class="banner ok" role="status"><i data-lucide="check-circle-2"></i><div><strong>No balance left to pay.</strong><div>You are fully paid for the papers you scanned.</div></div></div>`;
    return `
      <div class="card table-card">
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">Payments made and balances still to pay</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="num">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>${body}</tbody>
            <tfoot><tr><th scope="row" colspan="2">Total paid so far</th><td class="num">${peso(s.paid)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>
      <div style="margin-top:24px">${note}</div>
      ${rows.some((x) => x.kind === "credit") ? '<p class="card-sub" style="margin-top:16px">Scholarship credits are listed for reference. They are not counted in your total paid.</p>' : ""}`;
  }

  // Clearance tab: progress bar and requirements grouped by office, with a printable checklist
  function clearancePanel() {
    const s = stats();
    if (!s.tasks)
      return emptyState(
        "list-checks",
        "No requirements yet",
        "Scan a clearance memo and we'll build a checklist for you.",
        "Scan your first document",
        "scanner",
      );
    const left = s.tasks - s.done;
    const headline =
      left === 0
        ? `All ${s.tasks} done. Nice work!`
        : `${s.done} of ${s.tasks} done, ${left} to go`;
    const all = allTasks().map((t) => ({ ...t, office: officeOf(t) }));
    const groups = OFFICES.map((o) => ({
      office: o,
      tasks: all
        .filter((t) => t.office === o)
        .sort((a, b) => a.done - b.done || sortByDeadline(a, b)),
    })).filter((g) => g.tasks.length);
    return `
      <p class="print-only print-head">Clearance checklist · ${esc(student().name)} (${esc(student().program)}) · ${esc(todayLabel())}</p>
      <div class="card" style="margin-bottom:24px">
        <div class="clear-top">
          <p class="clear-headline">${headline}</p>
          <button class="btn btn-ghost no-print" data-action="print-clearance" type="button"><i data-lucide="printer"></i>Print checklist</button>
        </div>
        <div class="progress ${s.pct === 100 ? "ok" : ""}" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Clearance progress"><span style="width:${s.pct}%"></span></div>
      </div>
      <div class="stack">${groups
        .map((g) => {
          const d = g.tasks.filter((t) => t.done).length;
          return `<section class="card" aria-labelledby="off-${g.office}">
          <div class="group-head">
            <h2 id="off-${g.office}" class="card-title office-title"><i data-lucide="${OFFICE_ICON[g.office]}"></i>${g.office}</h2>
            <span class="card-sub">${d} of ${g.tasks.length} done</span>
          </div>
          ${g.tasks.map((t) => taskRow(t, true)).join("")}
        </section>`;
        })
        .join("")}</div>`;
  }

  // ───────── View 5: Ask EasyBo ─────────
  // Suggested questions shown before the first message and as chips afterwards
  const SUGGESTIONS = [
    ["wallet", "How much do I still owe?"],
    ["calendar-clock", "When is my next deadline?"],
    ["list-checks", "What's left for my clearance?"],
    ["receipt", "Summarize my latest receipt"],
  ];
  // Chat helpers: a short pause, and adding a message to the conversation
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let chatSeq = 0;
  const addMsg = (m) => {
    state.chat.push({ id: ++chatSeq, ...m });
  };

  // ── Local answers: balance, deadlines, clearance, latest receipt. No network, no credits. ──
  // Order matters: more specific topics are checked first.
  const INTENTS = [
    [
      "summary",
      /summar|buod|latest|pinakabago|pinaka-?bago|huling (resibo|receipt)|last receipt/i,
    ],
    [
      "ref",
      /\bor\s?(number|no\.?|#)|\bor#|reference|\bref\b|receipt number|resibo number|numero ng resibo/i,
    ],
    [
      "biggest",
      /pinakamalaki|pinaka-?malaking|pinakamahal|biggest|largest|highest/i,
    ],
    [
      "office",
      /\boffice\b|opisina|pupuntahan|saan (ko|ako|ba)|where (do|should|can) i|which office/i,
    ],
    [
      "clearance",
      /clearance|requirement|ipasa|isumite|i-?submit|\bsubmit\b|permit|kulang sa|to-?do|checklist|\bano pa\b/i,
    ],
    [
      "deadline",
      /deadline|due date|\bkailan\b|petsa|hanggang kailan|until when|\bwhen\b/i,
    ],
    [
      "paid",
      /nabayaran|binayaran|bayad na|paid so far|total paid|how much (did|have) i (paid|pay)|have i paid/i,
    ],
    [
      "balance",
      /balance|babayaran|utang|\bowe\b|magkano pa|natitira|remaining|still (need to )?pay|how much.*\b(left|still)\b/i,
    ],
  ];
  // Words in a question that point at a specific document ("lab fee", "COR", "99412")
  const STOPWORDS = new Set(
    (
      "ang ng sa ko mo ba na mga para ano anong magkano saan kailan paano lahat at pa po nga yung iyong aking akin " +
      "how much what which where when is are my the a an of for to do did have has i me can should office opisina pupuntahan " +
      "nabayaran binayaran bayad babayaran balance paid pay owe deadline number reference ref resibo receipt receipts document documents " +
      "pinakamalaki pinakamalaking biggest largest highest still left need"
    ).split(/\s+/),
  );
  // On-device answers: the meaningful words in a question
  function questionKeys(q) {
    return (q.toLowerCase().match(/[a-z0-9ñ][a-z0-9ñ-]{2,}/g) || []).filter(
      (w) => !STOPWORDS.has(w),
    );
  }
  // On-device answers: documents whose title, reference, type or summary mention those words
  function matchRecords(q, list = state.records) {
    const keys = questionKeys(q);
    if (!keys.length) return [];
    return list.filter((r) => {
      const hay =
        `${r.title} ${r.referenceNo} ${r.category} ${r.summary || ""} ${(r.fileSummary && Array.isArray(r.fileSummary.keyPoints) ? r.fileSummary.keyPoints : []).join(" ")}`.toLowerCase();
      return keys.some((k) => hay.includes(k));
    });
  }
  // Answer helpers: real reference numbers, bullet lists, source links, scan prompt, days-left text
  const realRef = (r) =>
    r.referenceNo && !/^(n\/a|note|none)$/i.test(r.referenceNo);
  const bullets = (arr) => arr.map((x) => "• " + x).join("\n");
  const srcOf = (rs) => rs.map((r) => ({ id: r.id, title: r.title }));
  const needScan = (text) => ({
    text,
    sources: [],
    action: { label: "Scan a document", view: "scanner" },
  });
  const daysLeftText = (m) =>
    !m
      ? ""
      : m.days < 0
        ? `${-m.days} day${m.days === -1 ? "" : "s"} overdue`
        : m.days === 0
          ? "due today"
          : `${m.days} day${m.days === 1 ? "" : "s"} left`;

  // Ask EasyBo on-device answers (no credits): balance, paid, deadline, clearance, reference number,
  // largest payment, office and latest receipt. Returns null for open-ended questions.
  function localAnswer(q) {
    const kind = (INTENTS.find(([, re]) => re.test(q)) || [])[0];
    if (!kind) return null; // open-ended: let the AI handle it
    const recs = state.records;
    if (kind === "office" && !recs.length)
      return needScan(
        "I don't see any documents yet. Scan a clearance memo so I can tell you which offices to visit.",
      );
    if (!recs.length)
      return needScan(
        "I don't see any documents yet. Scan a receipt or memo first, then I can answer that.",
      );
    const s = stats();

    if (kind === "ref") {
      const withRef = recs.filter(realRef);
      if (!withRef.length)
        return needScan(
          "I don't see any OR or reference numbers yet. Scan a receipt and I'll keep track of it.",
        );
      const hit = matchRecords(q, withRef);
      const list = hit.length ? hit : withRef;
      return {
        text: `${list.length === 1 ? "Here is the reference number:" : "Here are your reference numbers:"}\n${bullets(list.slice(0, 8).map((r) => `**${r.referenceNo}**: ${r.title}`))}`,
        sources: srcOf(list.slice(0, 8)),
      };
    }
    if (kind === "biggest") {
      const items = [];
      recs
        .filter((r) => !isCredit(r))
        .forEach((r) => {
          if (Number(r.amountPaid) > 0)
            items.push({
              amount: Number(r.amountPaid),
              label: r.title,
              when: r.createdAt,
              r,
            });
          paymentsOf(r).forEach((p) =>
            items.push({
              amount: Number(p.amount) || 0,
              label: `Balance payment: ${r.title}`,
              when: fmtDay(p.date),
              r,
            }),
          );
        });
      if (!items.length)
        return {
          text: "I don't see any payments in your documents yet.",
          sources: [],
        };
      const top = items.sort((a, b) => b.amount - a.amount)[0];
      return {
        text: `Your largest payment is **${peso(top.amount)}** for ${top.label}${top.when ? ` (${top.when})` : ""}.`,
        sources: srcOf([top.r]),
      };
    }
    if (kind === "office") {
      const pend = allTasks()
        .filter((t) => !t.done)
        .map((t) => ({ ...t, office: officeOf(t) }));
      if (!pend.length)
        return {
          text: s.tasks
            ? "You don't need to visit any office. All your requirements are done."
            : "I don't see any requirements yet. Scan a clearance memo so I can tell you which offices to visit.",
          sources: [],
        };
      const keys = questionKeys(q);
      const hit = keys.length
        ? pend.filter((t) => keys.some((k) => t.text.toLowerCase().includes(k)))
        : [];
      if (hit.length) {
        return {
          text: hit
            .map((t) => `For “${t.text}”, go to the **${t.office}**.`)
            .join("\n"),
          sources: srcOf(
            recs.filter((r) => hit.some((t) => t.recordId === r.id)),
          ),
        };
      }
      const byOffice = OFFICES.map((o) => ({
        o,
        n: pend.filter((t) => t.office === o).length,
      })).filter((g) => g.n);
      return {
        text: `These are the offices you need to visit:\n${bullets(byOffice.map((g) => `**${g.o}**: ${g.n} ${g.n === 1 ? "requirement" : "requirements"}`))}\n\nSee the Clearance tab for the full list.`,
        sources: srcOf(
          recs.filter((r) => (r.tasks || []).some((t) => !t.done)),
        ),
      };
    }
    if (kind === "balance") {
      const owing = recs
        .filter((r) => Number(r.balanceDue) > 0)
        .sort(sortByDeadline);
      const paidLine =
        s.paid > 0 ? `\n\nYou have paid **${peso(s.paid)}** so far.` : "";
      if (!owing.length)
        return {
          text: `You have no balance to pay.${paidLine}`,
          sources: srcOf(
            recs.filter((r) => !isCredit(r) && Number(r.amountPaid) > 0),
          ),
        };
      const total = owing.reduce((sum, r) => sum + Number(r.balanceDue), 0);
      const lines = owing.map((r) => {
        const m = dueMeta(r.deadline);
        return `${peso(r.balanceDue)} for ${r.title}${m ? `, due ${fmtDay(r.deadline)} (${daysLeftText(m)})` : ""}`;
      });
      return {
        text: `You still owe **${peso(total)}**.\n${bullets(lines)}${paidLine}`,
        sources: srcOf(owing),
      };
    }
    if (kind === "paid") {
      const paidRecs = recs.filter((r) => !isCredit(r) && paidTotal(r) > 0);
      if (!paidRecs.length)
        return {
          text: "I don't see any payments in your documents yet.",
          sources: [],
        };
      const hit = matchRecords(q, paidRecs);
      if (hit.length) {
        const sum = hit.reduce((t, r) => t + paidTotal(r), 0);
        return {
          text: `For that, you have paid **${peso(sum)}**.\n${bullets(hit.map((r) => `${peso(paidTotal(r))}: ${r.title}${realRef(r) ? ` (${r.referenceNo})` : ""}`))}`,
          sources: srcOf(hit),
        };
      }
      return {
        text: `You have paid **${peso(s.paid)}** in total.\n${bullets(paidRecs.map((r) => `${peso(paidTotal(r))}: ${r.title}`))}`,
        sources: srcOf(paidRecs),
      };
    }
    if (kind === "deadline") {
      const pending = recs
        .filter(
          (r) =>
            parseDay(r.deadline) &&
            (Number(r.balanceDue) > 0 || (r.tasks || []).some((t) => !t.done)),
        )
        .sort(sortByDeadline);
      if (!pending.length)
        return {
          text: recs.some((r) => parseDay(r.deadline))
            ? "You have no pending deadlines. Everything is done."
            : "I don't see any deadlines in your documents.",
          sources: [],
        };
      const first = pending[0];
      const rest =
        pending.length > 1
          ? `\n\nAll your deadlines:\n${bullets(pending.map((r) => `${fmtDay(r.deadline)}: ${r.title} (${daysLeftText(dueMeta(r.deadline))})`))}`
          : "";
      return {
        text: `Your nearest deadline is **${fmtDay(first.deadline)}** (${daysLeftText(dueMeta(first.deadline))}) for ${first.title}.${rest}`,
        sources: srcOf(pending),
      };
    }
    if (kind === "clearance") {
      if (!s.tasks)
        return needScan(
          "I don't see any requirements yet. Scan a clearance memo so I can list what you need.",
        );
      const pend = allTasks().filter((t) => !t.done);
      if (!pend.length)
        return {
          text: `Your clearance is complete: **${s.done} of ${s.tasks}** done. Well done!`,
          sources: srcOf(recs.filter((r) => (r.tasks || []).length)),
        };
      const byOffice = OFFICES.map((o) => ({
        o,
        items: pend.filter((t) => officeOf(t) === o),
      })).filter((g) => g.items.length);
      const ids = new Set(pend.map((t) => t.recordId));
      return {
        text:
          `You have finished **${s.done} of ${s.tasks}**. **${pend.length}** still to go:\n\n` +
          byOffice
            .map((g) => `**${g.o}**\n${bullets(g.items.map((t) => t.text))}`)
            .join("\n\n"),
        sources: srcOf(recs.filter((r) => ids.has(r.id))),
      };
    }
    // summary: newest receipt
    const r =
      recs.find((x) => x.category === "Receipt & Tuition") ||
      recs.find((x) => !isCredit(x) && Number(x.amountPaid) > 0);
    if (!r)
      return needScan(
        "I don't see any receipts yet. Scan a receipt and I'll summarize it.",
      );
    const m = dueMeta(r.deadline);
    const lines = [
      `Reference no.: ${r.referenceNo}`,
      `Paid: ${peso(paidTotal(r))}${paymentsOf(r).length ? ` (including ${paymentsOf(r).length} later payment${paymentsOf(r).length === 1 ? "" : "s"})` : ""}`,
      Number(r.balanceDue) > 0
        ? `Remaining balance: ${peso(r.balanceDue)}${m ? `, due ${fmtDay(r.deadline)}` : ""}`
        : "No remaining balance",
      `Filed on ${r.createdAt || "an unknown date"}`,
    ];
    return {
      text: `Here is your latest receipt: **${r.title}**.\n${bullets(lines)}${r.summary ? `\n\n${r.summary}` : ""}`,
      sources: srcOf([r]),
    };
  }

  // ── AI answers (open-ended questions only) ──
  function buildContext() {
    if (!state.records.length) return "";
    return (
      "SAVED DOCUMENTS (newest first):\n" +
      state.records
        .map((r) => {
          const open = (r.tasks || [])
            .filter((t) => !t.done)
            .map((t) => t.text)
            .join("; ");
          return `- [${r.category}] ${r.title} (Ref: ${r.referenceNo}, Paid: PHP ${paidTotal(r)}, Balance Due: PHP ${r.balanceDue}, Deadline: ${r.deadline}${open ? `, To do: ${open}` : ""}): ${String(r.summary || "").slice(0, 140)}`;
        })
        .join("\n")
    );
  }
  // Which saved documents does the answer actually mention?
  function aiSources(text) {
    const t = text.toLowerCase();
    return srcOf(
      state.records
        .filter(
          (r) =>
            (r.title && t.includes(r.title.toLowerCase())) ||
            (r.referenceNo &&
              !/^(n\/a|note)$/i.test(r.referenceNo) &&
              t.includes(r.referenceNo.toLowerCase())),
        )
        .slice(0, 6),
    );
  }
  // Ask EasyBo: plain-language message when the AI can't be reached
  const friendlyError = (msg) =>
    /failed to fetch|networkerror|load failed/i.test(msg || "")
      ? "I cannot reach the server. Please check your internet connection."
      : String(msg || "Something went wrong.");

  // Ask EasyBo: answers on the device when possible, otherwise asks Lumen AI Chat
  async function ask(question, retry = false) {
    question = (question || "").trim().slice(0, 500);
    if (!question || state.chatBusy) return;
    if (!retry) addMsg({ role: "user", text: question });
    state.chatBusy = true;
    refreshChat();
    try {
      const local = localAnswer(question);
      if (local) {
        await wait(550); // a short beat so it feels like a conversation
        addMsg({ role: "bot", ...local });
      } else {
        const data = await postJson("/api/chat/ask", {
          question,
          contextText: buildContext(),
          studentId: state.studentId,
        });
        const text =
          String(data.answer || "").trim() ||
          "No answer was received. Try asking in a different way.";
        addMsg({
          role: "bot",
          text,
          sources: aiSources(text),
          ai: true,
          mock: !!data.mock,
        });
      }
    } catch (e) {
      addMsg({
        role: "bot",
        kind: "error",
        q: question,
        detail: friendlyError(e.message),
      });
    } finally {
      state.chatBusy = false;
      refreshChat();
      const i = $("#chatInput");
      if (i && matchMedia("(pointer: fine)").matches) i.focus();
    }
  }
  // Ask EasyBo: "Try again" on a failed answer
  function retryAsk(id) {
    const idx = state.chat.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const q = state.chat[idx].q;
    state.chat.splice(idx, 1);
    ask(q, true);
  }

  // ── Rendering ──
  function suggestionsHtml(compact) {
    return SUGGESTIONS.map(([ic, q]) =>
      compact
        ? `<button class="chip" type="button" data-action="ask-preset" data-q="${esc(q)}">${esc(q)}</button>`
        : `<button class="prompt-btn" type="button" data-action="ask-preset" data-q="${esc(q)}"><i data-lucide="${ic}"></i><span>${esc(q)}</span></button>`,
    ).join("");
  }
  // Chat: EasyBo avatar, source links under answers, and one message bubble (msgHtml)
  const avatar = '<span class="avatar" aria-hidden="true">EB</span>';
  function sourceHtml(m) {
    if (m.sources && m.sources.length) {
      const links = m.sources
        .slice(0, 3)
        .map(
          (s) =>
            `<button class="link-btn plain src-link" data-action="open-record" data-id="${esc(s.id)}" type="button">${esc(s.title)}</button>`,
        )
        .join(", ");
      const more =
        m.sources.length > 3 ? ` and ${m.sources.length - 3} more` : "";
      return `<div class="msg-source"><i data-lucide="file-text"></i><span>From: ${links}${more}</span></div>`;
    }
    if (m.ai)
      return `<div class="msg-source"><i data-lucide="sparkles"></i><span>From: EasyBo AI, using your saved documents${m.mock ? " (sample answer)" : ""}</span></div>`;
    return "";
  }
  function msgHtml(m) {
    if (m.role === "user")
      return `<div class="msg-row user"><div class="msg user">${richText(m.text)}</div></div>`;
    if (m.kind === "error") {
      return `<div class="msg-row bot">${avatar}<div class="msg-col"><div class="msg bot error" role="alert">
        <div class="err-title"><i data-lucide="alert-circle"></i>I couldn't answer that right now.</div>
        <div>${esc(m.detail)}</div>
        <button class="btn btn-ghost btn-sm" data-action="retry-ask" data-id="${m.id}" type="button" style="margin-top:12px"><i data-lucide="refresh-cw"></i>Try again</button>
      </div></div></div>`;
    }
    const action = m.action
      ? `<div><button class="btn btn-ghost btn-sm" data-action="goto" data-view="${esc(m.action.view)}" type="button" style="margin-top:8px"><i data-lucide="scan-line"></i>${esc(m.action.label)}</button></div>`
      : "";
    return `<div class="msg-row bot">${avatar}<div class="msg-col"><div class="msg bot">${richText(m.text)}</div>${sourceHtml(m)}${action}</div></div>`;
  }
  // Chat: greeting, messages (or suggested questions) and the typing indicator
  function chatLogHtml() {
    const intro = `<div class="msg-row bot">${avatar}<div class="msg-col"><div class="msg bot">Hi ${esc(student().first)}! I'm <strong>EasyBo</strong>. Ask me about your balance, deadlines and clearance.${state.chat.length ? "" : "<br><br>Pick a question below, or type your own."}</div></div></div>`;
    const list = state.chat.length
      ? state.chat.map(msgHtml).join("")
      : `<div class="suggest-list">${suggestionsHtml(false)}</div>`;
    const typing = state.chatBusy
      ? `<div class="msg-row bot">${avatar}<div class="msg bot typing" role="status" aria-label="EasyBo is typing"><span></span><span></span><span></span></div></div>`
      : "";
    return intro + list + typing;
  }
  // Ask EasyBo page: conversation, suggestion chips and the question box
  function viewBuddy() {
    return `
      <div class="page-head chat-head"><div><h1 class="page-title">Ask EasyBo</h1><p class="page-sub">Ask a question. Answers are based on your saved documents.</p></div></div>
      <div class="chat-wrap">
        <div class="card chat-card">
          <div class="chat-log" id="chatLog" role="log" aria-live="polite" aria-label="Conversation" tabindex="0">${chatLogHtml()}</div>
          <div class="suggest-row" id="suggestRow" ${state.chat.length ? "" : "hidden"}>${suggestionsHtml(true)}</div>
          <form class="chat-input" id="chatForm">
            <label class="sr-only" for="chatInput">Your question</label>
            <input id="chatInput" class="input" autocomplete="off" maxlength="500" placeholder="Ask EasyBo a question…" />
            <button class="btn btn-primary" type="submit" aria-label="Send" ${state.chatBusy ? "disabled" : ""}><i data-lucide="send-horizontal"></i><span>Send</span></button>
          </form>
        </div>
      </div>`;
  }
  // Chat: keeps the newest message in view; refreshChat redraws only the conversation
  function scrollChat() {
    const l = $("#chatLog");
    if (l) l.scrollTop = l.scrollHeight;
  }
  function refreshChat() {
    const l = $("#chatLog");
    if (!l) return;
    l.innerHTML = chatLogHtml();
    const row = $("#suggestRow");
    if (row) row.hidden = state.chat.length === 0;
    const btn = $("#chatForm button[type=submit]");
    if (btn) btn.disabled = state.chatBusy;
    icons();
    scrollChat();
  }

  // ───────── Demo data & quick note ─────────
  // Sample records for "Load Demo Data": a receipt with a balance, a clearance memo, a scholarship and a note
  function demoRecords() {
    const t = Date.now();
    const sid = state.studentId;
    return [
      {
        id: `demo-${sid}-1`,
        studentId: sid,
        documentId: "demo-doc-1",
        title: "1st Sem Computer Lab & Misc Receipt",
        category: "Receipt & Tuition",
        referenceNo: "OR-2026-99412",
        amountPaid: 1250,
        balanceDue: 500,
        deadline: isoDay(12),
        verified: true,
        createdAt: "Nov 12, 2026",
        summary:
          "Official receipt for the ₱1,250.00 Computer Lab deposit. A ₱500.00 balance is still due before finals clearance.",
        studyNotes: [
          "OR-2026-99412 is your proof of payment.",
          "Pay the ₱500.00 balance at the Cashier before the deadline.",
        ],
        tasks: [
          {
            id: `t-${t}-1`,
            text: "Photocopy OR-2026-99412 for the Exam Permit",
            done: true,
          },
          {
            id: `t-${t}-2`,
            text: "Pay the ₱500.00 balance at the Cashier",
            done: false,
          },
        ],
      },
      {
        id: `demo-${sid}-2`,
        studentId: sid,
        documentId: "demo-doc-2",
        title: "Final Exam Permit Requirements",
        category: "Enrollment & Clearance",
        referenceNo: "REG-MEMO-114",
        amountPaid: 0,
        balanceDue: 0,
        deadline: isoDay(5),
        verified: true,
        createdAt: "Nov 10, 2026",
        summary:
          "Registrar memo: complete three requirements to get your Final Exam Permit.",
        studyNotes: ["Permit is required to enter every final exam."],
        tasks: [
          {
            id: `t-${t}-3`,
            text: "Get Library & Computer Lab clearance slip signed",
            done: false,
          },
          {
            id: `t-${t}-4`,
            text: "Updated COR with Adviser signature",
            done: false,
          },
          {
            id: `t-${t}-5`,
            text: "Submit all papers to the Registrar",
            done: false,
          },
        ],
      },
      {
        id: `demo-${sid}-3`,
        studentId: sid,
        documentId: "demo-doc-3",
        title: "Academic Excellence Scholarship Notice",
        category: "Scholarship",
        referenceNo: "SCH-2026-031",
        amountPaid: 5000,
        balanceDue: 0,
        deadline: isoDay(30),
        verified: true,
        createdAt: "Nov 3, 2026",
        summary:
          "Your scholarship was approved this semester. Submit the renewal form before the end of the month.",
        studyNotes: ["Keep your GWA at or above the required cutoff."],
        tasks: [
          {
            id: `t-${t}-6`,
            text: "Submit scholarship renewal form",
            done: false,
          },
        ],
      },
      {
        id: `demo-${sid}-4`,
        studentId: sid,
        documentId: "demo-doc-4",
        title: "Intro to Computing: Week 12 Notes",
        category: "Class Note & Memo",
        referenceNo: "NOTE-012",
        amountPaid: 0,
        balanceDue: 0,
        deadline: "None",
        verified: true,
        createdAt: "Nov 8, 2026",
        summary:
          "Review of networking basics: IP addressing, DNS and HTTP request flow.",
        studyNotes: [
          "DNS turns names into IP addresses.",
          "HTTP is stateless.",
        ],
        tasks: [],
      },
    ];
  }
  // Demo tools: "Load Demo Data" adds the sample records this student doesn't have yet
  async function loadDemo() {
    const have = new Set(state.records.map((r) => r.id));
    const fresh = demoRecords().filter((r) => !have.has(r.id));
    if (!fresh.length) {
      toast("Demo data is already loaded.", "warn");
      return;
    }
    state.records = [...fresh, ...state.records];
    await syncRecords();
    toast(`Added ${fresh.length} demo records for ${student().first}.`);
    renderView();
  }
  // My Documents: "New note" dialog (saved by the submit handler below)
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
  // Every button click goes through this one listener and is routed by its data-action
  document.addEventListener("click", async (e) => {
    if (!e.target.closest(".menu-wrap")) closeMenus();
    const el = e.target.closest("[data-action]");
    if (!el) {
      if (!e.target.closest(".popover-wrap")) closeDemo();
      return;
    }
    const a = el.dataset.action;
    switch (a) {
      // Navigation, theme and the Demo tools popover
      case "goto":
        setView(el.dataset.view);
        break;
      case "toggle-theme":
        applyTheme(
          document.documentElement.getAttribute("data-theme") === "dark"
            ? "light"
            : "dark",
        );
        break;
      case "toggle-demo": {
        const pop = $("#demoPop");
        const open = pop.hidden;
        pop.hidden = !open;
        el.setAttribute("aria-expanded", String(open));
        break;
      }
      // Home: complete the next-step task
      case "mark-paid":
        markTask(el.dataset.rec, el.dataset.task, true);
        break;
      case "mark-done":
        markTask(el.dataset.rec, el.dataset.task, false);
        break;
      // Demo tools: reset and the Mock/Live switch
      case "reset-demo":
        closeDemo();
        confirmReset();
        break;
      case "confirm-reset":
        resetDemo();
        break;
      case "toggle-mock":
        // Going Live spends Lumen credits, so it needs a second click. Going back to Mock is instant.
        if (state.mock) {
          closeDemo();
          confirmLive();
        } else setMock(true);
        break;
      case "confirm-live":
        closeModal();
        setMock(false);
        break;
      // Welcome screen, demo data and quick notes
      case "enter":
        enterApp(el.dataset.student);
        break;
      case "load-demo":
        loadDemo();
        break;
      case "quick-note":
        quickNote();
        break;
      // Checklist checkbox: payment tasks record a payment; unticking takes it back
      case "toggle-task": {
        e.stopPropagation();
        const rec = state.records.find((r) => r.id === el.dataset.rec);
        const t = rec?.tasks.find((x) => x.id === el.dataset.task);
        if (t && el.checked && isPaymentTask(t, rec)) {
          el.checked = false;
          markTask(rec.id, t.id, true);
        } else if (t) {
          t.done = el.checked;
          // Unticking a payment task takes back the payment it created
          if (!el.checked && t.paymentId) {
            const p = paymentsOf(rec).find((x) => x.id === t.paymentId);
            if (p) {
              rec.balanceDue = (Number(rec.balanceDue) || 0) + Number(p.amount);
              rec.payments = paymentsOf(rec).filter((x) => x.id !== p.id);
            }
            delete t.paymentId;
          }
          await syncRecords();
          renderView();
        }
        break;
      }
      // Document drawer and its actions (delete, photo, edit, calendar, print checklist)
      case "open-record":
        openRecord(el.dataset.id);
        break;
      case "confirm-delete":
        confirmDelete(el.dataset.id);
        break;
      case "delete-record":
        deleteRecord(el.dataset.id);
        break;
      case "view-photo":
        viewPhoto(el.dataset.id);
        break;
      case "edit-doc":
        editDoc();
        break;
      case "calendar-doc":
        calendarDoc();
        break;
      case "print-clearance":
        printClearance();
        break;
      // Check step: "Looks right" clears a field's flag
      case "confirm-field": {
        const f = el.dataset.field;
        state.scan.confirmed[f] = true;
        refreshFlags();
        const inp = $(`#f_${f}`);
        if (inp) inp.focus({ preventScroll: true });
        break;
      }
      // Upload step: sample papers
      case "try-sample": {
        el.disabled = true;
        try {
          setFile(await sampleFile(el.dataset.sample));
        } catch (_) {
          toast("Couldn't load the sample. Please try again.", "error");
          el.disabled = false;
        }
        break;
      }
      // Dialogs
      case "close-modal":
        closeModal();
        break;
      case "modal-backdrop":
        if (e.target === el) closeModal();
        break;
      // My Documents search and filters
      case "clear-search":
        state.vaultQ = "";
        state.vaultCat = "ALL";
        renderView();
        break;
      case "vault-cat":
        state.vaultCat = el.dataset.cat;
        refreshVaultGrid();
        break;
      // Drawer: close, "More actions" menu, print and download
      case "drawer-backdrop":
        if (e.target === el) closeDrawer();
        break;
      case "close-drawer":
        closeDrawer();
        break;
      case "toggle-menu": {
        const mn = $(".menu", el.parentElement);
        const open = mn.hidden;
        closeMenus();
        mn.hidden = !open;
        el.setAttribute("aria-expanded", String(open));
        break;
      }
      case "print-doc":
        printDoc();
        break;
      case "download-doc":
        downloadDoc();
        break;
      // Clearance & Payments tabs
      case "cp-tab":
        state.cpTab = el.dataset.tab;
        renderView();
        $("#tab-" + state.cpTab)?.focus();
        break;
      // Scan flow: type-it-in path, start over, retry, Summary step choices, Check and Save steps
      case "skip-upload": {
        resetScan();
        const sc = state.scan;
        sc.step = 3; // typed-in documents skip the Summary step
        applyStructured({}, "");
        sc.manual = true;
        renderView();
        break;
      }
      case "scan-reset":
        resetScan();
        renderView();
        window.scrollTo({ top: 0 });
        break;
      case "retry-process":
        processFile();
        break;
      case "summary-continue":
        if (state.scan.step !== 2 || state.scan.processing) break;
        state.scan.step = 3;
        renderView();
        window.scrollTo({ top: 0 });
        break;
      case "scan-discard": {
        // Nothing was saved yet: the file only lived in memory, so clearing the scan is enough.
        if (state.scan.step !== 2 || state.scan.processing) break;
        resetScan();
        renderView();
        window.scrollTo({ top: 0 });
        toast("The document was not saved. You can scan again any time.");
        break;
      }
      case "update-summary":
        updateSummary();
        break;
      case "scan-next":
        goToStep3();
        break;
      case "scan-back": {
        const sc = state.scan;
        sc.step = sc.step === 3 && sc.manual ? 1 : Math.max(1, sc.step - 1);
        renderView();
        window.scrollTo({ top: 0 });
        break;
      }
      // Word correction in "View scanned text"
      case "edit-word":
        openWord(Number(el.dataset.index));
        break;
      case "cancel-word":
        state.scan.editWord = null;
        refreshWords();
        break;
      // Save step: edit the to-do list, save, then scan another or view the document
      case "add-check": {
        state.scan.checklist.push({ text: "" });
        renderView();
        const last = $$("[data-check]").pop();
        if (last) last.focus();
        break;
      }
      case "remove-check":
        state.scan.checklist.splice(Number(el.dataset.index), 1);
        renderView();
        break;
      case "save-scan":
        saveScan();
        break;
      case "scan-another":
        resetScan();
        renderView();
        window.scrollTo({ top: 0 });
        break;
      case "view-saved":
        viewSaved(state.scan.savedId);
        break;
      // Ask EasyBo: suggested questions and retry
      case "ask-preset":
        ask(el.dataset.q);
        break;
      case "retry-ask":
        retryAsk(Number(el.dataset.id));
        break;
      // Tutorial: start-up prompt choices, step navigation, exit, and replay from Demo tools
      case "tour-start":
      case "tour-replay":
        startTour();
        break;
      case "tour-skip":
        closeModal();
        toast(
          "No problem. You can start the tutorial any time from Demo tools.",
        );
        break;
      case "tour-next":
        tourGo(1);
        break;
      case "tour-back":
        tourGo(-1);
        break;
      case "tour-exit":
        endTour(false);
        break;
      default:
        break;
    }
  });

  // Typing: My Documents search, Check step fields and Save step to-do items
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "vaultSearch") {
      state.vaultQ = t.value;
      refreshVaultGrid();
    } else if (t.dataset.field) {
      state.scan.fields[t.dataset.field] = t.value;
      state.scan.confirmed[t.dataset.field] = true;
      refreshFlags();
    } else if (t.dataset.check !== undefined) {
      const it = state.scan.checklist[Number(t.dataset.check)];
      if (it) it.text = t.value;
    }
  });
  // File picker, plus dropdown and date changes on the Check step
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fileInput" && t.files[0]) setFile(t.files[0]);
    else if (t.dataset.field) {
      state.scan.fields[t.dataset.field] = t.value;
      state.scan.confirmed[t.dataset.field] = true;
      refreshFlags();
    }
  });
  // Forms: word fix, chat question, Edit details and New note
  document.addEventListener("submit", (e) => {
    if (e.target.dataset && e.target.dataset.form === "word") {
      e.preventDefault();
      saveWord();
    } else if (e.target.id === "chatForm") {
      e.preventDefault();
      const i = $("#chatInput");
      const q = i.value;
      if (state.chatBusy || !q.trim()) return;
      i.value = "";
      ask(q);
    } else if (e.target.id === "editForm") {
      e.preventDefault();
      saveEdit(e.target);
    } else if (e.target.id === "noteForm") {
      e.preventDefault();
      const title = $("#noteTitle").value.trim(),
        body = $("#noteBody").value.trim();
      if (!title) return;
      const rec = {
        id: uid("note"),
        studentId: state.studentId,
        documentId: "note-" + Date.now(),
        title,
        category: "Class Note & Memo",
        referenceNo: "NOTE",
        amountPaid: 0,
        balanceDue: 0,
        deadline: "None",
        summary: body,
        studyNotes: [],
        tasks: [],
        verified: true,
        createdAt: todayLabel(),
      };
      closeModal();
      addRecord(rec, { quiet: true }).then((ok) => {
        toast(ok ? "Your note is saved." : OFFLINE_MSG, ok ? "ok" : "warn");
        renderView();
      });
    }
  });
  // Drag & drop upload
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); // required for drop to fire; stops the browser opening the file
    const z = e.target.closest("#dropzone");
    if (z) z.classList.add("over");
  });
  document.addEventListener("dragleave", (e) => {
    const z = e.target.closest("#dropzone");
    if (z) z.classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    const z = e.target.closest("#dropzone");
    if (z) {
      e.preventDefault();
      z.classList.remove("over");
      setFile(e.dataTransfer.files[0]);
    } else if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); // stop browser opening dropped files
  });
  // Keyboard: tutorial keys, Escape closes the top layer, Tab stays inside the drawer, arrows switch tabs
  document.addEventListener("keydown", (e) => {
    // Tutorial open: Escape exits it, Tab stays inside the step card, other shortcuts wait
    if (tour) {
      if (e.key === "Escape") {
        e.preventDefault();
        endTour(false);
      } else if (e.key === "Tab") {
        const f = $$("#tourCard button");
        const first = f[0],
          last = f[f.length - 1];
        if (!$("#tourCard").contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (e.key === "Escape") {
      if ($("#modalRoot .modal")) closeModal();
      else if ($$(".menu").some((mn) => !mn.hidden)) closeMenus();
      else if ($("#drawerPanel")) closeDrawer();
      else closeDemo();
    }
    if (e.key === "Tab" && $("#drawerPanel") && !$("#modalRoot .modal")) {
      const f = $$(
        "#drawerPanel button:not([disabled]), #drawerPanel input, #drawerPanel summary, #drawerPanel [href]",
      ).filter((x) => x.offsetParent !== null);
      if (f.length) {
        const first = f[0],
          last = f[f.length - 1];
        if (!$("#drawerPanel").contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      e.target.getAttribute &&
      e.target.getAttribute("role") === "tab"
    ) {
      state.cpTab = state.cpTab === "payments" ? "clearance" : "payments";
      renderView();
      $("#tab-" + state.cpTab)?.focus();
    }
  });
  // Demo tools: switches the server between Mock Mode and Live mode
  async function setMock(on) {
    try {
      const d = await postJson("/api/config/mock", { mockMode: on });
      state.mock = d.mockMode;
      renderApiMode();
      if (state.view === "scanner" && state.scan.step === 1) renderView();
      toast(
        state.mock
          ? "Mock Mode on. No credits will be used."
          : "Live mode on. Scans and AI questions now use Lumen credits.",
        state.mock ? "ok" : "warn",
      );
    } catch (err) {
      toast(err.message, "error");
    }
  }
  // Demo tools: confirmation before Live mode, which uses Lumen credits
  function confirmLive() {
    openModal(`
      <h2 class="modal-title">Switch to Live mode?</h2>
      <p class="card-sub" style="margin-top:8px">Every scan and every AI question will call Lumen and use your credits. Questions about balance, deadlines and clearance are still answered on this device for free.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="close-modal" type="button">Stay in Mock Mode</button>
        <button class="btn btn-primary" data-action="confirm-live" type="button"><i data-lucide="zap"></i>Use Live mode</button>
      </div>`);
  }

  // Delete with Undo. The stored photo is removed only after the Undo window has passed.
  async function deleteRecord(id) {
    const idx = state.records.findIndex((r) => r.id === id);
    if (idx < 0) {
      closeModal();
      return;
    }
    const removed = state.records[idx];
    const owner = state.studentId;
    let undone = false;
    state.records.splice(idx, 1);
    closeModal();
    closeDrawer();
    renderView();
    const ok = await syncRecords({ quiet: true });
    toast(ok ? "Document deleted." : OFFLINE_MSG, ok ? "ok" : "warn", {
      label: "Undo",
      fn: async () => {
        if (state.studentId !== owner) {
          toast("Switch back to that profile to undo.", "warn");
          return;
        }
        undone = true;
        state.records.splice(Math.min(idx, state.records.length), 0, removed);
        renderView();
        await syncRecords();
        toast("Document restored.");
      },
    });
    setTimeout(() => {
      if (undone || !/^\/uploads\//.test(removed.image || "")) return;
      fetch(
        "/api/images/" + encodeURIComponent(removed.image.split("/").pop()),
        { method: "DELETE" },
      ).catch(() => {});
    }, 9500);
  }

  // Printable "bring this to the office" checklist
  function printClearance() {
    document.body.classList.add("printing-clear");
    window.addEventListener(
      "afterprint",
      () => document.body.classList.remove("printing-clear"),
      { once: true },
    );
    window.print();
  }

  // Demo tools: closes the popover
  function closeDemo() {
    const p = $("#demoPop");
    if (p && !p.hidden) {
      p.hidden = true;
      $("#demoBtn").setAttribute("aria-expanded", "false");
    }
  }

  // Demo tools: "Reset Demo" confirmation; resetDemo clears this student's data with Undo
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
    state.records = [];
    state.chat = [];
    resetScan();
    closeModal();
    renderView();
    await syncRecords();
    toast("Demo reset.", "ok", {
      label: "Undo",
      fn: async () => {
        state.records = JSON.parse(snapshot);
        renderView();
        await syncRecords();
      },
    });
  }

  // Profile switcher: loads the other student's records and clears the scan and chat
  async function switchStudent(id, silent = false) {
    state.studentId = id;
    localStorage.setItem("easybo.student", id);
    $("#studentSelect").value = id;
    state.chat = [];
    resetScan();
    closeDrawer();
    $("#viewRoot").innerHTML =
      `<div class="skel-stack" aria-busy="true"><div class="skeleton" style="height:28px;width:40%"></div><div class="skeleton" style="height:140px"></div><div class="skeleton" style="height:90px"></div></div>`;
    await loadRecords();
    if (!silent) toast(`Switched to ${student().name}.`);
    renderView(true);
  }
  $("#studentSelect").addEventListener("change", (e) =>
    switchStudent(e.target.value),
  );

  // Welcome screen: demo profiles, no password. Shown once per browser session.
  async function enterApp(id) {
    sessionStorage.setItem("easybo.in", "1");
    document.documentElement.classList.remove("welcoming");
    if (id && id !== state.studentId) await switchStudent(id, true);
    setView("dashboard");
    window.scrollTo({ top: 0 });
    $("#viewRoot").focus({ preventScroll: true });
    offerTour(); // first visit on this browser: ask whether to take the tutorial
  }
  // Remember which "View scanned text" style sections are open across re-renders (toggle doesn't bubble)
  document.addEventListener(
    "toggle",
    (e) => {
      const d = e.target;
      if (d.dataset && d.dataset.detail) state.scan[d.dataset.detail] = d.open;
    },
    true,
  );
  // Browser back/forward and hash links switch pages
  window.addEventListener("hashchange", () =>
    setView(location.hash.slice(1), { push: false }),
  );

  // ───────── Tutorial (guided tour of the main areas) ─────────
  // Offered once per browser right after the student picks a profile. The student can start it
  // or skip it, exit at any step, and replay it later from Demo tools.
  const TOUR_KEY = "easybo.tour";
  // Each step highlights one part of the app. `view` opens that page behind the highlight;
  // `target` is a page name (sidebar or tab bar link) or a CSS selector starting with "#".
  const TOUR_STEPS = [
    {
      view: "dashboard",
      target: "dashboard",
      title: "Home",
      text: "Your starting point. It shows the most urgent next step, what you have paid, what you still owe and your clearance progress.",
    },
    {
      view: "scanner",
      target: "scanner",
      title: "Scan a document",
      text: "Upload a photo or PDF of a receipt or memo. EasyBo shows a summary first, then you choose whether to save it.",
    },
    {
      view: "vault",
      target: "vault",
      title: "My Documents",
      text: "Every document you save, searchable. Open one to see the original photo, edit the details, print or download it.",
    },
    {
      view: "tracker",
      target: "tracker",
      title: "Clearance & Payments",
      text: "Your payment history and the requirements you still need to finish, grouped by office.",
    },
    {
      view: "buddy",
      target: "buddy",
      title: "Ask EasyBo",
      text: "Ask about your balance, deadlines or clearance. Answers come from your saved documents.",
    },
    {
      view: null,
      target: "#demoBtn",
      title: "Demo tools",
      text: "For presenters: load sample data, reset the demo, switch between Mock and Live mode, or replay this tutorial.",
    },
  ];
  let tour = null; // { i: current step index } while the tutorial is open

  // Tutorial memory: whether it was already offered on this browser. Storage errors never block the app.
  function tourSeen() {
    try {
      return !!localStorage.getItem(TOUR_KEY);
    } catch (_) {
      return true;
    }
  }
  function markTourSeen() {
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch (_) {
      /* storage unavailable: the offer may show again next visit */
    }
  }

  // Start-up prompt: the student chooses to take the tutorial or skip it.
  function offerTour() {
    if (tourSeen() || tour || $("#modalRoot .modal")) return;
    markTourSeen();
    openModal(`
      <p class="eyebrow"><i data-lucide="compass" style="vertical-align:-3px"></i> Quick tour</p>
      <h2 class="modal-title">Welcome to EasyBo, ${esc(student().first)}</h2>
      <p class="card-sub" style="margin-top:8px">Would you like a short tour? It shows the main areas of the app and takes less than a minute.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="tour-skip" type="button">Skip for now</button>
        <button class="btn btn-primary" data-action="tour-start" type="button" autofocus><i data-lucide="play"></i>Start tour</button>
      </div>`);
  }

  // Opens the tutorial at the first step (closes any dialog, drawer or popover first).
  function startTour() {
    closeModal();
    closeDemo();
    closeDrawer();
    markTourSeen();
    tour = { i: 0 };
    renderTour();
  }

  // Finds the visible element to highlight: the sidebar link on wide screens, the tab bar on phones.
  function tourTarget(step) {
    const list = step.target.startsWith("#")
      ? [$(step.target)]
      : $$(
          `.nav-item[data-view="${step.target}"], .tab-item[data-view="${step.target}"]`,
        );
    return list.find((el) => el && el.offsetParent !== null) || null;
  }

  // Draws the current step: a backdrop that blocks the page, a spotlight on the target and the step card.
  function renderTour() {
    if (!tour) return;
    const step = TOUR_STEPS[tour.i];
    if (step.view && state.view !== step.view) setView(step.view);
    const last = tour.i === TOUR_STEPS.length - 1;
    $("#tourRoot").innerHTML = `
      <div class="tour-back"></div>
      <div class="tour-spot" id="tourSpot" aria-hidden="true"></div>
      <section class="tour-card" id="tourCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText">
        <p class="eyebrow">Step ${tour.i + 1} of ${TOUR_STEPS.length}</p>
        <h2 id="tourTitle" class="card-title">${esc(step.title)}</h2>
        <p id="tourText" class="tour-text">${esc(step.text)}</p>
        <div class="tour-actions">
          <button class="link-btn" data-action="tour-exit" type="button">Exit tutorial</button>
          <span class="tour-nav">
            ${tour.i > 0 ? '<button class="btn btn-ghost" data-action="tour-back" type="button">Back</button>' : ""}
            <button class="btn btn-primary" id="tourNext" data-action="tour-next" type="button">${last ? "Finish" : "Next"}</button>
          </span>
        </div>
      </section>`;
    icons();
    positionTour();
    $("#tourNext").focus();
  }

  // Places the spotlight over the target and the card beside it, always inside the screen.
  function positionTour() {
    if (!tour) return;
    const spot = $("#tourSpot"),
      card = $("#tourCard");
    if (!spot || !card) return;
    const el = tourTarget(TOUR_STEPS[tour.i]);
    const gap = 16,
      vw = window.innerWidth,
      vh = window.innerHeight;
    const cw = card.offsetWidth,
      ch = card.offsetHeight;
    const clamp = (v, max) => Math.max(gap, Math.min(v, max - gap));
    if (!el) {
      // Nothing to point at: dim the whole screen and center the card
      spot.classList.add("tour-spot-none");
      card.style.left = `${clamp((vw - cw) / 2, vw - cw)}px`;
      card.style.top = `${clamp((vh - ch) / 2, vh - ch)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    spot.classList.remove("tour-spot-none");
    Object.assign(spot.style, {
      left: `${r.left - 6}px`,
      top: `${r.top - 6}px`,
      width: `${r.width + 12}px`,
      height: `${r.height + 12}px`,
    });
    let left, top;
    if (r.right + gap + cw <= vw - gap) {
      // Room on the right (sidebar links)
      left = r.right + gap;
      top = r.top + r.height / 2 - ch / 2;
    } else if (r.top - gap - ch >= gap) {
      // Room above (phone tab bar)
      top = r.top - gap - ch;
      left = r.left + r.width / 2 - cw / 2;
    } else {
      // Otherwise below (Demo tools button in the top bar)
      top = r.bottom + gap;
      left = r.left + r.width / 2 - cw / 2;
    }
    card.style.left = `${clamp(left, vw - cw)}px`;
    card.style.top = `${clamp(top, vh - ch)}px`;
  }

  // Next / Back buttons. "Finish" on the last step closes the tutorial.
  function tourGo(delta) {
    if (!tour) return;
    const i = tour.i + delta;
    if (i >= TOUR_STEPS.length) {
      endTour(true);
      return;
    }
    tour.i = Math.max(0, i);
    renderTour();
  }

  // Exit tutorial (button, Escape or Finish): removes the overlay and returns the student to Home.
  function endTour(finished) {
    if (!tour) return;
    tour = null;
    $("#tourRoot").innerHTML = "";
    setView("dashboard");
    $("#viewRoot").focus({ preventScroll: true });
    toast(
      finished
        ? "Tutorial complete. You can replay it any time from Demo tools."
        : "Tutorial closed. You can replay it any time from Demo tools.",
    );
  }
  // Keep the spotlight on its target when the window is resized or the phone is rotated
  window.addEventListener("resize", positionTour);

  // ───────── Boot ─────────
  // Startup: theme, profiles, server mode, records, first page, then the tutorial offer
  async function init() {
    applyTheme(document.documentElement.getAttribute("data-theme") || "light");
    renderStudentSelect();
    $("#viewRoot").innerHTML =
      `<div class="skel-stack" aria-busy="true"><div class="skeleton" style="height:28px;width:40%"></div><div class="skeleton" style="height:110px"></div></div>`;
    try {
      const cfg = await api("/api/config");
      state.mock = !!cfg.mockMode;
      state.hasKeys = !!cfg.hasKeys;
    } catch (_) {
      toast("Cannot reach the server. Please try again.", "error");
    }
    renderApiMode();
    if (!state.hasKeys && !state.mock)
      toast(
        "Live mode is not set up yet. Turn on Mock Mode in Demo tools to try the app.",
        "warn",
      );
    await loadRecords();
    setView(location.hash.slice(1) || "dashboard", { push: false });
    if (document.documentElement.classList.contains("welcoming")) {
      const first = $(".profile-btn");
      if (first) first.focus({ preventScroll: true });
    } else offerTour(); // already signed in this session: offer the tutorial if not seen yet
  }
  init();
})();
