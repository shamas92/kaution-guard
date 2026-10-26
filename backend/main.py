"""KautionGuard FastAPI entry point: routes over the existing Meta wrappers."""

from __future__ import annotations

import hashlib
import io
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pypdf import PdfReader
from pydantic import BaseModel, Field

from config import credit_shield, settings
from pdf_builder import build_handover_pdf
from services import (
    MUSE_VOICE_TRANSCRIBE_MODEL,
    SAM31_MODEL,
    call_meta_chat,
    call_muse_voice,
    call_sam_3_1_single_frame,
    compare_moveout_crops_local,
    extract_1fps_and_audio,
    get_jurisdiction,
    load_registry,
)

# Default chat model, matching prior project usage; overridable per request.
CHAT_MODEL_DEFAULT = "muse-wonder-1m"

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = BASE_DIR / "storage"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

REVIEW_NOTE = (
    "Automated findings are preliminary and uncertain. "
    "Have a qualified professional review everything before use."
)

app = FastAPI(title="KautionGuard", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/files", StaticFiles(directory=str(STORAGE_DIR)), name="files")


class DisputeRequest(BaseModel):
    jurisdiction_code: str = "GLOBAL_AUTO"
    facts: str = Field(min_length=1)
    desired_outcome: str = ""
    user_language: str = "en"
    model: str = CHAT_MODEL_DEFAULT


def _new_job_dir(prefix: str) -> tuple[str, Path]:
    job_id = uuid.uuid4().hex[:12]
    job_dir = STORAGE_DIR / prefix / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_id, job_dir


async def _save_upload(upload: UploadFile, suffixes: set[str], dest: Path) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in suffixes:
        raise HTTPException(
            status_code=415, detail=f"Unsupported file type: {suffix or '(none)'}"
        )
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    dest.write_bytes(data)
    return dest


def _polygon_area_percent(polygon: Any, img_size: tuple[int, int]) -> Any:
    """Local shoelace area as % of frame; 'unknown' when not computable."""
    try:
        pts = [(float(x), float(y)) for x, y in polygon]
        width, height = img_size
        if len(pts) < 3 or width <= 0 or height <= 0:
            return "unknown"
        area = abs(
            sum(
                x1 * y2 - x2 * y1
                for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1])
            )
        ) / 2
        return round(100 * area / (width * height), 2)
    except (TypeError, ValueError):
        return "unknown"


@app.get("/api/meta")
def meta_status() -> dict[str, Any]:
    """Spend totals, configured limits, offline-lock status, jurisdictions."""
    return {
        "spend_usd": {
            "session": credit_shield.get_session_spend(),
            "cumulative": credit_shield.get_cumulative_spend(),
        },
        "limits_usd": {
            "max_session": settings.MAX_SESSION_SPEND_USD,
            "max_cumulative": settings.MAX_CUMULATIVE_SPEND_USD,
        },
        "offline_lock": settings.DEMO_OFFLINE_LOCK,
        "disk_cache": settings.ENABLE_DISK_CACHE,
        "jurisdictions": sorted(load_registry().keys()),
        "models": {
            "chat_default": CHAT_MODEL_DEFAULT,
            "voice": MUSE_VOICE_TRANSCRIBE_MODEL,
            "sam31": SAM31_MODEL,
        },
        "review_note": REVIEW_NOTE,
    }


SAMPLES_DIR = STORAGE_DIR / "samples"
WALKTHROUGH_VIDEO_FILE = "sample_walkthrough.mp4"

DEMO_PRESETS = {
    "DE": {
        "jurisdiction_code": "DE",
        "title": "Berlin lease demo (fictional)",
        "description": (
            "Fictional German lease with a 150 EUR Kleinreparaturen charge "
            "and a rigid three-year cosmetic-repair schedule."
        ),
        "contract_file": "sample_berlin_mietvertrag.pdf",
        "demo_issues": [
            "Planted 150 EUR Kleinreparaturen flat charge to review.",
            "Planted rigid three-year Schoenheitsreparaturen schedule to review.",
        ],
    },
    "UK": {
        "jurisdiction_code": "UK",
        "title": "London AST demo (fictional)",
        "description": (
            "Fictional English AST with an eight-week deposit and a 300 GBP "
            "mandatory exit-cleaning charge."
        ),
        "contract_file": "sample_london_ast_lease.pdf",
        "demo_issues": [
            "Planted eight-week tenancy deposit to review.",
            "Planted 300 GBP mandatory exit-cleaning charge to review.",
        ],
    },
    "FR": {
        "jurisdiction_code": "FR",
        "title": "Paris lease demo (fictional)",
        "description": (
            "Fictional French unfurnished lease with a two-month deposit and "
            "a waiver of normal vetuste ageing."
        ),
        "contract_file": "sample_paris_bail.pdf",
        "demo_issues": [
            "Planted two-month deposit on an unfurnished lease to review.",
            "Planted waiver of normal vetuste ageing to review.",
        ],
    },
}


