"""Meta Model API wrapper with CreditShield caching and spend budgets."""

from __future__ import annotations

import base64
import json
import math
import shutil
import struct
import subprocess
import zlib
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException

from config import credit_shield, settings

REGISTRY_PATH = Path(__file__).resolve().parent / "jurisdictions" / "registry.json"

# Meta Model API chat endpoint (relative to settings.META_API_BASE_URL).
ENDPOINT = "chat/completions"

# Sentinel API key that enables deterministic offline responses for tests.
MOCK_API_KEY = "MOCK_FREE_TEST"

_registry: dict[str, Any] | None = None


def load_registry() -> dict[str, Any]:
    """Load the jurisdiction registry once and reuse it afterwards."""
    global _registry
    if _registry is None:
        _registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return _registry


def get_jurisdiction(jurisdiction_code: str) -> dict[str, Any]:
    """Return the registry entry for a code, falling back to GLOBAL_AUTO."""
    registry = load_registry()
    entry = registry.get(jurisdiction_code)
    if not isinstance(entry, dict):
        entry = registry["GLOBAL_AUTO"]
    return entry


def build_system_prompt(
    system_prompt: str, jurisdiction_code: str, use_prefix_cache: bool
) -> str:
    """Compose the effective system prompt with jurisdiction statutes.

    When prefix caching is requested, the statute text goes first so that
    identical prefixes can be reused across calls.
    """
    statutes = str(get_jurisdiction(jurisdiction_code).get("statutes", ""))
    if use_prefix_cache:
        return f"{statutes}\n\n{system_prompt}"
    return f"{system_prompt}\n\n{statutes}"


def build_cache_payload(
    model: str, system_prompt: str, user_content: str, jurisdiction_code: str
) -> bytes:
    """Canonical request bytes used as the CreditShield cache key input."""
    return json.dumps(
        {
            "model": model,
            "system": system_prompt,
            "user": user_content,
            "jurisdiction": jurisdiction_code,
        },
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")


def strip_markdown_fences(text: str) -> str:
    """Remove surrounding Markdown code fences if present."""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    lines = lines[1:]  # drop opening fence (may carry a language tag)
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _mock_response(model: str, jurisdiction_code: str) -> dict[str, Any]:
    """Small deterministic offline response used for MOCK_FREE_TEST."""
    return {
        "mock": True,
        "model": model,
        "jurisdiction": jurisdiction_code,
        "result": {"status": "ok", "findings": []},
        "usage": {"cost_usd": 0.0},
    }


async def call_meta_chat(
    model: str,
    system_prompt: str,
    user_content: str,
    est_cost: float,
    jurisdiction_code: str = "GLOBAL_AUTO",
    use_prefix_cache: bool = False,
) -> Any:
    """Call the Meta Model API chat endpoint with caching and budgets.

    On a CreditShield cache hit the cached JSON is returned without any
    API call. On a miss the budget is verified before calling Meta, the
    model's JSON content is parsed (tolerating Markdown fences), and the
    parsed response plus actual usage/cost data are saved via CreditShield.
    """
    effective_system = build_system_prompt(
        system_prompt, jurisdiction_code, use_prefix_cache
    )
    payload_bytes = build_cache_payload(
        model, effective_system, user_content, jurisdiction_code
    )

    if settings.META_API_KEY == MOCK_API_KEY:
        try:
            cached = credit_shield.fetch_or_record(payload_bytes, ENDPOINT)
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            cached = None  # offline lock cannot block a mock (no live call)
        if cached is not None:
            return cached
        mock = _mock_response(model, jurisdiction_code)
        key = credit_shield.cache_key_for(payload_bytes)
        credit_shield.save_response(key, ENDPOINT, "meta-mock", mock, 0.0)
        return mock

    cached = credit_shield.fetch_or_record(payload_bytes, ENDPOINT)
    if cached is not None:
        return cached

    credit_shield.verify_budget(est_cost)

    url = settings.META_API_BASE_URL.rstrip("/") + "/" + ENDPOINT
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": effective_system},
            {"role": "user", "content": user_content},
        ],
    }
    headers = {
        "Authorization": f"Bearer {settings.META_API_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(url, headers=headers, json=body)
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Meta API error {response.status_code}: {response.text[:500]}",
        )
    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise HTTPException(
            status_code=502, detail=f"Unexpected Meta API response shape: {exc}"
        ) from exc
    try:
        parsed = json.loads(strip_markdown_fences(str(content)))
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"Meta API did not return JSON content: {exc}"
        ) from exc

    usage = data.get("usage") or {}
    try:
        actual_cost = float(usage.get("cost_usd", est_cost))
    except (TypeError, ValueError):
        actual_cost = float(est_cost)
    key = credit_shield.cache_key_for(payload_bytes)
    credit_shield.save_response(key, ENDPOINT, "meta", parsed, actual_cost)
    return parsed


