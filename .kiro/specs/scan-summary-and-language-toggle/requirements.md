# Requirements Document

## Introduction

This feature puts the summary first on the Scan flow of EasyBo Student Buddy. Every upload now goes Upload → Summary → Check → Save. Right after the paper is read, the Scanner shows a new Summary step with a "Tungkol saan ang file na ito" card that explains in plain words what the paper is, who issued it, what it asks the student to do, and the key amounts and dates. The summary is written in the app's existing Taglish voice, the same style as today's `taglishSummary`. Below the summary the student picks one of two choices: "I-save sa My Documents" (continues to the existing Check step with fields, Pakicheck flags and word corrections, then Save) or "Tapos na, huwag i-save" (ends the scan with nothing saved). When the student saves, the summary is saved with the record.

Scope is kept tight for the 2:00 PM code freeze. The feature reuses the existing `/api/chat/organize` call (no extra Lumen calls per scan), adds no build step or framework, and works fully in Mock Mode.

Notes from the current code (`public/app.js`, `server.js`):

- `processFile()` already calls `/api/chat/organize` once, right after `/api/ocr/upload` returns, on the OCR text and before the student sees the Check step. The request body field is named `verifiedText` but holds unverified OCR text. Word corrections (`saveWord()`) call only `/api/ocr/correct` and do not call the Organizer again. This feature keeps that single call and uses its result for both the Summary step and the Check step.
- The uploaded file is held in browser memory until save. `/api/ocr/upload` uses multer memory storage and writes no file to disk, and `saveScan()` sends the image to `POST /api/images` only when the student saves. "Tapos na, huwag i-save" therefore needs no image cleanup on the server.
- The current stepper is built from `STEP_LABELS = ["Upload", "Check", "Save"]` in `viewScanner()`, with step lines between steps and all steps marked done on the Saved screen.
- The duplicate warning ("Mukhang na-save mo na ito.") is built by `dupHtml()` and shown only on the Check step.
- In Mock_Mode the server picks built-in sample text by file name (`mockOcrText()` in `server.js`), so the summary describes that sample text, not the real contents of the uploaded file.

Assumptions to confirm with the user:

- The "type the details without a file" path (`skip-upload`) has no scanned text, so it skips the Summary step and opens the Check step directly, as today.
- The Check step shows only a compact summary (overview line and "I-update ang summary"), not the full Summary_Card again.

## Glossary

- **EasyBo**: The EasyBo Student Buddy web app as a whole (`public/index.html`, `public/app.js`, `public/styles.css`, `server.js`).
- **Scanner**: The Scan view of EasyBo (`viewScanner`) with its steps in this order: Upload (`scanStep1`), Summary_Step, Check (`scanStep2`), Save (`scanStep3`) and Saved (`scanSaved`).
- **Summary_Step**: The new Scanner step shown right after the Organizer returns for an uploaded file. The Summary_Step shows the Summary_Card and the two choices "I-save sa My Documents" and "Tapos na, huwag i-save", and shows no record fields, Pakicheck flags or duplicate warning.
- **Check_Step**: The existing Scanner step (`scanStep2`) with the record fields, Pakicheck flags, scanned-text word corrections and duplicate warning.
- **Organizer**: The server route `POST /api/chat/organize`, which turns scanned text into record fields using Lumen AI Chat in Live mode or `mockOrganize()` in Mock_Mode.
- **Scanned_Text**: The text the Organizer receives: the OCR text returned by `/api/ocr/upload` for the first request, or the text including the student's word corrections for a request started by "I-update ang summary".
- **File_Summary**: A plain-language Taglish explanation of one scanned file, made of a short overview paragraph plus key points (document type, issuing office, what the student must do, key amounts, key dates).
- **Summary_Card**: The "Tungkol saan ang file na ito" card that displays the File_Summary on the Summary_Step.
- **Compact_Summary**: The short summary block on the Check_Step that shows the File_Summary overview and the "I-update ang summary" action.
- **Record**: One saved document in a student's records, with the fields defined in `project-handoff.md` (`id, title, category, referenceNo, amountPaid, balanceDue, deadline, summary, studyNotes[], tasks[], payments[], ...`).
- **Legacy_Record**: A Record that has a single `summary` string and no structured File_Summary, either because it was saved before this feature or because no File_Summary was available when it was saved.
- **Mock_Mode**: The server mode (`MOCK_MODE=true`) in which EasyBo returns built-in sample results and makes no Lumen calls.
- **Device_Storage**: The browser `localStorage` of the current device.