class DemoPresetRequest(BaseModel):
    preset_id: str


@app.post("/api/load-demo-preset")
def load_demo_preset(body: DemoPresetRequest) -> dict[str, Any]:
    """Serve local synthetic demo assets; makes no AI calls and writes nothing.

    Only local files under backend/storage/samples/ are referenced.
    """
    preset = DEMO_PRESETS.get(body.preset_id)
    if preset is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown demo preset {body.preset_id!r}. "
                "Choose one of: DE, UK, FR."
            ),
        )
    contract = SAMPLES_DIR / preset["contract_file"]
    video = SAMPLES_DIR / WALKTHROUGH_VIDEO_FILE
    missing = [p.name for p in (contract,) if not p.is_file()]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Demo assets not generated yet, missing: {', '.join(missing)}. "
                "Run backend/seed_demo_cache.py first."
            ),
        )
    return {
        "preset_id": body.preset_id,
        "jurisdiction_code": preset["jurisdiction_code"],
        "title": preset["title"],
        "description": preset["description"],
        "contract_pdf_url": f"/files/samples/{contract.name}",
        "walkthrough_video_url": (
            f"/files/samples/{video.name}" if video.is_file() else None
        ),
        "walkthrough_video_available": video.is_file(),
        "demo_issues": preset["demo_issues"],
        "review_note": REVIEW_NOTE,
    }


@app.post("/api/decode-contract")
async def decode_contract(
    file: UploadFile = File(...),
    jurisdiction_code: str = Form("GLOBAL_AUTO"),
    model: str = Form(CHAT_MODEL_DEFAULT),
) -> dict[str, Any]:
    """Extract PDF text locally with pypdf, then analyse via Meta chat."""
    job_id, job_dir = _new_job_dir("uploads")
    pdf_path = await _save_upload(file, {".pdf"}, job_dir / f"contract-{job_id}.pdf")
    try:
        reader = PdfReader(io.BytesIO(pdf_path.read_bytes()))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not parse PDF: {exc}"
        ) from exc
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="No extractable text in PDF")
    truncated = text[:12000]
    system = (
        "You are a tenancy-document analyst. Read the extracted contract "
        "text for the applicable jurisdiction and return JSON with keys "
        "summary, possible_issues (list of {clause, why_risky}), "
        "deposit_terms, confidence (low|medium|high). Flag uncertainty; "
        "never state legal conclusions as certain."
    )
    analysis = await call_meta_chat(
        model, system, truncated, 0.0, jurisdiction_code=jurisdiction_code
    )
    return {
        "analysis": analysis,
        "truncated_chars": len(truncated),
        "total_chars": len(text),
        "review_note": REVIEW_NOTE,
    }


@app.post("/api/draft-dispute")
async def draft_dispute(body: DisputeRequest) -> dict[str, Any]:
    """Return a bilingual dispute draft via the existing Meta wrapper."""
    pack = get_jurisdiction(body.jurisdiction_code)
    system = (
        "Draft a formal tenant dispute letter in two languages: the "
        "jurisdiction's official record language and the tenant's language. "
        "Return JSON with keys draft_local, draft_tenant, caveats. "
        "Never state legal conclusions as certain."
    )
    user_content = json.dumps(
        {
            "official_language": pack.get("official_language"),
            "tenant_language": body.user_language,
            "facts": body.facts,
            "desired_outcome": body.desired_outcome,
        },
        ensure_ascii=False,
    )
    draft = await call_meta_chat(
        body.model, system, user_content, 0.0,
        jurisdiction_code=body.jurisdiction_code,
    )
    return {"draft": draft, "review_note": REVIEW_NOTE}