# ---------------------------------------------------------------------------
# Media preprocessing (FFmpeg, only if already installed)
# ---------------------------------------------------------------------------

def _require_ffmpeg() -> str:
    """Return the FFmpeg executable path or raise if it is not available."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise HTTPException(
            status_code=500,
            detail="FFmpeg is not available on this host; "
            "extract_1fps_and_audio cannot run.",
        )
    return ffmpeg


def extract_1fps_and_audio(
    video_path: str | Path, job_dir: str | Path
) -> dict[str, Any]:
    """Extract mono 16 kHz audio and 1 fps JPEG frames (max 1280 px wide).

    Requires FFmpeg to already be installed; nothing is downloaded here.
    """
    ffmpeg = _require_ffmpeg()
    video = Path(video_path)
    if not video.is_file():
        raise HTTPException(
            status_code=404, detail=f"Video not found: {video}"
        )
    job = Path(job_dir)
    frames_dir = job / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    audio_path = job / "audio.wav"

    audio = subprocess.run(
        [ffmpeg, "-y", "-i", str(video), "-vn",
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio_path)],
        capture_output=True,
        text=True,
    )
    if audio.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"FFmpeg audio extraction failed: {audio.stderr[-500:]}",
        )
    frames = subprocess.run(
        [ffmpeg, "-y", "-i", str(video), "-vf",
         "fps=1,scale=min(1280\\,iw):-2",
         str(frames_dir / "frame-%06d.jpg")],
        capture_output=True,
        text=True,
    )
    if frames.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"FFmpeg frame extraction failed: {frames.stderr[-500:]}",
        )
    frame_paths = sorted(str(p) for p in frames_dir.glob("frame-*.jpg"))
    return {
        "audio_path": str(audio_path),
        "frames": frame_paths,
        "frame_count": len(frame_paths),
        "fps": 1,
    }


# ---------------------------------------------------------------------------
# Muse Voice transcription (Meta Model API)
# ---------------------------------------------------------------------------

# Documented Muse Voice Transcribe model on the Meta Model API.
MUSE_VOICE_ENDPOINT = "audio/transcriptions"
MUSE_VOICE_TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0"

MUSE_VOICE_MOCK_SEGMENTS = [
    {
        "start": 0.0,
        "end": 4.5,
        "text": "Mock narration: entry hallway, walls and ceiling in good condition.",
    },
    {
        "start": 4.5,
        "end": 9.0,
        "text": "Mock narration: living room, small scuff mark beside the door frame.",
    },
]


def _record_cost(usage: Any) -> tuple[float, Any]:
    """Split API usage into (ledger_cost, recorded_cost).

    Uses the actual cost reported by the API when present. When the exact
    spend cannot be determined, the ledger takes 0.0 and the record keeps
    the explicit marker "unknown" instead of an invented value.
    """
    if isinstance(usage, dict) and usage.get("cost_usd") is not None:
        try:
            cost = float(usage["cost_usd"])
        except (TypeError, ValueError):
            pass
        else:
            return cost, cost
    return 0.0, "unknown"


def _normalize_segments(data: Any) -> list[dict[str, Any]]:
    """Accept verbose segment lists or plain text; always return segments."""
    if isinstance(data, dict):
        raw = data.get("segments")
        if isinstance(raw, list) and raw:
            segments = []
            for item in raw:
                if isinstance(item, dict) and "text" in item:
                    segments.append(
                        {
                            "start": item.get("start", 0.0),
                            "end": item.get("end"),
                            "text": str(item.get("text", "")),
                        }
                    )
            if segments:
                return segments
        text = data.get("text")
        if isinstance(text, str) and text.strip():
            return [{"start": 0.0, "end": None, "text": text.strip()}]
    raise HTTPException(
        status_code=502, detail="Muse Voice response contained no transcript"
    )


async def call_muse_voice(audio_path: str | Path) -> list[dict[str, Any]]:
    """Transcribe audio with Muse Voice; cached results need no live call."""
    audio = Path(audio_path)
    if not audio.is_file():
        raise HTTPException(status_code=404, detail=f"Audio not found: {audio}")
    payload_bytes = (
        MUSE_VOICE_TRANSCRIBE_MODEL.encode("utf-8") + b"\x00" + audio.read_bytes()
    )

    if settings.META_API_KEY == MOCK_API_KEY:
        try:
            cached = credit_shield.fetch_or_record(
                payload_bytes, MUSE_VOICE_ENDPOINT
            )
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            cached = None
        if isinstance(cached, dict) and isinstance(cached.get("segments"), list):
            return cached["segments"]
        if cached is not None:
            return cached
        segments = [dict(s) for s in MUSE_VOICE_MOCK_SEGMENTS]
        record = {
            "segments": segments,
            "usage": {"cost_usd": 0.0},
            "model": MUSE_VOICE_TRANSCRIBE_MODEL,
            "mock": True,
        }
        key = credit_shield.cache_key_for(payload_bytes)
        credit_shield.save_response(
            key, MUSE_VOICE_ENDPOINT, "meta-mock", record, 0.0
        )
        return segments

    cached = credit_shield.fetch_or_record(payload_bytes, MUSE_VOICE_ENDPOINT)
    if cached is not None:
        record = cached if isinstance(cached, dict) else {}
        return record.get("segments", cached)

    credit_shield.verify_budget(0.0)

    url = settings.META_API_BASE_URL.rstrip("/") + "/" + MUSE_VOICE_ENDPOINT
    headers = {"Authorization": f"Bearer {settings.META_API_KEY}"}
    with audio.open("rb") as stream:
        files = {"file": (audio.name, stream, "audio/wav")}
        data = {"model": MUSE_VOICE_TRANSCRIBE_MODEL}
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(url, headers=headers, files=files, data=data)
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Meta API error {response.status_code}: {response.text[:500]}",
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"Muse Voice returned non-JSON: {exc}"
        ) from exc
    segments = _normalize_segments(body)
    usage = body.get("usage") if isinstance(body, dict) else None
    ledger_cost, recorded_cost = _record_cost(usage)
    record = {
        "segments": segments,
        "usage": usage if isinstance(usage, dict) else {"cost_usd": recorded_cost},
        "model": MUSE_VOICE_TRANSCRIBE_MODEL,
    }
    if record["usage"].get("cost_usd") is None:
        record["usage"]["cost_usd"] = recorded_cost
    key = credit_shield.cache_key_for(payload_bytes)
    credit_shield.save_response(
        key, MUSE_VOICE_ENDPOINT, "meta-muse-voice", record, ledger_cost
    )
    return segments


# ---------------------------------------------------------------------------
# SAM 3.1 single-frame segmentation (Meta Model API)
# ---------------------------------------------------------------------------

# Hosted SAM 3.1 text-concept segmentation on the Meta Model API.
SAM31_ENDPOINT = "segmentations"
SAM31_MODEL = "sam-3.1"


def _rasterize_polygon(
    polygon: list[list[float]], width: int, height: int
) -> bytearray:
    """Scanline-fill a polygon into a flat W*H mask (stdlib only)."""
    grid = bytearray(width * height)
    if len(polygon) < 3 or width <= 0 or height <= 0:
        return grid
    pts = [(float(x), float(y)) for x, y in polygon]
    for y in range(height):
        yc = y + 0.5
        xs: list[float] = []
        n = len(pts)
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            if (y1 <= yc) != (y2 <= yc):
                xs.append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for j in range(0, len(xs) - 1, 2):
            x0 = max(0, math.ceil(xs[j] - 0.5))
            x1 = min(width, math.ceil(xs[j + 1] - 0.5))
            for x in range(x0, x1):
                grid[y * width + x] = 1
    return grid


def _write_grayscale_png(path: str | Path, width: int, height: int, grid: Any) -> None:
    """Write a white-on-black mask PNG using stdlib struct/zlib only."""
    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        body = chunk_type + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + bytes(grid[y * width:(y + 1) * width]) * 255
        for y in range(height)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    Path(path).write_bytes(png)


def _jpeg_size(path: Path) -> tuple[int, int] | None:
    """Read JPEG dimensions from SOF markers without image libraries."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if data[:2] != b"\xff\xd8":
        return None
    i, n = 2, len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        i += 2
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue
        seg_len = struct.unpack(">H", data[i:i + 2])[0]
        if marker in (
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        ):
            if i + 7 > n:
                return None
            height, width = struct.unpack(">HH", data[i + 3:i + 7])
            return (width, height)
        i += seg_len
    return None


