---
inclusion: always
---
# UX Principles for EasyBo Student Buddy

Audience: first-year to senior Filipino college students on phones and laptops. Not developers. Assume they have never seen this app and will not read instructions.

## Rules
1. Every screen answers one question and has ONE primary button. Secondary actions are quiet text or ghost buttons.
2. Organize by student tasks, not by features or data types. A student should know what to do within 5 seconds of opening any screen.
3. Plain language. No jargon like "KPI", "ledger", "OCR", "structured fields", "API", "vault". Use: "Documents", "Payments", "Clearance", "Scan". Short sentences. English labels; Taglish only for friendly helper text and AI replies.
4. Typography: body 16px minimum, secondary text 14px minimum, never lighter than #475569 on white. Plus Jakarta Sans for everything including peso amounts. JetBrains Mono ONLY for OR/reference numbers. Headings clearly larger than body (24/20/16 scale).
5. Spacing: generous. 24px between cards, 24px card padding, max content width 1120px, max line length 70 characters.
6. Progressive disclosure: show the summary first, details on click. Raw OCR text, word-level corrections, and technical info are collapsed by default under "View scanned text".
7. Developer/demo controls (Live API toggle, Load Demo Data, Reset) live in one "Demo tools" popover, not in the main UI.
8. Every status uses color + icon + word (never color alone). Paid = green check, Due soon = amber clock, Overdue = red alert.
9. Every empty state has an illustration-free friendly message and one button that fixes it.
10. Every action gives feedback: toast, inline success state, or undo. Never use alert()/prompt().
11. Mobile first: bottom tab bar on screens under 768px, sidebar on desktop. Touch targets at least 44px.
12. Reduce, don't add. If a card or number does not help the student decide or act, remove it.