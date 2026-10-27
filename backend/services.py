"""Meta Model API wrapper with CreditShield caching and spend budgets."""

from __future__ import annotations

import base64
import io
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

from config import (
    BASETEN_CHAT_MODEL_REQUIRED,
    CHAT_INPUT_USD_PER_1K_TOKENS,
    CHAT_MAX_OUTPUT_TOKENS,
    CHAT_OUTPUT_USD_PER_1K_TOKENS,
    META_CHAT_MODEL_DEFAULT,
    META_CHAT_MODEL_RETIRED,
    SAM_USD_PER_IMAGE,
    VOICE_USD_PER_MINUTE,
    credit_shield,
    settings,
)

try:
    from meta_sam_parser import (
        FramePrompt,
        InvalidSegmentationMaskError,
        ObjectPromptError,
        PromptObject,
        PromptPoint,
        ResponsesStreamError,
        build_object_prompt,
        decode_mask_to_raster,
        image_segmentation_format,
        parse_responses_stream,
    )
    _SAM_PARSER_AVAILABLE = True
except ImportError:  # pragma: no cover - installed via requirements.txt
    FramePrompt = None  # type: ignore[assignment,misc]
    InvalidSegmentationMaskError = Exception  # type: ignore[assignment,misc]
    ObjectPromptError = Exception  # type: ignore[assignment,misc]
    PromptObject = None  # type: ignore[assignment,misc]
    PromptPoint = None  # type: ignore[assignment,misc]
    ResponsesStreamError = Exception  # type: ignore[assignment,misc]
    build_object_prompt = None  # type: ignore[assignment]
    decode_mask_to_raster = None  # type: ignore[assignment]
    image_segmentation_format = None  # type: ignore[assignment]
    parse_responses_stream = None  # type: ignore[assignment]
    _SAM_PARSER_AVAILABLE = False

REGISTRY_PATH = Path(__file__).resolve().parent / "jurisdictions" / "registry.json"

# OpenAI-compatible chat endpoint (relative to the chat provider base URL).
ENDPOINT = "chat/completions"

# Sentinel API key that enables deterministic offline responses for tests.
MOCK_API_KEY = "MOCK_FREE_TEST"


