# KautionGuard

KautionGuard is a prototype workspace for tenants reviewing rental documents and organising apartment condition evidence. It combines jurisdiction-aware lease analysis, bilingual dispute-letter drafts, and image-based move-in/move-out evidence tools. Its outputs are preliminary and should be checked by a qualified local professional.

## Try it in three minutes (no files of your own needed)

The app opens on Contract Review and has three routes — Contract Review & Notice
(`/contract`), Defect HUD & Walkthrough (`/evidence`), and Move-Out Comparator
(`/move-out`). Every demo below is labelled as a sample; real findings only ever
come from running the check, never from the demo data itself.

1. **Contract:** click a demo preset (Germany, UK, or France) or "Attach Sample
   PDF ($0.00)", then Decode Contract. Findings show the quoted clause checked
   verbatim against the uploaded PDF text, with its citation checked against the
   jurisdiction registry, before display.
2. **Dispute letter:** pick a finding and "Draft Objection for This Clause", or
   use a one-click scenario pill (DE €150 Kleinreparaturen, UK £300 exit-cleaning,
   FR 2-month deposit + vétusté) to pre-fill sample facts, then draft the notice
   in the jurisdiction's official language and the tenant's selected language.
3. **Evidence:** "Attach Sample Defect Photo ($0.00)" or "Attach Sample
   Walkthrough Video ($0.00)", then Highlight the damage (Meta SAM 3.1, by
   concept phrase or clicked points) or Check my video (Muse Voice narration +
   SAM frames). Save a mask as a move-in reference in the current browser.
4. **Move-out:** attach a move-out photo and compare it against a saved move-in
   reference. The IoU maths itself is local, but outlining the move-out photo
   is a metered SAM 3.1 call (~$0.02); it does not prove when damage occurred or
   who is responsible.

## What is new in this version

- **Swiss Legal Dossier workspace:** warm editorial light theme, sticky header
  with live model badges (chat / vision / audio providers and models, plus a
  Disk Cache on/off badge — all from `/api/meta`, shown only when the backend
  responds) and a CreditShield budget meter (session and cumulative; hard caps
  of $5 per session and $135 cumulative, behind a provider-fingerprinted disk
  cache, so a result cached under one provider or in mock mode is never served
  under another).
- **One-click demos:** demo presets carry the backend's own title, description
  and planted-issue annotations into the contract page; sample-attach buttons
  generate or fetch real sample files through the same upload path as manual files.
- **Timing transparency:** decode, draft, segment and verify responses carry a
  top-level `elapsed_ms`, shown as a ⚡ pill with the real provider/model
  (Baseten • meta-models/muse-spark-open-1026 for contract/letter, Meta SAM 3.1
  for photos). No cache-hit label is shown: no response carries a cache-hit signal.
- **Provider-layer reliability:** voice transcription now uses the request
  shape the live ASR route requires, so narrated walkthroughs return real
  transcripts (mode `voice_and_vision`) instead of silently falling back to
  silent vision. SAM segmentation tries alternate defect phrases when the
  first phrase finds nothing ("mold growth" where "mold" misses) and reports
  the phrase that matched. Provider timeouts surface as clean errors and
  release their budget reservation, and a walkthrough whose per-frame call
  fails degrades that frame to a no-match instead of failing the whole request.
- **Backend hardening:** SQLite in WAL mode, and upload validation before
  storage (PDF / JPEG / PNG magic bytes and size caps; video size cap).
- **Jurisdictions:** Germany, United Kingdom, New York State, France, and Japan,
  plus global auto-detection (including the French 1989 housing law and New York
  General Obligations Law markers).

## Current features

