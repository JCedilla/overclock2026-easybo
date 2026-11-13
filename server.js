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
// Runs the upload middleware and turns its errors (file over 10 MiB) into a clear JSON message
// instead of Express's default HTML error page
const uploadOne = (field) => (req, res, next) =>
  upload.single(field)(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    console.error(`[upload] ${err.code || ""} ${err.message}`);
    res.status(tooBig ? 413 : 400).json({
      error: {
        message: tooBig
          ? "That file is over 10 MB. Please use a smaller photo or PDF."
          : "The file couldn't be uploaded. Please try again.",
        step: "upload",
      },
    });
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

// ─── LUMEN ERROR HANDLING ────────────────────────────────────────
// Every failed Lumen call is logged on the server (status + start of the body, never the keys) and
// turned into one clear sentence for the browser, so the student never sees a vague error.
// Lumen errors look like { error: { code, message }, requestId }. The code decides the message;
// the HTTP status is the fallback when there is no code.
function lumenMessage(status, code = "", detail = "") {
  const c = String(code || "").toUpperCase();
  if (
    c === "API_CREDITS_INSUFFICIENT" ||
    c === "LC_INSUFFICIENT" ||
    status === 402
  )
    return "Lumen says this key has run out of credits. Switch to Mock Mode in Demo tools to keep demoing.";
  if (c === "ACCESS_DENIED")
    return "This Lumen key doesn't have access to this feature (OCR or AI Chat). Ask the organizers to enable it for your key.";
  if (c === "OCR_NOT_CONFIGURED")
    return "Lumen OCR isn't set up for this key yet. Switch to Mock Mode, or ask the organizers to enable OCR.";
  if (c === "OCR_READ_QUEUE_FULL")
    return "Lumen OCR is busy reading other documents. Wait a minute and press Try again.";
  if (c === "OCR_REVIEW_CONFLICT" || status === 409)
    return "This document changed since it was read, so the fix wasn't applied. Scan it again to correct words.";
  if (status === 401)
    return "Lumen rejected the API key or secret. Check LUMEN_API_KEY and LUMEN_API_SECRET in .env, then restart the server.";
  if (status === 403)
    return "Lumen refused this request for this key (access or credits). Switch to Mock Mode to keep demoing.";
  if (status === 413)
    return "That file is over 10 MB. Please use a smaller photo or PDF.";
  if (status === 415)
    return "Photos and PDFs only. Save Word files as PDF first.";
  if (status === 429)
    return "Lumen is receiving too many requests. Wait a few seconds and try again.";
  if (status === 503)
    return "Lumen is temporarily unavailable. Try again in a minute, or switch to Mock Mode.";
  if (status >= 500)
    return "Lumen had a problem on its side. Try again in a minute, or switch to Mock Mode.";
  return `Lumen could not process the request (HTTP ${status}${c ? `, ${c}` : ""})${detail ? `: ${String(detail).slice(0, 160)}` : ""}.`;
}
// Reads a Lumen error body (JSON or not), logs status, code and requestId, and sends the clear message
function sendLumenError(res, step, status, body) {
  let j = body;
  if (typeof body === "string") {
    try {
      j = JSON.parse(body);
    } catch (_) {
      j = null; // not JSON (for example an HTML error page)
    }
  }
  const code = j?.error?.code || j?.code || "";
  const detail = j?.error?.message || j?.message || "";
  const requestId = j?.requestId || j?.error?.requestId || "";
  const raw = typeof body === "string" ? body : JSON.stringify(body || {});
  console.error(
    `[lumen] ${step} failed: HTTP ${status}${code ? ` ${code}` : ""}${requestId ? ` requestId=${requestId}` : ""} ${detail || raw.replace(/\s+/g, " ").slice(0, 200)}`,
  );
  return res.status(status >= 500 ? 502 : status).json({
    error: { message: lumenMessage(status, code, detail), code, step },
  });
}
// Errors thrown before Lumen answered (network down, DNS, timeouts, failed session setup)
function sendThrownError(res, step, err) {
  console.error(`[lumen] ${step} error:`, err && err.message);
  const m = String((err && err.message) || "");
  const message =
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(
      m + (err?.cause?.code || ""),
    )
      ? "The server could not reach Lumen. Check the internet connection, or switch to Mock Mode."
      : /^Lumen/.test(m)
        ? m
        : `Lumen error during ${step}: ${m.slice(0, 160)}`;
  return res.status(502).json({ error: { message, step } });
}

// ─── LUMEN OCR LIMITS ────────────────────────────────────────────
// Accepted types and size follow the Lumen OCR spec. Browsers sometimes send no type (or a generic
// one), so the file extension is used as a fallback. Anything else is refused before calling Lumen.
const OCR_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};
const OCR_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
// Every status check costs 1 credit: poll every 2.5 s for at most 45 s (about 18 checks per document).
// Both can be overridden in .env (tests use short values).
const OCR_POLL_MS = Number(process.env.OCR_POLL_MS) || 2500;
const OCR_MAX_WAIT_MS = Number(process.env.OCR_MAX_WAIT_MS) || 45000;
function ocrMediaType(file) {
  const allowed = Object.values(OCR_TYPES);
  if (allowed.includes(file.mimetype)) return file.mimetype;
  const ext = String(file.originalname || "")
    .split(".")
    .pop()
    .toLowerCase();
  return OCR_TYPES[ext] || null;
}

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
  // Unknown layout (some PDFs come back as blocks/paragraphs): collect every text value found,
  // instead of showing the raw response to the student
  const found = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 8 || found.length > 5000) return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (
        /^(text|content|value)$/i.test(k) &&
        typeof v === "string" &&
        v.trim()
      )
        found.push(v.trim());
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(root);
  return found.join("\n");
}

