require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

// Express app. Uploaded files stay in memory only (never written to disk here) and are capped at 10 MB.
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MiB max per Lumen OCR spec
});

// Middleware: CORS, JSON bodies up to 5 MB (photo copies), and the frontend files in /public
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Configuration from .env: port, Lumen keys (server-side only), API base URLs and Mock Mode
const PORT = process.env.PORT || 3000;
const LUMEN_API_KEY = process.env.LUMEN_API_KEY;
const LUMEN_API_SECRET = process.env.LUMEN_API_SECRET;
const LUMEN_OCR_BASE =
  process.env.LUMEN_OCR_BASE ||
  "https://api.staging.nonlive.lumen.bayanichain.tech/ocr";
const LUMEN_CHAT_BASE =
  process.env.LUMEN_CHAT_BASE ||
  "https://api.staging.nonlive.lumen.bayanichain.tech/ai_chat";
let MOCK_MODE = (process.env.MOCK_MODE || "false").toLowerCase() === "true";

// Cache AI Chat InstanceID and SessionID in memory to save API credits!
let cachedInstanceId = null;
let cachedSessionId = null;

// Auth headers for every Lumen request. The keys never leave the server.
function getLumenHeaders(extra = {}) {
  return {
    "lumen-api-key": LUMEN_API_KEY,
    "lumen-api-secret": LUMEN_API_SECRET,
    ...extra,
  };
}