## Requirements

### Requirement 1: Generate a file summary for each scanned file

**User Story:** As a student, I want EasyBo to explain what my scanned paper is about, so that I understand it without reading office wording.

#### Acceptance Criteria

1. WHEN the Organizer processes Scanned_Text, THE Organizer SHALL return one File_Summary, written in the same Taglish voice as the `taglishSummary` field, in the same response as the structured record.
2. THE Organizer SHALL include in the File_Summary one non-empty overview of 1 to 3 sentences and a list of 2 to 5 key points, where each key point is a non-empty string.
3. THE Organizer SHALL include in the File_Summary's key points the following items: the document type, matching the record's category value; the issuing office, when the Scanned_Text contains a line naming an office (for example, "OFFICE OF THE UNIVERSITY REGISTRAR"); the action the student must take; and every non-zero amountPaid and balanceDue value plus every date and deadline value in the returned record that is not "None".
4. IF the returned record has no checklist items and a balanceDue of 0, THEN THE Organizer SHALL include a key point in the File_Summary stating that the student does not need to do anything.
5. THE Organizer SHALL write every amount in the File_Summary as a peso amount with comma thousands separators and 2 decimal places (for example, ₱1,250.00), and every date in the month-name, day, year form (for example, November 24, 2026).
6. WHILE Mock_Mode is on, WHEN the Organizer processes Scanned_Text, THE Organizer SHALL build the File_Summary from that text using the built-in template that matches the record category: the receipt template for "Receipt & Tuition", the clearance memo template for "Enrollment & Clearance", the scholarship notice template for "Scholarship", and a general template for "Class Note & Memo".
7. WHILE Mock_Mode is on, THE Organizer SHALL produce the File_Summary without sending any request to Lumen.
8. WHEN the Organizer runs in Live mode, THE Organizer SHALL ask for the File_Summary in the existing single Lumen AI Chat organize message and SHALL NOT send a second Lumen AI Chat message for the summary.
9. IF the Lumen AI Chat reply cannot be parsed into a record, or the parsed reply lacks a File_Summary, or the File_Summary has an empty overview or fewer than 2 key points, THEN THE Organizer SHALL replace the File_Summary with a template File_Summary built from the returned record fields, and SHALL return the response without an error.

### Requirement 2: Show the summary first, then let the student choose

**User Story:** As a student, I want to read what my paper is about right after uploading it, so that I can decide whether to save it to My Documents.

#### Acceptance Criteria

