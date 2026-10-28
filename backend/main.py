"""KautionGuard FastAPI entry point: routes over the existing Meta wrappers."""

from __future__ import annotations

import hashlib
import io
import json
import math
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pypdf import PdfReader
from pydantic import BaseModel, Field

from config import (
    META_CHAT_MODEL_DEFAULT,
    credit_shield,
    settings,
)
from pdf_builder import build_handover_pdf
from services import (
    MUSE_VOICE_TRANSCRIBE_MODEL,
    SAM31_MODEL,
    call_meta_chat,
    call_muse_voice,
    call_sam_3_1_single_frame,
    compare_moveout_masks_local,
    extract_1fps_and_audio,
    get_jurisdiction,
    load_registry,
    validate_lease_findings,
)

# Server-side default chat model. The provider, base URL, and model are
# resolved from backend/.env (CHAT_PROVIDER); browsers never send API keys,
# provider names, or model overrides.
CHAT_MODEL_DEFAULT = META_CHAT_MODEL_DEFAULT

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


def _new_job_dir(prefix: str) -> tuple[str, Path]:
    job_id = uuid.uuid4().hex[:12]
    job_dir = STORAGE_DIR / prefix / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_id, job_dir


def _storage_file_url(path: Any) -> str | None:
    """Serve a storage file through the ``/files`` mount, if possible.

    Returns the ``/files/...`` URL for paths inside ``STORAGE_DIR`` and
    ``None`` for anything else, so absolute filesystem paths never leak
    into API responses.
    """
    if not path:
        return None
    try:
        return "/files/" + Path(path).relative_to(STORAGE_DIR).as_posix()
    except ValueError:
        return None


def _walkthrough_frame_size(frame_path: str | Path) -> tuple[int, int]:
    """Actual ``(width, height)`` of one extracted frame sent to SAM.

    Frames come from FFmpeg processing (scaled/padded per the extraction
    filter), so their size is read back from the file, never assumed.
    Unreadable files report ``(0, 0)``; callers treat non-positive sizes
    as unknown dimensions.
    """
    try:
        from PIL import Image

        with Image.open(Path(frame_path)) as img:
            width, height = img.size
    except Exception:
        return (0, 0)
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError):
        return (0, 0)
    if width <= 0 or height <= 0:
        return (0, 0)
    return (width, height)


def _walkthrough_mask_entries(sam: Any) -> list[dict[str, Any]]:
    """Lean per-mask entries with servable file URLs for one frame.

    One entry per returned mask (``object_id``, ``box``, ``mask_dims``,
    ``mask_url``), so callers can offer individual masks including
    several from the same frame. Falls back to the legacy single-mask
    fields for older single-mask rows, and to ``[]`` on no-match rows.
    Entries without a servable file URL are dropped; box/dims ride along
    untouched for frame-coordinate placement downstream.
    """
    if isinstance(sam, dict):
        raw_masks = sam.get("masks")
        if isinstance(raw_masks, list) and raw_masks:
            entries = []
            for entry in raw_masks:
                if not isinstance(entry, dict):
                    continue
                url = _storage_file_url(entry.get("mask_path"))
                if url is None:
                    continue
                entries.append(
                    {
                        "object_id": entry.get("object_id"),
                        "box": entry.get("box"),
                        "mask_dims": entry.get("mask_dims"),
                        "mask_url": url,
                    }
                )
            return entries
        if sam.get("match") and sam.get("mask_path"):
            url = _storage_file_url(sam.get("mask_path"))
            if url is not None:
                return [
                    {
                        "object_id": sam.get("object_id"),
                        "box": sam.get("box"),
                        "mask_dims": sam.get("mask_dims"),
                        "mask_url": url,
                    }
                ]
    return []


def _build_walkthrough_region(
    frame_path: str | Path, index: int, sam: Any
) -> dict[str, Any]:
    """Assemble one walkthrough region with frame dims and mask entries.

    ``frame_width``/``frame_height`` are the actual dimensions of the
    processed frame file sent to SAM; ``masks`` holds the per-mask
    entries from :func:`_walkthrough_mask_entries`. The raw ``sam``
    mapping is preserved untouched for backward compatibility.
    """
    frame_width, frame_height = _walkthrough_frame_size(frame_path)
    return {
        "frame": Path(frame_path).name,
        "second": index,
        **(sam if isinstance(sam, dict) else {}),
        "frame_width": frame_width,
        "frame_height": frame_height,
        "masks": _walkthrough_mask_entries(sam),
    }


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


@app.on_event("startup")
def _warn_when_live_provider_has_no_key() -> None:
    """Log a clear startup warning when a live provider lacks its key."""
    try:
        settings.resolve_chat_target()
    except HTTPException as exc:
        print(f"WARNING: chat provider not ready: {exc.detail}")
    if settings.CHAT_PROVIDER != "mock" and not settings.META_API_KEY:
        print(
            "WARNING: Muse Voice and SAM 3.1 need META_API_KEY, "
            "which is not configured."
        )