// Pause helper: OCR polling and realistic Mock Mode delays
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extract readable text from Lumen OCR Page object regardless of shape
function extractTextFromPagePayload(pageData) {
  const root = pageData?.data || pageData;
  if (!root) return "";

  // Check if Lines array exists
  const lines = root.Lines || root.lines;
  if (Array.isArray(lines) && lines.length > 0) {
    return lines
      .map(
        (l) =>
          l.Text ||
          l.text ||
          (l.Words || l.words || []).map((w) => w.Text || w.text).join(" "),
      )
      .join("\n");
  }

  // Check if Words array exists
  const words = root.Words || root.words;
  if (Array.isArray(words) && words.length > 0) {
    return words.map((w) => w.Text || w.text || "").join(" ");
  }

  // Check if Pages array exists
  const pages =
    root.Pages ||
    root.pages ||
    root.Items ||
    root.items ||
    (Array.isArray(root) ? root : null);
  if (Array.isArray(pages)) {
    return pages
      .map((p, idx) => {
        const pText = extractTextFromPagePayload(p);
        return pText ? `--- Page ${p.PageNumber || idx + 1} ---\n${pText}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  if (typeof root.Text === "string") return root.Text;
  if (typeof root.text === "string") return root.text;
  return JSON.stringify(root, null, 2);
}

// Every word Lumen returned, with its page and position, so a student's fix is sent for the right word.
function collectWords(payload, cap = 4000) {
  const out = [];
  const root = payload?.data || payload;
  const pages = Array.isArray(root)
    ? root
    : root?.Pages || root?.pages || root?.Items || root?.items || [root];
  (Array.isArray(pages) ? pages : [pages]).forEach((p, pi) => {
    if (!p || out.length >= cap) return;
    const pageNumber = Number(p.PageNumber || p.pageNumber || pi + 1);
    let words = p.Words || p.words;
    if (!Array.isArray(words)) {
      const lines = p.Lines || p.lines || [];
      words = Array.isArray(lines)
        ? lines.flatMap((l) => l.Words || l.words || [])
        : [];
    }
    words.forEach((w, wi) => {
      if (out.length >= cap) return;
      const idx = w.WordIndex ?? w.wordIndex ?? w.Index ?? w.index ?? wi;
      out.push({
        pageNumber,
        wordIndex: Number(idx),
        text: String(w.Text || w.text || ""),
      });
    });
  });
  return out;
}

// ─── MOCK MODE HELPERS (zero Lumen credits) ──────────────────────
// Mock OCR returns a realistic school paper chosen by file name. The receipt
// deliberately contains one classic scanner misread ("2O26" with a letter O)
// so the "Please check" flow can be demonstrated without live credits.
function mockOcrText(fileName = "") {
  const header = `SAMPLE STATE UNIVERSITY\n`;
  if (/memo|clearance|permit|notice-of-exam/i.test(fileName)) {
    return (
      header +
      `OFFICE OF THE UNIVERSITY REGISTRAR\n` +
      `MEMORANDUM\n` +
      `Memo No.: REG-MEMO-114 | Date: November 10, 2026\n` +
      `SUBJECT: FINAL EXAM PERMIT AND CLEARANCE REQUIREMENTS\n` +
      `To: All 1st Semester Students\n\n` +
      `Please complete the following before exam week:\n` +
      `1. Signed Library & Computer Lab Clearance Slip\n` +
      `2. Updated Certificate of Registration (COR) with Adviser Signature\n` +
      `3. Submit all papers to the Registrar's Office\n\n` +
      `Deadline: November 20, 2026`
    );
  }
  if (/scholar|grant|award/i.test(fileName)) {
    return (
      header +
      `OFFICE OF STUDENT AFFAIRS AND SCHOLARSHIPS\n` +
      `NOTICE OF SCHOLARSHIP AWARD\n` +
      `Reference: SCH-2026-031 | Date: November 3, 2026\n` +
      `SUBJECT: ACADEMIC EXCELLENCE SCHOLARSHIP, 1ST SEMESTER\n` +
      `Scholarship Amount Credited: PHP 5,000.00\n\n` +
      `To keep your scholarship:\n` +
      `1. Submit the scholarship renewal form\n` +
      `2. Maintain the required General Weighted Average (GWA)\n\n` +
      `Deadline: November 30, 2026`
    );
  }
  return (
    header +
    `OFFICE OF THE UNIVERSITY REGISTRAR & CASHIER\n` +
    `OFFICIAL RECEIPT\n` +
    `Document Ref: OR-2O26-99412 | Date: November 12, 2026\n` +
    `Particulars: Computer Lab & miscellaneous deposit\n` +
    `Amount Paid: PHP 1,250.00\n` +
    `Remaining Balance Due: PHP 500.00\n` +
    `Submission Deadline: November 24, 2026\n\n` +
    `REQUIREMENTS FOR FINAL EXAM PERMIT:\n` +
    `1. Signed Library & Computer Lab Clearance Slip\n` +
    `2. Official Receipt (OR-2026-99412) photocopy\n` +
    `3. Updated Certificate of Registration (COR) with Adviser Signature`
  );
}

// Mock Mode helpers: read dates written as "November 24, 2026", format money, dates and titles
const MOCK_MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
function mockToIso(str) {
  const m = String(str || "").match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  const month = m && MOCK_MONTHS[m[1].toLowerCase()];
  return month
    ? `${m[3]}-${String(month).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`
    : null;
}
const mockPeso = (n) =>
  "₱" +
  Number(n).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const mockNiceDate = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
const mockTitleCase = (s) =>
  s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bPlp\b/, "PLP");