- Upload rental-contract PDFs for text extraction and AI-assisted issue review.
- Select a jurisdiction or use global auto-detection. The registry currently covers Germany, the United Kingdom, New York State, France, and Japan.
- Review model findings with excerpts checked against the extracted document text. A matching excerpt confirms only that the text appears in the uploaded document; it does not validate the legal interpretation.
- Draft a notice in the jurisdiction's official language and the tenant's selected language.
- Segment a still image with Meta SAM 3.1, using a short concept phrase or clicked point prompts — or leave the prompt empty and let the chat model inspect the photo and suggest what to outline. If the first phrase finds nothing, alternate defect phrases are tried automatically and the response reports the phrase that matched. View multiple returned masks over the source photo and save a mask as a move-in reference in the current browser.
- Compare a move-out photo against a saved move-in mask. The overlap (IoU) maths is computed locally, but outlining the move-out photo is a metered SAM 3.1 call (~$0.02); the result reports the IoU and the area growth. Cross-size inputs are normalised and flagged via `dimension_normalized`; matching dimensions are not required. This prototype compares mask overlap; it does not prove when damage occurred or who is responsible.
- Process a walkthrough video into frames, audio transcript, evidence regions, and a handover report. Narration is transcribed when present (mode `voice_and_vision`); defect phrases spotted deterministically in the transcript then lead the SAM search for their scene, ahead of the vision-discovered labels, and the transcript also informs the report's defect descriptions. A video without usable narration falls back to silent visual detection. This path requires FFmpeg and uses the configured live model providers unless mock mode is selected.
- Load synthetic Germany, UK, and France demo leases from the local UI.

## Stack

- Frontend: Next.js, React, and TypeScript.
- Backend: FastAPI and Python.
- Lease chat can use mock mode, Meta Model API, or Baseten's OpenAI-compatible endpoint. Muse Voice and SAM 3.1 use the Meta Model API when live mode is enabled.
- SAM output is parsed and decoded with Meta's `meta-sam-parser` package.

## Local setup

### Backend

From the repository root, create and activate a virtual environment, then install the pinned backend requirements:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend/.env` locally. It is ignored by Git. The example defaults `CHAT_PROVIDER` to `mock`, which is useful for UI and offline development. To enable live chat, select `meta` or `baseten` and fill only that provider's key and model settings. Live SAM and voice requests require `META_API_KEY`. SAM uses the shared Meta base URL and fixed `sam-3.1` model; it has no separate SAM key setting. Never commit API keys or private tenant documents.

Start the API from the backend directory:

```powershell
python -m uvicorn main:app --reload --port 8000
```

API documentation is available at `http://127.0.0.1:8000/docs`; the budget/status endpoint is `http://127.0.0.1:8000/api/meta`.

### Frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` — the start page is the Contract Review page (`/contract` serves the same page). Set `NEXT_PUBLIC_API_BASE_URL` only if the backend is not at `http://localhost:8000`.

### Optional walkthrough video support

Install FFmpeg and make sure `ffmpeg` and `ffprobe` are available on `PATH` before using the walkthrough-video route. Video processing may make Meta voice and SAM requests when live mode is enabled.

## Tests

Backend tests use Python's standard `unittest` runner (90 test methods):

```powershell
cd backend
python -m unittest discover -s .\tests -v
```

Frontend utility tests and type checking (34 tests):

```powershell
cd frontend
node --test src/lib/*.test.ts
npx tsc --noEmit
```

## Privacy, costs, and limitations

- `CHAT_PROVIDER=mock` is the no-network mode for chat, voice, and SAM paths. Selecting `meta` or `baseten` enables live chat; live voice and SAM use Meta. Live calls can incur provider charges.
- The in-app budget shield uses conservative estimates and provider-reported usage when available. It is not the provider's account balance, and some calls report exact cost as unknown.
- Move-in references are stored in this browser's local storage; they are not synchronized or backed up.
- Move-out comparison currently compares the primary mask only. Outlining the move-out photo is a metered SAM 3.1 call (~$0.02); only the overlap maths is local. Cross-size inputs are normalised and flagged via `dimension_normalized`.
- SAM 3.1 matching is phrasing-sensitive: the same damage can match under one concept phrase and miss under another. Alternate phrases are tried automatically, but some damage (for example, large areas of peeling paint) can still segment coarsely, and a no-match result is possible.
- Automatic defect discovery sends the photo itself to the chat model, which suggests SAM prompts from what it sees (for example "black mold on bathroom ceiling" for a mould photo). The suggestions are only as good as that first look, and SAM matching stays phrasing-sensitive, so the phrase fallback still applies; typing a concept phrase remains the most predictable path.
- Click-points segmentation is live-verified (a single positive point on a ceiling stain matched with essentially the same outline as the concept-phrase result), alongside concept-phrase and automatic discovery modes.
- Provider latency varies, and a live call can occasionally be slow. Timeouts surface as a clean error rather than a stuck request, and a walkthrough continues with its remaining frames when one frame's call fails.
- Model findings and generated correspondence can be incomplete or wrong. Evidence text matching does not validate legal citations or legal advice.