1. THE Scanner SHALL show a step indicator with four steps in this order: Upload, Summary, Check, Save, and SHALL mark the step currently shown as current and every step before it as done.
2. WHEN the student uploads a photo or PDF or picks a sample paper on the Upload step, THE Scanner SHALL show the Summary_Step as the current step, send one OCR request, and, only after the OCR request succeeds with OCR text that contains at least one non-whitespace character, send exactly one Organizer request with the OCR text as the Scanned_Text.
3. WHILE the OCR request or the first Organizer request is pending, THE Scanner SHALL display a loading state on the Summary_Step with a text label that names the current stage ("reading the file" while the OCR request is pending, "preparing the summary" while the Organizer request is pending), and SHALL display neither the "I-save sa My Documents" button nor the "Tapos na, huwag i-save" button.
4. WHEN the first Organizer request returns a File_Summary that contains at least one non-whitespace character, THE Scanner SHALL display the Summary_Card on the Summary_Step with the heading "Tungkol saan ang file na ito", followed by the overview and all key points of the File_Summary.
5. WHEN the Summary_Step finishes loading after a successful OCR request, THE Scanner SHALL display below the Summary_Card a primary button labeled "I-save sa My Documents" and a secondary button labeled "Tapos na, huwag i-save".
6. WHILE the Summary_Step is shown, THE Scanner SHALL display no record fields, Pakicheck flags, scanned-text word editor or duplicate warning.
7. WHEN the student selects "I-save sa My Documents" on the Summary_Step, THE Scanner SHALL show the Check_Step and SHALL send no Organizer request. IF the first Organizer request succeeded, THEN every field SHALL be filled from that same response. IF it failed or was not sent, THEN the Scanned_Text SHALL be set to the OCR text and all record fields SHALL be empty.
8. IF the first Organizer request fails with a network error or an error response, or returns an empty or whitespace-only File_Summary, or the OCR text is empty or whitespace-only (in which case no Organizer request is sent), THEN THE Scanner SHALL display a message in the Summary_Card saying that the summary is unavailable, and SHALL still offer "I-save sa My Documents" as the primary button and "Tapos na, huwag i-save" as the secondary button.
9. IF the OCR request fails, THEN THE Scanner SHALL display an OCR error message on the Summary_Step, with a primary button to try reading the file again and "Tapos na, huwag i-save" as the secondary button; WHEN the student selects try again, THE Scanner SHALL resend the OCR request for the same file without asking the student to upload it again, and SHALL then follow criteria 2 to 8.
10. WHEN the student chooses to type the details without a file on the Upload step, THE Scanner SHALL open the Check_Step directly, skip the Summary_Step, and send no OCR or Organizer request.
11. WHEN the student reaches the Save step (scanStep3) and a File_Summary with at least one non-whitespace character is available, THE Scanner SHALL display the File_Summary under the Summary_Card heading in place of the current "What this means" section.
12. IF no File_Summary with at least one non-whitespace character is available when the student reaches the Save step (scanStep3), THEN THE Scanner SHALL omit the Summary_Card section from the Save step.
13. WHEN the Scanner renders a File_Summary on the Summary_Step, the Check_Step or the Save step, THE Scanner SHALL pass all File_Summary text through esc() before inserting it into the page, so that HTML in the File_Summary (for example `<script>` or `<img>` tags) shows as literal text and does not run or render.
14. THE Summary_Card and the Compact_Summary SHALL use body text of at least 16px and a text-to-background contrast ratio of at least 4.5:1 in both light and dark themes, and every button on the Summary_Step and the "I-update ang summary" action SHALL have a touch target of at least 44px by 44px.
15. THE Scanner SHALL show exactly one primary button on each Scan step (Upload, Summary_Step, Check_Step, Save and Saved) once that step has finished loading.
16. WHEN the Saved screen is shown, THE Scanner SHALL mark all four steps of the step indicator as done.

### Requirement 3: Update the summary on the Check step

**User Story:** As a student, I want to refresh the summary after I fix misread details, so that the saved explanation matches my corrections.

#### Acceptance Criteria