@app.get("/api/meta")
def meta_status() -> dict[str, Any]:
    """Spend totals, configured limits, offline-lock status, jurisdictions."""
    return {
        "spend_usd": {
            "session": credit_shield.get_session_spend(),
            "cumulative": credit_shield.get_cumulative_spend(),
        },
        "ledger_note": (
            "Locally tracked usage from API-reported figures; "
            "not the live balance in any provider account."
        ),
        "limits_usd": {
            "max_session": settings.MAX_SESSION_SPEND_USD,
            "max_cumulative": settings.MAX_CUMULATIVE_SPEND_USD,
        },
        "offline_lock": settings.DEMO_OFFLINE_LOCK,
        "disk_cache": settings.ENABLE_DISK_CACHE,
        "chat_provider": settings.CHAT_PROVIDER,
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
        "summary, possible_issues (list of {clause, why_risky, "
        "severity (low|medium|high), evidence_quote (a short verbatim "
        "excerpt from the contract text below supporting the issue), "
        "citation (a clause, section, or page reference grounded in the "
        "supplied jurisdiction text; use the exact reference only when it "
        "appears there, otherwise null), flagged_amount (a number in the "
        "contract currency when the issue names a monetary amount, "
        "otherwise null)}), "
        "deposit_terms, confidence (low|medium|high). Quote exactly; "
        "never invent excerpts or references. Flag uncertainty; "
        "never state legal conclusions as certain."
    )
    analysis = await call_meta_chat(
        system, truncated, 0.0, jurisdiction_code=jurisdiction_code
    )
    # Verify every excerpt against the locally extracted lease text and
    # every citation against the supplied jurisdiction registry text:
    # unverifiable quotes are marked, unsupported citations become null,
    # and unvalidated scores are dropped.
    jurisdiction_text = str(
        get_jurisdiction(jurisdiction_code).get("statutes", "")
    )
    analysis = validate_lease_findings(analysis, text, jurisdiction_text)
    issues = (
        analysis.get("possible_issues")
        if isinstance(analysis, dict)
        else None
    )
    if not isinstance(issues, list):
        issues = []
    issue_count = len(issues)
    high_severity_count = sum(
        1 for item in issues
        if isinstance(item, dict) and item.get("severity") == "high"
    )
    total_flagged_amount = 0.0
    for item in issues:
        if not isinstance(item, dict):
            continue
        amount = item.get("flagged_amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            continue
        value = float(amount)
        if not math.isfinite(value):
            continue
        total_flagged_amount += value
    if isinstance(analysis, dict):
        # The frontend reads analysis fields: nest the computed metrics
        # there. Top-level copies stay for compatibility.
        analysis["issue_count"] = issue_count
        analysis["high_severity_count"] = high_severity_count
        analysis["total_flagged_amount"] = total_flagged_amount
    return {
        "analysis": analysis,
        "issue_count": issue_count,
        "high_severity_count": high_severity_count,
        "total_flagged_amount": total_flagged_amount,
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
        system, user_content, 0.0,
        jurisdiction_code=body.jurisdiction_code,
    )
    return {"draft": draft, "review_note": REVIEW_NOTE}


@app.post("/api/process-walkthrough")
async def process_walkthrough(
    file: UploadFile = File(...),
    jurisdiction_code: str = Form("GLOBAL_AUTO"),
    user_language: str = Form("en"),
    text_prompt: str = Form("visible damage or stain"),
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
        regions.append(_build_walkthrough_region(frame_path, index, sam))

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
        if region.get("match") is False:
            continue  # no-match frames contribute no defect
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
    prior_polygon: str = Form(""),
    prior_mask: str = Form(""),
    text_prompt: str = Form("visible damage or stain"),
) -> dict[str, Any]:
    """Segment one move-out image with SAM 3.1, then compare locally.

    Prior evidence is either a legacy ``prior_polygon`` point list in
    frame pixels or a ``prior_mask`` JSON object mirroring a
    segment-image mask entry (``box``, ``mask_dims``, ``frame_size`` plus
    ``mask_png_base64``); exactly one is required. The current side uses
    the first returned raster mask stamped at its box -- never a
    fabricated polygon. The comparison itself is fully local; no model
    is called for it. Missing or unalignable evidence fails with a clear
    validation error instead of a misleading damage result.
    """
    # Non-string values are the unset Form markers from a direct call,
    # which mean the same as an omitted field.
    raw_polygon = prior_polygon if isinstance(prior_polygon, str) else ""
    raw_mask = prior_mask if isinstance(prior_mask, str) else ""
    has_polygon = bool(raw_polygon.strip())
    has_mask = bool(raw_mask.strip())
    if has_polygon and has_mask:
        raise HTTPException(
            status_code=400,
            detail="Provide only one of prior_polygon or prior_mask.",
        )
    if not has_polygon and not has_mask:
        raise HTTPException(
            status_code=400,
            detail="Provide prior evidence as prior_polygon or prior_mask.",
        )
    try:
        prior_evidence = json.loads(raw_polygon if has_polygon else raw_mask)
    except ValueError as exc:
        field = "prior_polygon" if has_polygon else "prior_mask"
        raise HTTPException(
            status_code=400, detail=f"{field} is not valid JSON: {exc}"
        ) from exc
    if has_mask and (
        not isinstance(prior_evidence, dict)
        or (
            "mask_png_base64" not in prior_evidence
            and "mask_png_bytes" not in prior_evidence
        )
    ):
        raise HTTPException(
            status_code=400,
            detail="prior_mask must be a JSON object with mask PNG bytes, "
            "a box, and mask_dims.",
        )
    job_id, job_dir = _new_job_dir("verify")
    suffix = Path(file.filename or "").suffix.lower() or ".jpg"
    image_path = await _save_upload(
        file, {".jpg", ".jpeg", ".png"}, job_dir / f"moveout-{job_id}{suffix}"
    )
    sam = await call_sam_3_1_single_frame(
        image_path, text_prompt, job_dir / f"mask-{job_id}.png"
    )
    if sam.get("match") is False:
        return {
            "mask": sam,
            "comparison": {
                "match": False,
                "note": "SAM 3.1 found no region matching the prompt.",
            },
            "review_note": REVIEW_NOTE,
        }
    current_evidence = None
    compared_object_id = None
    candidates = [
        entry
        for entry in (sam.get("masks") or [])
        if isinstance(entry, dict)
    ]
    top_level = {
        "box": sam.get("box"),
        "mask_dims": sam.get("mask_dims"),
        "mask_path": sam.get("mask_path"),
        "object_id": sam.get("object_id"),
    }
    if top_level["box"] and top_level["mask_dims"] and top_level["mask_path"]:
        candidates.append(top_level)
    for entry in candidates:
        mask_file = Path(entry.get("mask_path") or "")
        if (
            entry.get("box")
            and entry.get("mask_dims")
            and mask_file.is_file()
        ):
            current_evidence = {
                "box": entry["box"],
                "mask_dims": entry["mask_dims"],
                "mask_png_bytes": mask_file.read_bytes(),
            }
            compared_object_id = entry.get("object_id")
            break
    if current_evidence is None and sam.get("polygon"):
        current_evidence = {"polygon": sam["polygon"]}
    if current_evidence is None:
        raise HTTPException(
            status_code=502,
            detail="SAM 3.1 returned no mask raster or polygon to compare",
        )
    from PIL import Image

    try:
        with Image.open(image_path) as img:
            img_size = img.size
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not read image size: {exc}"
        ) from exc
    comparison = compare_moveout_masks_local(
        prior_evidence, current_evidence, img_size
    )
    comparison["compared_object_id"] = compared_object_id
    return {
        "mask": sam,
        "comparison": comparison,
        "review_note": REVIEW_NOTE,
    }