def _use_mock() -> bool:
    """True when chat/media calls must stay fully offline.

    Mock mode is selected server-side via ``CHAT_PROVIDER=mock`` (the
    default, so a fresh setup cannot make a paid request). The legacy
    ``MOCK_FREE_TEST`` sentinel key is honoured the same way.
    """
    return settings.CHAT_PROVIDER == "mock" or settings.META_API_KEY == MOCK_API_KEY

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
    system_prompt: str,
    user_content: str,
    est_cost: float,
    jurisdiction_code: str = "GLOBAL_AUTO",
    use_prefix_cache: bool = False,
    model: str | None = None,
) -> Any:
    """Call the configured chat provider with caching and budgets.

    The provider, base URL, and model are resolved server-side from
    ``settings`` (``CHAT_PROVIDER``); the optional ``model`` argument is
    never taken from the browser and never overrides the server
    configuration. ``mock`` performs zero network calls. ``baseten`` uses
    exactly ``meta-models/muse-spark-open-1026`` at the Baseten base URL.
    ``meta`` uses ``META_CHAT_MODEL_ID`` (default ``muse-spark-1.3``).
    A retired model ID is rejected instead of being sent.

    On a CreditShield cache hit the cached JSON is returned without any
    API call. On a miss the budget is verified before the live call, the
    model's JSON content is parsed (tolerating Markdown fences), and the
    parsed response plus raw reported usage are saved via CreditShield.
    There is no fallback from one provider to another: a missing key or a
    failed request raises instead of retrying elsewhere.
    """
    if model is not None and META_CHAT_MODEL_RETIRED in model:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Model '{model}' is retired. Server default is "
                f"'{META_CHAT_MODEL_DEFAULT}'."
            ),
        )
    if _use_mock():
        server_model = META_CHAT_MODEL_DEFAULT
        effective_system = build_system_prompt(
            system_prompt, jurisdiction_code, use_prefix_cache
        )
        payload_bytes = build_cache_payload(
            server_model, effective_system, user_content, jurisdiction_code
        )
        try:
            cached = credit_shield.fetch_or_record(payload_bytes, ENDPOINT)
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            cached = None  # offline lock cannot block a mock (no live call)
        if cached is not None:
            if isinstance(cached, dict) and cached.get("mock") is True:
                return cached
            if (
                isinstance(cached, dict)
                and "result" in cached
                and "provider" in cached
            ):
                return cached["result"]
            return cached
        mock = _mock_response(server_model, jurisdiction_code)
        key = credit_shield.cache_key_for(payload_bytes)
        credit_shield.save_response(key, ENDPOINT, "meta-mock", mock, 0.0)
        return mock

    # Resolves (provider, base_url, model) or raises 503/500 before any
    # request when the selected live provider has no key configured.
    provider, base_url, server_model = settings.resolve_chat_target()
    effective_system = build_system_prompt(
        system_prompt, jurisdiction_code, use_prefix_cache
    )
    payload_bytes = build_cache_payload(
        server_model, effective_system, user_content, jurisdiction_code
    )

    cached = credit_shield.fetch_or_record(payload_bytes, ENDPOINT)
    if cached is not None:
        if (
            isinstance(cached, dict)
            and "result" in cached
            and "provider" in cached
        ):
            return cached["result"]
        return cached

    # Conservative pre-call estimate from the input size and the output
    # cap; the request is rejected when it cannot fit the app budget. The
    # reservation stands for live calls whose exact cost stays unknown; it
    # is released on failure or when a monetary actual is recorded.
    pre_call_estimate = max(
        float(est_cost or 0.0),
        estimate_chat_cost(effective_system, user_content),
    )
    key = credit_shield.cache_key_for(payload_bytes)
    credit_shield.verify_budget(pre_call_estimate)
    credit_shield.reserve(key, ENDPOINT, provider, pre_call_estimate)

    url = base_url + "/" + ENDPOINT
    api_key = (
        settings.BASETEN_API_KEY if provider == "baseten" else settings.META_API_KEY
    )
    body = {
        "model": server_model,
        "messages": [
            {"role": "system", "content": effective_system},
            {"role": "user", "content": user_content},
        ],
        # Low reasoning effort where the endpoint supports it.
        "reasoning_effort": "low",
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(url, headers=headers, json=body)
    if response.status_code != 200:
        credit_shield.release(key)
        raise HTTPException(
            status_code=502,
            detail=(
                f"Chat API error ({provider}) "
                f"{response.status_code}: {response.text[:500]}"
            ),
        )
    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        credit_shield.release(key)
        raise HTTPException(
            status_code=502, detail=f"Unexpected chat API response shape: {exc}"
        ) from exc
    try:
        parsed = json.loads(strip_markdown_fences(str(content)))
    except ValueError as exc:
        credit_shield.release(key)
        raise HTTPException(
            status_code=502, detail=f"Chat API did not return JSON content: {exc}"
        ) from exc

    usage = data.get("usage") if isinstance(data, dict) else None
    ledger_cost, recorded_cost = _record_cost(usage)
    record = {
        "result": parsed,
        "usage": usage if isinstance(usage, dict) else {"cost_usd": recorded_cost},
        "model": server_model,
        "provider": provider,
    }
    if record["usage"].get("cost_usd") is None:
        record["usage"]["cost_usd"] = recorded_cost
    if ledger_cost is not None:
        credit_shield.release(key)  # monetary actual replaces the estimate
    credit_shield.save_response(key, ENDPOINT, provider, record, ledger_cost)
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

# Documented Muse Voice Transcribe route on the Meta Model API
# (POST {base}/v1/asr/transcribe) and model ID.
MUSE_VOICE_ENDPOINT = "asr/transcribe"
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


def _record_cost(usage: Any) -> tuple[float | None, Any]:
    """Split API usage into (ledger_cost, recorded_cost).

    Uses the actual monetary cost reported by the API when present
    (``cost_usd`` / ``total_cost``). Token/audio/frame counts alone are
    not converted: without the applicable documented rate schedule an
    exact cost cannot be determined, so the ledger takes NULL and the
    record keeps the explicit marker "unknown" instead of an invented
    value. Unknown live spend is never stored as $0.00.
    """
    if isinstance(usage, dict):
        for key in ("cost_usd", "total_cost"):
            if usage.get(key) is not None:
                try:
                    cost = float(usage[key])
                except (TypeError, ValueError):
                    break
                else:
                    return cost, cost
    return None, "unknown"


def _estimate_tokens(chars: int) -> int:
    """Conservative character-to-token estimate for pre-call budgeting."""
    return max(1, chars // 4)


def estimate_chat_cost(system_prompt: str, user_content: str) -> float:
    """Conservative pre-call chat estimate from input size + output cap."""
    in_tokens = _estimate_tokens(len(system_prompt) + len(user_content))
    return (
        in_tokens / 1000 * CHAT_INPUT_USD_PER_1K_TOKENS
        + CHAT_MAX_OUTPUT_TOKENS / 1000 * CHAT_OUTPUT_USD_PER_1K_TOKENS
    )


def estimate_voice_cost(audio_bytes: int) -> float:
    """Conservative pre-call voice estimate from 16 kHz mono 16-bit size."""
    seconds = max(1.0, audio_bytes / 32000.0)
    return seconds / 60.0 * VOICE_USD_PER_MINUTE


def estimate_sam_cost() -> float:
    """Conservative pre-call per-image segmentation estimate."""
    return SAM_USD_PER_IMAGE


# Minimum normalized characters for a lease excerpt to count as verifiable
# evidence: shorter snippets match coincidentally and prove nothing.
_MIN_VERIFIABLE_QUOTE_CHARS = 12


def _normalize_for_match(value: Any) -> str:
    """Collapse all whitespace so formatting cannot hide a verbatim match."""
    return " ".join(str(value).split())


def _validate_lease_issue(item: Any, haystack: str) -> dict[str, Any]:
    """Check one finding against the normalized extracted lease text.

    The model's original wording is kept as-is; only the comparison is
    normalized. A quote that is missing, too short, or absent from the
    lease text marks the issue unverified instead of document-supported.
    A citation kept only when it appears in the lease text, else null --
    legal references are never generated from memory.
    """
    entry = dict(item) if isinstance(item, dict) else {}
    reasons: list[str] = []
    quote = entry.get("evidence_quote")
    flat_quote = _normalize_for_match(quote) if isinstance(quote, str) else ""
    if not flat_quote:
        reasons.append("no evidence_quote provided")
    elif len(flat_quote) < _MIN_VERIFIABLE_QUOTE_CHARS:
        reasons.append("evidence_quote too short to verify")
    elif flat_quote not in haystack:
        reasons.append("evidence_quote not found in the extracted lease text")
    why = entry.get("why_risky")
    if not (isinstance(why, str) and why.strip()):
        reasons.append("why_risky is missing")
    entry["evidence_quote"] = quote if isinstance(quote, str) else None
    entry["verified_quote"] = not reasons
    citation = entry.get("citation")
    if citation is None:
        entry["citation"] = None
    else:
        flat_citation = _normalize_for_match(citation)
        if flat_citation and flat_citation in haystack:
            entry["citation"] = citation
        else:
            entry["citation"] = None
            reasons.append("citation not found in the extracted lease text")
    if entry.get("severity") not in ("low", "medium", "high"):
        entry["severity"] = None
    entry["verification_note"] = None if not reasons else "; ".join(reasons)
    return entry


def validate_lease_findings(
    analysis: Any, extracted_text: str
) -> dict[str, Any]:
    """Rebuild a lease analysis from validated contract keys only.

    Each possible issue is checked against the extracted lease text (see
    ``_validate_lease_issue``); unvalidated numeric claims such as
    ``risk_score`` or ``estimated_savings`` are dropped, so the frontend
    keeps showing them as not provided unless a validated value exists.
    Never mutates the input.
    """
    cleaned = dict(analysis) if isinstance(analysis, dict) else {}
    for key in ("risk_score", "estimated_savings"):
        cleaned.pop(key, None)
    haystack = _normalize_for_match(extracted_text or "")
    raw_issues = cleaned.get("possible_issues")
    issues = (
        [_validate_lease_issue(item, haystack) for item in raw_issues]
        if isinstance(raw_issues, list)
        else []
    )
    cleaned["possible_issues"] = issues
    verified = sum(1 for issue in issues if issue.get("verified_quote") is True)
    cleaned["verification"] = {
        "checked_issues": len(issues),
        "verified_quotes": verified,
        "unverified_quotes": len(issues) - verified,
    }
    return cleaned


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
    """Transcribe audio with Muse Voice; cached results need no live call.

    Muse Voice always uses the Meta Model API -- never Baseten -- and
    there is no cross-provider fallback. In mock mode no network call
    is made. Otherwise a missing ``META_API_KEY`` raises before any
    request is attempted.
    """
    audio = Path(audio_path)
    if not audio.is_file():
        raise HTTPException(status_code=404, detail=f"Audio not found: {audio}")
    audio_bytes = audio.read_bytes()
    payload_bytes = MUSE_VOICE_TRANSCRIBE_MODEL.encode("utf-8") + b"\x00" + audio_bytes

    if _use_mock():
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

    # Conservative pre-call estimate from the audio size; the request is
    # rejected when it cannot fit the app budget. The reservation stands
    # while the exact cost stays unknown; it is released on failure or
    # when a monetary actual is recorded.
    voice_estimate = estimate_voice_cost(len(audio_bytes))
    key = credit_shield.cache_key_for(payload_bytes)
    credit_shield.verify_budget(voice_estimate)
    credit_shield.reserve(key, MUSE_VOICE_ENDPOINT, "meta-muse-voice", voice_estimate)

    # Fail clearly before any request when no Meta key is configured.
    # Muse Voice is never routed to Baseten or any other provider.
    api_key = settings.require_meta_key("Muse Voice transcription")
    url = settings.META_API_BASE_URL.rstrip("/") + "/" + MUSE_VOICE_ENDPOINT
    headers = {"Authorization": f"Bearer {api_key}"}
    with audio.open("rb") as stream:
        files = {"file": (audio.name, stream, "audio/wav")}
        data = {"model": MUSE_VOICE_TRANSCRIBE_MODEL}
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(url, headers=headers, files=files, data=data)
    if response.status_code != 200:
        credit_shield.release(key)
        raise HTTPException(
            status_code=502,
            detail=f"Meta API error {response.status_code}: {response.text[:500]}",
        )
    try:
        body = response.json()
    except ValueError as exc:
        credit_shield.release(key)
        raise HTTPException(
            status_code=502, detail=f"Muse Voice returned non-JSON: {exc}"
        ) from exc
    try:
        segments = _normalize_segments(body)
    except HTTPException:
        credit_shield.release(key)
        raise
    usage = body.get("usage") if isinstance(body, dict) else None
    ledger_cost, recorded_cost = _record_cost(usage)
    record = {
        "segments": segments,
        "usage": usage if isinstance(usage, dict) else {"cost_usd": recorded_cost},
        "model": MUSE_VOICE_TRANSCRIBE_MODEL,
    }
    if record["usage"].get("cost_usd") is None:
        record["usage"]["cost_usd"] = recorded_cost
    if ledger_cost is not None:
        credit_shield.release(key)  # monetary actual replaces the estimate
    credit_shield.save_response(
        key, MUSE_VOICE_ENDPOINT, "meta-muse-voice", record, ledger_cost
    )
    return segments


# ---------------------------------------------------------------------------
# SAM 3.1 single-frame segmentation (Meta Model API)
# ---------------------------------------------------------------------------

# Hosted SAM 3.1 text-concept segmentation on the Meta Model API via the
# documented Responses API (POST {base}/v1/responses). SAM is never routed
# to Baseten or any other provider.
SAM31_ENDPOINT = "responses"
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
        b"\x00" + bytes(value * 255 for value in grid[y * width:(y + 1) * width])
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


def _strip_data_url_prefix(value: str) -> str:
    """Remove a ``data:...;base64,`` prefix from an inline image payload."""
    if "," in value and value.strip().startswith("data:"):
        return value.split(",", 1)[1]
    return value


# ---------------------------------------------------------------------------
# SAM 3.1 segmentation via Meta's official meta-sam-parser package.
# ---------------------------------------------------------------------------
#
# The wire grammar and mask decoding follow Meta's SAM 3 protocol
# (https://github.com/meta-models/meta-sam/blob/main/protocol/sam3.md)
# through the package's documented public imports only:
# image_segmentation_format, parse_responses_stream, decode_mask_to_raster.
# Deep imports are unsupported and are never used here.


def _require_sam_parser() -> None:
    """Raise a clear error when the official SAM parser is not installed."""
    if not _SAM_PARSER_AVAILABLE:
        raise HTTPException(
            status_code=500,
            detail=(
                "SAM 3.1 needs Meta's official meta-sam-parser package, "
                "which is not installed. Run: "
                "pip install -r backend/requirements.txt"
            ),
        )


async def _sam_response_events(sse_text: str):
    """Yield official Responses API event mappings parsed from SSE text."""
    for raw_line in sse_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def _sse_reported_usage(sse_text: str) -> Any | None:
    """Return the first usage mapping reported by an SSE stream, if any."""
    for raw_line in sse_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except ValueError:
            continue
        if isinstance(event, dict) and isinstance(event.get("usage"), dict):
            return event.get("usage")
    return None


async def _run_official_sam_parser(sse_text: str) -> Any:
    """Parse one Responses API text stream with the official SAM parser.

    Uses the documented final-only pattern: the SSE text becomes the
    adapter's async event source and ``final_result()`` drains it.
    Adapter failures become explicit 502 errors; a non-completed outcome
    fails clearly instead of fabricating data.
    """
    _require_sam_parser()
    try:
        result = await parse_responses_stream(
            _sam_response_events(sse_text), image_segmentation_format()
        ).final_result()
    except ResponsesStreamError as exc:
        raise HTTPException(
            status_code=502, detail=f"SAM 3.1 stream failed: {exc}"
        ) from exc
    if getattr(result.outcome, "status", "") != "completed":
        raise HTTPException(
            status_code=502,
            detail=(
                "SAM 3.1 returned an incomplete response "
                f"(outcome={getattr(result.outcome, 'status', '?')})."
            ),
        )
    return result


def _data_url_mime(image_bytes: bytes) -> str:
    """Return the data-URL MIME type matching the actual image bytes."""
    if image_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"


def _safe_diagnostic(diagnostic: Any) -> dict[str, Any]:
    """Reduce one official parser diagnostic to safe, storable fields.

    Keeps severity, code, a truncated message, and the line number so a
    no-match stays explainable. Drops the diagnostic's ``raw`` source
    line: the stored record must never carry provider payload text.
    """
    return {
        "severity": str(getattr(diagnostic, "severity", "")),
        "code": str(getattr(diagnostic, "code", "")),
        "message": str(getattr(diagnostic, "message", ""))[:300],
        "line": getattr(diagnostic, "line", None),
    }


def _sam_request_body(text_prompt: str, image_bytes: bytes) -> dict[str, Any]:
    """Build the Responses API request body for one SAM 3.1 frame.

    The concept is the trimmed user prompt sent directly as
    ``input_text``: Meta's SAM documentation requires a short noun
    phrase, and command-style wrappers are unreliable.
    """
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    return {
        "model": SAM31_MODEL,
        "stream": True,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": text_prompt.strip(),
                    },
                    {
                        "type": "input_image",
                        "image_url": f"data:{_data_url_mime(image_bytes)}"
                        f";base64,{image_b64}",
                    },
                ],
            }
        ],
    }