// Reads the (possibly user-corrected) text and builds the same shape as the live AI response.
function mockOrganize(text, fileName = "") {
  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const num = (s) => (s ? Number(s.replace(/,/g, "")) : 0);
  const amountPaid = num(
    grab(
      /Amount\s+(?:Paid|Credited)[^:\n]*:\s*(?:PHP|₱)?\s*([\d,]+(?:\.\d+)?)/i,
    ),
  );
  const balanceDue = num(
    grab(/Balance[^:\n]*:\s*(?:PHP|₱)?\s*([\d,]+(?:\.\d+)?)/i),
  );
  const referenceNo =
    grab(
      /(?:Document Ref|Memo No\.?|Reference(?: No\.?)?|Ref\.?)\s*:\s*([A-Z0-9][A-Z0-9-]{3,})/i,
    ) || "N/A";
  const date =
    mockToIso(grab(/Date:\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i)) ||
    new Date().toISOString().slice(0, 10);
  const deadline =
    mockToIso(grab(/Deadline:\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i)) ||
    "None";
  const subject = grab(/SUBJECT:\s*(.+)/i);
  const particulars = grab(/Particulars:\s*(.+)/i);
  const lower = text.toLowerCase();

  let category = "Class Note & Memo";
  if (/scholar/.test(lower)) category = "Scholarship";
  else if (/official receipt|amount paid|balance/.test(lower))
    category = "Receipt & Tuition";
  else if (/clearance|permit|enrol/.test(lower))
    category = "Enrollment & Clearance";

  let title;
  if (category === "Receipt & Tuition" && particulars)
    title = mockTitleCase(particulars) + " Receipt";
  else if (subject) title = mockTitleCase(subject);
  else title = String(fileName || "Student Document").replace(/\.[^.]+$/, "");

  const steps = [...text.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) =>
    m[1].trim(),
  );
  const when = deadline !== "None" ? mockNiceDate(deadline) : null;
  const checklist = [];
  if (balanceDue > 0)
    checklist.push(
      `Pay the ${mockPeso(balanceDue)} balance at the Cashier${when ? ` by ${when}` : ""}`,
    );
  checklist.push(...steps);

  // Plain-English explanation of the paper (also used as the file summary overview)
  let summary;
  if (category === "Receipt & Tuition") {
    summary =
      `This is an official receipt${referenceNo !== "N/A" ? ` (${referenceNo})` : ""} for a payment of ${mockPeso(amountPaid)}${particulars ? ` for the ${particulars}` : ""}. ` +
      (balanceDue > 0
        ? `You still owe ${mockPeso(balanceDue)}${when ? `, due ${when}` : ""}.`
        : "It is fully paid.");
  } else if (category === "Scholarship") {
    summary = `Your scholarship was approved${amountPaid ? ` and ${mockPeso(amountPaid)} was credited to your account` : ""}. ${when ? `Complete the listed steps by ${when} to keep it.` : "Follow the listed steps to keep it."}`;
  } else {
    summary = `${subject ? mockTitleCase(subject) + ": " : ""}You need to complete ${steps.length} item${steps.length === 1 ? "" : "s"}${when ? ` by ${when}` : ""}. See the checklist for details.`;
  }

  const studyNotes = [];
  if (referenceNo !== "N/A")
    studyNotes.push(
      `Reference no. ${referenceNo}, dated ${mockNiceDate(date)}.`,
    );
  if (amountPaid > 0)
    studyNotes.push(`Amount on this paper: ${mockPeso(amountPaid)}.`);
  if (balanceDue > 0)
    studyNotes.push(
      `Remaining balance: ${mockPeso(balanceDue)}${when ? `, due ${when}` : ""}.`,
    );
  if (steps.length)
    studyNotes.push(
      `${steps.length} requirement${steps.length === 1 ? "" : "s"} listed on this paper.`,
    );

  const structured = {
    title,
    category,
    referenceNo,
    date,
    amountPaid,
    balanceDue,
    deadline,
    summary,
    studyNotes,
    checklist,
  };
  structured.fileSummary = buildFileSummary(structured, text);
  return structured;
}

// ─── FILE SUMMARY ("What this document is about") ────────────────
// One plain-English overview (1-3 sentences) plus 2-5 key points. Built from the
// organized fields so Mock Mode and the Live fallback need no extra Lumen call.
// Text helpers: collapse whitespace, keep the first sentences, check YYYY-MM-DD dates, format office names.
const cleanStr = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
const firstSentences = (s, n = 3) => {
  // A sentence ends at . ! ? followed by a space, so "₱1,250.00" stays whole.
  const parts = cleanStr(s)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return parts.slice(0, n).join(" ").trim();
};
const isIsoDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const officeName = (s) =>
  cleanStr(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Of|The|And|For)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
// Plain-English label for each document type (first key point of the summary)
const DOC_TYPE_LABEL = {
  "Receipt & Tuition": "Receipt or school fee",
  "Enrollment & Clearance": "Enrollment or clearance memo",
  Scholarship: "Scholarship notice",
  "Class Note & Memo": "School memo or note",
};

