"""KautionGuard FastAPI entry point: routes over the existing Meta wrappers."""

from __future__ import annotations

import hashlib
import io
import json
import math
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pypdf import PdfReader
from pydantic import BaseModel, Field

from config import (
    BASETEN_CHAT_MODEL_REQUIRED,
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
    call_sam_concept_with_fallback,
    compare_moveout_masks_local,
    detect_input_locale,
    discover_visual_defects,
    extract_1fps_and_audio,
    get_jurisdiction,
    load_registry,
    narration_defect_phrases,
    render_contract_page_highlights,
    transcribe_document_page,
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


_MAX_PDF_BYTES = 25 * 1024 * 1024
_MAX_IMAGE_BYTES = 15 * 1024 * 1024
_MAX_VIDEO_BYTES = 100 * 1024 * 1024
_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
_PDF_MAGIC = b"%PDF-"
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _validate_upload_bytes(suffix: str, data: bytes) -> None:
    """Reject oversized or mislabelled uploads before anything is stored.

    Magic bytes are checked against the extension the handler accepted:
    a lease must start with ``%PDF-`` and a photo must carry a JPEG or
    PNG header, so a renamed file cannot slip into the wrong pipeline.
    Videos are size-capped only: the accepted container formats have no
    single shared signature (MP4/MOV use ``ftyp``, WebM/Matroska use
    EBML, AVI uses RIFF), and the container itself is validated during
    frame extraction.
    """
    if suffix == ".pdf":
        if len(data) > _MAX_PDF_BYTES:
            raise HTTPException(
                status_code=400,
                detail="PDF upload exceeds the 25 MB size limit.",
            )
        if not data.startswith(_PDF_MAGIC):
            raise HTTPException(
                status_code=400,
                detail="Uploaded file is not a PDF (missing %PDF- header).",
            )
    elif suffix in _IMAGE_SUFFIXES:
        if len(data) > _MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Image upload exceeds the 15 MB size limit.",
            )
        if not (data.startswith(_JPEG_MAGIC) or data.startswith(_PNG_MAGIC)):
            raise HTTPException(
                status_code=400,
                detail="Uploaded file is not a JPEG or PNG image.",
            )
    elif suffix in _VIDEO_SUFFIXES:
        if len(data) > _MAX_VIDEO_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Video upload exceeds the 100 MB size limit.",
            )


async def _save_upload(upload: UploadFile, suffixes: set[str], dest: Path) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in suffixes:
        raise HTTPException(
            status_code=415, detail=f"Unsupported file type: {suffix or '(none)'}"
        )
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    _validate_upload_bytes(suffix, data)
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


def _reported_chat_model() -> str:
    """Chat model actually sent by services.py for the configured provider.

    Uses ``settings.resolve_chat_target()`` so the reported ID always
    matches the model ``call_meta_chat`` sends; when the live provider is
    not fully configured (missing key), falls back to the configured model
    ID without raising, so ``GET /api/meta`` stays available.
    """
    try:
        _provider, _base_url, model = settings.resolve_chat_target()
    except HTTPException:
        if settings.CHAT_PROVIDER == "baseten":
            return BASETEN_CHAT_MODEL_REQUIRED
        if settings.CHAT_PROVIDER == "meta":
            return settings.META_CHAT_MODEL_ID or META_CHAT_MODEL_DEFAULT
        return CHAT_MODEL_DEFAULT
    return model


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
            "chat_default": _reported_chat_model(),
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


def _tesseract_page_text(page: Path) -> str:
    """OCR one page image with the local tesseract engine (deu+eng).

    Deterministic, offline and free; returns "" when tesseract is not
    installed or reads nothing usable.
    """
    if shutil.which("tesseract") is None:
        return ""
    try:
        result = subprocess.run(
            ["tesseract", str(page), "stdout", "--psm", "6", "-l", "deu+eng"],
            capture_output=True, timeout=90, text=True,
        )
    except Exception:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


