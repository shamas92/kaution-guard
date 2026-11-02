# KautionGuard

**A cross-border tenant legal auditor and multimodal deposit-evidence workspace** for international students and expats renting in **Berlin, London, Paris, New York, and Tokyo** — built for the Meta Global AI Developer Hackathon.

KautionGuard pairs two workflows that are usually separate: a **zero-hallucination contract decoder** that checks a lease against the statute book of its jurisdiction, and a **SAM 3.1 evidence shield** that turns move-in photos and narrated walkthroughs into tamper-evident, measurable records a tenant can actually use in a deposit dispute. Supported jurisdictions: **DE, UK, US_NY (New York), FR, JP**, plus **GLOBAL_AUTO** detection. Findings and explanations are always shown in English; statute and case names stay in their original language; objection letters are drafted bilingually (jurisdiction language + tenant language: DE / EN / FR / JA).

Everything the app claims is checked before it is shown: model-flagged quotes must verify **verbatim** against the lease text, citations must exist in the jurisdiction registry, deposit-cap arithmetic is done by deterministic Python — never by the model — and every evidence record carries a SHA-256 hash. Outputs are preliminary and are not legal advice.

## Try it in three minutes (no files of your own needed)

The app has three steps — **Contract Review** (`/contract`), **Evidence** (`/evidence`), and **Move-Out** (`/move-out`) — under a shell with a live Case Dossier ribbon that tracks your progress across all three.

1. **Contract:** pick a demo preset (Germany, UK, or France) or attach the sample dorm contract, then **Decode Contract**. Findings appear only after each quote is verified verbatim and each citation is grounded; if the lease states its rent and deposit, a **Statutory Deposit Cap Audit** banner shows the arithmetic, and the **Visual Annotated Contract** view highlights each verified quote on the rendered lease pages. Pick a finding and **Draft Objection for This Clause** to get a bilingual notice.
2. **Evidence:** use the one-click quick-pickers (open wall socket, table burn, narrated or silent dorm walkthrough) or attach your own photo/video. **Highlight the damage** outlines a defect with SAM 3.1 — by concept phrase, clicked points, or automatic discovery — and **Check my video** transcribes the narration and segments the defects it names. Save an outline as a move-in reference (it stays in your browser).
3. **Move-out:** attach the move-out photo (the burn-crop chip is the camera-shift demo), pick the saved reference, and compare: the registered IoU, the camera-shift compensation badge, and a curtain slider that wipes between the move-in and move-out outlines.
4. **Export:** once any step has data, the ribbon's **📄 Export Master Dossier PDF ($0.00)** assembles the audit, the objection letters, the evidence references, and the move-out comparison into one locally generated, hash-sealed PDF.

## Step 1 — Zero-hallucination contract decoder

- **Upload** a lease as a PDF or a JPG/PNG photo. Text comes from the PDF's embedded layer (pypdf). Scanned or photographed leases go through OCR: pages are rendered with `pdftoppm` (200 dpi) and read by local **Tesseract 5.3.4** first, with a vision-model transcription as fallback. The response's `extraction` field (`embedded-text` / `ocr` / `ocr-vision`) discloses which path produced the text.
- **Deterministic verification.** The chat model (Baseten, `meta-models/muse-spark-open-1026`) proposes findings; a Python validator then checks **every** `evidence_quote` as a verbatim substring of the extracted text and **every** citation against `backend/jurisdictions/registry.json`. Unverifiable findings are marked, never silently presented as fact. The final list is sorted deterministically (verified first, then severity, then flagged amounts) and deduplicated by quote.
- **Statutory Deposit Cap Audit (deterministic math, $0 model cost).** When a lease unambiguously labels its cold/base rent and its deposit, the backend computes the statutory ceiling for the jurisdiction — DE **§ 551 BGB**: 3 × cold rent; UK **Tenant Fees Act 2019**: 5 weeks' rent (annual rent under £50,000); FR **Loi n° 89-462 du 6 juillet 1989, art. 22**: 1 month (unfurnished); US_NY **NY GOL § 7-108**: 1 month — and reports base rent, stated deposit, cap, and excess. The banner shows a green *Within Statutory Cap* or a red *Above Statutory Cap* badge, and **Add Math Proof to Objection Letter** appends the arithmetic to your dispute facts. If the figures are not clearly labelled, no math is shown rather than guessed.
- **Visual Annotated Contract.** Verified quotes are located on the rendered lease pages with **exact text-line coordinates** taken from the PDF text layer itself (pypdf text-position fragments, with whitespace, typographic-quote, hyphen, and umlaut/eszett normalisation so multi-line quotes match). Highlights render as overlays on the first 3–5 pages with two-way click ⇄ pulse navigation between the findings list and the page. For scans and photos, quotes are located via Tesseract word boxes; a quote that cannot be located is drawn as an explicitly labelled estimated band instead of a fake precise box.
- **Bilingual drafting.** Objection notices are drafted in the jurisdiction's official language and the tenant's chosen language. Findings summaries are always in English; the quoted lease text is never translated.