def _image_dimensions(image_bytes: bytes) -> tuple[int, int]:
    """Return ``(width, height)`` of the uploaded image in natural pixels."""
    try:
        from PIL import Image as _PilImage
    except ImportError as exc:  # pragma: no cover - pillow is required
        raise HTTPException(
            status_code=500, detail="Image decoding is unavailable."
        ) from exc
    try:
        with _PilImage.open(io.BytesIO(image_bytes)) as img:
            width, height = img.size
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not read image size: {exc}"
        ) from exc
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Image has no size.")
    return int(width), int(height)


def _sam_point_prompt_text(
    points: list[Any], width: int, height: int
) -> str:
    """Build documented SAM point-prompt grammar for clicked spots.

    Each point becomes its own target object id (0, 1, ...) with a single
    point on frame 0, using Meta's official ``build_object_prompt``
    helper. Anything the builder cannot encode -- a point outside the
    image, a bad label, empty input -- fails with a clear 400 instead of
    a fabricated detection.
    """
    _require_sam_parser()
    objects: list[Any] = []
    for index, point in enumerate(points or []):
        if not isinstance(point, dict):
            raise HTTPException(
                status_code=400,
                detail=f"Point #{index} must be an object with x and y.",
            )
        x, y = point.get("x"), point.get("y")
        label = point.get("label", "positive")
        if (
            isinstance(x, bool)
            or isinstance(y, bool)
            or not isinstance(x, int)
            or not isinstance(y, int)
        ):
            raise HTTPException(
                status_code=400,
                detail=f"Point #{index} needs integer x/y pixel coordinates.",
            )
        if label not in ("positive", "negative"):
            raise HTTPException(
                status_code=400,
                detail=f"Point #{index} label must be "
                "'positive' or 'negative'.",
            )
        objects.append(
            PromptObject(
                id=index,
                prompts=[
                    FramePrompt(
                        frame=0, points=[PromptPoint(x=x, y=y, label=label)]
                    )
                ],
            )
        )
    try:
        return build_object_prompt(size=(width, height), objects=objects)
    except ObjectPromptError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid point prompt: {exc}"
        ) from exc