@app.post("/api/segment-image")
async def segment_image(
    file: UploadFile = File(...),
    text_prompt: str = Form("visible damage or stain"),
    points: str = Form(""),
) -> dict[str, Any]:
    """Segment one uploaded image with live Meta SAM 3.1.

    Minimal single-image probe: no move-out verification, no video
    processing, and no chat or voice calls. Two mutually exclusive
    prompt modes: when ``points`` carries a JSON list of
    ``{"x", "y", "label"}`` natural-pixel spots, each spot becomes its
    own target object id via Meta's documented point-prompt grammar and
    ``text_prompt`` is ignored; otherwise the trimmed ``text_prompt``
    concept phrase is sent directly. The mask files land under
    the job directory and are served through the existing ``/files``
    mount, so ``mask_url``/``mask_urls`` are directly usable by API
    clients.
    """
    parsed_points: list[dict[str, Any]] | None = None
    # ``points`` arrives as a JSON string from the form; a non-string here
    # is the unset Form marker from a direct call, which means concept mode.
    raw_points = points if isinstance(points, str) else ""
    if raw_points.strip():
        try:
            decoded = json.loads(raw_points)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"points must be a JSON list of x/y spots: {exc}",
            ) from exc
        if not isinstance(decoded, list):
            raise HTTPException(
                status_code=400,
                detail="points must be a JSON list of x/y spots.",
            )
        parsed_points = decoded
    job_id, job_dir = _new_job_dir("segment")
    suffix = Path(file.filename or "").suffix.lower() or ".jpg"
    image_path = await _save_upload(
        file, {".jpg", ".jpeg", ".png"}, job_dir / f"image-{job_id}{suffix}"
    )
    sam = await call_sam_3_1_single_frame(
        image_path, text_prompt, job_dir / f"mask-{job_id}.png",
        points=parsed_points,
    )

    mask_url = _storage_file_url(sam.get("mask_path"))
    mask_urls = []
    for entry in sam.get("masks", []) or []:
        entry_url = (
            _storage_file_url(entry.get("mask_path"))
            if isinstance(entry, dict)
            else None
        )
        if entry_url:
            mask_urls.append(entry_url)
    if not mask_urls and mask_url:
        mask_urls = [mask_url]
    return {
        "job_id": job_id,
        "mask": sam,
        "mask_url": mask_url,
        "mask_urls": mask_urls,
        "image_url": _storage_file_url(str(image_path)),
        "review_note": REVIEW_NOTE,
    }