## Step 2 — Multimodal evidence shield

- **Photo check.** Segment a defect with **SAM 3.1** (Meta Model API) by concept phrase or by clicking points on the photo. With no prompt, the chat model inspects the photo and auto-discovers defects — including **fixture/absence defects** such as a missing socket cover, a dent, or burn marks — through a candidate chain (concept phrases, then centre-point clicks) guarded by a 60%-of-frame specificity rule and a rejection of full-width floor/carpet strips when a fixture candidate exists. A miss is reported as a miss; the app never fabricates a mask.
- **Walkthrough video.** Up to 3 sampled keyframes are segmented while **Muse Voice Transcribe 1.0** transcribes the narration. The transcript **guides** segmentation: a deterministic lexicon spots defect phrases, hazard cues (electrical/socket) are tried first, and when ASR merges several sentences into one long segment, its cues are distributed across the keyframes that segment spans. The result is a **SHA-256–sealed Handover Protocol PDF** with the transcript, the outlined regions, and per-defect descriptions.
- **Move-in references** (mask, bounding box, dimensions) persist **only in the browser's localStorage** — no evidence is uploaded to an account.
- **Mobile handoff (zero dependencies).** Filming on a desktop? The evidence page shows a QR code generated by an **in-repo, pure-TypeScript Reed–Solomon GF(256) QR encoder** — no QR library anywhere in the stack. Scan it with a phone on the same LAN and the photo uploads straight to the desktop session. The backend enumerates and ranks the machine's IPv4 interfaces (RFC 1918 ranges — 192.168.x.x, 10.x.x.x, 172.16–31.x.x — first; virtual/benchmark ranges last), and the panel lets you switch the offered address or type a host manually, with the QR re-rendering instantly.

## Step 3 — Move-out comparator