def _synthetic_mask_polygon(width: int = 320, height: int = 240) -> list[list[int]]:
    """Clearly synthetic regular-octagon polygon (mock masks only)."""
    cx, cy, radius = width // 2, height // 2, min(width, height) // 3
    return [
        [
            int(round(cx + radius * math.cos(math.pi / 8 + k * math.pi / 4))),
            int(round(cy + radius * math.sin(math.pi / 8 + k * math.pi / 4))),
        ]
        for k in range(8)
    ]


async def call_sam_3_1_single_frame(
    frame_path: str | Path, text_prompt: str, out_path: str | Path
) -> dict[str, Any]:
    """Segment one JPEG with a text prompt via hosted SAM 3.1.

    Only the single frame plus the text prompt are ever sent; video
    streams are never uploaded. Results are cached by image+prompt hash.
    """
    frame = Path(frame_path)
    if not frame.is_file():
        raise HTTPException(status_code=404, detail=f"Frame not found: {frame}")
    image_bytes = frame.read_bytes()
    payload_bytes = (
        SAM31_MODEL.encode("utf-8")
        + b"\x00"
        + text_prompt.encode("utf-8")
        + b"\x00"
        + image_bytes
    )
    out = Path(out_path)
    if out.parent != Path("") and str(out.parent) not in ("", "."):
        out.parent.mkdir(parents=True, exist_ok=True)

    def _finish(record: dict[str, Any], cached: bool) -> dict[str, Any]:
        raw_b64 = record.get("mask_png_base64")
        if isinstance(raw_b64, str):
            out.write_bytes(base64.b64decode(raw_b64))
        elif record.get("polygon") and _jpeg_size(frame):
            w, h = _jpeg_size(frame)  # type: ignore[misc]
            _write_grayscale_png(
                out, w, h, _rasterize_polygon(record["polygon"], w, h)
            )
        return {
            "mask_path": str(out),
            "polygon": record.get("polygon"),
            "usage": record.get("usage"),
            "cached": cached,
        }

    if settings.META_API_KEY == MOCK_API_KEY:
        try:
            cached = credit_shield.fetch_or_record(payload_bytes, SAM31_ENDPOINT)
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            cached = None
        if isinstance(cached, dict) and cached.get("mask_png_base64"):
            return _finish(cached, True)
        polygon = _synthetic_mask_polygon()
        grid = _rasterize_polygon(polygon, 320, 240)
        _write_grayscale_png(out, 320, 240, grid)
        mask_b64 = base64.b64encode(out.read_bytes()).decode("ascii")
        record = {
            "mask_path": str(out),
            "polygon": polygon,
            "mask_png_base64": mask_b64,
            "usage": {"cost_usd": 0.0},
            "model": SAM31_MODEL,
            "mock": True,
        }
        key = credit_shield.cache_key_for(payload_bytes)
        credit_shield.save_response(key, SAM31_ENDPOINT, "meta-mock", record, 0.0)
        return {**record, "mask_png_base64": mask_b64, "cached": False}

    cached = credit_shield.fetch_or_record(payload_bytes, SAM31_ENDPOINT)
    if isinstance(cached, dict) and (
        cached.get("mask_png_base64") or cached.get("polygon")
    ):
        return _finish(cached, True)

    credit_shield.verify_budget(0.0)

    url = settings.META_API_BASE_URL.rstrip("/") + "/" + SAM31_ENDPOINT
    headers = {"Authorization": f"Bearer {settings.META_API_KEY}"}
    with frame.open("rb") as stream:
        files = {"image": (frame.name, stream, "image/jpeg")}
        data = {"model": SAM31_MODEL, "prompt": text_prompt}
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(url, headers=headers, files=files, data=data)
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Meta API error {response.status_code}: {response.text[:500]}",
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"SAM 3.1 returned non-JSON: {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="Unexpected SAM 3.1 response shape")

    polygon = body.get("polygon")
    mask_b64 = body.get("mask_png_base64") or body.get("mask")
    record_masks: dict[str, Any] = {"model": SAM31_MODEL}
    if isinstance(polygon, list) and polygon:
        record_masks["polygon"] = polygon
    if isinstance(mask_b64, str) and mask_b64:
        record_masks["mask_png_base64"] = mask_b64
    if "polygon" not in record_masks and "mask_png_base64" not in record_masks:
        raise HTTPException(
            status_code=502, detail="SAM 3.1 response contained no mask"
        )
    usage = body.get("usage")
    ledger_cost, recorded_cost = _record_cost(usage)
    record_masks["usage"] = (
        usage if isinstance(usage, dict) else {"cost_usd": recorded_cost}
    )
    if record_masks["usage"].get("cost_usd") is None:
        record_masks["usage"]["cost_usd"] = recorded_cost
    key = credit_shield.cache_key_for(payload_bytes)
    credit_shield.save_response(
        key, SAM31_ENDPOINT, "meta-sam31", record_masks, ledger_cost
    )
    return _finish(record_masks, False)