def _all_official_masks(records: Any) -> list[Any]:
    """Return every decoded mask record, in official result order."""
    return [record for record in (records or ()) if getattr(record, "kind", "") == "mask"]


def _sam_mask_path(out_path: Path, index: int) -> Path:
    """File for one mask PNG: ``out`` itself for the first mask, then
    ``<stem>-<index><suffix>`` siblings so every mask keeps its own file.
    """
    if index <= 0:
        return out_path
    return out_path.with_name(f"{out_path.stem}-{index}{out_path.suffix}")


def _paired_official_box(records: Any, object_id: Any) -> Any | None:
    """Return the box record paired with one mask's object id, if any."""
    for record in records or ():
        if (
            getattr(record, "kind", "") == "box"
            and getattr(record, "object_id", None) == object_id
        ):
            return record
    return None


def _decode_official_mask(mask_record: Any) -> tuple[bytes, int, int]:
    """Decode one official mask record to ``(raster, width, height)``.

    The raster is immutable row-major bytes of only 0 and 1, exactly
    width*height long. Anything else is an explicit 502 -- never fake data.
    """
    mask = mask_record.mask
    try:
        raster = bytes(decode_mask_to_raster(mask))
    except InvalidSegmentationMaskError as exc:
        raise HTTPException(
            status_code=502, detail=f"SAM 3.1 mask decode failed: {exc}"
        ) from exc
    width, height = int(mask.width), int(mask.height)
    if len(raster) != width * height:
        raise HTTPException(
            status_code=502,
            detail="SAM 3.1 raster length does not match mask dimensions.",
        )
    if any(byte not in (0, 1) for byte in raster):
        raise HTTPException(
            status_code=502, detail="SAM 3.1 raster is not binary."
        )
    return raster, width, height