// Builds the file summary from the organized fields and the scanned text (finds the issuing office line)
function buildFileSummary(s = {}, text = "") {
  const paid = Number(s.amountPaid) || 0;
  const due = Number(s.balanceDue) || 0;
  const scholarship = s.category === "Scholarship";
  const tasks = (Array.isArray(s.checklist) ? s.checklist : [])
    .map(cleanStr)
    .filter(Boolean);
  const officeLine = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(
      (l) =>
        /^OFFICE OF\b/i.test(l) ||
        /\b(REGISTRAR|CASHIER|ACCOUNTING|LIBRARY|STUDENT AFFAIRS)\b/.test(l),
    );

  // Key points in a fixed order: type, issuing office, amounts, deadline (or paper date), next action
  const points = [
    `Document type: ${DOC_TYPE_LABEL[s.category] || "School document"}`,
  ];
  if (officeLine) points.push(`Issued by: ${officeName(officeLine)}`);
  const money = [];
  if (paid > 0)
    money.push(`${scholarship ? "Credited" : "Paid"}: ${mockPeso(paid)}`);
  if (due > 0) money.push(`Balance due: ${mockPeso(due)}`);
  if (money.length) points.push(money.join(" · "));
  if (isIsoDay(s.deadline))
    points.push(`Deadline: ${mockNiceDate(s.deadline)}`);
  else if (isIsoDay(s.date))
    points.push(`Document date: ${mockNiceDate(s.date)}`);
  if (tasks.length)
    points.push(
      `Next action: ${tasks[0]}${tasks.length > 1 ? ` (plus ${tasks.length - 1} more)` : ""}`,
    );
  else if (due <= 0) points.push("No action needed.");

  // Overview: the organizer's explanation, or a one-line fallback built from the type and title
  const overview =
    firstSentences(s.summary || s.taglishSummary) ||
    `This is a ${(DOC_TYPE_LABEL[s.category] || "School document").toLowerCase()}${s.title ? `: ${cleanStr(s.title)}` : ""}.`;
  return { overview, keyPoints: points.slice(0, 5) };
}

// Accept the AI's fileSummary only if it has an overview and at least 2 key points.
function normalizeFileSummary(fs) {
  if (!fs || typeof fs !== "object") return null;
  const overview = firstSentences(fs.overview);
  const keyPoints = (Array.isArray(fs.keyPoints) ? fs.keyPoints : [])
    .map(cleanStr)
    .filter(Boolean)
    .slice(0, 5);
  return overview && keyPoints.length >= 2 ? { overview, keyPoints } : null;
}

// ─── STATUS & MOCK MODE TOGGLE ───────────────────────────────────
// GET /api/config: whether Mock Mode is on and whether Lumen keys are set (never the keys themselves)
app.get("/api/config", (req, res) => {
  res.json({
    mockMode: MOCK_MODE,
    hasKeys: Boolean(LUMEN_API_KEY && LUMEN_API_SECRET),
    cachedInstanceId,
    cachedSessionId,
  });
});

// POST /api/config/mock: the Demo tools switch between Mock Mode and Live mode
app.post("/api/config/mock", (req, res) => {
  MOCK_MODE = Boolean(req.body.mockMode);
  res.json({ mockMode: MOCK_MODE });
});