async def _ocr_document_text(
    doc_path: Path, suffix: str, job_dir: Path
) -> tuple[str, str]:
    """OCR fallback for scanned/photo contracts.

    PDFs are rendered to page JPEGs with pdftoppm (200 dpi, first 8
    pages); an image upload is read directly. Each page is OCR'd with
    the local tesseract engine first; when that yields too little text
    (unsupported language, handwriting), the chat model's vision
    transcription is the fallback. Returns ``(text, engine)`` where
    engine is ``"ocr"`` (tesseract) or ``"ocr-vision"``; ``("", "ocr")``
    when nothing could be read, so the caller keeps its clear no-text
    error instead of a misleading analysis.
    """
    pages: list[Path] = []
    if suffix == ".pdf":
        if shutil.which("pdftoppm") is None:
            return "", "ocr"
        try:
            subprocess.run(
                [
                    "pdftoppm", "-jpeg", "-r", "200",
                    str(doc_path), str(job_dir / "ocr-page"),
                ],
                check=True, capture_output=True, timeout=120,
            )
        except Exception:
            return "", "ocr"
        pages = sorted(job_dir.glob("ocr-page-*.jpg"))[:8]
    else:
        pages = [doc_path]
    tess = "\n".join(
        t for t in (_tesseract_page_text(p) for p in pages) if t
    )
    if len(tess.strip()) >= 200:
        return tess, "ocr"
    texts: list[str] = []
    for page in pages:
        page_text = await transcribe_document_page(page)
        if page_text:
            texts.append(page_text)
    return "\n".join(texts), "ocr-vision"


@app.post("/api/decode-contract")
async def decode_contract(
    file: UploadFile = File(...),
    jurisdiction_code: str = Form("GLOBAL_AUTO"),
) -> dict[str, Any]:
    """Extract PDF text locally with pypdf, then analyse via Meta chat.

    Scans and photos carry no embedded text: when the text layer is
    missing or near-empty, pages are OCR'd instead — local tesseract
    first, the chat model's vision transcription as fallback — and the
    response reports which ran via ``extraction``. Image uploads
    (JPG/PNG photos of a lease) are accepted for the same path.
    """
    _started = time.perf_counter()
    job_id, job_dir = _new_job_dir("uploads")
    suffix = Path(file.filename or "").suffix.lower() or ".pdf"
    if suffix not in {".pdf", ".jpg", ".jpeg", ".png"}:
        raise HTTPException(
            status_code=415, detail=f"Unsupported contract file: {suffix}"
        )
    pdf_path = await _save_upload(
        file, {".pdf", ".jpg", ".jpeg", ".png"},
        job_dir / f"contract-{job_id}{suffix}",
    )
    extraction = "embedded-text"
    text = ""
    if suffix == ".pdf":
        try:
            reader = PdfReader(io.BytesIO(pdf_path.read_bytes()))
            text = "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Could not parse PDF: {exc}"
            ) from exc
    if len(text.strip()) < 200:
        ocr_text, ocr_engine = await _ocr_document_text(pdf_path, suffix, job_dir)
        if len(ocr_text.strip()) > len(text.strip()):
            text = ocr_text
            extraction = ocr_engine
    text = text.strip()
    if not text:
        raise HTTPException(
            status_code=400,
            detail="No readable text in the uploaded document "
            "(no embedded text layer, and OCR found nothing).",
        )
    detected_locale = detect_input_locale(text, file.filename or "")
    effective_jurisdiction = (
        detected_locale["detected_jurisdiction"]
        if (jurisdiction_code or "GLOBAL_AUTO") == "GLOBAL_AUTO"
        and detected_locale["detected_jurisdiction"] != "GLOBAL_AUTO"
        else (jurisdiction_code or "GLOBAL_AUTO")
    )
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
        "never state legal conclusions as certain. Write the summary, "
        "every why_risky explanation and each clause heading in "
        "English, whatever language the contract is written in (a "
        "clause heading is the original section reference plus a short "
        "English label). Keep evidence_quote verbatim in "
        "the contract's original language, and keep statute names, "
        "section signs and court case names in their original language "
        "(e.g. '§ 551 BGB', 'BGH VIII ZR 91/88') — never translate "
        "legal names."
    )
    analysis = await call_meta_chat(
        system, truncated, 0.0, jurisdiction_code=effective_jurisdiction
    )
    # Verify every excerpt against the locally extracted lease text and
    # every citation against the supplied jurisdiction registry text:
    # unverifiable quotes are marked, unsupported citations become null,
    # and unvalidated scores are dropped.
    jurisdiction_text = str(
        get_jurisdiction(effective_jurisdiction).get("statutes", "")
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
    # Visual audit support: render the contract's first pages and locate
    # each verified issue's quote on them. Best-effort only — any
    # failure leaves the structured findings untouched.
    verified_issues = [
        item
        for item in issues
        if isinstance(item, dict) and item.get("verified_quote") is True
    ]
    try:
        page_previews = render_contract_page_highlights(
            pdf_path, verified_issues, job_id
        )
    except Exception:
        page_previews = []
    return {
        "analysis": analysis,
        "issue_count": issue_count,
        "high_severity_count": high_severity_count,
        "total_flagged_amount": total_flagged_amount,
        "truncated_chars": len(truncated),
        "total_chars": len(text),
        "detected_locale": detected_locale,
        "jurisdiction_code": effective_jurisdiction,
        "extraction": extraction,
        "page_previews": page_previews,
        "review_note": REVIEW_NOTE,
        "elapsed_ms": int(round((time.perf_counter() - _started) * 1000)),
    }


@app.post("/api/draft-dispute")
async def draft_dispute(body: DisputeRequest) -> dict[str, Any]:
    """Return a bilingual dispute draft via the existing Meta wrapper."""
    _started = time.perf_counter()
    detected_locale = detect_input_locale(
        f"{body.facts}\n{body.desired_outcome}"
    )
    effective_jurisdiction = (
        detected_locale["detected_jurisdiction"]
        if (body.jurisdiction_code or "GLOBAL_AUTO") == "GLOBAL_AUTO"
        and detected_locale["detected_jurisdiction"] != "GLOBAL_AUTO"
        else (body.jurisdiction_code or "GLOBAL_AUTO")
    )
    pack = get_jurisdiction(effective_jurisdiction)
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
        jurisdiction_code=effective_jurisdiction,
    )
    return {
        "draft": draft,
        "detected_locale": detected_locale,
        "jurisdiction_code": effective_jurisdiction,
        "review_note": REVIEW_NOTE,
        "elapsed_ms": int(round((time.perf_counter() - _started) * 1000)),
    }


