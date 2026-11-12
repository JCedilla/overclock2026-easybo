require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MiB max per Lumen OCR spec
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const LUMEN_API_KEY = process.env.LUMEN_API_KEY;
const LUMEN_API_SECRET = process.env.LUMEN_API_SECRET;
const LUMEN_OCR_BASE = process.env.LUMEN_OCR_BASE || 'https://api.staging.nonlive.lumen.bayanichain.tech/ocr';
const LUMEN_CHAT_BASE = process.env.LUMEN_CHAT_BASE || 'https://api.staging.nonlive.lumen.bayanichain.tech/ai_chat';
let MOCK_MODE = (process.env.MOCK_MODE || 'false').toLowerCase() === 'true';

// Cache AI Chat InstanceID and SessionID in memory to save API credits!
let cachedInstanceId = null;
let cachedSessionId = null;

function getLumenHeaders(extra = {}) {
  return {
    'lumen-api-key': LUMEN_API_KEY,
    'lumen-api-secret': LUMEN_API_SECRET,
    ...extra
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extract readable text from Lumen OCR Page object regardless of shape
function extractTextFromPagePayload(pageData) {
  const root = pageData?.data || pageData;
  if (!root) return '';

  // Check if Lines array exists
  const lines = root.Lines || root.lines;
  if (Array.isArray(lines) && lines.length > 0) {
    return lines.map(l => l.Text || l.text || (l.Words || l.words || []).map(w => w.Text || w.text).join(' ')).join('\n');
  }

  // Check if Words array exists
  const words = root.Words || root.words;
  if (Array.isArray(words) && words.length > 0) {
    return words.map(w => w.Text || w.text || '').join(' ');
  }

  // Check if Pages array exists
  const pages = root.Pages || root.pages || root.Items || root.items || (Array.isArray(root) ? root : null);
  if (Array.isArray(pages)) {
    return pages.map((p, idx) => {
      const pText = extractTextFromPagePayload(p);
      return pText ? `--- Page ${p.PageNumber || idx + 1} ---\n${pText}` : '';
    }).filter(Boolean).join('\n\n');
  }

  if (typeof root.Text === 'string') return root.Text;
  if (typeof root.text === 'string') return root.text;
  return JSON.stringify(root, null, 2);
}

// ─── STATUS & MOCK MODE TOGGLE ───────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    mockMode: MOCK_MODE,
    hasKeys: Boolean(LUMEN_API_KEY && LUMEN_API_SECRET),
    cachedInstanceId,
    cachedSessionId
  });
});

app.post('/api/config/mock', (req, res) => {
  MOCK_MODE = Boolean(req.body.mockMode);
  res.json({ mockMode: MOCK_MODE });
});

