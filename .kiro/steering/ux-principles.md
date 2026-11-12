---
inclusion: always
---
# UX Principles for EasyBo Student Buddy

Audience: First-year to senior Filipino college students on phones and laptops. Assume they have never seen this app and will not read instructions.

## Rules
1. Every screen answers one question and has ONE primary hero action. Secondary actions use subtle ghost buttons or underlined links.
2. Organize by student tasks, not by technical data types. A student should know what to do within 5 seconds of opening any screen.
3. Plain language. No jargon ("KPI", "ledger", "OCR", "structured fields", "API", "vault"). Use: "Documents", "Payments", "Clearance", "Scan". English labels; Taglish only for friendly helper text and AI replies.
4. Typography: body 16px minimum, secondary text 14px minimum, never lighter than #475569 on light backgrounds (or #CBD5E1 on dark navy hero cards). Plus Jakarta Sans for UI and Peso amounts; JetBrains Mono ONLY for OR/reference numbers. Headings scale clearly (28/22/18px).
5. **Desktop Bento Layout & Spacing:** Max content container width `1360px` (centered) with `24px` grid gaps and `24px` card padding. On desktop (`>= 1024px`), NEVER stack everything in a narrow single column with empty right-hand dead space. Use an asymmetric 2-column dashboard grid (`grid-template-columns: 7fr 5fr`):
   - **Left Column (7fr):** Hero "Next Step" card on top, followed by the 3-column stat summary row (`Paid so far`, `Still to pay`, `Clearance`).
   - **Right Column (5fr):** "Recent Documents" receipt stack and a "Quick Scan / Ask EasyBo" shortcut card so the viewport feels balanced and complete.
6. **Distinct Navigation Chrome:** The desktop left sidebar (`260px` wide) must use `--paper-sidebar` (`#F3EDE0`) with a subtle right border (`1px solid #E7DFCF`) and a warm gradient active pill (`linear-gradient(90deg, #17305A, #23457A)`) so navigation is visually anchored away from the canvas.
7. Progressive disclosure: show summary first, details on click. Raw OCR text and word-level corrections stay collapsed under "View scanned text".
8. Developer/demo controls (Live API toggle, Load Demo Data, Reset) live in one "Demo tools" popover in the top header bar.
9. Every status uses color + icon + word (never color alone). Paid = green check, Due soon = amber clock, Overdue = red alert.
10. Every empty state has a clean SVG illustration, one friendly Taglish sentence, and one button that fixes it.
11. Every action gives feedback: toast, inline success state, or undo. Never use `alert()`/`prompt()`.
12. Mobile first: bottom tab bar on screens under 768px, fixed sidebar on desktop. Touch targets at least 44px.