def _narration_phrases_by_frame(
    transcript: list[dict[str, Any]], picked_indices: list[int]
) -> list[list[str]]:
    """Align narration defect phrases to the sampled frames.

    A transcript segment covers the picked frames whose second falls
    inside its [start, end] window (half a second of tolerance for
    speech that begins just before the frame); a segment covering no
    sampled frame attaches to the nearest one. Deterministic: the
    phrases come from ``services.narration_defect_phrases`` and each
    frame keeps at most two.
    """
    per_frame: list[list[str]] = [[] for _ in picked_indices]
    if not picked_indices:
        return per_frame
    for segment in transcript or []:
        if not isinstance(segment, dict):
            continue
        phrases = narration_defect_phrases(str(segment.get("text", "")))
        if not phrases:
            continue
        try:
            start = float(segment.get("start", 0.0))
            end = float(segment.get("end", start))
        except (TypeError, ValueError):
            continue
        targets = [
            fi
            for fi, second in enumerate(picked_indices)
            if start - 0.5 <= second <= end + 0.5
        ]
        if not targets:
            midpoint = (start + end) / 2.0
            targets = [
                min(
                    range(len(picked_indices)),
                    key=lambda fi: abs(picked_indices[fi] - midpoint),
                )
            ]
        for fi in targets:
            for phrase in phrases:
                if phrase not in per_frame[fi] and len(per_frame[fi]) < 2:
                    per_frame[fi].append(phrase)
    return per_frame