// ─── 1. LUMEN OCR: UPLOAD + POLL + READ PAGES ────────────────────
// POST /api/ocr/upload: send the file to Lumen OCR, wait until it is read, return text and word positions.
// In Mock Mode it returns a sample paper chosen by file name instead.
app.post("/api/ocr/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: "No file uploaded." } });
    }

    if (MOCK_MODE) {
      await sleep(1600); // feel like real processing so the loading state is visible
      return res.json({
        mock: true,
        documentId: "mock-doc-" + Date.now(),
        fileName: req.file.originalname,
        status: "READY",
        pageCount: 1,
        extractedText: mockOcrText(req.file.originalname),
        wordsSample: [],
      });
    }
    const allowedTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/tiff",
      "image/webp",
    ];
    const mediaType = allowedTypes.includes(req.file.mimetype)
      ? req.file.mimetype
      : "image/jpeg";
    const encodedName = encodeURIComponent(req.file.originalname.slice(0, 200));

    // Step 1: POST raw binary bytes to /ocr/documents
    const uploadResp = await fetch(`${LUMEN_OCR_BASE}/documents`, {
      method: "POST",
      headers: getLumenHeaders({
        "Content-Type": mediaType,
        "X-Lumen-Document-Name": encodedName,
      }),
      body: req.file.buffer,
    });

    const uploadJson = await uploadResp.json();
    if (!uploadResp.ok) {
      return res.status(uploadResp.status).json(uploadJson);
    }

    const docRecord = uploadJson.data;
    const documentId = docRecord.DocumentID;
    let status = docRecord.Status;
    let pageCount = docRecord.PageCount || 1;
    let latestDoc = docRecord;

    // Step 2: Poll GET /ocr/documents/{documentID} until READY or PARTIAL (max ~22s)
    for (let attempt = 0; attempt < 12; attempt++) {
      if (status === "READY" || status === "PARTIAL" || status === "FAILED")
        break;
      await sleep(1800);
      const pollResp = await fetch(
        `${LUMEN_OCR_BASE}/documents/${documentId}`,
        {
          headers: getLumenHeaders(),
        },
      );
      if (pollResp.ok) {
        const pollJson = await pollResp.json();
        latestDoc = pollJson.data || latestDoc;
        status = latestDoc.Status;
        pageCount = latestDoc.PageCount || pageCount;
      }
    }

    if (status === "FAILED") {
      return res.status(422).json({
        error: {
          message: `OCR failed (${latestDoc.FailureReason || "unknown"}). Try a clearer image.`,
        },
        document: latestDoc,
      });
    }

    // Step 3: Read pages with words
    let extractedText = "";
    let wordsSample = [];
    let words = [];
    const pagesResp = await fetch(
      `${LUMEN_OCR_BASE}/documents/${documentId}/pages?IncludeWords=true`,
      {
        headers: getLumenHeaders(),
      },
    );

    if (pagesResp.ok) {
      const pagesJson = await pagesResp.json();
      extractedText = extractTextFromPagePayload(pagesJson);
      words = collectWords(pagesJson);
    }

    // Fallback: fetch page 1 directly if listOcrPages didn't inline text
    if (!extractedText || extractedText.length < 5) {
      const page1Resp = await fetch(
        `${LUMEN_OCR_BASE}/documents/${documentId}/pages/1`,
        {
          headers: getLumenHeaders(),
        },
      );
      if (page1Resp.ok) {
        const page1Json = await page1Resp.json();
        extractedText = extractTextFromPagePayload(page1Json);
        words = collectWords(page1Json);
      }
    }
    wordsSample = words.slice(0, 8);

    res.json({
      mock: false,
      documentId,
      fileName: req.file.originalname,
      status,
      pageCount,
      extractedText:
        extractedText ||
        "(OCR completed, but no text layer was detected on page 1. You can type/edit manually below.)",
      wordsSample,
      words,
    });
  } catch (err) {
    console.error("OCR Upload Error:", err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── 2. LUMEN OCR NATIVE HUMAN REVIEW / WORD CORRECTION (BONUS) ──
// POST /api/ocr/correct: send one word the student fixed to Lumen OCR review
app.post("/api/ocr/correct", async (req, res) => {
  try {
    const { documentId, pageNumber = 1, wordIndex = 0, text } = req.body;
    if (MOCK_MODE || !documentId || documentId.startsWith("mock-")) {
      return res.json({
        mock: true,
        message: "Human review judgement logged (Mock/Local verified).",
        correctedWord: {
          pageNumber,
          wordIndex,
          text,
          confidence: { measured: false, reason: "human_supplied" },
        },
      });
    }

    const resp = await fetch(
      `${LUMEN_OCR_BASE}/documents/${documentId}/review/corrections`,
      {
        method: "POST",
        headers: getLumenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          documentId,
          pageNumber: Number(pageNumber),
          wordIndex: Number(wordIndex),
          text: String(text).slice(0, 512),
        }),
      },
    );

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── 3. LUMEN AI CHAT: INSTANCE + ONE SESSION PER STUDENT ───────
// Each student gets their own Q&A session, so one student's records never sit in another's
// conversation. Organizing a document uses a fresh session so earlier documents can't leak into it.
const chatSessions = new Map(); // `${purpose}:${studentId}` -> sessionId
const validStudentId = (id) =>
  typeof id === "string" &&
  /^[\w-]{1,40}$/.test(id) &&
  !/^(__proto__|constructor|prototype)$/.test(id);

// Opens a new Lumen AI Chat session
async function openChatSession(instanceId, title) {
  const sessResp = await fetch(
    `${LUMEN_CHAT_BASE}/instances/${instanceId}/sessions`,
    {
      method: "POST",
      headers: getLumenHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title }),
    },
  );
  const sessJson = await sessResp.json();
  if (!sessResp.ok)
    throw new Error(
      sessJson?.error?.message || "Failed to open Lumen AI Chat session",
    );
  return sessJson.Session.id;
}

// Sends one message in the student's session (or a fresh one), reopening an expired session once
async function sendChatMessage(key, message, { fresh = false } = {}) {
  const { instanceId } = await ensureChatSession(false);
  let sessionId = fresh ? null : chatSessions.get(key);
  if (!sessionId) {
    sessionId = await openChatSession(instanceId, `EasyBo ${key}`.slice(0, 80));
    if (!fresh) chatSessions.set(key, sessionId);
  }
  const post = (sid) =>
    fetch(
      `${LUMEN_CHAT_BASE}/instances/${instanceId}/sessions/${sid}/messages`,
      {
        method: "POST",
        headers: getLumenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message: String(message).slice(0, 3950) }),
      },
    );
  let resp = await post(sessionId);
  // A cached session can expire: open a new one and try once more
  if (!fresh && (resp.status === 404 || resp.status === 410)) {
    sessionId = await openChatSession(instanceId, `EasyBo ${key}`.slice(0, 80));
    chatSessions.set(key, sessionId);
    resp = await post(sessionId);
  }
  cachedSessionId = sessionId;
  const json = await resp.json().catch(() => ({}));
  return { resp, json, sessionId };
}

