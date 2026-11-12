---
inclusion: always
---
# EasyBo Brand & Theme: "Papel"

Concept: the app is built around receipts, so the visual language borrows from paper receipts, stamps, and school forms, made friendly and modern. This must feel like its own product, not a generic SaaS dashboard.

Personality: a helpful classmate (kuya/ate). Calm, encouraging, never preachy. Short Taglish sentences.
Voice examples: "Wala nang kupas na resibo." / "Naka-save na! Safe na ang resibo mo." / "Pakicheck muna bago i-save."

## Tokens (replace the old indigo/slate palette everywhere)
--paper: #FBF7EF   (page background, warm)
--card: #FFFFFF
--ink: #1B2A41     (text)
--ink-soft: #475569 (secondary text, never lighter)
--brand: #17305A   (deep navy: primary buttons, active nav, logo)
--accent: #F5B700  (marigold: logo check, highlights, focus accents ONLY, never a status color)
--paid: #15803D    --due: #C2410C    --overdue: #B91C1C
--line: #E7DFCF    (warm borders, dashed dividers)
Map these in the Tailwind CDN config so utility classes use them.

## Type
Headings: Fraunces 600 (warm, academic). Body and UI: Plus Jakarta Sans. JetBrains Mono ONLY for OR/reference numbers.

## Signature elements (use consistently, don't overdo)
1. Document cards look like receipts: white card, zigzag/perforated bottom edge, dashed dividers, OR number in mono.
2. Stamp chips for document status (PAID, MAY BALANCE, PAKICHECK): bordered uppercase label, rotated about -3deg. Use only on document cards and the detail drawer.
3. Logo: a receipt with a torn bottom edge containing a checkmark; navy receipt, marigold check. Wordmark "EasyBo" in Fraunces, "Student Buddy" small beneath. Provide as inline SVG, a favicon, and public/brand/logo.svg.
4. Scan step shows a subtle receipt "printing" animation. Respect prefers-reduced-motion.
5. Empty states: a simple line SVG (receipt or folder) with one Taglish sentence and one button.
6. Welcome screen: logo, tagline, "Continue as Juan" / "Continue as Maria" (demo profiles, no password). No school, partner, or SDG badges.

## Don'ts
No gradients, glassmorphism, emoji as icons, heavy shadows, or more than one accent color. Contrast and readability rules in ux-principles.md always win over decoration.