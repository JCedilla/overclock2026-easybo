---
inclusion: always
---

# EasyBo: project context for the agent finalizing this app

You are helping a team member finish EasyBo for the OVERCLOCK 2026 hackathon. **Code freeze is 2:00 PM on hackathon day.** Read README.md for the pitch-level overview; this file is the working briefing.

## Ground rules

- **Credits:** do not switch to Live mode or call Lumen while testing. Start the server with `MOCK_MODE=true` (the default in `.env.example`). Only the human decides when to test Live, and does it by hand in Demo tools.
- **Secrets:** each team member has their own Lumen key in their own `.env`. Never print, commit or copy keys into code, docs or chat.
- **Commits:** the human commits. Suggest small commits with clear messages; commit history is judged.
- **Scope:** the app is feature-complete. Prefer fixing and polishing over adding features. Ask before big changes.

## Stack and layout

- Node.js 18+ (uses global `fetch`), Express, multer. No build step, no framework, **no Tailwind**.
- `server.js`: Lumen OCR + AI Chat proxy, Mock Mode, records (`vault-db.json`) and photo files (`uploads/`). Both data paths are git-ignored and created on first run.
- `public/app.js`: the whole single-page app (vanilla JS, one IIFE).
- `public/styles.css`: the "Papel" theme. Later blocks in the file override earlier ones; append new rules at the end.
- `public/index.html`: shell (welcome screen, sidebar, top bar, Demo tools popover, phone tab bar).

## How app.js works

- One `state` object. Each view is a function returning an HTML string: `viewDashboard`, `viewScanner` (steps `scanStep1/2/3`, `scanSaved`), `viewVault` (+ drawer `renderDrawer`), `viewTracker` (`paymentsPanel`, `clearancePanel`), `viewBuddy`. `renderView()` re-renders the current view.
- Routing: hash (`#dashboard`, `#scanner`, `#vault`, `#tracker`, `#buddy`) via `setView()`.
- Events: one delegated click listener switching on `data-action="..."`. Add new actions there; don't attach listeners to rendered elements.
- **Always wrap user or AI text in `esc()`** when building HTML. `richText()` escapes first, then allows `**bold**` and line breaks only.
- Feedback: `toast(msg, type, {label, fn})` for messages and Undo; `openModal()` for dialogs. Never use `alert()`/`prompt()`.
- Icons: Lucide via `<i data-lucide="name">`; `icons()` runs after each render.

## Data rules (don't break these)

- A record: `id, studentId, title, category, referenceNo, amountPaid, balanceDue, deadline (YYYY-MM-DD or 'None'), summary, studyNotes[], tasks[{id,text,done,paymentId?}], payments[{id,amount,date,note}], image, imageKind ('image'|'pdf'), rawText, fileName, corrections, createdAt`.
- `amountPaid` is what the scanned paper says and **never changes** after save. Later payments go in `payments[]`; use `paidTotal(r)` for totals. Unticking a payment task removes the payment it created.
- Category `Scholarship` is a **credit**, not money paid; it's excluded from "Paid so far".
- Persistence: device cache first, then server. A failed write sets an "unsynced" flag; the next load pushes the device copy. Use `syncRecords()` / `addRecord()`, not raw fetches.
- Dates: use `localIso()` / `isoDay()` (local time), not `toISOString()`.
- Chat: `localAnswer()` answers balance/deadline/clearance/OR number/biggest payment/office questions on-device; only unmatched questions call `/api/chat/ask`.

## Mock Mode

- The server returns sample text by **file name**: names containing `memo|clearance|permit` → clearance memo, `scholar|grant|award` → scholarship notice, anything else → receipt. The receipt deliberately contains the misread `OR-2O26-99412` to demo the "Please check"/correction flow.
- Scan flow is Upload → Summary → Check → Save. The tutorial (offered once per browser, replay in Demo tools) is in the "Tutorial" section of app.js.
- The Scan page's sample buttons draw matching sample papers on a canvas, so the demo shows a real-looking photo.

## Testing without credits

- Run the server: `$env:PORT='3917'; $env:MOCK_MODE='true'; node server.js`.
- Browser tests were done with `puppeteer-core` installed in a temp folder (not in package.json), driving the installed Chrome. Keep test tooling out of the repo.
- Check syntax with `node --check public/app.js` and `node --check server.js`.
- Design/UX rules are in `brand.md` and `ux-principles.md`: 16px body text, 44px touch targets, WCAG AA contrast, one primary button per screen, status = color + icon + word.

## Open items

1. Partner name in README is a TODO (the human decides; don't invent one).
2. Live mode has never been run. Risks to watch when the human tests it: word positions sent to `/review/corrections` (mapped via `buildTokenMap` from the `words` list the server returns), and AI replies that aren't valid JSON (server falls back to a generic record).
3. One automated check (Undo right after delete) failed inside a long test run but passed on its own; worth one manual try.
4. Slides (max 10) and demo rehearsal.
