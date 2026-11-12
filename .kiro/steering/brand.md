---
inclusion: always
---
# EasyBo Brand & Theme: "Papel" (Tactile & Dimensional)

Concept: The app is built around receipts, school forms, and physical stamps, elevated with warm paper textures, subtle theme-native gradients, and tactile depth. It must feel like a crafted student tool, never a flat white box or a neon AI template.

Personality: A helpful classmate (kuya/ate). Calm, encouraging, never preachy. Short Taglish sentences.
Voice examples: "Wala nang kupas na resibo." / "Naka-save na! Safe na ang resibo mo." / "Pakicheck muna bago i-save."

## Tokens & Gradients (CSS variables in public/styles.css; the app does not use Tailwind)
--paper: #FBF7EF         (base page background)
--paper-sidebar: #F3EDE0 (warmer, slightly deeper tone for sidebar separation)
--card: #FFFFFF
--ink: #1B2A41           (primary text)
--ink-soft: #475569      (secondary text, never lighter)
--brand: #17305A         (deep navy: active states, primary elements)
--brand-deep: #0F203C    (gradient anchor for dark hero cards)
--accent: #F5B700        (marigold: logo check, highlights, hero button; never a status color)
--paid: #15803D    --due: #C2410C    --overdue: #B91C1C
--line: #E7DFCF          (warm borders, dashed dividers)

## Required Gradients & Tactile Surfaces
1. **Page Background Mesh & Grain:** Base `--paper` with a soft warm radial glow (`radial-gradient(circle at 15% 10%, rgba(245, 183, 0, 0.09), transparent 45%), radial-gradient(circle at 85% 85%, rgba(23, 48, 90, 0.05), transparent 50%)`) plus a subtle 24px dot-matrix or paper grain pattern (`radial-gradient(#D8CEBE 1px, transparent 1px)` at `background-size: 20px 20px`).
2. **Hero "Next Step" Card:** Deep navy gradient (`linear-gradient(135deg, #17305A 0%, #0F203C 100%)`) with crisp white text, a marigold (`#F5B700`) primary button with dark ink text (`#1B2A41`), and a faint watermark SVG in the bottom-right corner.
3. **Typography Gradients:** Main page greetings and large Peso summary numbers use a rich ink-to-navy gradient (`background: linear-gradient(90deg, #1B2A41 0%, #2B4C7E 100%); -webkit-background-clip: text; color: transparent;`). Highlight the student's first name with a bottom marigold marker accent (`box-shadow: inset 0 -0.35em 0 rgba(245, 183, 0, 0.35)`).
4. **Stat Card Semantic Tints:** Top-down subtle tint gradients on summary cards (`linear-gradient(180deg, rgba(21, 128, 61, 0.05) 0%, #FFFFFF 60%)` for Paid, amber tint for Still to pay, navy tint for Clearance) paired with a `3px solid` colored top accent bar.
5. **Tactile Paper Shadows:** All cards use layered warm shadows (`0 8px 20px -4px rgba(27, 42, 65, 0.07), 0 2px 6px -1px rgba(27, 42, 65, 0.04)`) and lift `translateY(-2px)` on hover.

## Type
Headings: Fraunces 600/700 (warm, academic). Body and UI: Plus Jakarta Sans. JetBrains Mono ONLY for OR/reference numbers.

## Signature Elements
1. **Receipt Cards:** White cards with a pronounced CSS zigzag/serrated bottom edge, circular side ticket cutouts (`radial-gradient` notches) along a `2px dashed #E7DFCF` divider line, and OR numbers in JetBrains Mono.
2. **Rubber Stamp Chips:** Status badges (PAID, MAY BALANCE, PAKICHECK) use a double-border stamp look (`border: 2px solid`, `outline: 1px solid` with `outline-offset: 2px`), uppercase bold tracking, `rotate(-3deg)`, and a 10% tinted background fill.
3. **Logo:** Receipt with a torn bottom edge containing a marigold checkmark on deep navy. Wordmark "EasyBo" in Fraunces, "Student Buddy" small beneath.
4. **Scan Animation:** Subtle receipt "printing" animation respecting `prefers-reduced-motion`.
5. **Empty States:** Simple line SVG (receipt or folder) with one Taglish sentence and one button.
6. **Welcome Screen:** Logo, tagline, "Continue as Juan" / "Continue as Maria" (demo profiles, no password).

## Don'ts
No neon/cyberpunk/purple gradients, no blurry glassmorphism that lowers contrast, no emoji as icons. Contrast and readability rules in `ux-principles.md` always win.