async def call_sam_3_1_single_frame(
    frame_path: str | Path,
    text_prompt: str,
    out_path: str | Path,
    points: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Segment one JPEG with a concept prompt or clicked point prompts.

    Uses the Meta Responses API (``POST {base}/v1/responses``) with the
    frame sent inline as base64 plus the prompt, requesting the
    documented streaming behaviour. ``response.output_text.delta`` stream
    chunks are accumulated and parsed against the documented
    ``<Nf>id<|box;...|><|mask;...|>`` segmentation grammar. Only the
    single frame plus the prompt are ever sent; video streams are
    never uploaded.

    Two mutually exclusive prompt modes: when ``points`` is given (a
    non-empty list of ``{"x", "y", "label"}`` natural-pixel spots), each
    point becomes its own target object id via Meta's official
    ``build_object_prompt`` helper and ``text_prompt`` is ignored;
    otherwise the trimmed ``text_prompt`` concept phrase is sent
    directly. Results are cached by image+prompt hash. SAM always
    uses Meta -- never Baseten -- with no cross-provider fallback. An
    empty output is a legitimate "no match". Parsed matches are decoded
    with Meta's official meta-sam-parser and written as PNG; anything
    the official parser rejects fails clearly instead of fabricated data.
    """
    frame = Path(frame_path)
    if not frame.is_file():
        raise HTTPException(status_code=404, detail=f"Frame not found: {frame}")
    image_bytes = frame.read_bytes()
    if points is not None:
        mode = "points"
        width, height = _image_dimensions(image_bytes)
        prompt_input = _sam_point_prompt_text(points, width, height)
    else:
        mode = "concept"
        prompt_input = text_prompt.strip()
    prompt_echo = {"mode": mode, "text": prompt_input}
    # Cache namespace version: grammar-v2 rows hold one entry per
    # returned mask record. The v1 single-mask rows can no longer hit.
    payload_bytes = (
        b"sam31-grammar-v2\x00"
        + SAM31_MODEL.encode("utf-8")
        + b"\x00"
        + prompt_input.encode("utf-8")
        + b"\x00"
        + image_bytes
    )
    out = Path(out_path)
    if out.parent != Path("") and str(out.parent) not in ("", "."):
        out.parent.mkdir(parents=True, exist_ok=True)

    def _finish(record: dict[str, Any], cached: bool) -> dict[str, Any]:
        if record.get("match") is False:
            return {
                "mask_path": None,
                "polygon": None,
                "usage": record.get("usage"),
                "cached": cached,
                "match": False,
                "outcome": record.get("outcome"),
                "diagnostics": record.get("diagnostics", []),
                "prompt": record.get("prompt"),
            }
        entries = record.get("masks") or []
        if entries:
            for index, entry in enumerate(entries):
                raw_entry = (
                    entry.get("mask_png_base64")
                    if isinstance(entry, dict)
                    else None
                )
                if isinstance(raw_entry, str):
                    _sam_mask_path(out, index).write_bytes(
                        base64.b64decode(_strip_data_url_prefix(raw_entry))
                    )
        else:
            raw_b64 = record.get("mask_png_base64")
            if isinstance(raw_b64, str):
                out.write_bytes(base64.b64decode(_strip_data_url_prefix(raw_b64)))
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
            "match": True,
            "prompt": record.get("prompt"),
            "box": record.get("box"),
            "object_id": record.get("object_id"),
            "mask_dims": record.get("mask_dims"),
            "mask_encoding": record.get("mask_encoding"),
            # Lean per-mask entries (no base64 payloads) so downstream
            # JSON consumers stay small; the cached record keeps the
            # payloads needed to restore every mask file.
            "masks": [
                {
                    "object_id": entry.get("object_id"),
                    "box": entry.get("box"),
                    "mask_dims": entry.get("mask_dims"),
                    "mask_encoding": entry.get("mask_encoding"),
                    "mask_path": entry.get("mask_path"),
                }
                for entry in entries
                if isinstance(entry, dict)
            ],
        }

    if _use_mock():
        try:
            cached = credit_shield.fetch_or_record(payload_bytes, SAM31_ENDPOINT)
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            cached = None
        if isinstance(cached, dict) and (
            cached.get("mask_png_base64")
            or cached.get("polygon")
            or cached.get("match") is False
        ):
            return _finish(cached, True)
        polygon = _synthetic_mask_polygon()
        grid = _rasterize_polygon(polygon, 320, 240)
        _write_grayscale_png(out, 320, 240, grid)
        mask_b64 = base64.b64encode(out.read_bytes()).decode("ascii")
        record = {
            "mask_path": str(out),
            "polygon": polygon,
            "mask_png_base64": mask_b64,
            "mask_dims": {"width": 320, "height": 240},
            "usage": {"cost_usd": 0.0},
            "model": SAM31_MODEL,
            "mock": True,
            "match": True,
            "prompt": prompt_echo,
        }
        key = credit_shield.cache_key_for(payload_bytes)
        credit_shield.save_response(key, SAM31_ENDPOINT, "meta-mock", record, 0.0)
        return {**record, "mask_png_base64": mask_b64, "cached": False}

    cached = credit_shield.fetch_or_record(payload_bytes, SAM31_ENDPOINT)
    if isinstance(cached, dict) and (
        cached.get("mask_png_base64")
        or cached.get("polygon")
        or cached.get("match") is False
    ):
        return _finish(cached, True)

    # Conservative pre-call per-image estimate; the request is rejected
    # when it cannot fit the app budget. The reservation stands for live
    # calls whose exact cost stays unknown; it is released on failure or
    # when a monetary actual is recorded.
    sam_estimate = estimate_sam_cost()
    key = credit_shield.cache_key_for(payload_bytes)
    credit_shield.verify_budget(sam_estimate)
    credit_shield.reserve(key, SAM31_ENDPOINT, "meta-sam31", sam_estimate)

    # Fail clearly before any request when no Meta key is configured.
    api_key = settings.require_meta_key("SAM 3.1 segmentation")

    url = settings.META_API_BASE_URL.rstrip("/") + "/" + SAM31_ENDPOINT
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = _sam_request_body(prompt_input, image_bytes)
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(url, headers=headers, json=body)
    if response.status_code != 200:
        credit_shield.release(key)
        raise HTTPException(
            status_code=502,
            detail=f"Meta API error {response.status_code}: {response.text[:500]}",
        )
    sse_text = response.text or ""
    try:
        parsed = await _run_official_sam_parser(sse_text)
    except HTTPException:
        credit_shield.release(key)
        raise
    usage = _sse_reported_usage(sse_text)
    record_masks: dict[str, Any] = {"model": SAM31_MODEL}
    mask_records = _all_official_masks(parsed.records)
    if not mask_records:
        errors = [
            str(getattr(diagnostic, "message", diagnostic))
            for diagnostic in (parsed.diagnostics or ())
            if getattr(diagnostic, "severity", "") == "error"
        ]
        if errors:
            credit_shield.release(key)
            raise HTTPException(
                status_code=502,
                detail=(
                    "Malformed SAM 3.1 segmentation output: "
                    f"{errors[0][:300]}"
                ),
            )
        # Empty lane: legitimate "no match". The request was made, so its
        # unknown actual cost stays covered by the pre-call reservation;
        # only the usage record goes to NULL. The outcome and scrubbed
        # diagnostics explain the no-match without storing provider
        # payload text, image bytes, or credentials.
        record_masks["match"] = False
        record_masks["prompt"] = prompt_echo
        record_masks["outcome"] = str(getattr(parsed.outcome, "status", ""))
        record_masks["diagnostics"] = [
            _safe_diagnostic(diagnostic)
            for diagnostic in (parsed.diagnostics or ())
        ]
        ledger_cost, recorded_cost = _record_cost(usage)
        record_masks["usage"] = (
            usage if isinstance(usage, dict) else {"cost_usd": recorded_cost}
        )
        if record_masks["usage"].get("cost_usd") is None:
            record_masks["usage"]["cost_usd"] = recorded_cost
        credit_shield.save_response(
            key, SAM31_ENDPOINT, "meta-sam31", record_masks, ledger_cost
        )
        return _finish(record_masks, False)
    decoded_entries: list[dict[str, Any]] = []
    for index, mask_record in enumerate(mask_records):
        raster, width, height = _decode_official_mask(mask_record)
        target = _sam_mask_path(out, index)
        _write_grayscale_png(target, width, height, raster)
        box_record = _paired_official_box(parsed.records, mask_record.object_id)
        box = None
        if box_record is not None:
            box = {
                "left": float(box_record.left),
                "top": float(box_record.top),
                "right": float(box_record.right),
                "bottom": float(box_record.bottom),
            }
        decoded_entries.append(
            {
                "object_id": str(mask_record.object_id),
                "box": box,
                "mask_dims": {"width": width, "height": height},
                "mask_encoding": str(mask_record.mask.encoding),
                "mask_png_base64": base64.b64encode(target.read_bytes()).decode(
                    "ascii"
                ),
                "mask_path": str(target),
            }
        )
    first = decoded_entries[0]
    record_masks["match"] = True
    record_masks["prompt"] = prompt_echo
    record_masks["polygon"] = None
    # Legacy single-mask fields mirror the first record so existing
    # consumers keep working; the full list lives under "masks".
    record_masks["box"] = first["box"]
    record_masks["object_id"] = first["object_id"]
    record_masks["mask_dims"] = first["mask_dims"]
    record_masks["mask_encoding"] = first["mask_encoding"]
    record_masks["mask_png_base64"] = first["mask_png_base64"]
    record_masks["masks"] = decoded_entries
    ledger_cost, recorded_cost = _record_cost(usage)
    record_masks["usage"] = (
        usage if isinstance(usage, dict) else {"cost_usd": recorded_cost}
    )
    if record_masks["usage"].get("cost_usd") is None:
        record_masks["usage"]["cost_usd"] = recorded_cost
    if ledger_cost is not None:
        credit_shield.release(key)  # monetary actual replaces the estimate
    credit_shield.save_response(
        key, SAM31_ENDPOINT, "meta-sam31", record_masks, ledger_cost
    )
    return _finish(record_masks, False)


# ---------------------------------------------------------------------------
# Local move-out comparison (no API call)
# ---------------------------------------------------------------------------

def _read_grayscale_png_bytes(png: bytes) -> tuple[bytearray, int, int]:
    """Decode 8-bit grayscale PNG bytes to a flat binary grid plus dims.

    Reads the white-on-black masks this project writes (color type 0,
    bit depth 8, non-interlaced) using stdlib struct/zlib only; positive
    pixels threshold at >127. Anything else fails clearly.
    """
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(
            status_code=400, detail="Mask bytes are not a PNG image."
        )
    pos, width, height, seen_ihdr = 8, 0, 0, False
    idat = bytearray()
    total = len(png)
    try:
        while pos + 8 <= total:
            (length,) = struct.unpack(">I", png[pos : pos + 4])
            ctype = png[pos + 4 : pos + 8]
            data = png[pos + 8 : pos + 8 + length]
            if len(data) != length or pos + 12 + length > total:
                raise ValueError("truncated PNG chunk")
            if ctype == b"IHDR":
                (
                    width,
                    height,
                    bit_depth,
                    color_type,
                    comp,
                    filt,
                    inter,
                ) = struct.unpack(">IIBBBBB", data)
                if (bit_depth, color_type, comp, filt, inter) != (
                    8, 0, 0, 0, 0,
                ):
                    raise HTTPException(
                        status_code=400,
                        detail="Mask PNG must be 8-bit grayscale, "
                        "non-interlaced.",
                    )
                seen_ihdr = True
            elif ctype == b"IDAT":
                idat += data
            elif ctype == b"IEND":
                break
            pos += 12 + length
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Mask PNG is unreadable: {exc}"
        ) from exc
    if not seen_ihdr or width <= 0 or height <= 0:
        raise HTTPException(
            status_code=400, detail="Mask PNG has no image size."
        )
    try:
        raw = zlib.decompress(bytes(idat))
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Mask PNG data is corrupt: {exc}"
        ) from exc
    stride = width + 1
    if len(raw) != stride * height:
        raise HTTPException(
            status_code=400,
            detail="Mask PNG scanlines do not match its size.",
        )
    grid = bytearray(width * height)
    prev = bytearray(width)
    for y in range(height):
        row = raw[y * stride : (y + 1) * stride]
        ftype, cur = row[0], bytearray(row[1:])
        if ftype == 1:
            for i in range(1, width):
                cur[i] = (cur[i] + cur[i - 1]) & 0xFF
        elif ftype == 2:
            for i in range(width):
                cur[i] = (cur[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(width):
                above = cur[i - 1] if i else 0
                cur[i] = (cur[i] + ((above + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(width):
                above = cur[i - 1] if i else 0
                left = prev[i - 1] if i else 0
                paeth = above + prev[i] - left
                pa, pb, pc = (
                    abs(paeth - above),
                    abs(paeth - prev[i]),
                    abs(paeth - left),
                )
                base = (
                    above if (pa <= pb and pa <= pc) else (prev[i] if pb <= pc else left)
                )
                cur[i] = (cur[i] + base) & 0xFF
        elif ftype != 0:
            raise HTTPException(
                status_code=400,
                detail="Mask PNG uses an unsupported filter type.",
            )
        for x in range(width):
            grid[y * width + x] = 1 if cur[x] > 127 else 0
        prev = cur
    return grid, width, height


def _place_mask_on_frame(
    mask: bytes | bytearray,
    mask_width: int,
    mask_height: int,
    box: dict[str, Any],
    frame_width: int,
    frame_height: int,
) -> bytearray:
    """Stamp a mask raster onto a frame grid at its box, nearest-neighbor.

    Mirrors the overlay contract: the raster fills the box interior
    (left/top inclusive, right/bottom exclusive on the frame grid) and
    is never stretched over the whole frame. Box edges round to the
    nearest pixel; a box outside the frame fails instead of silently
    clipping.
    """
    try:
        edges = [float(box[key]) for key in ("left", "top", "right", "bottom")]
    except (TypeError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Mask box needs numeric left/top/right/bottom: {exc}",
        ) from exc
    if any(not math.isfinite(edge) for edge in edges):
        raise HTTPException(
            status_code=400, detail="Mask box edges must be finite numbers."
        )
    left, top, right, bottom = (int(math.floor(edge + 0.5)) for edge in edges)
    if not (
        0 <= left < right <= frame_width
        and 0 <= top < bottom <= frame_height
    ):
        raise HTTPException(
            status_code=400,
            detail="Mask box is outside the "
            f"{frame_width}x{frame_height} frame.",
        )
    if len(mask) != mask_width * mask_height:
        raise HTTPException(
            status_code=400,
            detail="Mask raster does not match its dimensions.",
        )
    grid = bytearray(frame_width * frame_height)
    draw_width, draw_height = right - left, bottom - top
    for y in range(draw_height):
        src_y = (y * mask_height) // draw_height
        for x in range(draw_width):
            if mask[src_y * mask_width + (x * mask_width) // draw_width]:
                grid[(top + y) * frame_width + (left + x)] = 1
    return grid


def _evidence_grid(
    evidence: Any, frame_size: tuple[int, int], side: str
) -> tuple[bytearray, str]:
    """Normalize one side's evidence to a frame-size binary grid.

    Accepted forms, both in frame coordinates: a polygon point list
    (legacy; an explicitly empty list means "no defect recorded"), or a
    dict carrying a raster mask (``mask_png_base64`` or
    ``mask_png_bytes``) with ``box`` and optional ``mask_dims`` /
    ``frame_size`` cross-checks. Returns the grid plus a
    ``"polygon"``/``"raster"`` kind label for the report. Missing or
    unalignable evidence fails with a 400 instead of a misleading result.
    """
    width, height = frame_size
    if isinstance(evidence, dict) and (
        "mask_png_base64" in evidence or "mask_png_bytes" in evidence
    ):
        raw = evidence.get("mask_png_bytes")
        if raw is None:
            encoded = evidence.get("mask_png_base64")
            if not isinstance(encoded, str) or not encoded.strip():
                raise HTTPException(
                    status_code=400,
                    detail=f"{side} raster mask needs PNG bytes.",
                )
            try:
                raw = base64.b64decode(_strip_data_url_prefix(encoded))
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"{side} mask base64 is invalid: {exc}",
                ) from exc
        if not isinstance(raw, (bytes, bytearray)) or not raw:
            raise HTTPException(
                status_code=400,
                detail=f"{side} raster mask needs PNG bytes.",
            )
        mask, mask_width, mask_height = _read_grayscale_png_bytes(bytes(raw))
        dims = evidence.get("mask_dims")
        if dims is not None:
            try:
                declared = (int(dims["width"]), int(dims["height"]))
            except (TypeError, KeyError, ValueError) as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"{side} mask_dims must give width/height: {exc}",
                ) from exc
            if declared != (mask_width, mask_height):
                raise HTTPException(
                    status_code=400,
                    detail=f"{side} mask_dims {declared[0]}x{declared[1]} "
                    f"does not match its PNG {mask_width}x{mask_height}.",
                )
        prior_frame = evidence.get("frame_size")
        if prior_frame is not None:
            try:
                declared_frame = (
                    int(prior_frame["width"]),
                    int(prior_frame["height"]),
                )
            except (TypeError, KeyError, ValueError) as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"{side} frame_size must give width/height: {exc}",
                ) from exc
            if declared_frame != (width, height):
                raise HTTPException(
                    status_code=400,
                    detail=f"{side} frame {declared_frame[0]}x{declared_frame[1]} "
                    f"does not match the {width}x{height} comparison frame; "
                    "evidence from different-size images cannot be aligned.",
                )
        box = evidence.get("box")
        if not isinstance(box, dict):
            raise HTTPException(
                status_code=400,
                detail=f"{side} raster mask needs a box in frame coordinates.",
            )
        return (
            _place_mask_on_frame(
                mask, mask_width, mask_height, box, width, height
            ),
            "raster",
        )
    points = evidence.get("polygon") if isinstance(evidence, dict) else evidence
    if points is None:
        raise HTTPException(
            status_code=400,
            detail=f"{side} evidence needs a polygon point list or a "
            "raster mask with box.",
        )
    if not isinstance(points, list):
        raise HTTPException(
            status_code=400, detail=f"{side} polygon must be a point list."
        )
    if len(points) == 0:
        return bytearray(width * height), "polygon"
    try:
        flat = [[float(x), float(y)] for x, y in points]
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{side} polygon points must be [x, y] pairs: {exc}",
        ) from exc
    if len(flat) < 3:
        raise HTTPException(
            status_code=400, detail=f"{side} polygon needs 3+ points."
        )
    return _rasterize_polygon(flat, width, height), "polygon"


def compare_moveout_masks_local(
    prior: Any, current: Any, frame_size: tuple[int, int]
) -> dict[str, Any]:
    """Compare prior vs current evidence on aligned frame-size rasters.

    Fully local: no network or model call. Each side is normalized to a
    binary grid in frame coordinates -- raster masks are stamped at their
    boxes (never stretched over the frame), polygons scanline-fill the
    same grid -- then IoU, areas, and growth are computed. Missing or
    unalignable evidence fails with a 400 instead of a misleading damage
    result.
    """
    try:
        width, height = int(frame_size[0]), int(frame_size[1])
    except (TypeError, IndexError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"frame_size must be a (width, height) pair: {exc}",
        ) from exc
    if width <= 0 or height <= 0:
        raise HTTPException(
            status_code=400, detail="frame_size must be positive"
        )
    day1, prior_kind = _evidence_grid(prior, (width, height), "prior")
    moveout, current_kind = _evidence_grid(current, (width, height), "current")
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
        "prior_kind": prior_kind,
        "current_kind": current_kind,
        "frame_size": {"width": width, "height": height},
    }