// Finds the organization's active AI Chat instance (cached) and a default session
async function ensureChatSession(forceNewSession = false) {
  if (!cachedInstanceId) {
    const instResp = await fetch(`${LUMEN_CHAT_BASE}/instances`, {
      headers: getLumenHeaders(),
    });
    const instJson = await instResp.json();
    if (!instResp.ok) {
      throw new Error(
        instJson?.error?.message || "Failed to list Lumen AI Chat instances",
      );
    }
    const list = instJson.Instances || [];
    const active =
      list.find(
        (i) =>
          (i.Status || "").toUpperCase() === "ACTIVE" || i.Status === "READY",
      ) || list[0];
    if (!active) {
      throw new Error(
        "No configured AI Chat instances found for this organization key.",
      );
    }
    cachedInstanceId = active.InstanceID;
  }

  if (!cachedSessionId || forceNewSession) {
    const sessResp = await fetch(
      `${LUMEN_CHAT_BASE}/instances/${cachedInstanceId}/sessions`,
      {
        method: "POST",
        headers: getLumenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ title: "EasyBo Student Record & Note Buddy" }),
      },
    );
    const sessJson = await sessResp.json();
    if (!sessResp.ok) {
      throw new Error(
        sessJson?.error?.message || "Failed to open Lumen AI Chat session",
      );
    }
    cachedSessionId = sessJson.Session.id;
  }

  return { instanceId: cachedInstanceId, sessionId: cachedSessionId };
}