@app.post("/api/process-walkthrough")
async def process_walkthrough(
    file: UploadFile = File(...),
    jurisdiction_code: str = Form("GLOBAL_AUTO"),
    user_language: str = Form("en"),
    text_prompt: str = Form(""),
    max_frames: int = Form(3),
) -> dict[str, Any]:
    """Video -> frames/audio -> transcript (or silent vision) -> SAM -> PDF.

    Voice narration is optional: an empty transcript, a missing audio
    stream, or a blank ``text_prompt`` falls back to autonomous visual
    defect discovery on the extracted keyframes before SAM runs. When
    narration exists and no prompt was typed, defect phrases spotted
    deterministically in the transcript lead the SAM candidate list
    for their scene, ahead of the vision-discovered labels.
    """
    job_id, job_dir = _new_job_dir("jobs")
    suffix = Path(file.filename or "").suffix.lower() or ".mp4"
    if suffix not in {".mp4", ".mov", ".webm", ".mkv", ".avi"}:
        raise HTTPException(status_code=415, detail=f"Unsupported video: {suffix}")
    video_path = job_dir / f"walkthrough-{job_id}{suffix}"
    await _save_upload(file, {suffix}, video_path)

    extracted = extract_1fps_and_audio(video_path, job_dir)
    transcript: list[dict[str, Any]] = []
    if extracted.get("has_audio", True):
        try:
            transcript = await call_muse_voice(extracted["audio_path"])
        except Exception:
            transcript = []
    if not isinstance(transcript, list):
        transcript = []
    transcript_text = " ".join(
        str(seg.get("text", "")) for seg in transcript
        if isinstance(seg, dict)
    ).strip()
    silent = not transcript_text

    # Sample the requested frames evenly across the whole video instead of
    # only its opening seconds, so a longer walkthrough produces evidence
    # from every scene. Each picked frame keeps its source index, which is
    # its second in the video (frames are extracted at 1 fps).
    all_frames = list(extracted["frames"])
    limit = max(1, max_frames)
    if len(all_frames) > limit:
        if limit == 1:
            picked_indices = [0]
        else:
            step = (len(all_frames) - 1) / (limit - 1)
            picked_indices = sorted({round(i * step) for i in range(limit)})
    else:
        picked_indices = list(range(len(all_frames)))
    frames = [all_frames[i] for i in picked_indices]
    user_prompt = (text_prompt or "").strip() if isinstance(text_prompt, str) else ""
    # Narration phrases guide the search only when the user did not
    # type a prompt themselves; a typed prompt always rules alone.
    narration_labels: list[list[str]] = (
        _narration_phrases_by_frame(transcript, picked_indices)
        if not user_prompt
        else [[] for _ in frames]
    )
    auto_labels: list[dict[str, str]] = []
    frame_labels: list[list[dict[str, str]]] = [[] for _ in frames]
    if silent or not user_prompt:
        # Discover defects per sampled frame: different scenes can show
        # different defects, so a single global prompt is not enough.
        seen_prompts: set[str] = set()
        for fi, frame_path in enumerate(frames):
            try:
                found = await discover_visual_defects(
                    frame_path, jurisdiction_code, user_language
                )
            except Exception:
                found = []
            for item in found or []:
                if isinstance(item, dict) and str(item.get("prompt", "")).strip():
                    label: dict[str, Any] = {
                        "prompt": str(item["prompt"]).strip()[:80],
                        "description_local": str(
                            item.get("description_local", "")
                        )[:300],
                        "description_tenant": str(
                            item.get("description_tenant", "")
                        )[:300],
                    }
                    point = item.get("point")
                    if isinstance(point, dict) and "x" in point and "y" in point:
                        try:
                            label["point"] = {
                                "x": float(point["x"]),
                                "y": float(point["y"]),
                            }
                        except (TypeError, ValueError):
                            pass
                    frame_labels[fi].append(label)
                    if label["prompt"] not in seen_prompts:
                        seen_prompts.add(label["prompt"])
                        auto_labels.append(label)
    prompt_text = user_prompt or (
        auto_labels[0]["prompt"] if auto_labels else "visible damage or stain"
    )
    regions: list[dict[str, Any]] = []
    for index, frame_path in enumerate(frames):
        mask_out = job_dir / f"mask-{index:03d}.png"
        primary = user_prompt or (
            frame_labels[index][0]["prompt"] if frame_labels[index] else prompt_text
        )
        # SAM phrases for this frame: its own discovered labels. Other
        # scenes' labels are not useful here and would crowd out this
        # phrase's own fallback variants within the attempt budget; they
        # are only used when this frame produced no labels of its own.
        own_labels = frame_labels[index]
        extra_labels = own_labels if own_labels else auto_labels
        frame_phrases: list[str] = []
        # The tenant's own narration for this scene leads the search:
        # what they said is wrong here is tried before the primary and
        # the vision-discovered labels (which stay in the list, so a
        # narration phrase that SAM cannot ground costs one attempt,
        # never the frame).
        for cand in narration_labels[index]:
            if cand and cand not in frame_phrases:
                frame_phrases.append(cand)
        for cand in [primary] + [label["prompt"] for label in extra_labels]:
            if cand and cand not in frame_phrases:
                frame_phrases.append(cand)
        try:
            sam = await call_sam_concept_with_fallback(
                frame_path, frame_phrases, mask_out,
                max_attempts=6 if narration_labels[index] else 5,
                single_frame=call_sam_3_1_single_frame,
            )
        except Exception as exc:
            # One frame's provider failure (e.g. a SAM read timeout) must
            # not kill the whole walkthrough: the frame is reported as a
            # failed no-match region and the transcript, remaining
            # frames, and handover PDF still complete.
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            sam = {
                "mask_path": None,
                "polygon": None,
                "usage": None,
                "cached": False,
                "match": False,
                "outcome": "failed",
                "diagnostics": [
                    {
                        "severity": "error",
                        "code": "sam_frame_failed",
                        "message": str(detail)[:300],
                        "line": None,
                    }
                ],
                "prompt": {"mode": "concept", "text": primary},
            }
        if not sam.get("match") and sam.get("outcome") != "failed":
            # Concept phrases missed this frame's defect: when its
            # discovered label carries a centre point, try one click
            # there (fixture defects like an open socket segment by
            # click, not by phrase). A provider failure above already
            # produced its failed region and is not retried.
            point = next(
                (l.get("point") for l in own_labels if l.get("point")), None
            )
            if point:
                try:
                    from PIL import Image as _Image

                    with _Image.open(frame_path) as _im:
                        _fw, _fh = _im.size
                    _px = min(_fw - 1, max(0, round(float(point["x"]) * _fw)))
                    _py = min(_fh - 1, max(0, round(float(point["y"]) * _fh)))
                    _patt = await call_sam_3_1_single_frame(
                        frame_path,
                        primary,
                        mask_out,
                        points=[{"x": _px, "y": _py, "label": "positive"}],
                    )
                    if _patt.get("match") and _specific_box(
                        _patt.get("box"), _fw, _fh
                    ):
                        sam = _patt
                except Exception:
                    pass
        regions.append(
            _build_walkthrough_region(frame_path, picked_indices[index], sam)
        )
    detection_mode = "silent_vision_auto" if silent else "voice_and_vision"

    from PIL import Image

    defects: list[dict[str, Any]] = []
    described: dict[str, dict[str, str]] = {}
    if regions:
        desc_system = (
            "Given transcript segments and detected frame regions, return "
            "JSON {defects: [{frame, timestamp, description_local, "
            "description_tenant}]}. Never state legal conclusions as certain."
        )
        try:
            desc_raw = await call_meta_chat(
                desc_system,
                json.dumps(
                    {"transcript": transcript, "regions": regions},
                    ensure_ascii=False,
                ),
                0.0,
                jurisdiction_code=jurisdiction_code,
            )
        except Exception:
            # Descriptions are an enhancement: if the chat call fails the
            # walkthrough still completes with the built-in region labels.
            desc_raw = {}
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
        region_prompt = str(
            (region.get("prompt") or {}).get("text") or prompt_text
        )
        label = f"Possible '{region_prompt}' in {region['frame']} (t={region['second']}s)"
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
        "detection_mode": detection_mode,
        "auto_discovered_prompt": auto_labels[0]["prompt"] if auto_labels else None,
        "auto_descriptions": auto_labels,
        "narration_prompts": list(
            dict.fromkeys(p for frame in narration_labels for p in frame)
        ),
        "review_note": REVIEW_NOTE,
    }