@app.post("/api/process-walkthrough")
async def process_walkthrough(
    file: UploadFile = File(...),
    jurisdiction_code: str = Form("GLOBAL_AUTO"),
    user_language: str = Form("en"),
    text_prompt: str = Form("visible damage or stain"),
    model: str = Form(CHAT_MODEL_DEFAULT),
    max_frames: int = Form(5),
) -> dict[str, Any]:
    """Video -> frames/audio -> transcript -> SAM masks -> handover PDF."""
    job_id, job_dir = _new_job_dir("jobs")
    suffix = Path(file.filename or "").suffix.lower() or ".mp4"
    if suffix not in {".mp4", ".mov", ".webm", ".mkv", ".avi"}:
        raise HTTPException(status_code=415, detail=f"Unsupported video: {suffix}")
    video_path = job_dir / f"walkthrough-{job_id}{suffix}"
    await _save_upload(file, {suffix}, video_path)

    extracted = extract_1fps_and_audio(video_path, job_dir)
    transcript = await call_muse_voice(extracted["audio_path"])

    frames = [f for f in extracted["frames"]][: max(1, max_frames)]
    regions: list[dict[str, Any]] = []
    for index, frame_path in enumerate(frames):
        mask_out = job_dir / f"mask-{index:03d}.png"
        sam = await call_sam_3_1_single_frame(frame_path, text_prompt, mask_out)
        regions.append(
            {"frame": Path(frame_path).name, "second": index, **sam}
        )

    from PIL import Image

    defects: list[dict[str, Any]] = []
    described: dict[str, dict[str, str]] = {}
    if regions:
        desc_system = (
            "Given transcript segments and detected frame regions, return "
            "JSON {defects: [{frame, timestamp, description_local, "
            "description_tenant}]}. Never state legal conclusions as certain."
        )
        desc_raw = await call_meta_chat(
            model,
            desc_system,
            json.dumps(
                {"transcript": transcript, "regions": regions}, ensure_ascii=False
            ),
            0.0,
            jurisdiction_code=jurisdiction_code,
        )
        if isinstance(desc_raw, dict):
            for item in desc_raw.get("defects", []) or []:
                if isinstance(item, dict) and item.get("frame"):
                    described[str(item["frame"])] = {
                        "description_local": str(item.get("description_local", "")),
                        "description_tenant": str(item.get("description_tenant", "")),
                        "timestamp": str(item.get("timestamp", "")),
                    }
    for region in regions:
        frame_path = job_dir / "frames" / region["frame"]
        try:
            img_size = Image.open(frame_path).size
        except Exception:
            img_size = (0, 0)
        label = f"Possible '{text_prompt}' in {region['frame']} (t={region['second']}s)"
        info = described.get(region["frame"], {})
        defects.append(
            {
                "timestamp": info.get("timestamp") or f"{region['second']}s",
                "sam_confidence": "unknown",
                "area_percent": _polygon_area_percent(
                    region.get("polygon"), (img_size[0], img_size[1])
                ),
                "description_local": info.get("description_local") or label,
                "description_tenant": info.get("description_tenant") or label,
                "image_path": str(job_dir / f"mask-{regions.index(region):03d}.png"),
            }
        )

    digest = hashlib.sha256()
    digest.update(Path(extracted["audio_path"]).read_bytes())
    for frame_path in sorted(extracted["frames"]):
        digest.update(Path(frame_path).read_bytes())
    pack = get_jurisdiction(jurisdiction_code)
    pdf_name = f"handover-{job_id}.pdf"
    pdf_path = build_handover_pdf(
        pack, user_language, digest.hexdigest(), defects, STORAGE_DIR, pdf_name
    )
    return {
        "pdf_url": f"/files/{Path(pdf_path).name}",
        "evidence_sha256": digest.hexdigest(),
        "transcript": transcript,
        "regions": regions,
        "defects": defects,
        "review_note": REVIEW_NOTE,
    }


@app.post("/api/verify-moveout")
async def verify_moveout(
    file: UploadFile = File(...),
    prior_polygon: str = Form(...),
    text_prompt: str = Form("visible damage or stain"),
) -> dict[str, Any]:
    """Segment one move-out image with SAM 3.1, then compare locally."""
    try:
        prior = json.loads(prior_polygon)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"prior_polygon is not valid JSON: {exc}"
        ) from exc
    job_id, job_dir = _new_job_dir("verify")
    suffix = Path(file.filename or "").suffix.lower() or ".jpg"
    image_path = await _save_upload(
        file, {".jpg", ".jpeg", ".png"}, job_dir / f"moveout-{job_id}{suffix}"
    )
    sam = await call_sam_3_1_single_frame(
        image_path, text_prompt, job_dir / f"mask-{job_id}.png"
    )
    polygon = sam.get("polygon")
    if not polygon:
        raise HTTPException(
            status_code=502, detail="SAM 3.1 returned no polygon to compare"
        )
    from PIL import Image

    try:
        img_size = Image.open(image_path).size
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not read image size: {exc}"
        ) from exc
    comparison = compare_moveout_crops_local(prior, polygon, img_size)
    return {
        "mask": sam,
        "comparison": comparison,
        "review_note": REVIEW_NOTE,
    }