// ─── 4. LUMEN AI CHAT: STRUCTURED RECORD & NOTE ORGANIZER ────────
// POST /api/chat/organize: turns scanned text into record fields, a checklist and the file summary
// in ONE Lumen call (or with mockOrganize in Mock Mode). A missing or invalid summary is rebuilt locally.
app.post("/api/chat/organize", async (req, res) => {
  try {
    const { verifiedText, fileName } = req.body;
    const studentId = validStudentId(req.body.studentId)
      ? req.body.studentId
      : "guest";
    if (!verifiedText) {
      return res
        .status(400)
        .json({ error: { message: "Verified text is required." } });
    }

    if (MOCK_MODE) {
      await sleep(1100);
      return res.json({
        mock: true,
        structured: mockOrganize(String(verifiedText), fileName),
      });
    }

    // Keep prompt under 4000 chars per OpenAPI spec
    const clippedDoc = String(verifiedText).slice(0, 2600);
    const promptMessage =
      `You are EasyBo, a Filipino college student's personal record, receipt, and study-note organizer.\n` +
      `Analyze this user-verified document (${fileName || "Document"}) and respond ONLY with a valid JSON object (no markdown fences), with all text in clear, professional English, matching these exact keys:\n` +
      `{"title":"short title","category":"Receipt & Tuition | Enrollment & Clearance | Scholarship | Class Note & Memo","referenceNo":"OR or ref number or N/A","date":"YYYY-MM-DD","amountPaid":0,"balanceDue":0,"deadline":"YYYY-MM-DD or None","summary":"Clear plain-English explanation of what this paper means","studyNotes":["bullet 1","bullet 2"],"checklist":["action item 1","action item 2"],"fileSummary":{"overview":"1-3 short sentences: what this paper is and what the student must do","keyPoints":["2-5 short points: document type, issuing office, amounts as ₱1,250.00, deadline as Month D, YYYY, action needed"]}}\n\n` +
      `DOCUMENT TEXT:\n${clippedDoc}`;

    const {
      resp: msgResp,
      json: msgJson,
      sessionId,
    } = await sendChatMessage(`organize:${studentId}`, promptMessage, {
      fresh: true,
    });
    if (!msgResp.ok) {
      return res.status(msgResp.status).json(msgJson);
    }

    const rawAnswer = msgJson?.Answer?.answer || "";
    let structured = null;

    // Parse JSON if the assistant returned JSON, or gracefully structure prose
    const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        structured = JSON.parse(jsonMatch[0]);
      } catch (_) {}
    }

    if (!structured) {
      structured = {
        title: fileName || "Scanned Student Record",
        category: "Enrollment & Clearance",
        referenceNo: "VERIFIED-DOC",
        date: new Date().toISOString().slice(0, 10),
        amountPaid: 0,
        balanceDue: 0,
        deadline: "See Summary",
        summary: rawAnswer,
        studyNotes: [rawAnswer.slice(0, 200)],
        checklist: [
          "Review verified document details",
          "Keep digital copy in EasyBo Vault",
        ],
      };
    }

    structured.fileSummary =
      normalizeFileSummary(structured.fileSummary) ||
      buildFileSummary(structured, verifiedText);

    res.json({
      mock: false,
      sessionId,
      rawAnswer,
      structured,
    });
  } catch (err) {
    console.error("AI Organize Error:", err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── 5. LUMEN AI CHAT: INTERACTIVE Q&A BUDDY ─────────────────────
// POST /api/chat/ask: answers an open-ended Ask EasyBo question using the student's saved documents
app.post("/api/chat/ask", async (req, res) => {
  try {
    const { question, contextText } = req.body;
    if (!question) {
      return res
        .status(400)
        .json({ error: { message: "Question is required." } });
    }

    if (MOCK_MODE) {
      await sleep(900);
      // Sample reply that reflects the question and the student's newest saved document
      const titles = [
        ...String(contextText || "").matchAll(/^- \[[^\]]+\] (.+?) \(Ref:/gm),
      ].map((m) => m[1]);
      const q = String(question).slice(0, 120);
      return res.json({
        mock: true,
        answer: titles.length
          ? `This is a sample answer. About your question "${q}": I found ${titles.length} saved document${titles.length === 1 ? "" : "s"}, including **${titles[0]}**. In Live mode you get a full, detailed answer.`
          : `This is a sample answer. I don't see any saved documents yet, so scan a receipt or memo first. In Live mode you get a full, detailed answer.`,
      });
    }
    const studentId = validStudentId(req.body.studentId)
      ? req.body.studentId
      : "guest";
    const combinedMessage = contextText
      ? `Context from my verified student records:\n${String(contextText).slice(0, 2200)}\n\nMy Question (please answer helpfully in clear, simple English): ${question}`
      : question;

    const {
      resp: msgResp,
      json: msgJson,
      sessionId,
    } = await sendChatMessage(`ask:${studentId}`, combinedMessage);
    if (!msgResp.ok) {
      return res.status(msgResp.status).json(msgJson);
    }

    res.json({
      mock: false,
      sessionId,
      answer: msgJson?.Answer?.answer || "No reply received.",
      citations: msgJson?.Answer?.citations || [],
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── LOCAL DEMO STORAGE ──────────────────────────────────────────
// Records live in vault-db.json (git-ignored), created with one sample receipt on first run.
const fs = require("fs");
const DB_FILE = path.join(__dirname, "vault-db.json");

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      "2026-00142": [
        {
          id: "rec-demo-1",
          studentId: "2026-00142",
          documentId: "lumen-doc-8821",
          title: "1st Sem Computer Lab & Misc Receipt",
          category: "Receipt & Tuition",
          referenceNo: "OR-2026-99412",
          amountPaid: 1250,
          balanceDue: 500,
          deadline: "2026-11-24",
          summary:
            "Official receipt (OR-2026-99412) for the ₱1,250.00 Computer Lab deposit. A ₱500.00 balance is still due before Finals Clearance on Nov 24.",
          createdAt: "Nov 12, 2026",
          tasks: [
            {
              id: "t-1",
              text: "Keep a photocopy of OR-2026-99412 for the Exam Permit",
              done: true,
            },
            {
              id: "t-2",
              text: "Pay the ₱500.00 remaining balance at the Cashier by Nov 24",
              done: false,
            },
          ],
        },
      ],
      "2026-00891": [],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

// Saves all records back to vault-db.json
function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── ORIGINAL PHOTOS / PDFs ──────────────────────────────────────
// Kept as files (not inside vault-db.json) so record syncs stay small. File names are made here,
// never taken from the request, so a client can't write outside the uploads folder.
const crypto = require("crypto");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
const UPLOAD_NAME = /^[a-z0-9]+-[a-f0-9]{12}\.(jpg|png|webp|pdf)$/;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=86400");
    },
  }),
);

// POST /api/images: stores an original photo or PDF (checked type and size) and returns its URL
app.post("/api/images", (req, res) => {
  const m = String(req.body?.dataUrl || "").match(
    /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/,
  );
  const ext = m && IMAGE_TYPES[m[1]];
  if (!ext)
    return res.status(400).json({
      error: { message: "Only JPG, PNG, WebP or PDF files can be stored." },
    });
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > 3.5 * 1024 * 1024)
    return res
      .status(413)
      .json({ error: { message: "File is too large to store." } });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
  fs.writeFile(path.join(UPLOAD_DIR, name), buf, (err) => {
    if (err)
      return res
        .status(500)
        .json({ error: { message: "Could not store the file." } });
    res.status(201).json({ url: `/uploads/${name}` });
  });
});

// DELETE /api/images/:name: removes a stored photo after its document is deleted
app.delete("/api/images/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!UPLOAD_NAME.test(name))
    return res.status(400).json({ error: { message: "Invalid file name." } });
  fs.unlink(path.join(UPLOAD_DIR, name), () => res.json({ status: "deleted" }));
});

// GET all records for a specific Student ID from the backend database
app.get("/api/records", (req, res) => {
  const studentId = req.query.studentId || "2026-00142";
  if (!validStudentId(studentId))
    return res.status(400).json({ error: { message: "Invalid student ID." } });
  const db = readDb();
  res.json({ studentId, records: db[studentId] || [] });
});

// POST a newly verified record to the backend database
app.post("/api/records", (req, res) => {
  const { studentId = "2026-00142", record } = req.body;
  if (!validStudentId(studentId))
    return res.status(400).json({ error: { message: "Invalid student ID." } });
  if (!record || typeof record !== "object" || Array.isArray(record))
    return res.status(400).json({ error: { message: "Record is required." } });
  const db = readDb();
  if (!db[studentId]) db[studentId] = [];
  db[studentId].unshift(record);
  writeDb(db);
  res.status(201).json({ status: "saved", records: db[studentId] });
});

// PUT/sync updated records (e.g., ticked checklist items or deleted record)
app.put("/api/records", (req, res) => {
  const { studentId = "2026-00142", records } = req.body;
  if (!validStudentId(studentId))
    return res.status(400).json({ error: { message: "Invalid student ID." } });
  if (!Array.isArray(records))
    return res
      .status(400)
      .json({ error: { message: "Records must be a list." } });
  const db = readDb();
  db[studentId] = records;
  writeDb(db);
  res.json({ status: "updated", records: db[studentId] });
});

// Start the server
app.listen(PORT, () => {
  console.log(
    `✅ EasyBo Student Buddy running on http://localhost:${PORT} (MOCK_MODE=${MOCK_MODE})`,
  );
});