// ─── PROMPT SIZE ─────────────────────────────────────────────────
// Lumen AI Chat accepts messages up to about 4000 characters. Long PDFs (and characters such as ₱,
// bullets and smart quotes, which take several bytes) can push a prompt over that, so the document
// text is cleaned and shortened until the whole message fits.
const MAX_PROMPT_BYTES = 3800;
function cleanDocText(text) {
  return String(text || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022\u25CF\u25AA\u2023\u2043]/g, "-")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\S\n]+/g, " ") // collapse spaces and tabs, keep line breaks
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// ─── PAGE SPLITTING & DOCUMENT CHUNKING (long documents) ─────────
// A document too long for one message is cut into parts that each fit the limit, in two levels:
//   1. Page splitting: the OCR text is split at its "--- Page N ---" markers and whole pages are
//      packed together into parts ("pages 1-2", "page 3").
//   2. Document chunking: a single page that is still too long is cut at line boundaries into
//      sections ("page 4, section 2 of 3").
// Each part is read on its own into short notes, then one final message combines the notes, so
// nothing past the limit is silently dropped. At most MAX_CHUNKS parts are read to cap Lumen credits.
const CHUNK_BYTES = 2400; // room for the instructions inside the ~4000 limit
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS) || 4;
const utf8Bytes = (s) => Buffer.byteLength(String(s), "utf8");

// Level 1: splits OCR text into pages using the markers added by extractTextFromPagePayload.
// Text without markers (a photo, a one-page file) is a single page.
function splitPages(text) {
  const t = cleanDocText(text);
  const marks = [...t.matchAll(/^--- Page (\d+) ---$/gm)];
  if (!marks.length) return t ? [{ page: 1, text: t }] : [];
  const pages = [];
  const lead = t.slice(0, marks[0].index).trim(); // text before the first marker joins page 1
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : t.length;
    let body = t.slice(m.index + m[0].length, end).trim();
    if (i === 0 && lead) body = lead + "\n" + body;
    if (body) pages.push({ page: Number(m[1]) || i + 1, text: body });
  });
  return pages;
}

// Level 2: cuts text into pieces of at most `maxBytes`, keeping whole lines together when possible
function splitLines(text, maxBytes) {
  const bytes = utf8Bytes;
  const chunks = [];
  let cur = "";
  for (let line of String(text).split("\n")) {
    // A single line longer than a part is cut into pieces
    while (bytes(line) > maxBytes) {
      let cut = Math.floor((line.length * maxBytes) / bytes(line));
      while (cut > 1 && bytes(line.slice(0, cut)) > maxBytes) cut--;
      const space = line.lastIndexOf(" ", cut);
      if (space > cut * 0.6) cut = space;
      if (cur) (chunks.push(cur), (cur = ""));
      chunks.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    const next = cur ? cur + "\n" + line : line;
    if (cur && bytes(next) > maxBytes) {
      chunks.push(cur);
      cur = line;
    } else cur = next;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// Builds the parts of a document: [{ label, firstPage, lastPage, text }].
// Whole pages are packed together up to `maxBytes`; an oversized page becomes its own sections.
// Every part's text starts with its page label, so the AI (and the student) know where facts came from.
function chunkDocument(text, maxBytes = CHUNK_BYTES) {
  const parts = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const label =
      cur.firstPage === cur.lastPage
        ? `page ${cur.firstPage}`
        : `pages ${cur.firstPage}-${cur.lastPage}`;
    parts.push({ ...cur, label });
    cur = null;
  };
  for (const p of splitPages(text)) {
    const block = `[Page ${p.page}]\n${p.text}`;
    if (utf8Bytes(block) > maxBytes) {
      // This page alone is too long: cut it into sections
      flush();
      const head = (i, n) => `[Page ${p.page}, section ${i} of ${n}]\n`;
      const sections = splitLines(p.text, maxBytes - utf8Bytes(head(99, 99)));
      sections.forEach((s, i) =>
        parts.push({
          label: `page ${p.page}, section ${i + 1} of ${sections.length}`,
          firstPage: p.page,
          lastPage: p.page,
          text: head(i + 1, sections.length) + s,
        }),
      );
      continue;
    }
    if (cur && utf8Bytes(cur.text + "\n\n" + block) <= maxBytes) {
      cur.text += "\n\n" + block;
      cur.lastPage = p.page;
    } else {
      flush();
      cur = { firstPage: p.page, lastPage: p.page, text: block };
    }
  }
  flush();
  return parts;
}

// Turns one part's notes reply (JSON or prose) into short bullet lines for the final message
function compactNotes(answer) {
  const m = String(answer || "").match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const lines = [];
      for (const [k, v] of Object.entries(j))
        (Array.isArray(v) ? v : [v]).forEach(
          (x) => x && lines.push(`- ${k}: ${cleanStr(x)}`),
        );
      if (lines.length) return lines.join("\n");
    } catch (_) {
      /* fall through to prose */
    }
  }
  return cleanStr(answer).slice(0, 900);
}

