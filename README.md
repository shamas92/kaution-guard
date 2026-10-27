# KautionGuard

KautionGuard is a prototype workspace for tenants reviewing rental documents and organizing apartment condition evidence. It combines jurisdiction-aware lease analysis, bilingual dispute-letter drafts, and image-based move-in/move-out evidence tools. Its outputs are preliminary and should be checked by a qualified local professional.

## Current features

- Upload rental-contract PDFs for text extraction and AI-assisted issue review.
- Select a jurisdiction or use global auto-detection. The registry currently covers Germany, the United Kingdom, New York State, France, and Japan.
- Review model findings with excerpts checked against the extracted document text. A matching excerpt confirms only that the text appears in the uploaded document; it does not validate the legal interpretation.
- Draft a notice in the jurisdiction's official language and the tenant's selected language.
- Segment a still image with Meta SAM 3.1, using a short concept phrase or clicked point prompts. View multiple returned masks over the source photo and save a mask as a move-in reference in the current browser.
- Compare saved move-in and move-out masks locally when the images have matching dimensions. This prototype compares mask overlap; it does not prove when damage occurred or who is responsible.
- Process a walkthrough video into frames, audio transcript, evidence regions, and a handover report. This path requires FFmpeg and uses the configured live model providers unless mock mode is selected.
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

Open `http://localhost:3000`. Set `NEXT_PUBLIC_API_BASE_URL` only if the backend is not at `http://localhost:8000`.

### Optional walkthrough video support

Install FFmpeg and make sure `ffmpeg` and `ffprobe` are available on `PATH` before using the walkthrough-video route. Video processing may make Meta voice and SAM requests when live mode is enabled.

## Tests

Backend tests use Python's standard `unittest` runner:

```powershell
cd backend
python -m unittest discover -s .\tests -v
```

Frontend utility tests and type checking:

```powershell
cd frontend
node --test src/lib/*.test.ts
npx tsc --noEmit
```

## Privacy, costs, and limitations

- `CHAT_PROVIDER=mock` is the no-network mode for chat, voice, and SAM paths. Selecting `meta` or `baseten` enables live chat; live voice and SAM use Meta. Live calls can incur provider charges.
- The in-app budget shield uses conservative estimates and provider-reported usage when available. It is not the provider's account balance, and some calls report exact cost as unknown.
- Move-in references are stored in this browser's local storage; they are not synchronized or backed up.
- Move-out comparison currently requires matching image dimensions and compares the primary mask only.
- Model findings and generated correspondence can be incomplete or wrong. Evidence text matching does not validate legal citations or legal advice.