- Pick a saved move-in reference and a move-out photo of the same spot. A fresh **SAM 3.1** mask is taken of the move-out photo (if the concept chain misses, the route retries once with a click at the saved outline's centre point), and the overlap is computed **locally and deterministically**: cross-size raster normalisation plus a **bounded translation registration** search that corrects camera zoom/angle drift, reporting raw IoU, `iou_registered`, and the compensating shift (Δx/Δy).
- The result shows both outlines side by side and as a **curtain/wipe slider** (move-in outline in emerald on one side, move-out in terracotta on the other, the prior outline offset by the registration shift), plus a *🎯 Camera Shift Compensated* badge when registration changed the score.
- Honest accounting: the IoU and registration maths is local and free; outlining the move-out photo is a metered SAM 3.1 call. A comparison shows that an outlined area changed — it does not by itself prove when damage occurred or who caused it.

## Shell, architecture, and providers

- **Case Dossier ribbon.** A live three-step ribbon under the header reflects the case as persisted in your browser — clauses flagged (with the high-risk count), SAM outlines locked in, and the latest move-out IoU — updating as you work.
- **Master Case Dossier export.** One click assembles everything the browser holds — the statutory audit with verbatim quotes, the bilingual objection notice, the move-in evidence references, and the move-out comparison — into a single PDF whose master `dossier_sha256` is computed over the compiled case data plus the PDF bytes. Generated entirely locally: **$0.00 API cost**.
- **Architecture X-Ray.** A panel in the shell lays out the split-provider routing (below) and the local deterministic engine.
- **Split-provider routing — every AI model is a Meta model:**
  - **Baseten** — `meta-models/muse-spark-open-1026`: zero-hallucination lease audit, vision defect discovery and descriptions, OCR-vision fallback, bilingual objection drafting.
  - **Meta Model API** — `sam-3.1`: narration-guided keyframe and photo segmentation; `muse-voice-transcribe-1.0`: walkthrough narration.
  - **Local deterministic engine** — the verbatim quote validator, citation grounder, deposit-cap calculator, translation-registered IoU comparator, handover/dossier PDF builders, and **CreditShield**: a SQLite (WAL) ledger with a SHA-256 disk cache and hard caps of **$5 per session / $135 cumulative**. Dollar figures shown in the UI are the app's own conservative estimates, not provider bills, and `match=False` SAM results are never written to the cache.

## Stack

- Frontend: Next.js, React, TypeScript (warm editorial "Swiss Legal Dossier" theme).
- Backend: FastAPI, Python; pypdf for text-layer extraction, `pdftoppm` + Tesseract for OCR, FFmpeg for video frames; SAM output parsed with Meta's `meta-sam-parser`.
- Storage: browser localStorage/sessionStorage for case state and move-in references; backend local storage for uploads, samples, and generated PDFs.

## Local setup

### Backend

From the repository root, create and activate a virtual environment and install the pinned requirements:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend/.env` locally (it is git-ignored; never commit API keys or private tenant documents). The example defaults `CHAT_PROVIDER` to `mock` — the no-network mode for chat, voice, and SAM, useful for UI and offline development. For live runs, set the Baseten key for chat and `META_API_KEY` for SAM 3.1 and voice.

Seed the demo samples once from the repository root, then start the API from the `backend` directory:

```powershell
# from the repository root:
python backend\seed_demo_cache.py
# then, from the backend directory:
python -m uvicorn main:app --reload --port 8000
```

API docs: `http://127.0.0.1:8000/docs`; status/budget endpoint: `http://127.0.0.1:8000/api/meta`.

System tools used by optional paths: **FFmpeg** (`ffmpeg`/`ffprobe` on `PATH`) for walkthrough videos, and **Poppler (`pdftoppm`) + Tesseract** for OCR of scanned leases.

### Frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. For a production build: `npm run build` then `npm start`. Set `NEXT_PUBLIC_API_BASE_URL` only if the backend is not at `http://localhost:8000`.

### Windows one-shot

With the venv created and `npm install` done, `start_dev.ps1` at the repo root launches backend and frontend in two windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\start_dev.ps1
```

## Tests

**114 backend tests** (Python `unittest`) — including HTTP route tests (decode, dossier export, mobile handoff, network info) and a demo-asset test proving that all five planted defects in the sample dorm contract resolve to exact, located page highlights:

```powershell
cd backend
python -m unittest discover -s .\tests -v
```

**34 frontend tests** (Node's built-in runner, over the `src/lib` utilities) plus type checking:

```powershell
cd frontend
node --test src/lib/*.test.ts
npx tsc --noEmit
```

## Privacy, costs, and technical boundaries

- **Preliminary, not legal advice.** Findings, drafts, and comparisons are working aids; have a qualified local professional review anything before you rely on it.
- **Verification has a defined scope.** A verified quote proves the text appears in the extracted lease text — for scanned documents, that means the OCR transcription itself, so an OCR misread is not independently detectable (the `extraction` field discloses when OCR ran). Quote verification does not validate the legal interpretation of a clause.
- **SAM 3.1 has real limits, and the app says so.** Matching is phrasing-sensitive; some defects cannot be isolated (a shallow dent returns the whole door-frame strip; pin-sized burn specks snap to the table surface). When segmentation misses, the app reports the miss — there is deliberately **no** synthetic or heuristic fallback mask, because a fabricated outline would be fabricated evidence.
- **Deposit math fires only on labelled figures.** If rent or deposit cannot be extracted unambiguously, the Statutory Deposit Cap Audit simply does not appear.
- **Costs are estimates.** CreditShield caps and the dollar figures in the UI are the app's own ledger estimates, not provider balances. Live calls (Baseten chat, Meta SAM/voice) can incur provider charges outside mock mode.
- **Your evidence stays yours.** Move-in references and case state live in your browser's storage only; they are not synced or backed up. Backend uploads and generated PDFs live in the backend's local storage directory.