// ─── 1. LUMEN OCR: UPLOAD + POLL + READ PAGES ────────────────────
app.post('/api/ocr/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: 'No file uploaded.' } });
    }

    if (MOCK_MODE) {
      await sleep(900);
      return res.json({
        mock: true,
        documentId: 'mock-doc-' + Date.now(),
        fileName: req.file.originalname,
        status: 'READY',
        pageCount: 1,
        extractedText:
          `PAMANTASAN NG LUNGSOD NG PASIG (PLP)\n` +
          `OFFICE OF THE UNIVERSITY REGISTRAR & CASHIER\n` +
          `Document Ref: OR-2026-99412 | Date: November 12, 2026\n\n` +
          `SUBJECT: 1ST SEMESTER FINAL CLEARANCE & LABORATORY FEE NOTICE\n` +
          `Student Name: Juan Dela Cruz (BSIT 1-A)\n` +
          `Amount Paid: PHP 1,250.00 (Computer Lab & miscellaneous deposit)\n` +
          `Remaining Balance Due: PHP 500.00\n` +
          `Submission Deadline: November 24, 2026\n\n` +
          `REQUIREMENTS FOR FINAL EXAM PERMIT:\n` +
          `1. Signed Library & Computer Lab Clearance Slip\n` +
          `2. Official Receipt (OR-2026-99412) photocopy\n` +
          `3. Updated Certificate of Registration (COR) with Adviser Signature`,
        wordsSample: [
          { pageNumber: 1, wordIndex: 0, text: 'OR-2026-99412' },
          { pageNumber: 1, wordIndex: 1, text: '1,250.00' },
          { pageNumber: 1, wordIndex: 2, text: 'November 24, 2026' }
        ]
      });
    }

    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp'];
    const mediaType = allowedTypes.includes(req.file.mimetype) ? req.file.mimetype : 'image/jpeg';
    const encodedName = encodeURIComponent(req.file.originalname.slice(0, 200));

    // Step 1: POST raw binary bytes to /ocr/documents
    const uploadResp = await fetch(`${LUMEN_OCR_BASE}/documents`, {
      method: 'POST',
      headers: getLumenHeaders({
        'Content-Type': mediaType,
        'X-Lumen-Document-Name': encodedName
      }),
      body: req.file.buffer
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
      if (status === 'READY' || status === 'PARTIAL' || status === 'FAILED') break;
      await sleep(1800);
      const pollResp = await fetch(`${LUMEN_OCR_BASE}/documents/${documentId}`, {
        headers: getLumenHeaders()
      });
      if (pollResp.ok) {
        const pollJson = await pollResp.json();
        latestDoc = pollJson.data || latestDoc;
        status = latestDoc.Status;
        pageCount = latestDoc.PageCount || pageCount;
      }
    }

    if (status === 'FAILED') {
      return res.status(422).json({
        error: { message: `OCR failed (${latestDoc.FailureReason || 'unknown'}). Try a clearer image.` },
        document: latestDoc
      });
    }

    // Step 3: Read pages with words
    let extractedText = '';
    let wordsSample = [];
    const pagesResp = await fetch(`${LUMEN_OCR_BASE}/documents/${documentId}/pages?IncludeWords=true`, {
      headers: getLumenHeaders()
    });

    if (pagesResp.ok) {
      const pagesJson = await pagesResp.json();
      extractedText = extractTextFromPagePayload(pagesJson);
    }

    // Fallback: fetch page 1 directly if listOcrPages didn't inline text
    if (!extractedText || extractedText.length < 5) {
      const page1Resp = await fetch(`${LUMEN_OCR_BASE}/documents/${documentId}/pages/1`, {
        headers: getLumenHeaders()
      });
      if (page1Resp.ok) {
        const page1Json = await page1Resp.json();
        extractedText = extractTextFromPagePayload(page1Json);
        const rawWords = page1Json?.data?.Words || page1Json?.data?.words || [];
        wordsSample = rawWords.slice(0, 8).map((w, idx) => ({
          pageNumber: 1,
          wordIndex: idx,
          text: w.Text || w.text || ''
        }));
      }
    }

    res.json({
      mock: false,
      documentId,
      fileName: req.file.originalname,
      status,
      pageCount,
      extractedText: extractedText || '(OCR completed, but no text layer was detected on page 1. You can type/edit manually below.)',
      wordsSample
    });
  } catch (err) {
    console.error('OCR Upload Error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── 2. LUMEN OCR NATIVE HUMAN REVIEW / WORD CORRECTION (BONUS) ──
app.post('/api/ocr/correct', async (req, res) => {
  try {
    const { documentId, pageNumber = 1, wordIndex = 0, text } = req.body;
    if (MOCK_MODE || !documentId || documentId.startsWith('mock-')) {
      return res.json({
        mock: true,
        message: 'Human review judgement logged (Mock/Local verified).',
        correctedWord: { pageNumber, wordIndex, text, confidence: { measured: false, reason: 'human_supplied' } }
      });
    }

    const resp = await fetch(`${LUMEN_OCR_BASE}/documents/${documentId}/review/corrections`, {
      method: 'POST',
      headers: getLumenHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        documentId,
        pageNumber: Number(pageNumber),
        wordIndex: Number(wordIndex),
        text: String(text).slice(0, 512)
      })
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── 3. LUMEN AI CHAT: HELPER TO ENSURE INSTANCE & SESSION ───────
async function ensureChatSession(forceNewSession = false) {
  if (!cachedInstanceId) {
    const instResp = await fetch(`${LUMEN_CHAT_BASE}/instances`, {
      headers: getLumenHeaders()
    });
    const instJson = await instResp.json();
    if (!instResp.ok) {
      throw new Error(instJson?.error?.message || 'Failed to list Lumen AI Chat instances');
    }
    const list = instJson.Instances || [];
    const active = list.find(i => (i.Status || '').toUpperCase() === 'ACTIVE' || i.Status === 'READY') || list[0];
    if (!active) {
      throw new Error('No configured AI Chat instances found for this organization key.');
    }
    cachedInstanceId = active.InstanceID;
  }

  if (!cachedSessionId || forceNewSession) {
    const sessResp = await fetch(`${LUMEN_CHAT_BASE}/instances/${cachedInstanceId}/sessions`, {
      method: 'POST',
      headers: getLumenHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: 'EasyBo Student Record & Note Buddy' })
    });
    const sessJson = await sessResp.json();
    if (!sessResp.ok) {
      throw new Error(sessJson?.error?.message || 'Failed to open Lumen AI Chat session');
    }
    cachedSessionId = sessJson.Session.id;
  }

  return { instanceId: cachedInstanceId, sessionId: cachedSessionId };
}

// ─── 4. LUMEN AI CHAT: STRUCTURED RECORD & NOTE ORGANIZER ────────
app.post('/api/chat/organize', async (req, res) => {
  try {
    const { verifiedText, fileName } = req.body;
    if (!verifiedText) {
      return res.status(400).json({ error: { message: 'Verified text is required.' } });
    }

    if (MOCK_MODE) {
      await sleep(700);
      return res.json({
        mock: true,
        structured: {
          title: '1st Sem Final Clearance & Lab Fee Receipt',
          category: 'Receipt & Clearance',
          referenceNo: 'OR-2026-99412',
          date: '2026-11-12',
          amountPaid: 1250,
          balanceDue: 500,
          deadline: '2026-11-24',
          taglishSummary:
            'Ito ay opisyal na resibo (OR-2026-99412) na nagkakahalaga ng ₱1,250.00 para sa Computer Lab at miscellaneous fee, kasama ang paalala para sa Final Exam Permit clearance. May natitira ka pang ₱500.00 balance na kailangang bayaran bago mag-November 24, 2026.',
          studyNotes: [
            'Official Receipt #OR-2026-99412 proves ₱1,250.00 payment on Nov 12, 2026.',
            'Remaining payable balance is ₱500.00 due on or before Nov 24, 2026.',
            'Three physical requirements must be presented to get the Final Exam Permit.'
          ],
          checklist: [
            'Magpa-pirma ng Library at Computer Lab Clearance Slip',
            'Mag-photocopy ng Official Receipt (OR-2026-99412)',
            'Ihanda ang updated COR na may pirma ng Academic Adviser',
            'Bayaran ang ₱500.00 remaining balance bago mag Nov 24, 2026'
          ]
        }
      });
    }

    const { instanceId, sessionId } = await ensureChatSession(false);

    // Keep prompt under 4000 chars per OpenAPI spec
    const clippedDoc = String(verifiedText).slice(0, 2600);
    const promptMessage =
      `You are EasyBo, a Filipino college student's personal record, receipt, and study-note organizer.\n` +
      `Analyze this user-verified document (${fileName || 'Document'}) and respond ONLY with a valid JSON object (no markdown fences) matching these exact keys:\n` +
      `{"title":"short title","category":"Receipt & Tuition | Enrollment & Clearance | Scholarship | Class Note & Memo","referenceNo":"OR or ref number or N/A","date":"YYYY-MM-DD","amountPaid":0,"balanceDue":0,"deadline":"YYYY-MM-DD or None","taglishSummary":"Clear Taglish explanation of what this paper means","studyNotes":["bullet 1","bullet 2"],"checklist":["action item 1","action item 2"]}\n\n` +
      `DOCUMENT TEXT:\n${clippedDoc}`;

    const msgResp = await fetch(`${LUMEN_CHAT_BASE}/instances/${instanceId}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: getLumenHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: promptMessage.slice(0, 3950) })
    });

    const msgJson = await msgResp.json();
    if (!msgResp.ok) {
      return res.status(msgResp.status).json(msgJson);
    }

    const rawAnswer = msgJson?.Answer?.answer || '';
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
        title: fileName || 'Scanned Student Record',
        category: 'Enrollment & Clearance',
        referenceNo: 'VERIFIED-DOC',
        date: new Date().toISOString().slice(0, 10),
        amountPaid: 0,
        balanceDue: 0,
        deadline: 'See Summary',
        taglishSummary: rawAnswer,
        studyNotes: [rawAnswer.slice(0, 200)],
        checklist: ['Review verified document details', 'Keep digital copy in EasyBo Vault']
      };
    }

    res.json({
      mock: false,
      sessionId,
      rawAnswer,
      structured
    });
  } catch (err) {
    console.error('AI Organize Error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── 5. LUMEN AI CHAT: INTERACTIVE Q&A BUDDY ─────────────────────
app.post('/api/chat/ask', async (req, res) => {
  try {
    const { question, contextText } = req.body;
    if (!question) {
      return res.status(400).json({ error: { message: 'Question is required.' } });
    }

    if (MOCK_MODE) {
      await sleep(500);
      return res.json({
        mock: true,
        answer:
          `Base sa iyong verified records sa EasyBo Vault:\n\n` +
          `• Nakapagbayad ka na ng **₱1,250.00** (OR-2026-99412).\n` +
          `• Ang kailangan mo na lang bayaran ay **₱500.00** bago ang deadline sa **November 24, 2026**.\n` +
          `• Huwag kalimutang dalhin ang photocopy ng OR, signed COR, at Lab Clearance slip sa Registrar!`
      });
    }

    const { instanceId, sessionId } = await ensureChatSession(false);
    const combinedMessage = contextText
      ? `Context from my verified student records:\n${String(contextText).slice(0, 2200)}\n\nMy Question (please answer helpfully in simple Taglish/English): ${question}`
      : question;

    const msgResp = await fetch(`${LUMEN_CHAT_BASE}/instances/${instanceId}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: getLumenHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: combinedMessage.slice(0, 3950) })
    });

    const msgJson = await msgResp.json();
    if (!msgResp.ok) {
      return res.status(msgResp.status).json(msgJson);
    }

    res.json({
      mock: false,
      sessionId,
      answer: msgJson?.Answer?.answer || 'No reply received.',
      citations: msgJson?.Answer?.citations || []
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

const fs = require('fs');
const DB_FILE = path.join(__dirname, 'vault-db.json');

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
          summary: "Opisyal na resibo (OR-2026-99412) para sa ₱1,250.00 Computer Lab deposit. May remaining balance pa na ₱500.00 bago mag Finals Clearance sa Nov 24.",
          createdAt: "Nov 12, 2026",
          tasks: [
            { id: "t-1", text: "Itago ang photocopy ng OR-2026-99412 para sa Exam Permit", done: true },
            { id: "t-2", text: "Bayaran ang ₱500.00 remaining balance sa Cashier bago mag Nov 24", done: false }
          ]
        }
      ],
      "2026-00891": []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// GET all records for a specific Student ID from the backend database
app.get('/api/records', (req, res) => {
  const studentId = req.query.studentId || '2026-00142';
  const db = readDb();
  res.json({ studentId, records: db[studentId] || [] });
});

// POST a newly verified record to the backend database
app.post('/api/records', (req, res) => {
  const { studentId = '2026-00142', record } = req.body;
  const db = readDb();
  if (!db[studentId]) db[studentId] = [];
  db[studentId].unshift(record);
  writeDb(db);
  res.status(201).json({ status: 'saved', records: db[studentId] });
});

// PUT/sync updated records (e.g., ticked checklist items or deleted record)
app.put('/api/records', (req, res) => {
  const { studentId = '2026-00142', records } = req.body;
  const db = readDb();
  db[studentId] = records;
  writeDb(db);
  res.json({ status: 'updated', records: db[studentId] });
});

app.listen(PORT, () => {
  console.log(`✅ EasyBo Student Buddy running on http://localhost:${PORT} (MOCK_MODE=${MOCK_MODE})`);
});