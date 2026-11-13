# EasyBo Student Buddy

**No more faded receipts.** EasyBo helps Filipino college students keep their school receipts and memos safe, understand them, and know what to do next.

Built for OVERCLOCK 2026 with **Lumen OCR** and **Lumen AI Chat**.

---

## The problem

Every semester, students juggle official receipts, statements of account, clearance memos and scholarship notices. The papers get lost, thermal receipts fade, and the instructions are written for offices, not students. A student who can't show an OR number at the Registrar, or misses a deadline buried in a memo, loses time, money, or an exam permit.

This hits hardest for first-year and working students who don't yet know how school offices work.

- **Who it's for:** college students in the Philippines, especially first-years.
- **Partner/s who could use it:** School's Office of Student Affairs/Student Success Office, Registrars

## The solution

EasyBo turns a photo of a school paper into an organized record and a to-do list.

1. **Upload.** Upload a photo or PDF, or try a built-in sample paper.
2. **Automatic fill and save.** EasyBo fills in the title, type, reference number, amounts, deadline and checklist by itself. Lumen AI Chat organizes the text, and the server reads labels like "OR No.", "Amount Paid" and "Balance due on" to fill anything the AI missed. When nothing looks doubtful, the document is **saved to My Documents automatically**, with nothing to type.
3. **Summary.** EasyBo explains what the document is about: an overview plus key points (type, issuing office, amounts, deadline, next action). From here the student can view it, **Review details**, scan another, or choose **Don't keep this document**.
4. **Ask about this document.** A chat box under the document answers questions such as "How much is left to pay?" or "When is the deadline?" on the device. Other questions go to Lumen AI Chat with only that document as context.
5. **Check (only when needed).** If a value looks misread (for example the letter O in `OR-2O26-99412`) or the paper looks like one already saved, EasyBo doesn't save it automatically. It asks the student to review it first. Doubtful fields are marked **Please check**; the student fixes them or confirms them with **Looks right**. Tapping a misread word sends the correction back to Lumen.

A short **tutorial** is offered the first time a student signs in. It can be skipped, exited at any step, and replayed from **Demo tools → Show tutorial**.

After saving:

- **Home:** the most urgent next step, what's been paid, what's still owed, and clearance progress.
- **My Documents:** searchable receipt-style cards. Each one opens to the original photo, payment history, Edit, Add to calendar, Print and Download.
- **Clearance & Payments:** a payment history table, and requirements grouped by office (Cashier, Library, Registrar) with a printable checklist.
- **Ask EasyBo:** a chat assistant. Questions about balance, deadlines, clearance, OR numbers and payments are answered from the student's own records without calling Lumen. Open-ended questions go to Lumen AI Chat.
- **Safeguards:**
  - A warning when the same receipt is scanned twice.
  - Undo for edits and deletes.
  - Work saved offline syncs when the connection returns.

## How we use Lumen

| Lumen tool                                                                                                         | Where                                 | What it does                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------- |
| **Lumen OCR**: `POST /ocr/documents`, `GET /ocr/documents/{id}`, `GET /ocr/documents/{id}/pages?IncludeWords=true` | Scan step                             | Reads the photo or PDF and returns the text and word positions                |
| **Lumen OCR review**: `POST /ocr/documents/{id}/review/corrections`                                                | "View scanned text" on the Check step | Sends each word the student corrects back to Lumen                            |
| **Lumen AI Chat**: sessions and messages                                                                           | Summary and Check steps               | Turns the scanned text into fields, a file summary and a checklist (one call) |
| **Lumen AI Chat**                                                                                                  | Ask EasyBo                            | Answers open-ended questions using the student's saved documents              |

**How it saves credits:**

- Common questions are answered on the device.
- Each student gets their own chat session.
- Organizing a document uses a fresh session.
- **Mock Mode** runs the whole app on built-in sample results with no Lumen calls.

## UN Sustainable Development Goals