1. WHILE a File_Summary is available, THE Scanner SHALL display the Compact_Summary on the Check_Step, showing only the File_Summary overview.
2. WHEN the student saves a corrected field or a corrected word on the Check_Step, THE Scanner SHALL keep the Compact_Summary text unchanged and SHALL send no Organizer request until the student selects "I-update ang summary".
3. WHILE at least one of title, category, amount paid, balance due or deadline on the Check_Step differs from the value it had when the current File_Summary was received, or at least one word correction has been saved since the current File_Summary was received, THE Scanner SHALL display "I-update ang summary" in the Compact_Summary as a secondary button that is not styled as the step's primary button, where text fields count as different only after leading and trailing whitespace is trimmed and amounts count as different only when their numeric values differ.
4. WHILE none of the conditions in criterion 3 hold, including after the student reverts every changed field to the value it had when the current File_Summary was received and has saved no word correction since then, THE Scanner SHALL hide the "I-update ang summary" button.
5. WHEN the student selects "I-update ang summary", THE Scanner SHALL send exactly one Organizer request (POST /api/chat/organize) with the Scanned_Text including all saved word corrections, and on success SHALL replace only the stored File_Summary with the returned File_Summary, SHALL leave the student's corrected title, category, amounts, deadline and Pakicheck review state unchanged, and SHALL use the current field values and word corrections as the new baseline for criterion 3.
6. WHILE a request started by "I-update ang summary" is pending, THE Scanner SHALL display a loading label in the Compact_Summary, SHALL disable the "I-update ang summary" button so that repeated selections send no additional request, and SHALL keep the Check_Step fields editable and the Check_Step's primary button enabled.
7. IF a request started by "I-update ang summary" returns an error, receives no response within 60 seconds, or returns an empty or whitespace-only File_Summary, THEN THE Scanner SHALL keep the previous File_Summary and all Check_Step field values, SHALL display a message in the Compact_Summary saying that the update failed, and SHALL enable "I-update ang summary" again, removing the failure message when the student next selects "I-update ang summary".
8. WHILE no File_Summary is available on the Check_Step, THE Scanner SHALL hide the Compact_Summary and the "I-update ang summary" button, SHALL keep every Check_Step field as entered, and SHALL keep the Check_Step's primary button enabled so the student can continue to the Save step.
9. WHILE Mock_Mode is on, WHEN the student selects "I-update ang summary", THE Organizer SHALL return a non-empty mock File_Summary with zero Lumen calls, and THE Scanner SHALL apply the same loading, success and baseline behavior as criteria 5 and 6.

### Requirement 4: Keep existing behavior and credit use unchanged

**User Story:** As a team member preparing the demo, I want the new feature to leave the existing flow intact, so that the two-minute demo still works before code freeze.

#### Acceptance Criteria

1. WHEN the student submits a scanned file in Live mode, THE Organizer SHALL make at most one Lumen AI Chat organize call (`POST /api/chat/organize`) for that file, sent after OCR and before the Summary_Step shows its result, and THE Scanner SHALL send no further organize call when the student moves from the Summary_Step to the Check_Step, saves a word correction, or saves a field correction. Calls the student starts with "I-update ang summary" and Ask EasyBo calls to `POST /api/chat/ask` do not count toward this limit.
2. WHILE Mock_Mode is on, THE Organizer SHALL make zero Lumen calls for any scanned file, including calls started with "I-update ang summary".
3. THE EasyBo SHALL keep these existing behaviors unchanged: the Pakicheck review gate blocks continuing from the Check_Step to the Save step until every flagged field is fixed or confirmed with "Tama ito"; tapping a misread word in the scanned text on the Check_Step and confirming the fix sends the correction to Lumen OCR review through `POST /api/ocr/correct`; a duplicate warning appears on the Check_Step when the student scans a paper that matches a saved Record by reference number, or by file name and title; Undo restores the Record after an edit or a delete; and changes saved while offline stay on the device and sync to the server when the connection returns.
4. WHILE Mock_Mode is on, THE EasyBo SHALL show the sample receipt reference number exactly as `OR-2O26-99412`, with the letter O in the fourth character of the year and no automatic correction, on the Check_Step.
5. THE EasyBo SHALL run by starting `server.js` with Node and loading `public/index.html`, with no build step and no frontend framework, and with no entries added to `dependencies` or `devDependencies` in `package.json`.
6. WHEN `node --check public/app.js` and `node --check server.js` run, THE EasyBo source files SHALL pass both checks with exit code 0 and no syntax errors reported.
7. WHEN the Organizer returns a result, THE Organizer SHALL return every record field it returned before this feature (`title, category, referenceNo, date, amountPaid, balanceDue, deadline, taglishSummary, studyNotes, checklist`) with the same names and value formats, SHALL keep accepting the request body field `verifiedText`, and SHALL add the File_Summary as an extra field only.
8. WHILE Mock_Mode is on, WHEN a team member runs the demo flow (scan the sample receipt, read the Summary_Step, select "I-save sa My Documents", correct `OR-2O26-99412` on the Check_Step, save, open the Record in My Documents), THE EasyBo SHALL complete every step without an error toast, an uncaught browser console error or a page reload.