# ---------------------------------------------------------------------------
# Local move-out comparison (no API call)
# ---------------------------------------------------------------------------

def compare_moveout_crops_local(
    day1_polygon: list[list[float]],
    moveout_polygon: list[list[float]],
    img_size: tuple[int, int],
) -> dict[str, Any]:
    """Compute polygon-mask IoU and area growth fully locally.

    No network or API call is made; both polygons are rasterized on a
    W*H grid derived from ``img_size``.
    """
    width, height = img_size
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="img_size must be positive")
    if len(day1_polygon) < 3 or len(moveout_polygon) < 3:
        raise HTTPException(status_code=400, detail="Both polygons need 3+ points")
    day1 = _rasterize_polygon(day1_polygon, width, height)
    moveout = _rasterize_polygon(moveout_polygon, width, height)
    day1_area = sum(day1)
    moveout_area = sum(moveout)
    inter = sum(1 for a, b in zip(day1, moveout) if a and b)
    union = day1_area + moveout_area - inter
    if union == 0:
        iou = 1.0
    else:
        iou = inter / union
    if day1_area == 0:
        growth = 0.0
    else:
        growth = (moveout_area - day1_area) / day1_area
    return {
        "iou": iou,
        "day1_area_px": day1_area,
        "moveout_area_px": moveout_area,
        "area_growth_ratio": growth,
    }