- **SDG 4: Quality Education.** Fewer students lose exam permits or enrollment slots because of lost papers or missed deadlines.
- **SDG 10: Reduced Inequalities.** First-year, working and first-generation students get the same plain-language guidance that students with experienced family support already have.

## How to run

Requires **Node.js 18 or newer**.

```bash
git clone https://github.com/JCedilla/overclock2026-easybo.git
cd overclock2026-easybo
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm start
```

Open **http://localhost:3000**, then choose **Continue as Juan** or **Continue as Maria** (demo profiles, no password).

- **Mock Mode (default, no credits):** `MOCK_MODE=true` in `.env`.
- **Live mode:**
  1. Put your own `LUMEN_API_KEY` and `LUMEN_API_SECRET` in `.env`.
  2. Restart the server.
  3. Switch to Live in **Demo tools**. The app asks you to confirm first.
- **Never commit `.env`.** It is git-ignored.

**Demo tools** (top bar) has Show tutorial, Load Demo Data, Reset Demo, the Mock/Live switch and Dark theme.

### Two-minute demo (Mock Mode)

1. Go to **Scan → Clearance memo**. It is read, filled in and saved automatically. Ask "What do I need to do?" in **Ask about this document**.
2. Go to **Scan → Sample receipt**. Its reference number looks misread, so EasyBo asks for a review. Press **Review and save**.
3. Open **View scanned text**, tap `OR-2O26-99412`, change the letter O to a zero, and confirm.
4. Press **Looks right, continue → Save to My Documents**.
5. On **Home**, press **Mark as paid**.
6. In **Ask EasyBo**, try "How much do I still owe?"
7. Scan the same sample again to see the duplicate warning.

## Project structure

```
server.js            Express server: Lumen OCR + AI Chat proxy, Mock Mode, records and photo storage
public/index.html    App shell (sidebar, top bar, welcome screen)
public/app.js        All screens and logic (vanilla JS, no build step)
public/styles.css    "Papel" theme
public/brand/        Logo and favicon
.kiro/steering/      Brand and UX rules that Kiro follows when editing this project
```

| Route                                          | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| `GET /api/config`, `POST /api/config/mock`     | Mock/Live status and switch                            |
| `POST /api/ocr/upload`                         | Upload, poll and read pages with Lumen OCR             |
| `POST /api/ocr/correct`                        | Send a word correction to Lumen OCR review             |
| `POST /api/chat/organize`                      | Structure verified text with Lumen AI Chat             |
| `POST /api/chat/ask`                           | Answer a question with Lumen AI Chat                   |
| `GET/POST/PUT /api/records`                    | Load and save a student's records (`vault-db.json`)    |
| `POST /api/images`, `DELETE /api/images/:name` | Store or remove the original photo or PDF (`uploads/`) |

## Notes and limits

- **Local demo storage:** records live in `vault-db.json` and photos in `uploads/`. Both are created on first run and git-ignored. A real deployment would need student accounts and proper storage.
- **Credentials:** API keys stay on the server in `.env` and are never sent to the browser.

---

## Status and to-do for finalization

**Done and tested in Mock Mode:**

- **The full flow:** scan, check, save, pay, ask.
- **Review gate and word corrections.**
- **Data and safety:**
  - Duplicate warning.
  - Payment history.
  - Edit and delete with Undo.
  - Offline sync.
  - Live-mode confirmation.
- **Extras:** photo storage, calendar export, printable checklist, sample papers.
- **Layout:** phone, tablet and desktop layouts, light and dark themes.

**Still to do:**

- [ ] Fill in the **partner** line above.
- [ ] **Test Live mode** with one or two real receipts (uses credits). Check these:
  - Fields fill in correctly.
  - A word correction is accepted by Lumen.
  - Ask EasyBo replies.
- [ ] Prepare the **slides** (max 10): problem, who it's for, demo, how Lumen is used, correction feature, SDGs and partner, what's next.
- [ ] Rehearse the demo in Mock Mode as a fallback in case the venue Wi-Fi fails.
- [ ] Commit in small steps with clear messages. Commit history is checked.
