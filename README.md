# 🛡️ LeaseLens

**Decode Every Clause. Prove Every Pixel. Protect Your Deposit.**

*Zero-Hallucination Legal Auditor & Multimodal SAM 3.1 Deposit Shield for International Tenants (`DE` · `UK` · `US_NY` · `FR` · `JP`)*

![Meta AI](https://img.shields.io/badge/Meta%20AI-SAM%203.1%20%2B%20Muse%20Voice%201.0-0081FB?style=flat-square)
![Baseten](https://img.shields.io/badge/Baseten-muse--spark--open--1026%20%28temp%3D0.0%29-000000?style=flat-square)
![Tests](https://img.shields.io/badge/Tests-132%20Backend%20%C2%B7%2065%20Frontend%20Passing-success?style=flat-square)
![Evidence](https://img.shields.io/badge/Evidence-SHA--256%20Tamper--Evident-blueviolet?style=flat-square)

Built for the **Meta Global AI Developer Hackathon** — [github.com/shamas92/leaselens](https://github.com/shamas92/leaselens)

---

## The Problem & Our Core Rule

- International students and expats lose thousands to unlawful lease clauses and pre-existing room damage because they sign contracts in foreign legal systems.
- Standard LLM wrappers hallucinate statutes and miscalculate rent caps.
- **Our Core Rule — Meta AI Proposes, Deterministic Python Disposes:** Every AI-flagged clause is verified character-for-character against the raw lease text and statutory registry before display, all deposit math is computed in deterministic Python, and move-out damage is proven via translation-and-scale registered pixel IoU.

---

## Architecture — Split Providers, Deterministic Core

```mermaid
flowchart LR
    subgraph Inputs
        A1["Lease PDF / Scan"]
        A2["Room Photos<br/>or LAN Phone QR Bridge"]
        A3["Narrated Walkthrough Video"]
    end

    subgraph AI["AI Perception and Reasoning Layer"]
        B1["Baseten<br/>muse-spark-open-1026, temp=0.0<br/>Clause extraction, vision defect<br/>discovery, bilingual drafting"]
        B2["Meta API<br/>muse-voice-transcribe-1.0<br/>Timestamped narration ASR"]
        B3["Meta API<br/>sam-3.1<br/>Concept / point segmentation<br/>60% frame-area specificity guard"]
    end

    subgraph Core["Deterministic Local Core - Python, $0.00"]
        C1["Verbatim Substring Quote Validator<br/>and registry.json Citation Grounder"]
        C2["Statutory Deposit-Cap Calculator<br/>551 BGB, UK Tenant Fees Act,<br/>FR Loi 89-462, NY GOL 7-108"]
        C3["Glyph-Precise PDF Highlight Locator<br/>/W CID CMap + TJ fragment anchoring"]
        C4["2D Translation + Scale<br/>Registered IoU Comparator"]
        C5["CreditShield SQLite WAL Ledger<br/>and SHA-256 Disk Cache"]
    end

    subgraph Outputs
        O1["Visual Annotated Lease"]
        O2["Bilingual Objection Notice<br/>Local + English"]
        O3["SHA-256 Handover Protocol PDF"]
        O4["1-Click Master Case Dossier PDF"]
    end

    A1 --> B1
    A2 --> B3
    A3 --> B2
    B2 -->|"narration_defect_phrases"| B3
    B1 --> C1
    B1 --> C2
    C1 --> C3
    B3 --> C4
    B1 -.->|"metered calls"| C5
    B3 -.->|"metered calls"| C5
    C1 --> O1
    C2 --> O1
    C3 --> O1
    C1 --> O2
    C2 --> O2
    B3 --> O3
    C4 --> O4
    O1 --> O4
    O2 --> O4
    O3 --> O4
```

---

## How It Works — The 3-Step Workflow

| Step | What You Do | What LeaseLens Executes Under the Hood | Verified Proof |
|---|---|---|---|
| **1. Check Contract** (`/contract`) | Drop a lease PDF/photo or click `DE Dorm Contract` | Python computes exact statutory deposit caps, verifies quotes verbatim, maps glyph-precise highlight boxes onto the rendered page, and drafts a concise German + English objection letter | **Catches `€414.59` illegal deposit excess (`€950` vs `€535.41` cap on `€178.47` cold rent)** |
| **2. Photograph Damage** (`/evidence`) | Snap via the zero-dependency Reed–Solomon QR Phone Bridge, pick a curated dorm photo, or run a narrated walkthrough video | Muse Voice 1.0 transcripts steer SAM 3.1 per keyframe to lock full-color defect overlays into browser storage and a `SHA-256` Handover PDF | **Isolates open wall socket hazards & desk surface burns with zero binary-mask clutter** |
| **3. Compare Move-Out** (`/move-out`) | Compare a saved Day-1 reference against a new Move-Out photo | Normalizes cross-size rasters and runs a bounded 2D translation + scale search with an interactive 2.2× zoomed Before/After Curtain Wipe | **Compensates camera shift/zoom (`0.0%` raw → `85.3%+` registered IoU) or proves exact damage growth** |
| **Master Export** (Command Bar) | Click `Export Master Dossier PDF ($0.00)` | Compiles the annotated lease page, deposit math table, bilingual letters, and full-color SAM 3.1 masks into one courtroom-ready PDF | **Sealed with a master `SHA-256` fingerprint** |

---

## Curated Demo Resources — 1-Click Testing in Under 60 Seconds

Pre-seeded real-world dorm assets (`backend/demo-assets/` → `backend/storage/samples/`):

| Where | Resource | What It Proves |
|---|---|---|
| Preset Bar | `DE Dorm Contract` / `UK London AST` / `FR Paris Bail` | 1-page German student dorm lease (`Studentenwerk Musterstadt`) with 5 planted unlawful clauses: `§ 3 Kaution €950`, `§ 7a Kleinreparaturen €175`, `§ 12(5) €250 cleaning fee`, `§ 13 rigid paint schedule`, `§ 9a guest ban` |
| Step 2 Photos | `⚡ Open Wall Socket` (`dorm_open_socket.jpg`) | Fixture-hazard auto-discovery — SAM 3.1 isolates the uncovered socket |
| Step 2 Photos | `🔥 Table Surface Burn` (`dorm_table_burn.jpg`) | Clean surface-burn segmentation, ready to save as a Day-1 reference |
| Step 2 Walkthrough | `🎙️ Narrated Dorm Walkthrough` (`sample_walkthrough.mp4`) | Muse Voice 1.0 narration steering SAM 3.1 across keyframes |
| Step 2 Walkthrough | `🔇 Silent Dorm Walkthrough` | Vision-only defect discovery with no narration |
| Step 3 Move-Out | `🔥 Table Burn — Grown (Damage Growth Demo)` | Registered IoU `86.1%` after compensating a 2.35× reframing (Δx `+2`, Δy `−82`); residual area change `+8.4%` — inside the ±10% band, so the UI reads the burn as essentially unchanged |

---

## Quick Start & Verification

**1. Seed demo assets & start the backend (`:8000`):**

```bash
python backend/seed_demo_cache.py
cd backend && python -m uvicorn main:app --port 8000
```

Windows PowerShell equivalent:

```powershell
python backend\seed_demo_cache.py
cd backend; python -m uvicorn main:app --port 8000
```

**2. Start the frontend (`:3000`):**

```bash
cd frontend && npm install && npm run build && npm start
```

**3. Configuration:** copy `backend/.env.example` to `backend/.env` and add your own Meta API and Baseten keys. The seeded demos above run without live keys; live decoding and segmentation use yours.

**4. Run the test suites:**

```bash
cd backend && python -m unittest discover -s tests
# 132 tests — OK (skipped=1)

cd frontend && node --test src/lib/*.test.ts
# 65 tests — pass

npx tsc --noEmit
# 0 errors
```

---

*LeaseLens produces verified evidence and preliminary contract analysis. It is not a law firm and its output is not legal advice.*