// For document questions: picks the parts of a long text that best match the question (by shared
// words), in their original order, so the answer is based on the relevant pages, not just page 1.
function relevantParts(question, text, budgetBytes) {
  // Small page-labeled parts, so the chosen text says which page it came from
  const parts = chunkDocument(text, 900).map((p) => p.text);
  if (Buffer.byteLength(parts.join("\n"), "utf8") <= budgetBytes)
    return parts.join("\n");
  const words = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .match(/[a-z0-9₱]{3,}/g) || [],
    );
  const q = words(question);
  const ranked = parts
    .map((p, i) => ({
      i,
      p,
      score: [...words(p)].filter((w) => q.has(w)).length,
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const r of ranked) {
    const b = Buffer.byteLength(r.p, "utf8") + 6;
    if (used + b > budgetBytes) continue;
    picked.push(r);
    used += b;
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((r) => r.p)
    .join("\n...\n");
}

// ─── LUMEN DISPATCHER ────────────────────────────────────────────
// Every AI Chat message goes through this queue: one request at a time with a short gap, so a long
// document read in several parts (or many questions at once) never floods Lumen into 429 errors.
const CHAT_GAP_MS = Number(process.env.CHAT_GAP_MS) || 400;
let chatQueue = Promise.resolve();
function dispatch(task) {
  const run = chatQueue.then(task, task);
  chatQueue = run.catch(() => {}).then(() => sleep(CHAT_GAP_MS));
  return run;
}

// Builds `before + doc + after`, trimming the document text so the message stays under the limit
function fitPrompt(before, doc, after = "") {
  let body = cleanDocText(doc);
  const size = () => Buffer.byteLength(before + body + after, "utf8");
  if (size() <= MAX_PROMPT_BYTES) return before + body + after;
  // Cut by bytes, then back off to the last whole line
  while (body.length && size() > MAX_PROMPT_BYTES)
    body = body.slice(0, Math.floor(body.length * 0.9));
  const cut = body.lastIndexOf("\n");
  if (cut > body.length * 0.7) body = body.slice(0, cut);
  return before + body + "\n[document shortened]" + after;
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

// Formatting helpers: money as ₱1,250.00, dates as "November 24, 2026", ALL CAPS lines as Title Case
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
// ─── LOCAL FIELD EXTRACTION (no Lumen call) ──────────────────────
// Reads the labels found on Philippine school papers ("OR No.", "Amount Paid", "Remaining balance",
// "Deadline", "Due on") straight from the scanned text. Used by Mock Mode, and in Live mode to fill
// any field the AI left blank, so the student types as little as possible.
const CATEGORY_LIST = [
  "Receipt & Tuition",
  "Enrollment & Clearance",
  "Scholarship",
  "Class Note & Memo",
];
const MONTH_NUM = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// Builds YYYY-MM-DD, or null when the parts are not a real date
function isoFrom(y, m, d) {
  [y, m, d] = [Number(y), Number(m), Number(d)];
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// First date in a line: "November 24, 2026", "Nov. 24, 2026", "2026-11-24" or "11/24/2026"
function findDate(s) {
  const str = String(s || "");
  let m = str.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (m) return isoFrom(m[3], MONTH_NUM[m[1].slice(0, 3).toLowerCase()], m[2]);
  m = str.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return isoFrom(m[1], m[2], m[3]);
  m = str.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return isoFrom(m[3], m[1], m[2]);
  return null;
}

// Last money amount in a line: "PHP 1,250.00", "₱500", "1,250.00" (plain years and IDs are ignored)
function findMoney(s) {
  const re =
    /(?:(?:PHP|Php|₱)\s?(\d[\d,]*(?:\.\d{1,2})?))|(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2})(?!\d)/g;
  const all = [...String(s || "").matchAll(re)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  const n = Number(String(last[1] || last[2]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Labels that come before a reference number ("OR No.: OR-2026-99412", "Memo No.: REG-MEMO-114")
const REF_LABEL =
  /\b(?:O\.?\s?R\.?\s*(?:No\.?|Number|#)|Official\s+Receipt\s+No\.?|Receipt\s+No\.?|Document\s+Ref(?:erence)?|Reference(?:\s+No\.?)?|Ref\.?(?:\s+No\.?)?|Memo\s+No\.?|Control\s+No\.?|Transaction\s+No\.?|Invoice\s+No\.?)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{3,})/i;

// Reads every field it can find from the scanned text
function extractFields(text = "", fileName = "") {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // First line matching `test` whose `pick(line, index)` returns a value
  const lineWith = (test, pick) => {
    for (let i = 0; i < lines.length; i++) {
      if (!test.test(lines[i])) continue;
      const v = pick(lines[i], i);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  // Fields filled by a best guess: the browser marks these "Please check" instead of auto-saving
  const guessed = [];
  // A line holding only an amount ("1,250.00", "PHP 500"): OCR often splits an amount column off its labels
  const VALUE_ONLY = /^(?:PHP|Php|₱)?\s?\d[\d,]*(?:\.\d{1,2})?$/;
  // Money on the label's own line, or on one of the next 3 lines when the amount sits in its own column
  const moneyNear = (l, i) => {
    const same = findMoney(l);
    if (same !== null) return same;
    for (let k = i + 1; k <= i + 3 && k < lines.length; k++)
      if (VALUE_ONLY.test(lines[k])) return findMoney(lines[k]);
    return null;
  };
  const grab = (re) => {
    const m = String(text).match(re);
    return m ? m[1].trim() : null;
  };
  const lower = String(text).toLowerCase();

  // Document type
  let category = "Class Note & Memo";
  if (/scholar/.test(lower)) category = "Scholarship";
  else if (
    /official receipt|amount paid|balance|cashier|tuition|\bfees?\b/.test(lower)
  )
    category = "Receipt & Tuition";
  else if (/clearance|permit|enrol/.test(lower))
    category = "Enrollment & Clearance";

  // Reference number: after a known label (must contain a digit), else an OR-style code anywhere
  const referenceNo =
    lineWith(REF_LABEL, (l) => {
      const m = l.match(REF_LABEL);
      return m && /\d/.test(m[1]) ? m[1] : null;
    }) ||
    grab(/\b(OR[-\s]?[0-9O]{4}[-\s]?\d{3,})\b/) ||
    "N/A";

  // Amounts: what was paid (or credited), and what is still owed
  let amountPaid = lineWith(
    /amount\s*paid|total\s*paid|amount\s*credited|amount\s*received|cash\s*received|payment\s*received/i,
    moneyNear,
  );
  // Receipts only: no "Amount Paid" value found, so use the receipt's total, else its largest amount.
  // These are guesses, so the student is asked to confirm them.
  if (amountPaid === null && category === "Receipt & Tuition") {
    const amounts = lines.map(findMoney).filter((n) => n !== null && n > 0);
    amountPaid =
      lineWith(/^total\b/i, moneyNear) ??
      (amounts.length ? Math.max(...amounts) : null);
    if (amountPaid) guessed.push("amountPaid");
  }
  const balanceDue = lineWith(/balance|unpaid|still\s*due/i, findMoney) || 0;

  // Dates: the deadline line, and the paper's own date (not the deadline)
  const deadline =
    lineWith(
      /deadline|\bdue\b|on or before|not later than|until|expir/i,
      findDate,
    ) || "None";
  const date =
    lineWith(/\bdate\b/i, (l) =>
      /due|deadline/i.test(l) ? null : findDate(l),
    ) ||
    findDate(text) ||
    new Date().toISOString().slice(0, 10);

  const subject = grab(/SUBJECT:\s*(.+)/i);
  const particulars = grab(/Particulars:\s*(.+)/i);

  // Title: what the receipt was for, the memo subject, or "Official Receipt <number>"
  let title;
  if (category === "Receipt & Tuition" && particulars)
    title = mockTitleCase(particulars) + " Receipt";
  else if (subject) title = mockTitleCase(subject);
  else if (category === "Receipt & Tuition")
    title = `Official Receipt${referenceNo !== "N/A" ? " " + referenceNo : ""}`;
  else title = String(fileName || "Student Document").replace(/\.[^.]+$/, "");

  return {
    category,
    referenceNo,
    amountPaid: amountPaid || 0,
    balanceDue,
    deadline,
    date,
    subject,
    particulars,
    title,
    guessed,
  };
}

// Organizes a document on the server alone (Mock Mode, and the base for filling gaps in Live mode).
// Returns the same shape as the Live AI response.
function mockOrganize(text, fileName = "") {
  const {
    category,
    referenceNo,
    amountPaid,
    balanceDue,
    deadline,
    date,
    subject,
    particulars,
    title,
    guessed,
  } = extractFields(text, fileName);

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
    uncertainFields: guessed, // best-guess fields the student should confirm
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
    .replace(/'S\b/g, "'s") // "Cashier's", not "Cashier'S"
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
        // A short heading line naming an office ("Cashier's Office", "REGISTRAR"), not a numbered step
        (l.length <= 60 &&
          !/^\d/.test(l) &&
          /\b(registrar|cashier|accounting|library|student affairs)\b/i.test(
            l,
          )),
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

// Live mode: combines the AI's answer with the server's own reading of the text.
// AI values win when they are valid; blanks, "N/A", 0 amounts and bad dates are filled from the text.
// A reference number the AI invented (not in the text) is replaced by the one found in the text.
function mergeOrganized(ai, local, text = "") {
  if (!ai || typeof ai !== "object" || Array.isArray(ai))
    return { merged: { ...local }, filled: ["all fields"] };
  const out = { ...ai };
  const filled = [];
  const flat = (s) =>
    String(s || "")
      .replace(/\s+/g, "")
      .toLowerCase();
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  out.amountPaid = num(out.amountPaid);
  out.balanceDue = num(out.balanceDue);
  out.summary = cleanStr(out.summary || out.taglishSummary);
  const realRef = (v) =>
    v && !/^(n\/a|none|verified-doc|null)$/i.test(String(v).trim());
  const take = (key, isValid) => {
    if (!isValid(out[key]) && isValid(local[key])) {
      out[key] = local[key];
      filled.push(key);
    }
  };
  take("title", (v) => cleanStr(v).length > 0);
  take("category", (v) => CATEGORY_LIST.includes(v));
  if (
    realRef(out.referenceNo) &&
    realRef(local.referenceNo) &&
    !flat(text).includes(flat(out.referenceNo))
  ) {
    out.referenceNo = local.referenceNo;
    filled.push("referenceNo");
  } else take("referenceNo", realRef);
  take("amountPaid", (v) => Number(v) > 0);
  take("balanceDue", (v) => Number(v) > 0);
  take("deadline", isIsoDay);
  take("date", isIsoDay);
  take("summary", (v) => cleanStr(v).length > 0);
  take("checklist", (v) => Array.isArray(v) && v.length > 0);
  take("studyNotes", (v) => Array.isArray(v) && v.length > 0);
  // A best guess from the text stays marked for review only if it was actually used
  out.uncertainFields = (local.uncertainFields || []).filter((k) =>
    filled.includes(k),
  );
  return { merged: out, filled };
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
app.post("/api/ocr/upload", uploadOne("document"), async (req, res) => {
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
    // Lumen OCR accepts only these types (anything else, including Word files, returns 415).
    // Unknown types are refused here instead of being sent as a wrong type and wasting a call.
    const mediaType = ocrMediaType(req.file);
    if (!mediaType)
      return res.status(415).json({
        error: {
          message: "Photos and PDFs only. Save Word files as PDF first.",
          step: "OCR upload",
        },
      });
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

    if (!uploadResp.ok)
      return sendLumenError(
        res,
        "OCR upload",
        uploadResp.status,
        await uploadResp.text(),
      );
    const uploadJson = await uploadResp.json();
    if (!uploadJson?.data?.DocumentID)
      return sendLumenError(res, "OCR upload", 502, uploadJson);

    const docRecord = uploadJson.data;
    const documentId = docRecord.DocumentID;
    let status = docRecord.Status;
    let pageCount = docRecord.PageCount || 1;
    let latestDoc = docRecord;
    console.log(
      `[ocr] uploaded ${req.file.originalname} (${mediaType}, ${(req.file.size / 1024).toFixed(0)} KB): HTTP ${uploadResp.status}, document ${documentId}, requestId=${uploadJson.requestId || "-"}`,
    );

    // Step 2: Poll GET /ocr/documents/{documentID} until READY or PARTIAL.
    // Each GET costs 1 API credit, so poll every 2.5 s with a hard time limit, stop at once on a
    // failed poll, and re-queue a FAILED document once with POST /documents/{id}/retry.
    const deadline = Date.now() + OCR_MAX_WAIT_MS;
    let retried = false;
    while (status !== "READY" && status !== "PARTIAL") {
      if (status === "FAILED") {
        if (retried) break;
        retried = true;
        const retryResp = await fetch(
          `${LUMEN_OCR_BASE}/documents/${documentId}/retry`,
          {
            method: "POST",
            headers: getLumenHeaders(),
          },
        );
        if (!retryResp.ok) break; // keep the FAILED result
        console.log(
          `[ocr] document ${documentId} FAILED (${latestDoc.FailureReason || "no reason"}), re-queued once`,
        );
        status = "QUEUED";
      }
      if (Date.now() >= deadline) break;
      await sleep(OCR_POLL_MS);
      const pollResp = await fetch(
        `${LUMEN_OCR_BASE}/documents/${documentId}`,
        {
          headers: getLumenHeaders(),
        },
      );
      if (!pollResp.ok)
        return sendLumenError(
          res,
          "checking OCR progress",
          pollResp.status,
          await pollResp.text(),
        );
      const pollJson = await pollResp.json();
      latestDoc = pollJson.data || latestDoc;
      status = latestDoc.Status;
      pageCount = latestDoc.PageCount || pageCount;
    }

    if (status === "FAILED") {
      console.error(
        `[lumen] OCR FAILED for ${documentId}: ${latestDoc.FailureReason || "no reason given"}`,
      );
      return res.status(422).json({
        error: {
          message: `Lumen couldn't read this document${latestDoc.FailureReason ? ` (${latestDoc.FailureReason})` : ""}. Try a clearer photo, or a PDF that isn't password-protected.`,
          step: "OCR",
        },
      });
    }
    if (status !== "READY" && status !== "PARTIAL") {
      console.error(
        `[lumen] OCR still ${status} after ${OCR_MAX_WAIT_MS / 1000}s for ${documentId}`,
      );
      return res.status(504).json({
        error: {
          message: `Lumen is still reading this document (${pageCount} page${pageCount === 1 ? "" : "s"}). Wait a minute and press Try again.`,
          step: "OCR",
        },
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
    } else {
      console.error(
        `[lumen] reading pages failed: HTTP ${pagesResp.status} (document ${documentId}, status ${status})`,
      );
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
    console.log(
      `[ocr] ${req.file.originalname} (${mediaType}, ${pageCount} page${pageCount === 1 ? "" : "s"}): status ${status}, ${extractedText.length} characters read`,
    );
    // Still reading after the wait (long PDF): say so instead of continuing with no text
    if (!extractedText && status !== "READY" && status !== "PARTIAL") {
      console.error(`[lumen] OCR not finished after waiting: status ${status}`);
      return res.status(504).json({
        error: {
          message: `Lumen is still reading this document (${pageCount} page${pageCount === 1 ? "" : "s"}). Wait a minute and press Try again.`,
          step: "OCR",
        },
      });
    }

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
    sendThrownError(res, "OCR upload", err);
  }
});

// ─── 2. LUMEN OCR NATIVE HUMAN REVIEW / WORD CORRECTION (BONUS) ──
// POST /api/ocr/correct: send one word the student fixed to Lumen OCR review
app.post("/api/ocr/correct", async (req, res) => {
  try {
    const { documentId, pageNumber = 1, wordIndex = 0 } = req.body;
    // Spec: pageNumber is 1-based, wordIndex is 0-based (per page), text is 1 to 512 characters,
    // and documentId in the body must equal the one in the path. Checked here so no credits are spent
    // on a request Lumen would reject.
    const text = String(req.body.text ?? "").trim();
    const page = Number(pageNumber),
      index = Number(wordIndex);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(index) ||
      index < 0 ||
      !text ||
      text.length > 512
    )
      return res.status(400).json({
        error: {
          message:
            "That word fix couldn't be sent. Type 1 to 512 characters and try again.",
          step: "word correction",
        },
      });
    if (MOCK_MODE || !documentId || String(documentId).startsWith("mock-")) {
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
        // Costs 2 credits. No fingerprint is sent (it is optional), so a stale-fingerprint 409 can't happen;
        // a 409 for other conflicts is still explained by sendLumenError.
        body: JSON.stringify({
          documentId,
          pageNumber: page,
          wordIndex: index,
          text,
        }),
      },
    );

    if (!resp.ok)
      return sendLumenError(
        res,
        "word correction",
        resp.status,
        await resp.text(),
      );
    res.status(resp.status).json(await resp.json());
  } catch (err) {
    sendThrownError(res, "word correction", err);
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

// Sends one message through the dispatcher queue (see LUMEN DISPATCHER)
function sendChatMessage(key, message, opts = {}) {
  return dispatch(() => sendChatMessageNow(key, message, opts));
}

// Sends one message in the student's session (or a fresh one), reopening an expired session once
async function sendChatMessageNow(key, message, { fresh = false } = {}) {
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
// in ONE Lumen call for a normal document (or with mockOrganize in Mock Mode). A document too long for
// one message is read in parts first (at most MAX_CHUNKS + 1 calls). A missing summary is rebuilt locally.
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

    // The organize instructions (JSON shape); the document text, or the notes from its parts, follow them
    const instructions =
      `You are EasyBo, a Filipino college student's personal record, receipt, and study-note organizer.\n` +
      `Analyze this user-verified document (${fileName || "Document"}) and respond ONLY with a valid JSON object (no markdown fences), with all text in clear, professional English, matching these exact keys:\n` +
      `Copy numbers and dates exactly as printed. amountPaid and balanceDue are plain numbers (for example 1250.00).\n` +
      `{"title":"short title","category":"Receipt & Tuition | Enrollment & Clearance | Scholarship | Class Note & Memo","referenceNo":"OR or ref number exactly as printed, or N/A","date":"YYYY-MM-DD","amountPaid":0,"balanceDue":0,"deadline":"YYYY-MM-DD or None","summary":"Clear plain-English explanation of what this paper means","studyNotes":["bullet 1","bullet 2"],"checklist":["action item 1","action item 2"],"fileSummary":{"overview":"1-3 short sentences: what this paper is and what the student must do","keyPoints":["2-5 short points: document type, issuing office, amounts as ₱1,250.00, deadline as Month D, YYYY, action needed"]}}\n\n` +
      "";
    const docText = cleanDocText(verifiedText);
    const fitsInOne =
      Buffer.byteLength(instructions + "DOCUMENT TEXT:\n" + docText, "utf8") <=
      MAX_PROMPT_BYTES;

    // Short document: one message, as before. Long document: read it part by part first.
    let finalPrompt;
    let chunkInfo = null;
    if (fitsInOne) {
      finalPrompt = instructions + "DOCUMENT TEXT:\n" + docText;
    } else {
      // Page splitting, then chunking of oversized pages (see PAGE SPLITTING & DOCUMENT CHUNKING)
      const parts = chunkDocument(docText);
      const used = parts.slice(0, MAX_CHUNKS);
      const pageCount = splitPages(docText).length;
      chunkInfo = {
        total: parts.length,
        used: used.length,
        pages: pageCount,
        coveredTo: used[used.length - 1].lastPage, // last page read when the part limit was reached
        labels: used.map((p) => p.label),
      };
      console.log(
        `[organize] long document (${pageCount} page${pageCount === 1 ? "" : "s"}, ${utf8Bytes(docText)} bytes): reading ${used.length} of ${parts.length} parts: ${chunkInfo.labels.join(" | ")}`,
      );
      const notes = [];
      for (let i = 0; i < used.length; i++) {
        const partPrompt = fitPrompt(
          `You are reading ${used[i].label} (part ${i + 1} of ${used.length}) of a student's school document (${fileName || "Document"}).\n` +
            `List only the facts in this part as JSON (no markdown fences), in English, copying numbers and dates exactly:\n` +
            `{"facts":["short fact"],"amounts":["label: amount"],"dates":["label: date"],"references":["reference numbers"],"actions":["what the student must do"]}\n\n`,
          used[i].text,
        );
        const part = await sendChatMessage(
          `organize:${studentId}`,
          partPrompt,
          { fresh: true },
        );
        if (!part.resp.ok)
          return sendLumenError(
            res,
            `reading ${used[i].label}`,
            part.resp.status,
            part.json,
          );
        notes.push(
          `${used[i].label.toUpperCase()}:\n${compactNotes(part.json?.Answer?.answer)}`,
        );
      }
      finalPrompt = fitPrompt(
        instructions +
          `The document has ${pageCount} page${pageCount === 1 ? "" : "s"} and was read in ${used.length} parts` +
          `${parts.length > used.length ? ` (pages 1-${chunkInfo.coveredTo} only)` : ""}. Build the JSON from these notes:\n`,
        notes.join("\n"),
      );
    }

    const {
      resp: msgResp,
      json: msgJson,
      sessionId,
    } = await sendChatMessage(`organize:${studentId}`, finalPrompt, {
      fresh: true,
    });
    if (!msgResp.ok)
      return sendLumenError(
        res,
        "organizing the document",
        msgResp.status,
        msgJson,
      );

    const rawAnswer = msgJson?.Answer?.answer || "";
    let structured = null;

    // Parse JSON if the assistant returned JSON, or gracefully structure prose
    const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        structured = JSON.parse(jsonMatch[0]);
      } catch (_) {}
    }

    // Fill every field the AI left blank or invalid with what the server read from the text itself.
    // If the reply was not JSON at all, the server's own reading is used for everything.
    const parsed = !!structured;
    const local = mockOrganize(String(verifiedText), fileName);
    const { merged, filled } = mergeOrganized(structured, local, verifiedText);
    console.log(
      `[organize] AI reply ${parsed ? "parsed" : "was not JSON"}; filled from text: ${filled.join(", ") || "none"}`,
    );

    // Keep the AI's summary only when no field had to be filled in (otherwise it may contradict them)
    merged.fileSummary =
      (!filled.length && normalizeFileSummary(merged.fileSummary)) ||
      buildFileSummary(merged, verifiedText);

    if (chunkInfo) merged.chunked = chunkInfo; // shown on the Summary step ("read in 3 parts")

    res.json({
      mock: false,
      sessionId,
      rawAnswer,
      filledFromText: filled,
      structured: merged,
    });
  } catch (err) {
    sendThrownError(res, "organizing the document", err);
  }
});

// ─── 5. LUMEN AI CHAT: INTERACTIVE Q&A BUDDY ─────────────────────
// POST /api/chat/ask: answers an open-ended Ask EasyBo question using the student's saved documents
app.post("/api/chat/ask", async (req, res) => {
  try {
    const { question, contextText } = req.body;
    // scope "document": the Scan page's "Ask about this document" box (one paper only)
    const docScope = req.body.scope === "document";
    if (!question) {
      return res
        .status(400)
        .json({ error: { message: "Question is required." } });
    }

    if (MOCK_MODE && docScope) {
      await sleep(700);
      const q = String(question).slice(0, 120);
      return res.json({
        mock: true,
        answer: `This is a sample answer. In Live mode, EasyBo reads this document and answers "${q}" from it. Questions about the amount, balance, deadline, reference number or what to do are answered right away, without Live mode.`,
      });
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
    const q = String(question).slice(0, 500);
    // Document questions: the document's details plus only the parts of its text that match the
    // question, so long documents fit the limit without losing the relevant page
    const docMessage = () => {
      const ctx = String(contextText || "");
      const at = ctx.indexOf("Scanned text:\n");
      const details = at >= 0 ? ctx.slice(0, at) : ctx;
      const body = at >= 0 ? ctx.slice(at + 14) : "";
      const before = `Here is one school document I scanned:\n${details}Relevant parts of the scanned text:\n`;
      const after = `\n\nAnswer my question using only this document, in clear, simple English. Mention the page number when it helps. If the document does not say, tell me so.\nQuestion: ${q}`;
      const budget =
        MAX_PROMPT_BYTES - Buffer.byteLength(before + after, "utf8") - 40;
      return fitPrompt(
        before,
        relevantParts(q, body, Math.max(400, budget)),
        after,
      );
    };
    const combinedMessage = docScope
      ? docMessage()
      : contextText
        ? fitPrompt(
            "Context from my verified student records:\n",
            contextText,
            `\n\nMy Question (please answer helpfully in clear, simple English): ${q}`,
          )
        : q;

    // Document questions use a fresh session each time so one paper never mixes with another
    const {
      resp: msgResp,
      json: msgJson,
      sessionId,
    } = await sendChatMessage(
      docScope ? `doc:${studentId}` : `ask:${studentId}`,
      combinedMessage,
      { fresh: docScope },
    );
    if (!msgResp.ok)
      return sendLumenError(
        res,
        "answering the question",
        msgResp.status,
        msgJson,
      );

    res.json({
      mock: false,
      sessionId,
      answer: msgJson?.Answer?.answer || "No reply received.",
      citations: msgJson?.Answer?.citations || [],
    });
  } catch (err) {
    sendThrownError(res, "answering the question", err);
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

// Start the server (only when run directly with `node server.js` / `npm start`;
// tests can require this file to check the text-reading helpers without opening a port)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `✅ EasyBo Student Buddy running on http://localhost:${PORT} (MOCK_MODE=${MOCK_MODE})`,
    );
    // The Lumen OCR API is a preview available on staging gateways only
    for (const [name, url] of [
      ["LUMEN_OCR_BASE", LUMEN_OCR_BASE],
      ["LUMEN_CHAT_BASE", LUMEN_CHAT_BASE],
    ]) {
      if (!/^https:\/\/api\.staging\.[^/]+\/(ocr|ai_chat)\/?$/.test(url))
        console.warn(
          `⚠️  ${name} is "${url}". Lumen's preview APIs run on the staging gateway (https://api.staging.<gateway>/ocr and /ai_chat). Live mode may fail.`,
        );
    }
    if (!LUMEN_API_KEY || !LUMEN_API_SECRET)
      console.warn(
        "⚠️  LUMEN_API_KEY or LUMEN_API_SECRET is missing in .env. Live mode will return 401; Mock Mode still works.",
      );
  });
} else {
  module.exports = {
    extractFields,
    mockOrganize,
    mergeOrganized,
    buildFileSummary,
    splitPages,
    chunkDocument,
    relevantParts,
    fitPrompt,
  };
}