### Requirement 5: Save the file summary with the record

**User Story:** As a student, I want the explanation saved with my document, so that I can read it again later.

#### Acceptance Criteria

1. WHEN the student saves a scanned file for which the Organizer returned a File_Summary, THE EasyBo SHALL store the File_Summary on the Record, with its overview and its key points in the order the Organizer returned them.
2. WHEN the student saves a scanned file for which the Organizer returned a File_Summary, THE EasyBo SHALL set the Record `summary` field to the File_Summary overview text, so that existing search, print, download and Ask EasyBo features keep reading the `summary` field without changes.
3. WHEN the document drawer in My Documents opens a Record that has a File_Summary, THE EasyBo SHALL display the overview and all key points of the File_Summary, with all File_Summary text escaped before it is inserted into the page.
4. WHEN the student prints or downloads a Record that has a File_Summary, THE EasyBo SHALL include the overview and all key points of the File_Summary.
5. WHEN the EasyBo displays, prints or downloads a Legacy_Record, THE EasyBo SHALL show the Legacy_Record `summary` text unchanged, and SHALL NOT show an error or an empty summary area.
6. FOR ALL Records with a File_Summary, saving the Record to the device cache and to the server vault-db.json through `addRecord()` or `syncRecords()` and then loading it again SHALL return the File_Summary with identical overview text and identical key points in the same order (round-trip property).
7. WHEN the student searches My Documents, THE EasyBo SHALL match the search text against the `summary` field and against the File_Summary overview and key points of each Record, using the same matching rule that existing search applies to the `summary` field.
8. IF the student saves a scanned file for which the Organizer returned no File_Summary (Requirement 2, criterion 8, or the type-it-in path in Requirement 2, criterion 10), THEN THE EasyBo SHALL save the Record without a File_Summary, keep all other entered field values, and handle the Record as a Legacy_Record from then on.

### Requirement 6: Finish a scan without saving

**User Story:** As a student, I want to read a paper's summary and leave without saving, so that My Documents only holds papers I chose to keep.

#### Acceptance Criteria

1. WHEN the student selects "Tapos na, huwag i-save" on the Summary_Step, THE Scanner SHALL clear the scan state (the file input value, the file preview, the Scanned_Text and the File_Summary) and SHALL show the Upload step with no file selected and the step indicator on Upload.
2. WHEN the student selects "Tapos na, huwag i-save", THE EasyBo SHALL create no Record and SHALL send no request to `/api/records` or `POST /api/images` for that scan.
3. WHEN the student selects "Tapos na, huwag i-save", THE EasyBo SHALL leave the records in the device cache and in the server vault-db.json unchanged, and SHALL add no file to the server uploads folder for that scan.
4. WHEN the student selects "Tapos na, huwag i-save", THE Scanner SHALL release the browser preview of the uploaded file and keep no copy of the file, its Scanned_Text or its File_Summary in Device_Storage.
5. WHEN the student selects "Tapos na, huwag i-save", THE EasyBo SHALL show exactly one toast through toast() stating that the file was not saved.
6. IF the student selects "Tapos na, huwag i-save" again within the same scan before the Upload step is shown, THEN THE EasyBo SHALL ignore the repeat selection and show no additional toast.
7. FOR ALL scans that end with "Tapos na, huwag i-save", the list of Records for the selected student SHALL be identical before the upload and after the Upload step is shown again (invariant property).
8. WHILE Mock_Mode is on, WHEN the student selects "Tapos na, huwag i-save", THE EasyBo SHALL make zero Lumen calls.