def _prior_centre_point(
    prior_evidence: Any, image_path: Path
) -> dict[str, Any] | None:
    """Centre of the saved move-in outline, in current-image pixels.

    Point-prompt fallback for the verify route: when the concept prompt
    misses on the move-out photo, one click at the prior object's centre
    gives SAM a second, legitimate chance. The centre mirrors exactly
    how ``services._evidence_grid`` normalises the same prior into the
    current frame -- raster boxes live in prior-frame pixels under the
    payload's declared ``frame_size`` and scale by the frame-size ratio;
    polygon points are already in current-frame coordinates unless the
    payload declares a ``frame_size``, in which case they scale the
    same way. Returns None when no centre can be derived (unreadable
    image, empty polygon, malformed shapes).
    """
    from PIL import Image

    try:
        with Image.open(image_path) as img:
            width, height = img.size
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None

    def _native_size(evidence: Any) -> tuple[float, float]:
        declared = (
            evidence.get("frame_size") if isinstance(evidence, dict) else None
        )
        if isinstance(declared, dict):
            try:
                fw, fh = float(declared["width"]), float(declared["height"])
            except (TypeError, KeyError, ValueError):
                return float(width), float(height)
            if fw > 0 and fh > 0:
                return fw, fh
        return float(width), float(height)

    centre: tuple[float, float] | None = None
    if isinstance(prior_evidence, dict) and (
        "mask_png_base64" in prior_evidence
        or "mask_png_bytes" in prior_evidence
    ):
        box = prior_evidence.get("box")
        if not isinstance(box, dict):
            return None
        try:
            centre = (
                (float(box["left"]) + float(box["right"])) / 2,
                (float(box["top"]) + float(box["bottom"])) / 2,
            )
        except (TypeError, KeyError, ValueError):
            return None
    else:
        points = (
            prior_evidence.get("polygon")
            if isinstance(prior_evidence, dict)
            else prior_evidence
        )
        if not isinstance(points, list) or not points:
            return None
        try:
            flat = [[float(x), float(y)] for x, y in points]
        except (TypeError, ValueError):
            return None
        if not flat:
            return None
        xs = [pt[0] for pt in flat]
        ys = [pt[1] for pt in flat]
        centre = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    src_w, src_h = _native_size(prior_evidence)
    x = centre[0] * width / src_w
    y = centre[1] * height / src_h
    return {
        "x": min(width - 1, max(0, int(round(x)))),
        "y": min(height - 1, max(0, int(round(y)))),
        "label": "positive",
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
    _started = time.perf_counter()
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
    sam = await call_sam_concept_with_fallback(
        image_path, [text_prompt], job_dir / f"mask-{job_id}.png",
        single_frame=call_sam_3_1_single_frame,
    )
    if sam.get("match") is False:
        # Second attempt: one click at the centre of the saved move-in
        # outline. Concept phrases miss some defects a point prompt
        # segments exactly; the retry writes to the same mask path so
        # downstream handling is unchanged. If it also misses, the
        # honest no-match response below stands -- no mask is invented.
        point = _prior_centre_point(prior_evidence, image_path)
        if point is not None:
            retry = await call_sam_3_1_single_frame(
                image_path,
                text_prompt,
                job_dir / f"mask-{job_id}.png",
                points=[point],
            )
            if isinstance(retry, dict) and retry.get("match"):
                sam = retry
    if sam.get("match") is False:
        return {
            "mask": sam,
            "comparison": {
                "match": False,
                "note": "SAM 3.1 found no region matching the prompt "
                "or the saved outline's centre point.",
            },
            "review_note": REVIEW_NOTE,
            "elapsed_ms": int(round((time.perf_counter() - _started) * 1000)),
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
        "elapsed_ms": int(round((time.perf_counter() - _started) * 1000)),
    }


def _specific_box(box: Any, frame_w: int, frame_h: int) -> bool:
    """True when a mask box covers at most 60% of the frame.

    A click that lands on a tiny defect can make SAM segment the whole
    surface instead (a speck on a tabletop returned the entire table);
    such non-specific results are rejected as auto-mode evidence.
    """
    if not isinstance(box, dict) or not frame_w or not frame_h:
        return False
    try:
        bw = float(box["right"]) - float(box["left"])
        bh = float(box["bottom"]) - float(box["top"])
    except (TypeError, KeyError, ValueError):
        return False
    return 0 < bw * bh <= 0.6 * frame_w * frame_h


async def _segment_auto_candidates(
    image_path: Path,
    candidates: list[dict[str, Any]],
    job_id: str,
    job_dir: Path,
) -> tuple[dict[str, Any], int]:
    """Auto mode: work through the discovered candidates in order.

    Per candidate: its concept phrases first (with lexicon fallbacks);
    on a miss, when the candidate carries a centre point, one click at
    that point — SAM concept phrases cannot ground some fixture
    defects (an open socket missed every phrasing) that a click
    segments exactly. Click results covering most of the frame are
    rejected as non-specific. Returns ``(sam_record, winner_index)``;
    when nothing matches, the first candidate's no-match record is
    returned so the response shape stays as before.
    """
    from PIL import Image

    try:
        with Image.open(image_path) as img:
            frame_w, frame_h = img.size
    except Exception:
        frame_w = frame_h = 0
    fallback_record: dict[str, Any] | None = None
    for idx, cand in enumerate(candidates):
        prompt = str(cand.get("prompt", "")).strip()
        if not prompt:
            continue
        attempt = await call_sam_concept_with_fallback(
            image_path,
            [prompt],
            job_dir / f"mask-{job_id}-{idx}.png",
            single_frame=call_sam_3_1_single_frame,
        )
        if fallback_record is None:
            fallback_record = attempt
        if attempt.get("match"):
            return attempt, idx
        point = cand.get("point")
        if isinstance(point, dict) and frame_w and frame_h:
            try:
                px = min(frame_w - 1, max(0, round(float(point["x"]) * frame_w)))
                py = min(frame_h - 1, max(0, round(float(point["y"]) * frame_h)))
            except (TypeError, KeyError, ValueError):
                continue
            try:
                patt = await call_sam_3_1_single_frame(
                    image_path,
                    prompt,
                    job_dir / f"mask-{job_id}-{idx}p.png",
                    points=[{"x": px, "y": py, "label": "positive"}],
                )
            except Exception:
                patt = None
            if (
                patt is not None
                and patt.get("match")
                and _specific_box(patt.get("box"), frame_w, frame_h)
            ):
                return patt, idx
    if fallback_record is None:
        raise HTTPException(
            status_code=502, detail="Auto-discovery produced no usable candidates."
        )
    return fallback_record, 0


@app.post("/api/segment-image")
async def segment_image(
    file: UploadFile = File(...),
    text_prompt: str = Form(""),
    points: str = Form(""),
    jurisdiction_code: str = Form("GLOBAL_AUTO"),
    user_language: str = Form("en"),
) -> dict[str, Any]:
    """Segment one uploaded image with live Meta SAM 3.1.

    Auto-Detect Mode: when ``text_prompt`` is empty/blank and no points
    are given, visual defects are discovered first and the top concept
    prompt is passed to SAM automatically. Two mutually exclusive
    prompt modes otherwise: points mode ignores the concept text.
    """
    _started = time.perf_counter()
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
    auto_discovered_prompt: str | None = None
    auto_descriptions: list[dict[str, Any]] = []
    effective_prompt = (text_prompt or "").strip() if isinstance(text_prompt, str) else ""
    if not effective_prompt and not parsed_points:
        try:
            found = await discover_visual_defects(
                image_path, jurisdiction_code, user_language
            )
        except Exception:
            found = []
        for item in found or []:
            if isinstance(item, dict) and str(item.get("prompt", "")).strip():
                entry: dict[str, Any] = {
                    "prompt": str(item["prompt"]).strip()[:80],
                    "description_local": str(
                        item.get("description_local", "")
                    )[:300],
                    "description_tenant": str(
                        item.get("description_tenant", "")
                    )[:300],
                }
                point = item.get("point")
                if isinstance(point, dict) and "x" in point and "y" in point:
                    try:
                        entry["point"] = {
                            "x": float(point["x"]),
                            "y": float(point["y"]),
                        }
                    except (TypeError, ValueError):
                        pass
                auto_descriptions.append(entry)
        if auto_descriptions:
            auto_discovered_prompt = auto_descriptions[0]["prompt"]
            effective_prompt = auto_discovered_prompt
    if not effective_prompt and not parsed_points:
        effective_prompt = "visible damage or stain"
    if parsed_points:
        sam = await call_sam_3_1_single_frame(
            image_path, effective_prompt or "visible damage or stain",
            job_dir / f"mask-{job_id}.png",
            points=parsed_points,
        )
    elif auto_descriptions:
        # Auto mode: per-candidate attempts (concept phrases, then a
        # click at the candidate's centre point) in discovery order.
        sam, winner = await _segment_auto_candidates(
            image_path, auto_descriptions, job_id, job_dir
        )
        if sam.get("match"):
            auto_discovered_prompt = auto_descriptions[winner]["prompt"]
    else:
        # Typed prompt: SAM phrasing is hit-or-miss, so on a no-match the
        # known defect-phrase variants are tried before reporting no
        # match (bounded, metered per attempt).
        sam = await call_sam_concept_with_fallback(
            image_path,
            [effective_prompt or "visible damage or stain"],
            job_dir / f"mask-{job_id}.png",
            single_frame=call_sam_3_1_single_frame,
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
        "auto_discovered_prompt": auto_discovered_prompt,
        "auto_descriptions": auto_descriptions,
        "review_note": REVIEW_NOTE,
        "elapsed_ms": int(round((time.perf_counter() - _started) * 1000)),
    }
