"""Provider wiring checks: mock makes no network calls, live modes target
the documented URLs/models, streaming SAM output parses, and missing keys
fail before any request.

Runs entirely offline with a fake ``httpx.AsyncClient`` and an in-memory
credit-shield stub. No API keys or network access required.
"""

import asyncio
import base64
import hashlib
import io
import json
import shutil
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main
import services
from services import (
    MUSE_VOICE_TRANSCRIBE_MODEL,
    SAM31_MODEL,
    call_meta_chat,
    call_muse_voice,
    call_sam_3_1_single_frame,
)
from config import CreditShield, settings

needs_sam_parser = unittest.skipUnless(
    services._SAM_PARSER_AVAILABLE, "meta-sam-parser is not installed"
)


# Literal representative fixture following Meta's documented segmentation
# grammar: ``<Nf>`` frame header, integer object ids, one box token with
# inclusive corners plus frame size, one mask token with ``x=0, y=0`` and
# ``data=H,W,marker+payload``. Payloads use the documented base85 alphabet
# (note the ``=`` inside the second payload: fields split on ``;``, never
# on ``key=``).
SAM_DOCUMENTED_LINE = (
    "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>"
    "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
    ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>"
    "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>"
)


def _sam_wire_stream(text):
    """Wire-complete SSE: lane-identified deltas plus the done finalizer."""
    midpoint = len(text) // 2
    lane = {"item_id": "item_1", "output_index": 0, "content_index": 0}
    return _sse(
        {"type": "response.output_text.delta", "delta": text[:midpoint], **lane},
        {"type": "response.output_text.delta", "delta": text[midpoint:], **lane},
        {"type": "response.output_text.done", "text": text, **lane},
        {"type": "response.completed", "usage": {"input_tokens": 3}},
    )


class _FakeResponse:
    def __init__(self, payload=None, text="", status_code=200):
        self._payload = payload
        self.status_code = status_code
        if text:
            self.text = text
        elif payload is not None:
            self.text = json.dumps(payload)
        else:
            self.text = ""

    def json(self):
        if self._payload is None:
            raise ValueError("no JSON payload")
        return self._payload


class _FakeClient:
    """Stand-in for httpx.AsyncClient. Never touches the network."""

    instances = []
    response = _FakeResponse({})
    forbid_network = True

    def __init__(self, *args, **kwargs):
        self.calls = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if _FakeClient.forbid_network:
            raise AssertionError(f"network call attempted: {url}")
        return _FakeClient.response


class _StubShield:
    """Offline credit shield: no disk, records saves, real budget logic.

    Mirrors the production reservation accounting: pre-call estimates are
    held separately from actuals, and both caps count recorded actuals
    plus outstanding reservations.
    """

    def __init__(self):
        self.saved = []
        self.reserved = {}
        self._session_spend = 0.0

    @staticmethod
    def cache_key_for(payload_bytes):
        return hashlib.sha256(payload_bytes).hexdigest()

    def fetch_or_record(self, payload_bytes, endpoint):
        return None

    def verify_budget(self, estimated_cost):
        from fastapi import HTTPException

        cumulative = sum(self.reserved.values())
        if cumulative + estimated_cost > settings.MAX_CUMULATIVE_SPEND_USD:
            raise HTTPException(status_code=402, detail="cap")
        session = self._session_spend + sum(self.reserved.values())
        if session + estimated_cost > settings.MAX_SESSION_SPEND_USD:
            raise HTTPException(status_code=429, detail="cap")

    def reserve(self, key, endpoint, provider, amount):
        self.reserved[key] = float(amount)

    def release(self, key):
        self.reserved.pop(key, None)

    def get_reserved_cumulative(self):
        return sum(self.reserved.values())

    def save_response(self, key, endpoint, provider, response_data, cost_usd):
        self.saved.append(
            {
                "endpoint": endpoint,
                "provider": provider,
                "cost_usd": cost_usd,
                "data": response_data,
            }
        )
        return key


def _event_loop_available() -> bool:
    """True when this host can create an asyncio event loop."""
    try:
        loop = asyncio.new_event_loop()
    except OSError:
        return False
    try:
        loop.close()
    except Exception:
        pass
    return True


_HAS_EVENT_LOOP = _event_loop_available()


_JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 100


def _mask_png_bytes(width, height, grid):
    """White-on-black mask PNG via the project's own stdlib writer."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        path = Path(tmp) / "m.png"
        services._write_grayscale_png(path, width, height, grid)
        return path.read_bytes()


_LEASE_TEXT = (
    "RENTAL AGREEMENT\n\nSection 4.2 Security Deposit. "
    "The tenant shall pay a security deposit of EUR 900 upon signing. "
    "The deposit will be returned within 14 days after moving out.\n\n"
    "Clause 7.1 Pets are not allowed without written consent."
)


_STATUTE_TEXT = (
    "BGB Section 551 deposit cap: a security deposit may not exceed three "
    "months cold rent, payable in three monthly installments. "
    "Tenant Fees Act 2019: tenancy deposits capped at five weeks rent."
)


def _lease_issue(**overrides):
    issue = {
        "clause": "Deposit terms",
        "why_risky": "The deposit terms are unusually strict.",
        "severity": "high",
        "evidence_quote": (
            "The tenant shall pay a security deposit of EUR 900 upon signing."
        ),
        "citation": "BGB Section 551",
    }
    issue.update(overrides)
    return issue


def _png_bytes(width, height):
    """Minimal valid PNG; only the IHDR size matters for dimension reads."""

    def chunk(ctype, data):
        body = ctype + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body))
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


class _StubUpload:
    """Minimal UploadFile stand-in with a loop-free async read.

    Starlette's UploadFile.read uses a worker threadpool, which needs a
    running event loop; this stub exposes the same ``filename``/``read``
    surface the route handler uses, with a plain coroutine.
    """

    def __init__(self, filename, data):
        self.filename = filename
        self._data = data

    async def read(self, size=-1):
        return self._data


def _run(coro):
    """Drive a coroutine to completion, with a real loop when available.

    Uses ``asyncio.run`` wherever the host can create an event loop (the
    official SAM stream adapter requires a running loop). Falls back to
    a simple send-pump for loop-free fakes where loop creation is
    sandboxed; pump-driven tests that need a running loop fail there.
    """
    if _HAS_EVENT_LOOP:
        return asyncio.run(coro)
    try:
        while True:
            try:
                coro.send(None)
            except StopIteration as done:
                return done.value
    finally:
        coro.close()


def _sse(*events):
    lines = []
    for event in events:
        lines.append("data: " + json.dumps(event))
    lines.append("data: [DONE]")
    return "\n".join(lines) + "\n"


def _build_pdf_bytes(pages):
    """Build a real text-layer PDF with fpdf2: one list of lines per page."""
    from fpdf import FPDF

    pdf = FPDF()
    for lines in pages:
        pdf.add_page()
        pdf.set_font("helvetica", size=11)
        for line in lines:
            pdf.multi_cell(0, 6, line, new_x="LMARGIN", new_y="NEXT")
    return bytes(pdf.output())


def _raw_pdf_bytes(content_stream):
    """Build a minimal one-page PDF around a hand-written content stream.

    Places text fragments at exact Tm coordinates in core Helvetica —
    geometry fpdf2's flow layout cannot express — for the highlight
    locator's multi-fragment anchoring test.
    """
    stream = zlib.compress(content_stream)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        (
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
            b"/Encoding /WinAnsiEncoding >>"
        ),
        (
            b"<< /Length " + str(len(stream)).encode()
            + b" /Filter /FlateDecode >>\nstream\n"
            + stream
            + b"\nendstream"
        ),
    ]
    out = [b"%PDF-1.4\n"]
    offsets = []
    for number, obj in enumerate(objects, start=1):
        offsets.append(sum(len(part) for part in out))
        out.append(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref_at = sum(len(part) for part in out)
    out.append(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets:
        out.append(f"{offset:010d} 00000 n \n".encode())
    out.append(
        b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"
        + str(xref_at).encode()
        + b"\n%%EOF\n"
    )
    return b"".join(out)


def _sam_payload_bytes(prompt_input, image_bytes):
    """Rebuild the exact cache payload call_sam_3_1_single_frame computes."""
    return (
        b"sam31-grammar-v3\x00"
        + b"live"
        + b"\x00"
        + SAM31_MODEL.encode("utf-8")
        + b"\x00"
        + prompt_input.encode("utf-8")
        + b"\x00"
        + image_bytes
    )


class ProviderWiringTest(unittest.TestCase):
    def setUp(self):
        _FakeClient.instances = []
        _FakeClient.response = _FakeResponse({})
        _FakeClient.forbid_network = True
        self._real_client = services.httpx.AsyncClient
        services.httpx.AsyncClient = _FakeClient
        self._real_shield = services.credit_shield
        self._stub = _StubShield()
        services.credit_shield = self._stub
        self._saved_settings = {
            "CHAT_PROVIDER": settings.CHAT_PROVIDER,
            "META_API_KEY": settings.META_API_KEY,
            "META_API_BASE_URL": settings.META_API_BASE_URL,
            "META_CHAT_MODEL_ID": settings.META_CHAT_MODEL_ID,
            "BASETEN_API_KEY": settings.BASETEN_API_KEY,
            "BASETEN_BASE_URL": settings.BASETEN_BASE_URL,
            "BASETEN_MODEL_ID": settings.BASETEN_MODEL_ID,
            "MAX_SESSION_SPEND_USD": settings.MAX_SESSION_SPEND_USD,
            "MAX_CUMULATIVE_SPEND_USD": settings.MAX_CUMULATIVE_SPEND_USD,
        }

    def tearDown(self):
        services.httpx.AsyncClient = self._real_client
        services.credit_shield = self._real_shield
        for key, value in self._saved_settings.items():
            setattr(settings, key, value)
        _FakeClient.forbid_network = True

    def test_mock_chat_makes_no_network_request(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        result = _run(call_meta_chat("sys", "hello", 0.0))
        self.assertTrue(result.get("mock"))
        self.assertEqual(_FakeClient.instances, [])
        # Mock responses are genuinely free and stay $0.00.
        self.assertEqual(self._stub.saved[0]["cost_usd"], 0.0)

    def test_mock_voice_and_sam_make_no_network_request(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            segments = _run(call_muse_voice(audio))
            self.assertTrue(segments)
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            sam = _run(call_sam_3_1_single_frame(frame, "stain", Path(tmp) / "m.png"))
            self.assertTrue(sam.get("match"))
            self.assertIn("polygon", sam)
        self.assertEqual(_FakeClient.instances, [])

    def test_baseten_mode_selects_exact_model_and_url(self):
        settings.CHAT_PROVIDER = "baseten"
        settings.BASETEN_API_KEY = "test-key"
        settings.BASETEN_MODEL_ID = "meta-models/muse-spark-open-1026"
        settings.BASETEN_BASE_URL = "https://inference.baseten.co/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            {
                "choices": [{"message": {"content": json.dumps({"ok": True})}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5},
            }
        )
        result = _run(call_meta_chat("sys", "draft this", 0.0))
        self.assertEqual(result, {"ok": True})
        self.assertEqual(len(_FakeClient.instances), 1)
        url, kwargs = _FakeClient.instances[0].calls[0]
        self.assertEqual(url, "https://inference.baseten.co/v1/chat/completions")
        self.assertEqual(kwargs["json"]["model"], "meta-models/muse-spark-open-1026")
        # Unknown exact cost is marked unknown and stored as NULL, never $0.
        saved = self._stub.saved[0]
        self.assertIsNone(saved["cost_usd"])
        self.assertEqual(saved["data"]["usage"].get("cost_usd"), "unknown")

    def test_chat_payloads_pin_temperature_zero_on_both_routes(self):
        # Deterministic sampling: every live chat-completion payload —
        # on the Baseten route and the Meta route alike — must carry
        # temperature 0.0, so an uncached decode of the same lease
        # extracts the same clauses on every run.
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            {
                "choices": [{"message": {"content": json.dumps({"ok": True})}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5},
            }
        )
        settings.CHAT_PROVIDER = "baseten"
        settings.BASETEN_API_KEY = "test-key"
        settings.BASETEN_MODEL_ID = "meta-models/muse-spark-open-1026"
        settings.BASETEN_BASE_URL = "https://inference.baseten.co/v1"
        _run(call_meta_chat("sys", "decode this lease", 0.0))
        baseten_body = _FakeClient.instances[-1].calls[0][1]["json"]
        self.assertIn("temperature", baseten_body)
        self.assertEqual(baseten_body["temperature"], 0.0)

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _run(call_meta_chat("sys", "decode this lease", 0.0))
        meta_body = _FakeClient.instances[-1].calls[0][1]["json"]
        self.assertIn("temperature", meta_body)
        self.assertEqual(meta_body["temperature"], 0.0)

    def test_meta_voice_targets_documented_asr_route(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse({"text": "hello world"})
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            segments = _run(call_muse_voice(audio))
        self.assertEqual(segments[0]["text"], "hello world")
        url, kwargs = _FakeClient.instances[0].calls[0]
        self.assertEqual(url, "https://api.meta.ai/v1/asr/transcribe")
        # The live ASR route takes the audio as an "audio" part plus a
        # JSON "request" part with the model and encoding (verified
        # against the live API 2026-10-31; the old "file" part + "model"
        # form field is rejected with HTTP 400).
        files = kwargs["files"]
        self.assertIn("audio", files)
        request = json.loads(files["request"][1])
        self.assertEqual(request["model"], "muse-voice-transcribe-1.0")
        self.assertEqual(request["audioEncoding"], "WAV")
        self.assertEqual(MUSE_VOICE_TRANSCRIBE_MODEL, "muse-voice-transcribe-1.0")

    @needs_sam_parser
    def test_official_parser_accepts_documented_match(self):
        from meta_sam_parser import (
            CompletedOutcome,
            decode_mask_to_raster,
            image_segmentation_format,
        )

        parser = image_segmentation_format().create_parser()
        for _snapshot in parser.push(SAM_DOCUMENTED_LINE):
            pass
        finished = parser.finish(CompletedOutcome())
        records = finished.result.records
        self.assertEqual(
            [record.kind for record in records], ["box", "mask", "box", "mask"]
        )
        box, mask = records[0], records[1]
        self.assertEqual(box.object_id, "0")
        self.assertEqual(
            (box.left, box.top, box.right, box.bottom), (211, 228, 271, 255)
        )
        self.assertEqual(mask.object_id, "0")
        self.assertEqual((mask.mask.width, mask.mask.height), (60, 27))
        self.assertEqual(mask.mask.encoding, "lossless")
        raster = decode_mask_to_raster(mask.mask)
        self.assertEqual(len(raster), 60 * 27)
        self.assertTrue(all(byte in (0, 1) for byte in raster))
        second_box, second_mask = records[2], records[3]
        self.assertEqual(second_box.object_id, "1")
        self.assertEqual((second_box.right, second_box.bottom), (203, 255))
        self.assertEqual(
            (second_mask.mask.width, second_mask.mask.height), (48, 27)
        )

    @needs_sam_parser
    def test_official_records_pair_masks_with_boxes(self):
        from meta_sam_parser import CompletedOutcome, image_segmentation_format

        parser = image_segmentation_format().create_parser()
        for _snapshot in parser.push(SAM_DOCUMENTED_LINE):
            pass
        records = parser.finish(CompletedOutcome()).result.records
        masks = services._all_official_masks(records)
        self.assertEqual(len(masks), 2)
        for mask_record, object_id in zip(masks, ["0", "1"]):
            self.assertEqual(str(mask_record.object_id), object_id)
            box_record = services._paired_official_box(records, object_id)
            self.assertIsNotNone(box_record)
            self.assertEqual(str(box_record.object_id), object_id)
        self.assertIsNone(services._paired_official_box(records, "nope"))

    def test_sam_mask_path_keeps_first_file_stable(self):
        out = Path("/tmp/job/mask-abc123.png")
        self.assertEqual(services._sam_mask_path(out, 0), out)
        self.assertEqual(
            services._sam_mask_path(out, 1),
            Path("/tmp/job/mask-abc123-1.png"),
        )
        self.assertEqual(
            services._sam_mask_path(out, 2),
            Path("/tmp/job/mask-abc123-2.png"),
        )

    @needs_sam_parser
    def test_official_parser_accepts_confidence_and_ignores_unknown_token(self):
        from meta_sam_parser import CompletedOutcome, image_segmentation_format

        line = (
            "<0f>2<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.75|>"
            "<|point;x=1;y=1|>"
            "<|mask;x=0;y=0;c=0.5;data=27,60,"
            "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
        )
        parser = image_segmentation_format().create_parser()
        for _snapshot in parser.push(line):
            pass
        records = parser.finish(CompletedOutcome()).result.records
        kinds = [record.kind for record in records]
        self.assertEqual(kinds, ["box", "mask"])
        self.assertEqual(records[0].confidence, 0.75)
        self.assertEqual(records[1].confidence, 0.5)
        # An out-of-range confidence is ignored, never fatal.
        bad = line.replace("c=0.75", "c=7.5")
        parser = image_segmentation_format().create_parser()
        for _snapshot in parser.push(bad):
            pass
        records = parser.finish(CompletedOutcome()).result.records
        self.assertIsNone(records[0].confidence)

    @unittest.skipIf(
        services._SAM_PARSER_AVAILABLE, "meta-sam-parser is installed"
    )
    def test_sam_parser_missing_error_is_explicit(self):
        with self.assertRaises(HTTPException) as ctx:
            services._require_sam_parser()
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIn("meta-sam-parser", ctx.exception.detail)
        self.assertIn("requirements.txt", ctx.exception.detail)

    def test_sse_helpers_parse_events_and_usage(self):
        lane = {"item_id": "item_1", "output_index": 0, "content_index": 0}
        stream = _sse(
            {
                "type": "response.output_text.delta",
                "delta": "<0f>",
                **lane,
            },
            {"type": "response.completed", "usage": {"input_tokens": 3}},
        )
        self.assertEqual(
            services._sse_reported_usage(stream), {"input_tokens": 3}
        )

        async def collect():
            return [event async for event in services._sam_response_events(stream)]

        events = _run(collect())
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["type"], "response.output_text.delta")
        self.assertEqual(events[1]["type"], "response.completed")

    @needs_sam_parser
    def test_sam_service_match_returns_decoded_png(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            text=_sam_wire_stream(SAM_DOCUMENTED_LINE)
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            out = Path(tmp) / "m.png"
            result = _run(call_sam_3_1_single_frame(frame, "stain", out))
            self.assertTrue(result.get("match"))
            self.assertTrue(out.is_file())
            header = out.read_bytes()
            self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", header[16:24])
            self.assertEqual((width, height), (60, 27))
            self.assertEqual(result["mask_dims"], {"width": 60, "height": 27})
            self.assertEqual(
                result["box"],
                {"left": 211, "top": 228, "right": 271, "bottom": 255},
            )
            # The box lives in frame pixels and the mask maps onto the box
            # 1:1 here -- the display must place it there, not stretch it
            # over the whole 320x334 frame.
            box = result["box"]
            self.assertTrue(0 <= box["left"] < box["right"] <= 320)
            self.assertTrue(0 <= box["top"] < box["bottom"] <= 334)
            self.assertEqual(box["right"] - box["left"], 60)
            self.assertEqual(box["bottom"] - box["top"], 27)
            # Every returned mask is preserved with its own box, dims,
            # object id, and file -- not just the first speck.
            masks = result["masks"]
            self.assertEqual(len(masks), 2)
            self.assertEqual(
                [entry["object_id"] for entry in masks], ["0", "1"]
            )
            self.assertEqual(
                masks[1]["box"],
                {"left": 155, "top": 228, "right": 203, "bottom": 255},
            )
            self.assertEqual(
                masks[1]["mask_dims"], {"width": 48, "height": 27}
            )
            for entry in masks:
                self.assertNotIn("mask_png_base64", entry)
                served = Path(tmp) / Path(entry["mask_path"]).name
                self.assertTrue(served.is_file())
            # The legacy single-mask fields mirror the first record.
            self.assertEqual(result["mask_path"], masks[0]["mask_path"])
            self.assertEqual(result["box"], masks[0]["box"])
            self.assertEqual(result["mask_dims"], masks[0]["mask_dims"])
            # Token counts alone are not converted to cost: recorded
            # unknown while the pre-call reservation stands.
            self.assertEqual(result["usage"].get("cost_usd"), "unknown")
            self.assertEqual(len(self._stub.reserved), 1)
        url, kwargs = _FakeClient.instances[0].calls[0]
        self.assertEqual(url, "https://api.meta.ai/v1/responses")
        self.assertTrue(kwargs["json"].get("stream"))
        self.assertEqual(kwargs["json"]["model"], "sam-3.1")
        self.assertEqual(SAM31_MODEL, "sam-3.1")

    def test_segment_image_endpoint_returns_mask_and_dims(self):
        # Loop-free offline exercise of the public POST /api/segment-image
        # handler: a stub upload (plain-coroutine read, no threadpool) plus
        # the mock SAM path (zero network calls). The live-parser variant
        # of this flow is covered by the service-level tests, which need
        # a real event loop.
        import inspect

        from fastapi.params import Form as FormMarker

        prompt_param = inspect.signature(main.segment_image).parameters[
            "text_prompt"
        ]
        self.assertIsInstance(prompt_param.default, FormMarker)
        # The default FastAPI would inject for an omitted form field.
        default_prompt = prompt_param.default.default
        self.assertEqual(default_prompt, "")
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                default_result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.jpg", _JPEG_BYTES),
                        text_prompt=default_prompt,
                    )
                )
                custom_result = _run(
                    main.segment_image(
                        file=_StubUpload("damage.jpg", _JPEG_BYTES),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
            for result in (default_result, custom_result):
                self.assertTrue(result["mask"].get("match"))
                self.assertEqual(
                    result["mask"]["mask_dims"], {"width": 148, "height": 148}
                )
                self.assertEqual(
                    result["mask"]["box"],
                    {"left": 86, "top": 46, "right": 234, "bottom": 194},
                )
                self.assertTrue(
                    result["mask_url"].startswith("/files/segment/")
                )
                self.assertTrue(result["mask_url"].endswith(".png"))
                served = Path(tmp) / result["mask_url"][len("/files/"):]
                self.assertTrue(served.is_file())
                self.assertEqual(served.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(_FakeClient.instances, [])

    def test_segment_image_returns_original_image_url(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _JPEG_BYTES + b"\x01\x02\x03"
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.jpg", data),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
            self.assertTrue(
                result["image_url"].startswith("/files/segment/")
            )
            self.assertTrue(result["image_url"].endswith(".jpg"))
            served = Path(tmp) / result["image_url"][len("/files/"):]
            self.assertTrue(served.is_file())
            self.assertEqual(served.read_bytes(), data)

    def test_segment_overlay_alignment_uses_frame_coordinates(self):
        # Geometry contract the overlay display relies on: polygon points
        # live in frame pixels and the mask file keeps native raster dims,
        # so the display places (never stretches) the mask.
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.jpg", _JPEG_BYTES),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
            polygon = result["mask"]["polygon"]
            self.assertGreaterEqual(len(polygon), 3)
            for x, y in polygon:
                self.assertGreaterEqual(x, 0)
                self.assertLess(x, 320)
                self.assertGreaterEqual(y, 0)
                self.assertLess(y, 240)
            dims = result["mask"]["mask_dims"]
            self.assertEqual((dims["width"], dims["height"]), (148, 148))
            served = Path(tmp) / result["mask_url"][len("/files/"):]
            width, height = struct.unpack(">II", served.read_bytes()[16:24])
            self.assertEqual((width, height), (148, 148))

    @needs_sam_parser
    def test_meta_sam_empty_output_is_no_match(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        lane = {"item_id": "item_1", "output_index": 0, "content_index": 0}
        _FakeClient.response = _FakeResponse(
            text=_sse(
                {"type": "response.output_text.done", "text": "", **lane},
                {"type": "response.completed", "usage": {"input_tokens": 0}},
            )
        )
        with tempfile.TemporaryDirectory() as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            out = Path(tmp) / "m.png"
            result = _run(call_sam_3_1_single_frame(frame, "stain", out))
        self.assertFalse(result.get("match"))
        self.assertIsNone(result.get("polygon"))
        self.assertIsNone(result.get("mask_path"))
        self.assertFalse(out.exists())
        # A valid completed lane with no mask carries safe diagnostics:
        # outcome plus severity/code/message/line entries, never raw
        # payload text, image bytes, or credentials.
        self.assertEqual(result.get("outcome"), "completed")
        self.assertIsInstance(result.get("diagnostics"), list)
        self.assertEqual(
            set(result.keys()),
            {
                "mask_path",
                "polygon",
                "usage",
                "cached",
                "match",
                "outcome",
                "diagnostics",
                "prompt",
            },
        )
        self.assertEqual(
            result.get("prompt"), {"mode": "concept", "text": "stain"}
        )
        for entry in result["diagnostics"]:
            self.assertLessEqual(
                set(entry.keys()), {"severity", "code", "message", "line"}
            )
        blob = json.dumps(result)
        self.assertNotIn("raw_output", blob)
        self.assertNotIn("mask_png_base64", blob)

    @needs_sam_parser
    def test_sam_incomplete_stream_is_rejected(self):
        lane = {"item_id": "item_1", "output_index": 0, "content_index": 0}
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            text=_sse(
                {
                    "type": "response.output_text.delta",
                    "delta": "<0f>",
                    **lane,
                }
            )
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            out = Path(tmp) / "m.png"
            with self.assertRaises(HTTPException) as ctx:
                _run(call_sam_3_1_single_frame(frame, "stain", out))
            self.assertEqual(ctx.exception.status_code, 502)
            self.assertFalse(out.exists())

    def test_sam_sends_trimmed_prompt_as_input_text(self):
        body = services._sam_request_body("  damaged tire  ", _JPEG_BYTES)
        self.assertEqual(body["model"], "sam-3.1")
        self.assertTrue(body["stream"])
        content = body["input"][0]["content"]
        self.assertEqual(
            content[0], {"type": "input_text", "text": "damaged tire"}
        )
        self.assertTrue(
            content[1]["image_url"].startswith("data:image/jpeg;base64,")
        )
        png_body = services._sam_request_body(
            "stain", b"\x89PNG\r\n\x1a\n" + b"\x00" * 10
        )
        png_content = png_body["input"][0]["content"]
        self.assertEqual(
            png_content[0], {"type": "input_text", "text": "stain"}
        )
        self.assertTrue(
            png_content[1]["image_url"].startswith("data:image/png;base64,")
        )

    @needs_sam_parser
    def test_sam_point_prompt_builds_documented_grammar(self):
        self.assertEqual(
            services._sam_point_prompt_text([{"x": 100, "y": 200}], 640, 480),
            "<0f>0<|point;x=100;y=200;w=640;h=480|>",
        )

    @needs_sam_parser
    def test_sam_point_prompt_assigns_one_id_per_spot(self):
        self.assertEqual(
            services._sam_point_prompt_text(
                [
                    {"x": 100, "y": 200},
                    {"x": 300, "y": 400, "label": "negative"},
                ],
                640,
                480,
            ),
            "<0f>0<|point;x=100;y=200;w=640;h=480|>,"
            "1-<|point;x=300;y=400;w=640;h=480|>",
        )

    @needs_sam_parser
    def test_sam_point_prompt_rejects_bad_spots(self):
        bad = [
            # x == width is outside the documented half-open image range.
            [{"x": 640, "y": 10}],
            [{"x": 10, "y": 480}],
            [{"x": 10, "y": -1}],
            [{"x": 1.5, "y": 2}],
            [{"x": True, "y": 2}],
            [{"x": 1, "y": 2, "label": "maybe"}],
            ["not-a-dict"],
            [],
        ]
        for points in bad:
            with self.assertRaises(HTTPException) as ctx:
                services._sam_point_prompt_text(points, 640, 480)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_sam_point_prompt_reads_natural_image_size(self):
        self.assertEqual(
            services._image_dimensions(_png_bytes(60, 27)), (60, 27)
        )
        with self.assertRaises(HTTPException) as ctx:
            services._image_dimensions(b"not an image")
        self.assertEqual(ctx.exception.status_code, 400)

    @needs_sam_parser
    def test_sam_service_point_mode_sends_grammar_as_input_text(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            text=_sam_wire_stream(SAM_DOCUMENTED_LINE)
        )
        points = [{"x": 10, "y": 10}, {"x": 40, "y": 20}]
        expected = (
            "<0f>0<|point;x=10;y=10;w=60;h=27|>,"
            "1<|point;x=40;y=20;w=60;h=27|>"
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.png"
            frame.write_bytes(_png_bytes(60, 27))
            out = Path(tmp) / "m.png"
            result = _run(
                call_sam_3_1_single_frame(frame, "stain", out, points=points)
            )
        self.assertTrue(result.get("match"))
        self.assertEqual(len(_FakeClient.instances), 1)
        url, kwargs = _FakeClient.instances[0].calls[0]
        self.assertEqual(url, "https://api.meta.ai/v1/responses")
        content = kwargs["json"]["input"][0]["content"]
        self.assertEqual(
            content[0], {"type": "input_text", "text": expected}
        )
        self.assertEqual(
            result["prompt"], {"mode": "points", "text": expected}
        )
        # Every returned mask keeps its own object id and box.
        self.assertEqual(
            [entry["object_id"] for entry in result["masks"]], ["0", "1"]
        )
        for entry in result["masks"]:
            placement_box = entry["box"]
            self.assertIsNotNone(placement_box)
            self.assertLess(
                placement_box["left"], placement_box["right"]
            )

    def test_segment_image_point_mode_ignores_concept(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.png", data),
                        text_prompt="stain",
                        points=json.dumps([{"x": 5, "y": 5}]),
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertTrue(result["mask"].get("match"))
        self.assertEqual(
            result["mask"]["prompt"],
            {"mode": "points", "text": "<0f>0<|point;x=5;y=5;w=60;h=27|>"},
        )
        self.assertEqual(_FakeClient.instances, [])

    def test_segment_image_rejects_bad_points_json(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        for bad in ("not-json", '{"x": 1}'):
            with self.assertRaises(HTTPException) as ctx:
                _run(
                    main.segment_image(
                        file=_StubUpload("photo.png", data),
                        text_prompt="stain",
                        points=bad,
                    )
                )
            self.assertEqual(ctx.exception.status_code, 400)

    def test_moveout_mask_png_round_trip_preserves_binary_grid(self):
        grid = bytearray([1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0])
        decoded, width, height = services._read_grayscale_png_bytes(
            _mask_png_bytes(4, 3, grid)
        )
        self.assertEqual((width, height), (4, 3))
        self.assertEqual(decoded, grid)
        with self.assertRaises(HTTPException) as ctx:
            services._read_grayscale_png_bytes(b"not a png")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_moveout_mask_placement_stamps_at_box_never_frame(self):
        solid = bytearray([1, 1, 1, 1])
        box = {"left": 1, "top": 2, "right": 3, "bottom": 4}
        placed = services._place_mask_on_frame(solid, 2, 2, box, 6, 6)
        self.assertEqual(len(placed), 36)
        for y in range(6):
            for x in range(6):
                self.assertEqual(
                    placed[y * 6 + x], 1 if x in (1, 2) and y in (2, 3) else 0
                )
        grown = services._place_mask_on_frame(
            solid, 2, 2, {"left": 0, "top": 0, "right": 4, "bottom": 4}, 4, 4
        )
        self.assertEqual(sum(grown), 16)
        with self.assertRaises(HTTPException) as ctx:
            services._place_mask_on_frame(
                solid,
                2,
                2,
                {"left": 5, "top": 0, "right": 9, "bottom": 2},
                6,
                6,
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_moveout_compare_keeps_polygon_pair_semantics(self):
        triangle = [[1, 1], [5, 1], [3, 4]]
        result = services.compare_moveout_masks_local(
            triangle, triangle, (8, 8)
        )
        self.assertEqual(result["iou"], 1.0)
        self.assertEqual(result["area_growth_ratio"], 0.0)
        self.assertEqual(result["prior_kind"], "polygon")
        self.assertEqual(result["current_kind"], "polygon")
        self.assertEqual(result["frame_size"], {"width": 8, "height": 8})
        self.assertGreater(result["day1_area_px"], 0)
        self.assertFalse(result["dimension_normalized"])

    def test_moveout_compare_raster_alignment_matches_polygon(self):
        # The alignment proof: a raster stamped at its box covers exactly
        # the frame pixels of the same-coordinate polygon.
        solid = bytearray([1] * 16)
        prior = {
            "mask_png_bytes": _mask_png_bytes(4, 4, solid),
            "mask_dims": {"width": 4, "height": 4},
            "box": {"left": 2, "top": 2, "right": 6, "bottom": 6},
            "frame_size": {"width": 8, "height": 8},
        }
        square = [[2, 2], [6, 2], [6, 6], [2, 6]]
        result = services.compare_moveout_masks_local(prior, square, (8, 8))
        self.assertEqual(result["iou"], 1.0)
        self.assertEqual(result["prior_kind"], "raster")
        self.assertEqual(result["current_kind"], "polygon")
        self.assertEqual(result["day1_area_px"], 16)
        self.assertEqual(result["moveout_area_px"], 16)
        self.assertFalse(result["dimension_normalized"])

    def test_moveout_compare_raster_partial_overlap(self):
        solid = bytearray([1, 1, 1, 1])
        prior = {
            "mask_png_bytes": _mask_png_bytes(2, 2, solid),
            "mask_dims": {"width": 2, "height": 2},
            "box": {"left": 0, "top": 0, "right": 2, "bottom": 2},
        }
        current = {
            "mask_png_bytes": _mask_png_bytes(2, 2, solid),
            "mask_dims": {"width": 2, "height": 2},
            "box": {"left": 1, "top": 0, "right": 3, "bottom": 2},
        }
        result = services.compare_moveout_masks_local(prior, current, (6, 6))
        self.assertEqual(result["day1_area_px"], 4)
        self.assertEqual(result["moveout_area_px"], 4)
        self.assertAlmostEqual(result["iou"], 2 / 6)
        self.assertEqual(result["area_growth_ratio"], 0.0)

    def test_moveout_compare_empty_prior_is_recorded_absence(self):
        square = [[2, 2], [6, 2], [6, 6], [2, 6]]
        result = services.compare_moveout_masks_local([], square, (8, 8))
        self.assertEqual(result["day1_area_px"], 0)
        self.assertEqual(result["iou"], 0.0)
        self.assertEqual(result["area_growth_ratio"], 0.0)

    def test_moveout_compare_rejects_missing_or_unalignable_evidence(self):
        solid = bytearray([1, 1, 1, 1])
        png = _mask_png_bytes(2, 2, solid)
        box = {"left": 0, "top": 0, "right": 2, "bottom": 2}
        bad = [
            (None, [[[1, 1], [2, 2], [3, 3]]][0]),
            ("not-evidence", [[1, 1], [5, 1], [3, 4]]),
            ([[1, 1], [2, 2]], [[1, 1], [5, 1], [3, 4]]),
            ({"mask_png_bytes": png}, [[1, 1], [5, 1], [3, 4]]),
            (
                {
                    "mask_png_bytes": png,
                    "mask_dims": {"width": 3, "height": 3},
                    "box": box,
                },
                [[1, 1], [5, 1], [3, 4]],
            ),
            (
                {
                    "mask_png_bytes": png,
                    "mask_dims": {"width": 2, "height": 2},
                    "box": box,
                    "frame_size": {"width": 9, "height": 9},
                },
                # A current-side dimension mismatch still cannot be aligned.
                {
                    "mask_png_bytes": png,
                    "mask_dims": {"width": 2, "height": 2},
                    "box": box,
                    "frame_size": {"width": 9, "height": 9},
                },
            ),
            (
                {"mask_png_base64": "!!!not-base64!!!", "box": box},
                [[1, 1], [5, 1], [3, 4]],
            ),
        ]
        for prior, current in bad:
            with self.assertRaises(HTTPException) as ctx:
                services.compare_moveout_masks_local(prior, current, (8, 8))
            self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            services.compare_moveout_masks_local(
                [[1, 1], [5, 1], [3, 4]], [[1, 1], [5, 1], [3, 4]], (0, 8)
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_select_sam_masks_filters_sorts_and_retains_only(self):
        frame_area = 100 * 100
        big = {
            "object_id": "b",
            "pixel_count": 500,
            "box": {"left": 0, "top": 0, "right": 30, "bottom": 30},
            "tag": "big",
        }
        speck_pixels = {
            "object_id": "s1",
            "pixel_count": 5,  # 0.05% of the frame
            "box": {"left": 0, "top": 0, "right": 2, "bottom": 2},
            "tag": "speck",
        }
        speck_box = {
            "object_id": "s2",
            "pixel_count": 0,
            # Narrow box: 1x500 = 5% of the frame, kept on box area.
            "box": {"left": 0, "top": 0, "right": 1, "bottom": 500},
            "tag": "kept-on-box",
        }
        kept = services._select_sam_masks(
            [speck_pixels, speck_box, big], frame_area
        )
        self.assertEqual([item["tag"] for item in kept], ["big", "kept-on-box"])
        # Payload rides along untouched for file association.
        self.assertEqual(kept[0]["object_id"], "b")
        self.assertEqual(
            kept[0]["box"], {"left": 0, "top": 0, "right": 30, "bottom": 30}
        )
        # A lone speck below threshold is retained, never dropped.
        only = services._select_sam_masks([dict(speck_pixels)], frame_area)
        self.assertEqual(len(only), 1)
        self.assertEqual(only[0]["object_id"], "s1")

    def test_sam_overlay_png_dimensions_and_styling(self):
        from PIL import Image

        width, height = 12, 12
        grid = bytearray(width * height)
        for y in range(2, 10):
            for x in range(2, 10):
                grid[y * width + x] = 1
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            path = Path(tmp) / "overlay.png"
            services._write_sam_overlay_png(path, width, height, [grid])
            with Image.open(path) as img:
                self.assertEqual(img.mode, "RGBA")
                self.assertEqual(img.size, (width, height))
                px = img.load()
                # Deep interior: translucent red fill.
                self.assertEqual(px[6, 6], (255, 0, 0, 110))
                # 2px interior border: opaque red.
                self.assertEqual(px[2, 2], (255, 0, 0, 255))
                self.assertEqual(px[3, 6], (255, 0, 0, 255))
                # Outside the mask: fully transparent.
                self.assertEqual(px[0, 0], (0, 0, 0, 0))
                self.assertEqual(px[11, 11], (0, 0, 0, 0))

    @needs_sam_parser
    def test_sam_live_result_writes_full_frame_overlay(self):
        from PIL import Image

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            text=_sam_wire_stream(SAM_DOCUMENTED_LINE)
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            out = Path(tmp) / "m.png"
            result = _run(call_sam_3_1_single_frame(frame, "stain", out))
            overlay = result.get("overlay_path")
            self.assertIsNotNone(overlay)
            self.assertTrue(Path(overlay).is_file())
            with Image.open(overlay) as img:
                self.assertEqual(img.mode, "RGBA")
                # Frame bytes are undecodable here, so the overlay falls
                # back to the returned boxes' bounding extent.
                self.assertEqual(img.size, (271, 255))
            # Both documented masks clear 0.10%; largest stays first.
            self.assertEqual(
                [entry["object_id"] for entry in result["masks"]], ["0", "1"]
            )

    def test_moveout_compare_normalizes_prior_raster_dimensions(self):
        solid = bytearray([1] * 4)
        prior = {
            "mask_png_bytes": _mask_png_bytes(2, 2, solid),
            "mask_dims": {"width": 2, "height": 2},
            "box": {"left": 0, "top": 0, "right": 2, "bottom": 2},
            "frame_size": {"width": 4, "height": 4},
        }
        square = [[2, 2], [6, 2], [6, 6], [2, 6]]
        result = services.compare_moveout_masks_local(prior, square, (8, 8))
        self.assertEqual(result["prior_kind"], "raster")
        self.assertTrue(result["dimension_normalized"])
        # The 2x2 block in a 4x4 move-in frame doubles to 4x4 = 16px.
        self.assertEqual(result["day1_area_px"], 16)
        self.assertEqual(result["moveout_area_px"], 16)
        self.assertAlmostEqual(result["iou"], 4 / 28)

    def test_moveout_compare_normalizes_prior_polygon_dimensions(self):
        prior = {
            "polygon": [[0, 0], [4, 0], [4, 4], [0, 4]],
            "frame_size": {"width": 4, "height": 4},
        }
        result = services.compare_moveout_masks_local(prior, [], (8, 8))
        self.assertEqual(result["prior_kind"], "polygon")
        self.assertTrue(result["dimension_normalized"])
        self.assertEqual(result["day1_area_px"], 64)
        self.assertEqual(result["moveout_area_px"], 0)

    def test_verify_moveout_endpoint_normalizes_cross_size_prior(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        prior_mask = {
            "mask_png_base64": base64.b64encode(
                _mask_png_bytes(2, 2, bytearray([1, 1, 1, 1]))
            ).decode("ascii"),
            "mask_dims": {"width": 2, "height": 2},
            "box": {"left": 0, "top": 0, "right": 2, "bottom": 2},
            "frame_size": {"width": 320, "height": 240},
        }
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon="",
                        prior_mask=json.dumps(prior_mask),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        comparison = result["comparison"]
        self.assertEqual(comparison["prior_kind"], "raster")
        self.assertTrue(comparison["dimension_normalized"])
        self.assertEqual(
            comparison["frame_size"], {"width": 60, "height": 27}
        )
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_endpoint_compares_locally_without_model(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        triangle = [[5, 5], [20, 5], [12, 20]]
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon=json.dumps(triangle),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertTrue(result["mask"].get("match"))
        comparison = result["comparison"]
        self.assertEqual(
            set(comparison.keys()),
            {
                "iou",
                "iou_registered",
                "registration_shift_px",
                "registered",
                "day1_area_px",
                "moveout_area_px",
                "area_growth_ratio",
                "prior_kind",
                "current_kind",
                "frame_size",
                "dimension_normalized",
                "compared_object_id",
            },
        )
        self.assertFalse(comparison["dimension_normalized"])
        self.assertEqual(comparison["prior_kind"], "polygon")
        self.assertEqual(comparison["current_kind"], "raster")
        self.assertEqual(
            comparison["frame_size"], {"width": 60, "height": 27}
        )
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_endpoint_accepts_raster_prior(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        mask_png = _mask_png_bytes(2, 2, bytearray([1, 1, 1, 1]))
        prior_mask = {
            "mask_png_base64": base64.b64encode(mask_png).decode("ascii"),
            "mask_dims": {"width": 2, "height": 2},
            "box": {"left": 1, "top": 1, "right": 3, "bottom": 3},
            "frame_size": {"width": 60, "height": 27},
            "object_id": "7",
        }
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon="",
                        prior_mask=json.dumps(prior_mask),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        comparison = result["comparison"]
        self.assertEqual(comparison["prior_kind"], "raster")
        self.assertEqual(comparison["day1_area_px"], 4)
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_endpoint_validates_prior_evidence(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        cases = [
            # No prior evidence at all.
            {"prior_polygon": "", "prior_mask": ""},
            # Mutually exclusive prior forms.
            {
                "prior_polygon": json.dumps([[1, 1], [2, 2], [3, 3]]),
                "prior_mask": json.dumps({"mask_png_base64": "eA=="}),
            },
            # Prior mask whose declared dims contradict its PNG bytes.
            {
                "prior_polygon": "",
                "prior_mask": json.dumps(
                    {
                        "mask_png_base64": base64.b64encode(
                            _mask_png_bytes(2, 2, bytearray([1, 1, 1, 1]))
                        ).decode("ascii"),
                        "mask_dims": {"width": 3, "height": 3},
                        "box": {"left": 0, "top": 0, "right": 2, "bottom": 2},
                        "frame_size": {"width": 60, "height": 27},
                    }
                ),
            },
        ]
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                for kwargs in cases:
                    with self.assertRaises(HTTPException) as ctx:
                        _run(
                            main.verify_moveout(
                                file=_StubUpload("photo.png", data),
                                text_prompt="stain",
                                **kwargs,
                            )
                        )
                    self.assertEqual(ctx.exception.status_code, 400)
            finally:
                main.STORAGE_DIR = real_storage

    def test_segment_image_result_includes_elapsed_ms(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.jpg", _JPEG_BYTES),
                        text_prompt="stain",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertIn("elapsed_ms", result)
        self.assertIsInstance(result["elapsed_ms"], int)
        self.assertGreaterEqual(result["elapsed_ms"], 0)
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_no_match_includes_elapsed_ms(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        triangle = [[5, 5], [20, 5], [12, 20]]
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            real_sam = main.call_sam_3_1_single_frame

            async def _no_match(*a, **k):
                return {"match": False}

            main.call_sam_3_1_single_frame = _no_match  # type: ignore[assignment]
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon=json.dumps(triangle),
                        text_prompt="stain",
                    )
                )
            finally:
                main.call_sam_3_1_single_frame = real_sam
                main.STORAGE_DIR = real_storage
        self.assertFalse(result["comparison"]["match"])
        self.assertIn("elapsed_ms", result)
        self.assertIsInstance(result["elapsed_ms"], int)
        self.assertGreaterEqual(result["elapsed_ms"], 0)
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_point_retry_after_concept_miss_raster_prior(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        # Prior box centre is (20, 10) in a declared 120x54 frame, i.e.
        # fractions (1/6, 5/27) -- the point on the 60x27 move-out
        # photo must land at (10, 5).
        prior_mask = {
            "mask_png_base64": base64.b64encode(
                _mask_png_bytes(2, 2, bytearray([1, 1, 1, 1]))
            ).decode("ascii"),
            "mask_dims": {"width": 2, "height": 2},
            "box": {"left": 10, "top": 5, "right": 30, "bottom": 15},
            "frame_size": {"width": 120, "height": 54},
        }
        calls = []

        async def _dispatch(*a, **k):
            points = k.get("points")
            calls.append(points)
            if points:
                return {
                    "match": True,
                    "polygon": [[12, 6], [24, 6], [24, 14], [12, 14]],
                    "prompt": {"mode": "points", "text": ""},
                }
            return {"match": False}

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            real_sam = main.call_sam_3_1_single_frame
            main.call_sam_3_1_single_frame = _dispatch  # type: ignore[assignment]
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon="",
                        prior_mask=json.dumps(prior_mask),
                        text_prompt="visible damage or stain",
                    )
                )
            finally:
                main.call_sam_3_1_single_frame = real_sam
                main.STORAGE_DIR = real_storage
        self.assertTrue(result["mask"].get("match"))
        comparison = result["comparison"]
        self.assertEqual(comparison["prior_kind"], "raster")
        for key in ("iou", "area_growth_ratio"):
            self.assertIsInstance(comparison[key], float)
        self.assertGreaterEqual(comparison["day1_area_px"], 1)
        self.assertGreaterEqual(comparison["moveout_area_px"], 1)
        point_calls = [p for p in calls if p]
        self.assertEqual(len(point_calls), 1)
        self.assertEqual(len(point_calls[0]), 1)
        point = point_calls[0][0]
        self.assertEqual(point["label"], "positive")
        self.assertEqual((point["x"], point["y"]), (10, 5))
        self.assertTrue(0 <= point["x"] < 60)
        self.assertTrue(0 <= point["y"] < 27)
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_point_retry_after_concept_miss_polygon_prior(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        # Polygon bbox centre is (40, 20) in the declared 120x54 frame;
        # _evidence_grid scales it by (60/120, 27/54), so the retry
        # point on the 60x27 photo must be (20, 10).
        prior = {
            "polygon": [[20, 10], [60, 10], [60, 30], [20, 30]],
            "frame_size": {"width": 120, "height": 54},
        }
        calls = []

        async def _dispatch(*a, **k):
            points = k.get("points")
            calls.append(points)
            if points:
                return {
                    "match": True,
                    "polygon": [[12, 6], [24, 6], [24, 14], [12, 14]],
                    "prompt": {"mode": "points", "text": ""},
                }
            return {"match": False}

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            real_sam = main.call_sam_3_1_single_frame
            main.call_sam_3_1_single_frame = _dispatch  # type: ignore[assignment]
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon=json.dumps(prior),
                        text_prompt="visible damage or stain",
                    )
                )
            finally:
                main.call_sam_3_1_single_frame = real_sam
                main.STORAGE_DIR = real_storage
        self.assertTrue(result["mask"].get("match"))
        comparison = result["comparison"]
        self.assertEqual(comparison["prior_kind"], "polygon")
        self.assertEqual(comparison["current_kind"], "polygon")
        self.assertIsInstance(comparison["iou"], float)
        self.assertGreater(comparison["iou"], 0)
        self.assertGreaterEqual(comparison["day1_area_px"], 1)
        self.assertGreaterEqual(comparison["moveout_area_px"], 1)
        self.assertIsInstance(comparison["area_growth_ratio"], float)
        point_calls = [p for p in calls if p]
        self.assertEqual(len(point_calls), 1)
        point = point_calls[0][0]
        self.assertEqual(point["label"], "positive")
        self.assertEqual((point["x"], point["y"]), (20, 10))
        self.assertEqual(_FakeClient.instances, [])

    def test_verify_moveout_both_attempts_miss_returns_no_match(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        data = _png_bytes(60, 27)
        triangle = [[5, 5], [20, 5], [12, 20]]
        calls = []

        async def _dispatch(*a, **k):
            calls.append(k.get("points"))
            return {"match": False}

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            real_sam = main.call_sam_3_1_single_frame
            main.call_sam_3_1_single_frame = _dispatch  # type: ignore[assignment]
            try:
                result = _run(
                    main.verify_moveout(
                        file=_StubUpload("photo.png", data),
                        prior_polygon=json.dumps(triangle),
                        text_prompt="visible damage or stain",
                    )
                )
            finally:
                main.call_sam_3_1_single_frame = real_sam
                main.STORAGE_DIR = real_storage
        self.assertFalse(result["comparison"]["match"])
        self.assertEqual(
            result["comparison"]["note"],
            "SAM 3.1 found no region matching the prompt "
            "or the saved outline's centre point.",
        )
        # The point retry really was attempted, with one in-bounds
        # positive point, before the route gave up honestly.
        point_calls = [p for p in calls if p]
        self.assertEqual(len(point_calls), 1)
        point = point_calls[0][0]
        self.assertEqual(point["label"], "positive")
        self.assertTrue(0 <= point["x"] < 60)
        self.assertTrue(0 <= point["y"] < 27)
        self.assertIn("elapsed_ms", result)
        self.assertEqual(_FakeClient.instances, [])

    def test_walkthrough_frame_size_reads_processed_frame(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "frame-000001.jpg"
            services._write_grayscale_png(
                frame, 12, 10, bytearray([1]) * 120
            )
            self.assertEqual(main._walkthrough_frame_size(frame), (12, 10))
            self.assertEqual(
                main._walkthrough_frame_size(Path(tmp) / "missing.jpg"),
                (0, 0),
            )

    def test_walkthrough_region_carries_frame_dims_and_mask_urls(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                storage = Path(tmp)
                frames = storage / "frames"
                frames.mkdir(parents=True, exist_ok=True)
                frame = frames / "frame-000001.jpg"
                services._write_grayscale_png(
                    frame, 12, 10, bytearray([1]) * 120
                )
                jobs = storage / "jobs"
                jobs.mkdir(parents=True, exist_ok=True)
                mask0 = jobs / "mask-000.png"
                services._write_grayscale_png(
                    mask0, 6, 5, bytearray([1]) * 30
                )
                mask1 = jobs / "mask-001.png"
                services._write_grayscale_png(
                    mask1, 4, 4, bytearray([1]) * 16
                )
                sam = {
                    "match": True,
                    "model": SAM31_MODEL,
                    "box": {"left": 1, "top": 1, "right": 7, "bottom": 6},
                    "mask_dims": {"width": 6, "height": 5},
                    "mask_path": str(mask0),
                    "masks": [
                        {
                            "object_id": "0",
                            "box": {"left": 1, "top": 1, "right": 7, "bottom": 6},
                            "mask_dims": {"width": 6, "height": 5},
                            "mask_path": str(mask0),
                        },
                        {
                            "object_id": "1",
                            "box": {"left": 8, "top": 0, "right": 12, "bottom": 4},
                            "mask_dims": {"width": 4, "height": 4},
                            "mask_path": str(mask1),
                        },
                    ],
                }
                region = main._build_walkthrough_region(frame, 3, sam)
                self.assertEqual(region["frame"], "frame-000001.jpg")
                self.assertEqual(region["second"], 3)
                # Actual processed-frame dimensions, not assumed values.
                self.assertEqual(region["frame_width"], 12)
                self.assertEqual(region["frame_height"], 10)
                # Both masks from the one frame stay individually
                # addressable with their own boxes and served URLs.
                entries = region["masks"]
                self.assertEqual(
                    [entry["object_id"] for entry in entries], ["0", "1"]
                )
                self.assertEqual(
                    entries[0]["mask_url"], "/files/jobs/mask-000.png"
                )
                self.assertEqual(
                    entries[1]["mask_url"], "/files/jobs/mask-001.png"
                )
                self.assertEqual(
                    entries[1]["box"],
                    {"left": 8, "top": 0, "right": 12, "bottom": 4},
                )
                self.assertEqual(
                    entries[1]["mask_dims"], {"width": 4, "height": 4}
                )
                # The raw SAM mapping is preserved for compatibility.
                self.assertTrue(region["match"])
                self.assertEqual(region["model"], SAM31_MODEL)
            finally:
                main.STORAGE_DIR = real_storage

    def test_walkthrough_mask_entries_legacy_fallback_and_drops(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                storage = Path(tmp)
                inside = storage / "jobs" / "mask-000.png"
                inside.parent.mkdir(parents=True, exist_ok=True)
                inside.write_bytes(b"fake-png-bytes")
                legacy = {
                    "match": True,
                    "object_id": "7",
                    "box": {"left": 1, "top": 1, "right": 3, "bottom": 3},
                    "mask_dims": {"width": 2, "height": 2},
                    "mask_path": str(inside),
                }
                entries = main._walkthrough_mask_entries(legacy)
                self.assertEqual(len(entries), 1)
                self.assertEqual(entries[0]["object_id"], "7")
                self.assertEqual(
                    entries[0]["mask_url"], "/files/jobs/mask-000.png"
                )
                # No-match rows offer no masks.
                self.assertEqual(
                    main._walkthrough_mask_entries({"match": False}), []
                )
                self.assertEqual(main._walkthrough_mask_entries(None), [])
                # Files outside storage never leak as served URLs.
                outside = Path(tmp).parent / "elsewhere-mask.png"
                entries = main._walkthrough_mask_entries(
                    {
                        "match": True,
                        "masks": [
                            {
                                "object_id": "0",
                                "box": {"left": 0, "top": 0, "right": 1, "bottom": 1},
                                "mask_dims": {"width": 1, "height": 1},
                                "mask_path": str(outside),
                            }
                        ],
                    }
                )
                self.assertEqual(entries, [])
            finally:
                main.STORAGE_DIR = real_storage

    def test_lease_quote_verification_accepts_verbatim_excerpt(self):
        haystack = services._normalize_for_match(_LEASE_TEXT)
        result = services._validate_lease_issue(
            _lease_issue(), haystack, _STATUTE_TEXT
        )
        self.assertTrue(result["verified_quote"])
        self.assertIsNone(result["verification_note"])
        self.assertEqual(result["citation"], "BGB Section 551")
        self.assertEqual(result["severity"], "high")

    def test_lease_quote_verification_normalizes_whitespace(self):
        haystack = services._normalize_for_match(_LEASE_TEXT)
        odd_spacing = "security  deposit\nof EUR   900 upon signing."
        result = services._validate_lease_issue(
            _lease_issue(evidence_quote=odd_spacing), haystack, _STATUTE_TEXT
        )
        self.assertTrue(result["verified_quote"])
        # The comparison is normalized; the returned text is untouched.
        self.assertEqual(result["evidence_quote"], odd_spacing)

    def test_lease_quote_verification_rejects_fabricated_excerpt(self):
        haystack = services._normalize_for_match(_LEASE_TEXT)
        result = services._validate_lease_issue(
            _lease_issue(
                evidence_quote=(
                    "The landlord may keep the entire deposit forever."
                ),
                citation="Section 99.9 Forfeiture",
            ),
            haystack,
            _STATUTE_TEXT,
        )
        self.assertFalse(result["verified_quote"])
        assert result["verification_note"] is not None
        self.assertIn("not found", result["verification_note"])
        self.assertIsNone(result["citation"])

    def test_lease_quote_verification_handles_missing_fields(self):
        haystack = services._normalize_for_match(_LEASE_TEXT)
        # An absent citation stays null without failing the excerpt check.
        no_citation = services._validate_lease_issue(
            _lease_issue(citation=None), haystack
        )
        self.assertTrue(no_citation["verified_quote"])
        self.assertIsNone(no_citation["citation"])
        # A missing explanation cannot be assessed: unverified, not dropped.
        no_why = services._validate_lease_issue(
            _lease_issue(why_risky="  "), haystack
        )
        self.assertFalse(no_why["verified_quote"])
        assert no_why["verification_note"] is not None
        self.assertIn("why_risky", no_why["verification_note"])
        # A snippet too short to be meaningful never counts as verified.
        short = services._validate_lease_issue(
            _lease_issue(evidence_quote="EUR 900"), haystack
        )
        self.assertFalse(short["verified_quote"])

    def test_lease_findings_drop_unvalidated_scores(self):
        analysis = {
            "summary": "Strict deposit terms.",
            "possible_issues": [_lease_issue()],
            "deposit_terms": "EUR 900.",
            "confidence": "high",
            "risk_score": 0.95,
            "estimated_savings": 100,
        }
        cleaned = services.validate_lease_findings(
            analysis, _LEASE_TEXT, _STATUTE_TEXT
        )
        self.assertNotIn("risk_score", cleaned)
        self.assertNotIn("estimated_savings", cleaned)
        self.assertEqual(cleaned["deposit_terms"], "EUR 900.")
        self.assertEqual(
            cleaned["verification"],
            {
                "checked_issues": 1,
                "verified_quotes": 1,
                "unverified_quotes": 0,
            },
        )
        # The input is never mutated.
        self.assertEqual(analysis["risk_score"], 0.95)
        self.assertEqual(len(analysis["possible_issues"]), 1)
        self.assertNotIn("verified_quote", analysis["possible_issues"][0])

    def test_decode_contract_validates_quotes_against_lease_text(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        reported = {
            "summary": "Strict deposit terms.",
            "possible_issues": [
                _lease_issue(),
                _lease_issue(
                    evidence_quote=(
                        "The landlord may keep the entire deposit forever."
                    ),
                    citation="Section 99.9 Forfeiture",
                ),
            ],
            "confidence": "high",
            "risk_score": 0.95,
        }

        async def fake_chat(*args, **kwargs):
            return reported

        class FakePage:
            def extract_text(self):
                return _LEASE_TEXT

        class FakeReader:
            def __init__(self, *args, **kwargs):
                self.pages = [FakePage()]

        real_chat, real_reader = main.call_meta_chat, main.PdfReader
        main.call_meta_chat, main.PdfReader = fake_chat, FakeReader
        real_jurisdiction = main.get_jurisdiction
        main.get_jurisdiction = lambda code: {"statutes": _STATUTE_TEXT}
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.decode_contract(
                        file=_StubUpload("lease.pdf", b"%PDF-1.4 fake"),
                        jurisdiction_code="DE",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
                main.call_meta_chat, main.PdfReader = real_chat, real_reader
                main.get_jurisdiction = real_jurisdiction
        out = result["analysis"]
        self.assertTrue(out["possible_issues"][0]["verified_quote"])
        self.assertEqual(
            out["possible_issues"][0]["citation"], "BGB Section 551"
        )
        self.assertFalse(out["possible_issues"][1]["verified_quote"])
        self.assertIsNone(out["possible_issues"][1]["citation"])
        self.assertEqual(
            out["verification"],
            {
                "checked_issues": 2,
                "verified_quotes": 1,
                "unverified_quotes": 1,
            },
        )
        self.assertNotIn("risk_score", out)
        self.assertEqual(_FakeClient.instances, [])

    def test_reservation_floor_covers_fallback_tariff(self):
        from config import floor_reservation_for_model

        # Holds below the tariff are raised to it.
        self.assertEqual(
            floor_reservation_for_model("sam-3.1", 0.01), 0.02
        )
        self.assertEqual(
            floor_reservation_for_model("muse-voice-transcribe-1.0", 0.001),
            0.015,
        )
        self.assertEqual(
            floor_reservation_for_model(
                "meta-models/muse-spark-open-1026", 0.0
            ),
            0.005,
        )
        # Larger holds pass through; models without a tariff are unchanged.
        self.assertEqual(
            floor_reservation_for_model("sam-3.1", 0.05), 0.05
        )
        self.assertEqual(
            floor_reservation_for_model("muse-spark-1.3", 0.03), 0.03
        )
        self.assertEqual(
            floor_reservation_for_model("future-model-9", 0.007), 0.007
        )
        self.assertEqual(floor_reservation_for_model(None, 0.009), 0.009)

    def test_voice_precall_reservation_covers_fallback_tariff(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            {
                "segments": [
                    {"start": 0.0, "end": 1.0, "text": "hallway looks fine"}
                ]
            }
        )
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            segments = _run(call_muse_voice(audio))
        self.assertTrue(segments)
        # A 104-byte clip estimates far below the voice tariff, so the
        # floored hold -- not the raw size estimate -- is reserved.
        self.assertEqual(len(self._stub.reserved), 1)
        held = next(iter(self._stub.reserved.values()))
        self.assertAlmostEqual(held, 0.015)
        self.assertIsNone(self._stub.saved[0]["cost_usd"])

    def test_fallback_tariff_replaces_reservation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            shield = CreditShield(db_path=Path(tmp) / "test.sqlite")
            key = shield.cache_key_for(b"live-sam-payload")
            shield.reserve(key, "responses", "meta-sam31", 0.01)
            self.assertAlmostEqual(shield.get_reserved_cumulative(), 0.01)
            record = {
                "model": SAM31_MODEL,
                "usage": {"cost_usd": "unknown"},
                "match": True,
            }
            shield.save_response(key, "responses", "meta-sam31", record, None)
            # The recorded estimate replaces the hold: no double charge.
            self.assertEqual(shield.get_reserved_cumulative(), 0.0)
            self.assertEqual(shield.get_session_reserved(), 0.0)
            self.assertAlmostEqual(shield.get_cumulative_spend(), 0.02)
            self.assertAlmostEqual(shield.get_session_spend(), 0.02)
            with shield._connect() as conn:
                row = conn.execute(
                    "SELECT cost_usd, response_json FROM api_cache "
                    "WHERE cache_key = ?",
                    (key,),
                ).fetchone()
            self.assertAlmostEqual(row[0], 0.02)
            cached = json.loads(row[1])
            self.assertEqual(cached["cost_source"], "fallback_estimate")
            self.assertAlmostEqual(cached["estimated_cost_usd"], 0.02)
            # The estimate is never presented as provider-reported usage.
            self.assertEqual(cached["usage"].get("cost_usd"), "unknown")
            del shield

    def test_fallback_skips_mock_and_unknown_models(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            shield = CreditShield(db_path=Path(tmp) / "test.sqlite")
            mock_key = shield.cache_key_for(b"mock-payload")
            shield.save_response(
                mock_key,
                "responses",
                "meta-mock",
                {
                    "model": SAM31_MODEL,
                    "mock": True,
                    "usage": {"cost_usd": 0.0},
                },
                None,
            )
            unknown_key = shield.cache_key_for(b"unknown-model-payload")
            shield.reserve(unknown_key, "responses", "meta-chat", 0.02)
            shield.save_response(
                unknown_key,
                "responses",
                "meta-chat",
                {"model": "future-model-9", "usage": {"cost_usd": "unknown"}},
                None,
            )
            with shield._connect() as conn:
                rows = conn.execute(
                    "SELECT cost_usd FROM spend_ledger"
                ).fetchall()
            self.assertEqual([row[0] for row in rows], [None, None])
            self.assertEqual(shield.get_cumulative_spend(), 0.0)
            self.assertEqual(shield.get_session_spend(), 0.0)
            # No fallback was recorded, so the unrelated hold stands.
            self.assertAlmostEqual(shield.get_reserved_cumulative(), 0.02)
            del shield

    def test_citation_validated_against_registry_text(self):
        haystack = services._normalize_for_match(_LEASE_TEXT)
        # A registry-grounded citation is kept though absent from the lease.
        kept = services._validate_lease_issue(
            _lease_issue(), haystack, _STATUTE_TEXT
        )
        self.assertTrue(kept["verified_quote"])
        self.assertEqual(kept["citation"], "BGB Section 551")
        # A lease section header is not a statute citation: nulled, with
        # a note. The verbatim quote itself stays verified; only the
        # citation is dropped (verified_quote reflects quote and why_risky,
        # matching the long-standing validator semantics).
        lease_only = services._validate_lease_issue(
            _lease_issue(citation="Section 4.2 Security Deposit"),
            haystack,
            _STATUTE_TEXT,
        )
        self.assertIsNone(lease_only["citation"])
        self.assertTrue(lease_only["verified_quote"])
        assert lease_only["verification_note"] is not None
        self.assertIn("jurisdiction", lease_only["verification_note"])
        # Unsupported citations still become null.
        bogus = services._validate_lease_issue(
            _lease_issue(citation="Section 99.9 Forfeiture"),
            haystack,
            _STATUTE_TEXT,
        )
        self.assertIsNone(bogus["citation"])

    def test_validate_lease_findings_grounds_citations_in_registry(self):
        analysis = {
            "summary": "Strict deposit terms.",
            "possible_issues": [
                _lease_issue(),
                _lease_issue(citation="Section 99.9 Forfeiture"),
            ],
            "confidence": "low",
        }
        cleaned = services.validate_lease_findings(
            analysis, _LEASE_TEXT, _STATUTE_TEXT
        )
        self.assertEqual(
            cleaned["possible_issues"][0]["citation"], "BGB Section 551"
        )
        self.assertIsNone(cleaned["possible_issues"][1]["citation"])
        # The input is never mutated.
        self.assertEqual(
            analysis["possible_issues"][0]["citation"], "BGB Section 551"
        )

    def test_decode_contract_nests_metrics_in_analysis(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        reported = {
            "summary": "Strict deposit terms.",
            # Distinct quotes per finding: since the decode stabiliser
            # landed, findings citing the exact same sentence collapse
            # into one, so this metrics fixture must not reuse a single
            # quote for six different amount/severity cases.
            "possible_issues": [
                _lease_issue(
                    flagged_amount=150,
                    severity="high",
                    evidence_quote=(
                        "The tenant shall pay a cleaning charge "
                        "of EUR 150 at the end of the tenancy."
                    ),
                ),
                _lease_issue(
                    flagged_amount=49.5,
                    severity="medium",
                    citation="Tenant Fees Act 2019",
                    evidence_quote=(
                        "An administration fee of EUR 49.50 is charged "
                        "for the tenancy agreement."
                    ),
                ),
                _lease_issue(
                    flagged_amount=True,
                    severity="low",
                    evidence_quote=(
                        "The tenant shall repaint all walls in white "
                        "before moving out."
                    ),
                ),
                _lease_issue(
                    flagged_amount="300",
                    severity="low",
                    evidence_quote=(
                        "A lump sum of EUR 300 is charged for final "
                        "cleaning regardless of condition."
                    ),
                ),
                _lease_issue(
                    flagged_amount=float("inf"),
                    severity="low",
                    evidence_quote=(
                        "Garden maintenance is charged to the tenant "
                        "at the landlord's discretion."
                    ),
                ),
                _lease_issue(
                    severity="weird",
                    evidence_quote=(
                        "Overnight guests are prohibited without "
                        "written consent of the landlord."
                    ),
                ),
            ],
            "confidence": "high",
        }

        async def fake_chat(*args, **kwargs):
            return reported

        class FakePage:
            def extract_text(self):
                return _LEASE_TEXT

        class FakeReader:
            def __init__(self, *args, **kwargs):
                self.pages = [FakePage()]

        real_chat, real_reader = main.call_meta_chat, main.PdfReader
        main.call_meta_chat, main.PdfReader = fake_chat, FakeReader
        real_jurisdiction = main.get_jurisdiction
        main.get_jurisdiction = lambda code: {"statutes": _STATUTE_TEXT}
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.decode_contract(
                        file=_StubUpload("lease.pdf", b"%PDF-1.4 fake"),
                        jurisdiction_code="DE",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
                main.call_meta_chat, main.PdfReader = real_chat, real_reader
                main.get_jurisdiction = real_jurisdiction
        out = result["analysis"]
        # Metrics live inside analysis, where the frontend reads them;
        # only finite numbers count, booleans and strings never do.
        self.assertEqual(out["issue_count"], 6)
        self.assertEqual(out["high_severity_count"], 1)
        self.assertAlmostEqual(out["total_flagged_amount"], 199.5)
        self.assertEqual(
            out["possible_issues"][1]["citation"], "Tenant Fees Act 2019"
        )
        # Top-level compatibility fields are preserved.
        self.assertEqual(result["issue_count"], 6)
        self.assertEqual(result["high_severity_count"], 1)
        self.assertAlmostEqual(result["total_flagged_amount"], 199.5)
        self.assertEqual(result["review_note"], main.REVIEW_NOTE)
        self.assertIn("truncated_chars", result)
        self.assertIn("total_chars", result)
        self.assertEqual(_FakeClient.instances, [])

    def test_sam_request_labels_mime_from_image_bytes(self):
        self.assertEqual(
            services._data_url_mime(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100),
            "image/png",
        )
        self.assertEqual(
            services._data_url_mime(b"\xff\xd8\xff\xe0" + b"\x00" * 100),
            "image/jpeg",
        )
        self.assertEqual(services._data_url_mime(b""), "image/jpeg")

    def test_sam_diagnostic_scrub_keeps_only_safe_fields(self):
        class _Diag:
            severity = "warning"
            code = "ignored_token"
            message = "x" * 500
            line = 3
            raw = "<0f>SECRET-KEY-MATERIAL"
            api_key = "SHOULD-NEVER-APPEAR"

        scrubbed = services._safe_diagnostic(_Diag())
        self.assertEqual(
            set(scrubbed.keys()), {"severity", "code", "message", "line"}
        )
        self.assertEqual(scrubbed["severity"], "warning")
        self.assertEqual(scrubbed["code"], "ignored_token")
        self.assertEqual(len(scrubbed["message"]), 300)
        self.assertEqual(scrubbed["line"], 3)
        blob = json.dumps(scrubbed)
        self.assertNotIn("raw", blob)
        self.assertNotIn("SECRET", blob)

    @needs_sam_parser
    def test_sam_bare_frame_header_is_malformed(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(text=_sam_wire_stream("<0f>"))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            out = Path(tmp) / "m.png"
            with self.assertRaises(HTTPException) as ctx:
                _run(call_sam_3_1_single_frame(frame, "stain", out))
            self.assertEqual(ctx.exception.status_code, 502)
            self.assertFalse(out.exists())

    @needs_sam_parser
    def test_sam_box_outside_frame_is_malformed(self):
        line = (
            "<0f>0<|box;x1=1;y1=1;x2=400;y2=2;w=320;h=334|>"
            "<|mask;x=0;y=0;data=27,60,"
            "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
        )
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(text=_sam_wire_stream(line))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            with self.assertRaises(HTTPException) as ctx:
                _run(call_sam_3_1_single_frame(frame, "stain", Path(tmp) / "m.png"))
            self.assertEqual(ctx.exception.status_code, 502)

    @needs_sam_parser
    def test_sam_bad_alphabet_digit_is_malformed(self):
        # '"' is one of the seven wire delimiters, never a digit.
        line = (
            "<0f>0<|box;x1=1;y1=1;x2=2;y2=2;w=10;h=10|>"
            '<|mask;x=0;y=0;data=2,2,~!!!!"!!!!|>'
        )
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(text=_sam_wire_stream(line))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            with self.assertRaises(HTTPException) as ctx:
                _run(call_sam_3_1_single_frame(frame, "stain", Path(tmp) / "m.png"))
            self.assertEqual(ctx.exception.status_code, 502)

    def test_sam_mock_png_has_documented_dimensions(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            out = Path(tmp) / "m.png"
            result = _run(call_sam_3_1_single_frame(frame, "stain", out))
            self.assertTrue(result.get("match"))
            header = out.read_bytes()
            self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", header[16:24])
            self.assertEqual((width, height), (148, 148))

    def test_missing_keys_fail_before_request(self):
        from fastapi import HTTPException

        settings.CHAT_PROVIDER = "baseten"
        settings.BASETEN_API_KEY = ""
        with self.assertRaises(HTTPException) as ctx:
            _run(call_meta_chat("sys", "hi", 0.0))
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(_FakeClient.instances, [])

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = ""
        with self.assertRaises(HTTPException) as ctx:
            _run(call_meta_chat("sys", "hi", 0.0))
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(_FakeClient.instances, [])

        settings.CHAT_PROVIDER = "baseten"  # voice/SAM stay on Meta: no fallback
        settings.BASETEN_API_KEY = "test-key"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            with self.assertRaises(HTTPException) as ctx:
                _run(call_muse_voice(audio))
            self.assertEqual(ctx.exception.status_code, 503)
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
            with self.assertRaises(HTTPException) as ctx:
                _run(call_sam_3_1_single_frame(frame, "stain", Path(tmp) / "m.png"))
            self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(_FakeClient.instances, [])

    def test_live_call_rejected_when_estimate_exceeds_budget(self):
        from fastapi import HTTPException

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.MAX_SESSION_SPEND_USD = 0.0
        settings.MAX_CUMULATIVE_SPEND_USD = 0.0
        with self.assertRaises(HTTPException) as ctx:
            _run(call_meta_chat("sys", "hello", 0.0))
        self.assertIn(ctx.exception.status_code, (402, 429))
        self.assertEqual(_FakeClient.instances, [])

    def test_live_voice_rejected_when_estimate_exceeds_budget(self):
        from fastapi import HTTPException

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.MAX_SESSION_SPEND_USD = 0.0
        settings.MAX_CUMULATIVE_SPEND_USD = 0.0
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            with self.assertRaises(HTTPException) as ctx:
                _run(call_muse_voice(audio))
        self.assertIn(ctx.exception.status_code, (402, 429))
        self.assertEqual(_FakeClient.instances, [])

    def test_retired_chat_model_is_rejected(self):
        from fastapi import HTTPException

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_CHAT_MODEL_ID = "muse-wonder-1m"
        with self.assertRaises(HTTPException):
            _run(call_meta_chat("sys", "hi", 0.0))
        self.assertEqual(_FakeClient.instances, [])

    def test_unknown_cost_never_stored_as_zero_in_ledger(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            shield = CreditShield(db_path=Path(tmp) / "test.sqlite")
            key = shield.cache_key_for(b"payload")
            shield.save_response(key, "responses", "meta-sam31", {"a": 1}, None)
            self.assertEqual(shield.get_cumulative_spend(), 0.0)
            with shield._connect() as conn:
                row = conn.execute(
                    "SELECT cost_usd FROM spend_ledger"
                ).fetchone()
            self.assertIsNone(row[0])
            # The companion reservation still counts toward the caps.
            shield.reserve("k-res", "responses", "meta-sam31", 0.02)
            self.assertAlmostEqual(shield.get_reserved_cumulative(), 0.02)
            shield.release("k-res")
            self.assertEqual(shield.get_reserved_cumulative(), 0.0)
            del shield

    def _unknown_cost_chat_setup(self):
        from services import estimate_chat_cost

        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            {
                "choices": [{"message": {"content": json.dumps({"ok": True})}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5},
            }
        )
        return estimate_chat_cost("sys", "hello-0")

    def test_unknown_cost_calls_consume_session_budget(self):
        from fastapi import HTTPException

        estimate = self._unknown_cost_chat_setup()
        settings.MAX_SESSION_SPEND_USD = estimate * 2.5
        settings.MAX_CUMULATIVE_SPEND_USD = 135.00
        _run(call_meta_chat("sys", "hello-0", 0.0))
        _run(call_meta_chat("sys", "hello-1", 0.0))
        with self.assertRaises(HTTPException) as ctx:
            _run(call_meta_chat("sys", "hello-2", 0.0))
        self.assertEqual(ctx.exception.status_code, 429)
        # Only the two affordable requests reached the provider.
        self.assertEqual(len(_FakeClient.instances), 2)
        # Both unknown actuals are stored as NULL while their estimates
        # remain reserved against the caps.
        self.assertEqual(len(self._stub.reserved), 2)
        for saved in self._stub.saved:
            self.assertIsNone(saved["cost_usd"])
            self.assertEqual(saved["data"]["usage"].get("cost_usd"), "unknown")

    def test_unknown_cost_calls_consume_cumulative_budget(self):
        from fastapi import HTTPException

        estimate = self._unknown_cost_chat_setup()
        settings.MAX_SESSION_SPEND_USD = 135.00
        settings.MAX_CUMULATIVE_SPEND_USD = estimate * 2.5
        _run(call_meta_chat("sys", "hello-0", 0.0))
        _run(call_meta_chat("sys", "hello-1", 0.0))
        with self.assertRaises(HTTPException) as ctx:
            _run(call_meta_chat("sys", "hello-2", 0.0))
        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(len(_FakeClient.instances), 2)

    def test_meta_reports_baseten_model_id(self):
        from config import BASETEN_CHAT_MODEL_REQUIRED

        settings.CHAT_PROVIDER = "baseten"
        settings.BASETEN_MODEL_ID = BASETEN_CHAT_MODEL_REQUIRED
        settings.BASETEN_BASE_URL = "https://inference.baseten.co/v1"
        settings.BASETEN_API_KEY = "test-key"
        status = main.meta_status()
        self.assertEqual(status["chat_provider"], "baseten")
        self.assertEqual(
            status["models"]["chat_default"], BASETEN_CHAT_MODEL_REQUIRED
        )
        self.assertEqual(
            status["models"]["chat_default"],
            "meta-models/muse-spark-open-1026",
        )

    def test_build_handover_pdf_per_locale(self):
        from pdf_builder import build_handover_pdf

        packs = {
            "DE": {
                "protocol_title": "Übergabeprotokoll – Müllerstraße",
                "country_name": "Deutschland",
                "official_language": "de",
                "statutes": "BGB § 551 – Kaution, Schönheitsreparaturen – café",
                "dispute_title": "Streit – naïve façade",
            },
            "UK": {
                "protocol_title": "Handover Report – café façade",
                "country_name": "United Kingdom",
                "official_language": "en",
                "statutes": "Tenant Fees Act 2019 – naïve “quoted” deposit",
                "dispute_title": "Dispute – Müller",
            },
            "FR": {
                "protocol_title": "État des lieux – café façade",
                "country_name": "France",
                "official_language": "fr",
                "statutes": "Loi n° 89-462 – vétusté, dépôt de garantie – naïve",
                "dispute_title": "Litige – Müllerstraße",
            },
            "JP": {
                "protocol_title": "Handover Report – Tōkyō café",
                "country_name": "Japan",
                "official_language": "ja",
                "statutes": "Tōkyō lease rules – naïve façade, Müller – “quoted”",
                "dispute_title": "Dispute – café",
            },
        }
        for code, pack in packs.items():
            with self.subTest(locale=code), tempfile.TemporaryDirectory(
                ignore_cleanup_errors=True
            ) as tmp:
                defects = [
                    {
                        "timestamp": "3s",
                        "sam_confidence": "unknown",
                        "area_percent": "1.5",
                        "description_local": f"Riss – Müller café {code} naïve",
                        "description_tenant": f"Crack – façade “quoted” {code}",
                        "image_path": "",
                    }
                ]
                out = build_handover_pdf(
                    pack,
                    pack["official_language"],
                    "ab" * 32,
                    defects,
                    tmp,
                    f"handover-{code}.pdf",
                )
                data = Path(out).read_bytes()
                self.assertTrue(len(data) > 0)
                self.assertTrue(data.startswith(b"%PDF-"))

    def test_known_cost_releases_reservation(self):
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            {
                "choices": [{"message": {"content": json.dumps({"ok": True})}}],
                "usage": {"cost_usd": 0.001},
            }
        )
        _run(call_meta_chat("sys", "hello", 0.0))
        self.assertEqual(self._stub.saved[0]["cost_usd"], 0.001)
        self.assertEqual(self._stub.reserved, {})


    def test_detect_input_locale_de_markers(self):
        result = services.detect_input_locale(
            "Mietvertrag: Der Mieter trägt die Kosten kleiner "
            "Instandhaltungen bis zu 150 EUR. Kaution nach BGB."
        )
        self.assertEqual(result["detected_jurisdiction"], "DE")
        self.assertEqual(result["detected_language"], "de")
        self.assertEqual(result["confidence"], "high")
        self.assertEqual(
            set(result.keys()),
            {"detected_jurisdiction", "detected_language", "confidence"},
        )

    def test_detect_input_locale_uk_markers(self):
        result = services.detect_input_locale(
            "Assured shorthold tenancy: the deposit is protected under "
            "the Tenant Fees Act 2019 in London."
        )
        self.assertEqual(result["detected_jurisdiction"], "UK")
        self.assertEqual(result["detected_language"], "en")
        self.assertEqual(result["confidence"], "high")

    def test_detect_input_locale_fr_markers(self):
        result = services.detect_input_locale(
            "Bail d'habitation à Paris: dépôt de garantie, vétusté "
            "et loyer mensuel."
        )
        self.assertEqual(result["detected_jurisdiction"], "FR")
        self.assertEqual(result["detected_language"], "fr")
        self.assertEqual(result["confidence"], "high")

    def test_detect_input_locale_jp_markers(self):
        result = services.detect_input_locale(
            "東京の賃貸契約: 敷金を支払う。原状回復について。"
        )
        self.assertEqual(result["detected_jurisdiction"], "JP")
        self.assertEqual(result["detected_language"], "ja")
        self.assertEqual(result["confidence"], "high")

    def test_detect_input_locale_global_auto_fallback(self):
        result = services.detect_input_locale("Hello, here is my lease.")
        self.assertEqual(result["detected_jurisdiction"], "GLOBAL_AUTO")
        self.assertEqual(result["detected_language"], "en")
        self.assertEqual(result["confidence"], "heuristic")

    def test_detect_input_locale_fr_loi_1989_marker(self):
        result = services.detect_input_locale(
            "Contrat de location soumis à la Loi du 6 juillet 1989."
        )
        self.assertEqual(result["detected_jurisdiction"], "FR")
        self.assertEqual(result["detected_language"], "fr")
        self.assertEqual(result["confidence"], "high")

    def test_detect_input_locale_us_ny_general_obligations_marker(self):
        result = services.detect_input_locale(
            "Security deposit held under the General Obligations Law."
        )
        self.assertEqual(result["detected_jurisdiction"], "US_NY")
        self.assertEqual(result["detected_language"], "en")
        self.assertEqual(result["confidence"], "high")

    def test_discover_visual_defects_mock_is_deterministic(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(_JPEG_BYTES)
            first = _run(services.discover_visual_defects(frame, "DE", "de"))
            second = _run(services.discover_visual_defects(frame, "DE", "de"))
        self.assertEqual(first, second)
        self.assertTrue(1 <= len(first) <= 2)
        for item in first:
            self.assertTrue(str(item["prompt"]).strip())
            self.assertIn("description_local", item)
            self.assertIn("description_tenant", item)
        self.assertEqual(_FakeClient.instances, [])

    def test_segment_image_auto_detect_fallback_on_empty_prompt(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.jpg", _JPEG_BYTES),
                        text_prompt="",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertTrue(result["mask"].get("match"))
        self.assertTrue(str(result["auto_discovered_prompt"] or "").strip())
        self.assertTrue(result["auto_descriptions"])
        self.assertEqual(
            result["auto_discovered_prompt"],
            result["auto_descriptions"][0]["prompt"],
        )
        self.assertEqual(_FakeClient.instances, [])

    def test_segment_image_blank_prompt_with_spaces_auto_detects(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                result = _run(
                    main.segment_image(
                        file=_StubUpload("photo.jpg", _JPEG_BYTES),
                        text_prompt="   ",
                    )
                )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertTrue(result["mask"].get("match"))
        self.assertTrue(str(result["auto_discovered_prompt"] or "").strip())
        self.assertEqual(_FakeClient.instances, [])

    def test_process_walkthrough_silent_video_auto_scan(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            frame = Path(tmp) / "frame.jpg"
            frame.write_bytes(_JPEG_BYTES)
            audio = Path(tmp) / "audio.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            real_extract = main.extract_1fps_and_audio
            real_voice = main.call_muse_voice
            real_sam = main.call_sam_3_1_single_frame
            real_chat = main.call_meta_chat
            real_pdf = main.build_handover_pdf
            main.extract_1fps_and_audio = lambda *a, **k: {
                "audio_path": str(audio),
                "frames": [str(frame)],
                "frame_count": 1,
                "fps": 1,
            }
            async def _no_transcript(*a, **k):
                return []
            async def _sam(*a, **k):
                return {
                    "match": True,
                    "polygon": [[1, 1], [5, 1], [3, 4]],
                    "usage": {"cost_usd": 0.0},
                    "cached": False,
                }
            async def _chat(*a, **k):
                return {"defects": []}
            main.call_muse_voice = _no_transcript  # type: ignore[assignment]
            main.call_sam_3_1_single_frame = _sam  # type: ignore[assignment]
            main.call_meta_chat = _chat  # type: ignore[assignment]
            main.build_handover_pdf = (  # type: ignore[assignment]
                lambda *a, **k: str(Path(tmp) / "handover.pdf")
            )
            Path(tmp, "handover.pdf").write_bytes(b"%PDF-1.4 fake")
            try:
                result = _run(
                    main.process_walkthrough(
                        file=_StubUpload("walk.mp4", b"fake-video"),
                        jurisdiction_code="GLOBAL_AUTO",
                        user_language="en",
                        text_prompt="",
                        max_frames=3,
                    )
                )
            finally:
                main.extract_1fps_and_audio = real_extract
                main.call_muse_voice = real_voice
                main.call_sam_3_1_single_frame = real_sam
                main.call_meta_chat = real_chat
                main.build_handover_pdf = real_pdf
                main.STORAGE_DIR = real_storage
        self.assertEqual(result["detection_mode"], "silent_vision_auto")
        self.assertTrue(str(result["auto_discovered_prompt"] or "").strip())
        self.assertEqual(result["transcript"], [])
        self.assertEqual(_FakeClient.instances, [])

    def test_process_walkthrough_voice_mode_kept(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            frame = Path(tmp) / "frame.jpg"
            frame.write_bytes(_JPEG_BYTES)
            audio = Path(tmp) / "audio.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            real_extract = main.extract_1fps_and_audio
            real_voice = main.call_muse_voice
            real_sam = main.call_sam_3_1_single_frame
            real_chat = main.call_meta_chat
            real_pdf = main.build_handover_pdf
            main.extract_1fps_and_audio = lambda *a, **k: {
                "audio_path": str(audio),
                "frames": [str(frame)],
                "frame_count": 1,
                "fps": 1,
            }
            async def _transcript(*a, **k):
                return [{"start": 0.0, "end": 1.0, "text": "crack by window"}]
            async def _sam(*a, **k):
                return {
                    "match": True,
                    "polygon": [[1, 1], [5, 1], [3, 4]],
                    "usage": {"cost_usd": 0.0},
                    "cached": False,
                }
            async def _chat(*a, **k):
                return {"defects": []}
            main.call_muse_voice = _transcript  # type: ignore[assignment]
            main.call_sam_3_1_single_frame = _sam  # type: ignore[assignment]
            main.call_meta_chat = _chat  # type: ignore[assignment]
            main.build_handover_pdf = (  # type: ignore[assignment]
                lambda *a, **k: str(Path(tmp) / "handover.pdf")
            )
            Path(tmp, "handover.pdf").write_bytes(b"%PDF-1.4 fake")
            try:
                result = _run(
                    main.process_walkthrough(
                        file=_StubUpload("walk.mp4", b"fake-video"),
                        jurisdiction_code="DE",
                        user_language="en",
                        text_prompt="crack",
                        max_frames=3,
                    )
                )
            finally:
                main.extract_1fps_and_audio = real_extract
                main.call_muse_voice = real_voice
                main.call_sam_3_1_single_frame = real_sam
                main.call_meta_chat = real_chat
                main.build_handover_pdf = real_pdf
                main.STORAGE_DIR = real_storage
        self.assertEqual(result["detection_mode"], "voice_and_vision")
        self.assertEqual(_FakeClient.instances, [])

    def test_narration_defect_phrases_spot_negate_and_order(self):
        spot = services.narration_defect_phrases
        self.assertEqual(spot("Several burn marks on the table."), ["burn mark"])
        self.assertEqual(
            spot("Here is a dent in the wooden door frame."), ["chipped wood"]
        )
        self.assertEqual(
            spot("The open socket next to the skirting board."),
            ["open electrical socket"],
        )
        self.assertEqual(
            spot("A stain on the carpet and later a crack in the wall."),
            ["water stain", "wall crack"],
        )
        # Negated mentions and clean-condition narration yield nothing.
        self.assertEqual(spot("No cracks and no mold anywhere."), [])
        self.assertEqual(spot("Walls and ceiling in good condition."), [])
        # At most two phrases, in the order the defects are spoken.
        self.assertEqual(
            spot("burn, stain and crack everywhere"),
            ["burn mark", "water stain"],
        )
        self.assertEqual(spot(""), [])

    def test_narration_phrases_align_to_sampled_frames(self):
        transcript = [
            {"start": 0.0, "end": 5.0, "text": "several burn marks on the table"},
            {"start": 10.0, "end": 14.0, "text": "a dent in the door frame"},
        ]
        per_frame = main._narration_phrases_by_frame(transcript, [0, 7, 13])
        self.assertEqual(per_frame, [["burn mark"], [], ["chipped wood"]])
        # A segment between sampled frames attaches to the nearest one.
        late = [{"start": 20.0, "end": 22.0, "text": "a crack in the wall"}]
        per_frame = main._narration_phrases_by_frame(late, [0, 7, 13])
        self.assertEqual(per_frame, [[], [], ["wall crack"]])
        self.assertEqual(main._narration_phrases_by_frame([], [0, 7]), [[], []])

    def test_process_walkthrough_narration_guides_sam(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            frame = Path(tmp) / "frame.jpg"
            frame.write_bytes(_JPEG_BYTES)
            audio = Path(tmp) / "audio.wav"
            audio.write_bytes(b"RIFF" + b"\x00" * 100)
            real_extract = main.extract_1fps_and_audio
            real_voice = main.call_muse_voice
            real_sam = main.call_sam_3_1_single_frame
            real_chat = main.call_meta_chat
            real_pdf = main.build_handover_pdf
            main.extract_1fps_and_audio = lambda *a, **k: {
                "audio_path": str(audio),
                "frames": [str(frame)],
                "frame_count": 1,
                "fps": 1,
            }
            async def _transcript(*a, **k):
                return [
                    {
                        "start": 0.0,
                        "end": 1.0,
                        "text": "there are several burn marks on the table",
                    }
                ]
            sam_phrases: list[str] = []
            async def _sam(path, phrase, out, **k):
                sam_phrases.append(phrase)
                return {
                    "match": True,
                    "polygon": [[1, 1], [5, 1], [3, 4]],
                    "usage": {"cost_usd": 0.0},
                    "cached": False,
                }
            async def _chat(*a, **k):
                return {"defects": []}
            main.call_muse_voice = _transcript  # type: ignore[assignment]
            main.call_sam_3_1_single_frame = _sam  # type: ignore[assignment]
            main.call_meta_chat = _chat  # type: ignore[assignment]
            main.build_handover_pdf = (  # type: ignore[assignment]
                lambda *a, **k: str(Path(tmp) / "handover.pdf")
            )
            Path(tmp, "handover.pdf").write_bytes(b"%PDF-1.4 fake")
            try:
                result = _run(
                    main.process_walkthrough(
                        file=_StubUpload("walk.mp4", b"fake-video"),
                        jurisdiction_code="DE",
                        user_language="en",
                        text_prompt="",
                        max_frames=3,
                    )
                )
            finally:
                main.extract_1fps_and_audio = real_extract
                main.call_muse_voice = real_voice
                main.call_sam_3_1_single_frame = real_sam
                main.call_meta_chat = real_chat
                main.build_handover_pdf = real_pdf
                main.STORAGE_DIR = real_storage
        self.assertEqual(result["detection_mode"], "voice_and_vision")
        self.assertEqual(result["narration_prompts"], ["burn mark"])
        # The narration phrase is the FIRST concept SAM is asked about.
        self.assertEqual(sam_phrases[0], "burn mark")
        self.assertEqual(_FakeClient.instances, [])

    def test_decode_contract_rejects_non_pdf_upload(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = "MOCK_FREE_TEST"
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with self.assertRaises(HTTPException) as ctx:
                    _run(
                        main.decode_contract(
                            file=_StubUpload(
                                "lease.pdf", b"definitely not a pdf"
                            ),
                            jurisdiction_code="DE",
                        )
                    )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertEqual(ctx.exception.status_code, 400)

    def test_decode_contract_rejects_oversized_pdf(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = "MOCK_FREE_TEST"
        oversized = b"%PDF-" + b"\x00" * (25 * 1024 * 1024)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with self.assertRaises(HTTPException) as ctx:
                    _run(
                        main.decode_contract(
                            file=_StubUpload("lease.pdf", oversized),
                            jurisdiction_code="DE",
                        )
                    )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertEqual(ctx.exception.status_code, 400)

    def test_segment_image_rejects_non_image_upload(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = "MOCK_FREE_TEST"
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with self.assertRaises(HTTPException) as ctx:
                    _run(
                        main.segment_image(
                            file=_StubUpload(
                                "photo.jpg", b"this is not an image"
                            ),
                            text_prompt="stain",
                        )
                    )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertEqual(ctx.exception.status_code, 400)

    def test_verify_moveout_rejects_non_image_upload(self):
        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = "MOCK_FREE_TEST"
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with self.assertRaises(HTTPException) as ctx:
                    _run(
                        main.verify_moveout(
                            file=_StubUpload(
                                "photo.png", b"this is not an image"
                            ),
                            prior_polygon=json.dumps(
                                [[0, 0], [10, 0], [10, 10]]
                            ),
                            text_prompt="stain",
                        )
                    )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertEqual(ctx.exception.status_code, 400)


    # ------------------------------------------------------------------
    # HTTP route tests (TestClient) and the 2026-11-02 reliability round:
    # decode page previews, SAM no-match cache policy, mock raster masks,
    # contract highlight helper, narration hazard order, mobile handoff.
    # ------------------------------------------------------------------

    def test_decode_contract_http_returns_verified_findings_and_previews(self):
        from fastapi.testclient import TestClient

        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        sentence = (
            "The tenant shall pay a security deposit of EUR 900 upon signing."
        )
        pdf_bytes = _build_pdf_bytes(
            [
                [
                    "RENTAL AGREEMENT",
                    "Section 4.2 Security Deposit.",
                    sentence,
                    "The deposit will be returned within 14 days "
                    "after moving out.",
                    "Clause 7.1 Pets are not allowed without written consent.",
                    "This agreement is made between the landlord "
                    "and the tenant.",
                ]
            ]
        )
        reported = {
            "summary": "Strict deposit terms.",
            "possible_issues": [_lease_issue()],
            "confidence": "high",
        }

        async def fake_chat(*args, **kwargs):
            return reported

        real_chat, real_jurisdiction = main.call_meta_chat, main.get_jurisdiction
        main.call_meta_chat = fake_chat
        main.get_jurisdiction = lambda code: {"statutes": _STATUTE_TEXT}
        contracts_root = (
            Path(services.__file__).resolve().parent / "storage" / "contracts"
        )
        before = (
            {p.name for p in contracts_root.iterdir()}
            if contracts_root.is_dir()
            else set()
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with TestClient(main.app) as client:
                    response = client.post(
                        "/api/decode-contract",
                        files={
                            "file": ("lease.pdf", pdf_bytes, "application/pdf")
                        },
                        data={"jurisdiction_code": "DE"},
                    )
            finally:
                main.STORAGE_DIR = real_storage
                main.call_meta_chat = real_chat
                main.get_jurisdiction = real_jurisdiction
                # Page renders land under the real backend/storage/
                # contracts/ (services-relative), not the swapped
                # STORAGE_DIR: remove the job dir this call created.
                if contracts_root.is_dir():
                    for child in contracts_root.iterdir():
                        if child.name not in before:
                            shutil.rmtree(child, ignore_errors=True)
        self.assertEqual(response.status_code, 200, response.text[:400])
        body = response.json()
        self.assertEqual(body["extraction"], "embedded-text")
        issues = body["analysis"]["possible_issues"]
        self.assertEqual(len(issues), 1)
        self.assertTrue(issues[0]["verified_quote"])
        self.assertEqual(issues[0]["citation"], "BGB Section 551")
        previews = body["page_previews"]
        self.assertIsInstance(previews, list)
        if shutil.which("pdftoppm"):
            self.assertGreaterEqual(len(previews), 1)
            for entry in previews:
                self.assertTrue(
                    entry["image_url"].startswith("/files/contracts/")
                )
            first = next(p for p in previews if p["page_number"] == 1)
            self.assertTrue(
                any(h.get("located") for h in first["highlights"])
            )
        self.assertEqual(_FakeClient.instances, [])

    @needs_sam_parser
    def test_sam_no_match_cache_entry_is_not_served_permanently(self):
        # A match=False record sitting in api_cache under the exact
        # payload key must not become a permanent hit: the function has
        # to make the live call and return the fresh match instead.
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        _FakeClient.response = _FakeResponse(
            text=_sam_wire_stream(SAM_DOCUMENTED_LINE)
        )
        image_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 100
        payload_bytes = _sam_payload_bytes("stain", image_bytes)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            shield = CreditShield(Path(tmp) / "shield.sqlite")
            shield.save_response(
                shield.cache_key_for(payload_bytes),
                services.SAM31_ENDPOINT,
                "meta-sam31",
                {
                    "match": False,
                    "model": SAM31_MODEL,
                    "prompt": {"mode": "concept", "text": "stain"},
                },
                0.0,
            )
            seeded = shield.fetch_or_record(
                payload_bytes, services.SAM31_ENDPOINT
            )
            self.assertIsInstance(seeded, dict)
            self.assertFalse(seeded.get("match"))
            services.credit_shield = shield
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(image_bytes)
            result = _run(
                call_sam_3_1_single_frame(frame, "stain", Path(tmp) / "m.png")
            )
        self.assertTrue(result.get("match"))
        self.assertFalse(result.get("cached"))
        self.assertEqual(
            result["box"],
            {"left": 211, "top": 228, "right": 271, "bottom": 255},
        )

    @needs_sam_parser
    def test_sam_no_match_records_spend_without_caching(self):
        # A live no-match call still records its cost in the spend
        # ledger (fallback tariff), but no api_cache row may survive:
        # a later fetch of the same payload must come back empty.
        settings.CHAT_PROVIDER = "meta"
        settings.META_API_KEY = "test-key"
        settings.META_API_BASE_URL = "https://api.meta.ai/v1"
        _FakeClient.forbid_network = False
        lane = {"item_id": "item_1", "output_index": 0, "content_index": 0}
        _FakeClient.response = _FakeResponse(
            text=_sse(
                {"type": "response.output_text.done", "text": "", **lane},
                {"type": "response.completed", "usage": {"input_tokens": 0}},
            )
        )
        image_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 100
        payload_bytes = _sam_payload_bytes("stain", image_bytes)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            shield = CreditShield(Path(tmp) / "shield.sqlite")
            services.credit_shield = shield
            frame = Path(tmp) / "f.jpg"
            frame.write_bytes(image_bytes)
            result = _run(
                call_sam_3_1_single_frame(frame, "stain", Path(tmp) / "m.png")
            )
            self.assertFalse(result.get("match"))
            self.assertAlmostEqual(shield.get_cumulative_spend(), 0.02, places=6)
            self.assertGreater(shield.get_session_spend(), 0.0)
            self.assertIsNone(
                shield.fetch_or_record(payload_bytes, services.SAM31_ENDPOINT)
            )

    def test_segment_image_http_mock_returns_raster_metadata(self):
        # The reference-saving contract: in mock mode the segment
        # endpoint must return the same raster metadata as live mode
        # (box, mask_dims equal to the box crop, mask_url, overlay).
        from fastapi.testclient import TestClient
        from PIL import Image

        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        buffer = io.BytesIO()
        Image.new("RGB", (800, 600), (196, 178, 158)).save(buffer, "JPEG")
        jpeg_bytes = buffer.getvalue()
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with TestClient(main.app) as client:
                    response = client.post(
                        "/api/segment-image",
                        files={
                            "file": ("photo.jpg", jpeg_bytes, "image/jpeg")
                        },
                        data={"text_prompt": "stain"},
                    )
            finally:
                main.STORAGE_DIR = real_storage
        self.assertEqual(response.status_code, 200, response.text[:400])
        body = response.json()
        mask = body["mask"]
        self.assertTrue(mask.get("match"))
        box = mask["box"]
        self.assertGreater(box["left"], 0)
        self.assertGreater(box["top"], 0)
        self.assertLess(box["right"], 800)
        self.assertLess(box["bottom"], 600)
        self.assertEqual(
            mask["mask_dims"],
            {
                "width": box["right"] - box["left"],
                "height": box["bottom"] - box["top"],
            },
        )
        self.assertTrue(body["mask_url"])
        self.assertTrue(mask.get("overlay_path"))

    @unittest.skipUnless(shutil.which("pdftoppm"), "pdftoppm is not installed")
    def test_render_contract_page_highlights_pdf_locates_quote(self):
        sentence = (
            "The tenant shall pay a security deposit of EUR 900 upon signing."
        )
        job_id = "test-highlights-pdf"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            pdf_path = Path(tmp) / "lease.pdf"
            pdf_path.write_bytes(
                _build_pdf_bytes(
                    [
                        [
                            "RENTAL AGREEMENT",
                            "Section 4.2 Security Deposit.",
                            sentence,
                            "The deposit will be returned within 14 days "
                            "after moving out.",
                        ],
                        ["Clause 9. Final provisions of this agreement."],
                    ]
                )
            )
            try:
                previews = services.render_contract_page_highlights(
                    pdf_path,
                    [
                        {
                            "clause": "Deposit terms",
                            "severity": "high",
                            "evidence_quote": sentence,
                        }
                    ],
                    job_id,
                )
                self.assertTrue(previews)
                self.assertEqual(previews[0]["page_number"], 1)
                self.assertTrue((contracts_dir / "page_1.png").is_file())
                located = [
                    h for h in previews[0]["highlights"] if h.get("located")
                ]
                self.assertTrue(located)
                x, y, w, h = located[0]["box_pct"]
                for value in (x, y, w, h):
                    self.assertGreaterEqual(value, 0)
                    self.assertLessEqual(value, 100)
                self.assertLessEqual(y + h, 100)
            finally:
                shutil.rmtree(contracts_dir, ignore_errors=True)

    def test_render_contract_page_highlights_photo_falls_back_unlocated(self):
        from PIL import Image

        job_id = "test-highlights-photo"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            photo = Path(tmp) / "scan.png"
            Image.new("RGB", (400, 300), (240, 238, 230)).save(photo, "PNG")
            try:
                previews = services.render_contract_page_highlights(
                    photo,
                    [
                        {
                            "clause": "Deposit terms",
                            "severity": "high",
                            "evidence_quote": (
                                "The tenant shall pay a security deposit "
                                "of EUR 900 upon signing."
                            ),
                        }
                    ],
                    job_id,
                )
                self.assertEqual(len(previews), 1)
                self.assertEqual(previews[0]["page_number"], 1)
                self.assertTrue((contracts_dir / "page_1.png").is_file())
                self.assertEqual(len(previews[0]["highlights"]), 1)
                self.assertFalse(previews[0]["highlights"][0]["located"])
            finally:
                shutil.rmtree(contracts_dir, ignore_errors=True)

    def test_render_contract_page_highlights_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                services.render_contract_page_highlights(
                    Path(tmp) / "missing.pdf",
                    [
                        {
                            "clause": "Deposit terms",
                            "severity": "low",
                            "evidence_quote": "anything at all",
                        }
                    ],
                    "test-highlights-missing",
                ),
                [],
            )

    @unittest.skipUnless(shutil.which("pdftoppm"), "pdftoppm is not installed")
    def test_render_contract_page_highlights_multiline_quote_page_two_located(self):
        from fpdf import FPDF

        sentence = (
            "The tenant shall reimburse the landlord for any damage "
            "caused by improper use of the furnished room and its "
            "fittings beyond ordinary wear and tear."
        )
        job_id = "test-highlights-page2"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        start_y_mm = 100.0
        pdf = FPDF()
        pdf.set_margins(20, 20, 20)
        pdf.set_auto_page_break(False)
        pdf.add_page()
        pdf.set_font("helvetica", size=11)
        pdf.multi_cell(
            0, 6, "Page one holds an unrelated clause.",
            new_x="LMARGIN", new_y="NEXT",
        )
        pdf.add_page()
        pdf.set_y(start_y_mm)
        pdf.set_font("helvetica", size=11)
        # 170 mm of text width at 11 pt wraps this sentence over 2 lines.
        pdf.multi_cell(0, 6, sentence, new_x="LMARGIN", new_y="NEXT")
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            pdf_path = Path(tmp) / "two-page.pdf"
            pdf_path.write_bytes(bytes(pdf.output()))
            try:
                previews = services.render_contract_page_highlights(
                    pdf_path,
                    [
                        {
                            "clause": "Damage liability",
                            "severity": "high",
                            "evidence_quote": sentence,
                        }
                    ],
                    job_id,
                )
                page_two = [p for p in previews if p["page_number"] == 2]
                self.assertTrue(page_two)
                self.assertTrue((contracts_dir / "page_2.png").is_file())
                located = [
                    h for h in page_two[0]["highlights"] if h.get("located")
                ]
                self.assertTrue(located)
                _x, y, _w, _h = located[0]["box_pct"]
                expected_top = start_y_mm / 297.0 * 100.0
                self.assertAlmostEqual(y, expected_top, delta=3.0)
            finally:
                shutil.rmtree(contracts_dir, ignore_errors=True)

    @unittest.skipUnless(shutil.which("pdftoppm"), "pdftoppm is not installed")
    def test_render_contract_page_highlights_planted_dorm_all_located(self):
        from pypdf import PdfReader

        pdf_path = (
            Path(services.__file__).resolve().parent
            / "demo-assets" / "dorm-vertrag-planted.pdf"
        )
        self.assertTrue(pdf_path.is_file())
        lines = []
        reader = PdfReader(str(pdf_path))
        for page in reader.pages:
            lines.extend((page.extract_text() or "").splitlines())
        issues = []
        for marker in ["950,00", "175", "250", "20:00", "Schönheitsreparaturen"]:
            quote = next(
                (
                    line.strip()
                    for line in lines
                    if marker in line and len(line.strip()) >= 20
                ),
                None,
            )
            self.assertIsNotNone(quote, marker)
            issues.append(
                {"clause": marker, "severity": "high", "evidence_quote": quote}
            )
        job_id = "test-highlights-dorm"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        try:
            previews = services.render_contract_page_highlights(
                pdf_path, issues, job_id
            )
            found = [h for p in previews for h in p["highlights"]]
            self.assertEqual(len(found), 5)
            for highlight in found:
                self.assertTrue(
                    highlight["located"], highlight["evidence_quote"]
                )
        finally:
            shutil.rmtree(contracts_dir, ignore_errors=True)

    @unittest.skipUnless(shutil.which("pdftoppm"), "pdftoppm is not installed")
    def test_render_contract_page_highlights_planted_dorm_all_eleven_located(self):
        # Eleven real clause sentences from the planted dorm
        # contract, spanning pages 1-3 (Kaution, rent composition,
        # SEPA mandate, term, use, no-side-agreement, written form,
        # petty repairs, guest ban, cleaning fee, cosmetic repairs).
        # With glyph-precise coordinates every one must resolve to
        # located=True — zero fallback estimation bands.
        pdf_path = (
            Path(services.__file__).resolve().parent
            / "demo-assets" / "dorm-vertrag-planted.pdf"
        )
        self.assertTrue(pdf_path.is_file())
        quotes = [
            "Die vor dem Einzug zu zahlende Kaution beträgt 950,00 EUR.",
            "(1) In der Gesamtpauschalmiete sind enthalten: "
            "wohnwertorientierter Mietanteil 178,47 EUR; pauschale "
            "Umlage, inkl. Strom (siehe § 3 AMB) 78,91 EUR.",
            "(3) Die Mietzahlung erfolgt monatlich im Voraus bis zum "
            "7. des laufenden Monats aufgrund eines dem Vermieter zu "
            "erteilenden, für die Dauer des Mietverhältnisses "
            "unwiderruflichen SEPA-Lastschriftmandats.",
            "(1) Der Vermieter vermietet dem Mieter ab: 16.09.2026 "
            "folgende Mietsache, befristet bis zum: 30.09.2028, im "
            "Studentenwohnheim: Musterweg 12, Zimmer-/WE-Nr.: A101",
            "Die Mietsache wird für Wohnzwecke im Zusammenhang mit "
            "dem Studium vermietet.",
            "Zu diesem Mietvertrag existiert keine Zusatzvereinbarung.",
            "Änderungen und Ergänzungen dieses Mietvertrages bedürfen "
            "der Schrift- bzw. Textform.",
            "Der Mieter trägt die Kosten kleiner Instandhaltungen an "
            "den ihm zugänglichen Teilen der Mietsache bis zu 175 EUR "
            "je Einzelfall selbst.",
            "Übernachtungsbesuche sind dem Mieter untersagt. Besucher "
            "haben das Wohnheim bis spätestens 20:00 Uhr zu verlassen.",
            "(5) Bei Auszug wird eine pauschale Endreinigungsgebühr "
            "von 250 EUR von der Kaution einbehalten.",
            "(1) Der Mieter hat Schönheitsreparaturen auf seine "
            "Kosten spätestens alle 3 Jahre in Küche und Bad, alle 5 "
            "Jahre in den Wohnräumen und alle 7 Jahre in den "
            "Nebenräumen auszuführen, und zwar unabhängig vom "
            "tatsächlichen Zustand der Mietsache und unabhängig "
            "davon, ob die Räume bei Mietbeginn renoviert übergeben "
            "wurden.",
        ]
        issues = [
            {"clause": f"clause-{index}", "severity": "high",
             "evidence_quote": quote}
            for index, quote in enumerate(quotes)
        ]
        job_id = "test-highlights-dorm-eleven"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        try:
            previews = services.render_contract_page_highlights(
                pdf_path, issues, job_id
            )
            found = [h for p in previews for h in p["highlights"]]
            self.assertEqual(len(found), 11)
            for highlight in found:
                self.assertTrue(
                    highlight["located"], highlight["evidence_quote"]
                )
            pages = {
                p["page_number"] for p in previews if p["highlights"]
            }
            self.assertEqual(pages, {1, 2, 3})
        finally:
            shutil.rmtree(contracts_dir, ignore_errors=True)

    @unittest.skipUnless(shutil.which("pdftoppm"), "pdftoppm is not installed")
    def test_render_contract_page_highlights_kaution_box_is_glyph_precise(self):
        # The § 3 Kaution quote ends mid-line — the PDF line runs on
        # with "(§§ 4 u. 11 Abs. 5 der …". The old fragment-union box
        # swallowed the whole fragment (width ≈ 85.5%); the
        # glyph-precise box must end at the quote's last character
        # and start at the left margin (10%).
        pdf_path = (
            Path(services.__file__).resolve().parent
            / "demo-assets" / "dorm-vertrag-planted.pdf"
        )
        self.assertTrue(pdf_path.is_file())
        job_id = "test-highlights-kaution-precision"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        try:
            previews = services.render_contract_page_highlights(
                pdf_path,
                [
                    {
                        "clause": "Deposit terms",
                        "severity": "high",
                        "evidence_quote": (
                            "Die vor dem Einzug zu zahlende Kaution "
                            "beträgt 950,00 EUR."
                        ),
                    }
                ],
                job_id,
            )
            found = [h for p in previews for h in p["highlights"]]
            self.assertEqual(len(found), 1)
            highlight = found[0]
            self.assertTrue(highlight["located"])
            x, _y, w, _h = highlight["box_pct"]
            self.assertAlmostEqual(x, 10.0, delta=1.5)
            self.assertLess(w, 75.0)
        finally:
            shutil.rmtree(contracts_dir, ignore_errors=True)

    @unittest.skipUnless(shutil.which("pdftoppm"), "pdftoppm is not installed")
    def test_render_contract_page_highlights_anchors_multi_fragment_line(self):
        # Hand-written content stream: three fragments share one
        # baseline. "Alpha " starts at tm x=100; "Beta" is repositioned
        # to tm x=300 — a gap that accumulating glyph advances from
        # x=100 could never reproduce (it would end the quote near
        # x=159, i.e. ~25.9% of the 612pt page); "Gamma" follows at
        # tm x=320, closer than "Beta"'s summed advances reach
        # (300 + ~24.7pt), so the span's end must clamp to Gamma's
        # true tm[4] instead of overshooting into the gap.
        content = (
            b"BT /F1 12 Tf 1 0 0 1 100 700 Tm (Alpha ) Tj ET\n"
            b"BT /F1 12 Tf 1 0 0 1 300 700 Tm (Beta) Tj ET\n"
            b"BT /F1 12 Tf 1 0 0 1 320 700 Tm (Gamma) Tj ET\n"
            b"BT /F1 12 Tf 1 0 0 1 100 650 Tm "
            b"(Delta epsilon zeta eta theta iota kappa lambda mu nu) Tj ET\n"
        )
        job_id = "test-highlights-tj-anchor"
        contracts_dir = (
            Path(services.__file__).resolve().parent
            / "storage" / "contracts" / job_id
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            pdf_path = Path(tmp) / "fragments.pdf"
            pdf_path.write_bytes(_raw_pdf_bytes(content))
            try:
                previews = services.render_contract_page_highlights(
                    pdf_path,
                    [
                        {
                            "clause": "Fragment span",
                            "severity": "high",
                            "evidence_quote": "Alpha Beta",
                        }
                    ],
                    job_id,
                )
                found = [h for p in previews for h in p["highlights"]]
                self.assertEqual(len(found), 1)
                self.assertTrue(found[0]["located"])
                x, _y, w, _h = found[0]["box_pct"]
                # Start anchored at fragment 1's tm[4] = 100pt.
                self.assertAlmostEqual(x, 100 / 612 * 100, delta=0.6)
                # End anchored in fragment 2 (tm[4] = 300) and clamped
                # to fragment 3's tm[4] = 320pt: not the unclamped
                # 324.7pt (~53.0%), and nowhere near the drifted
                # accumulation endpoint (~25.9%).
                self.assertAlmostEqual(x + w, 320 / 612 * 100, delta=0.5)
                self.assertGreater(x + w, 45.0)
            finally:
                shutil.rmtree(contracts_dir, ignore_errors=True)

    def test_statutory_deposit_math_berlin_within_cap(self):
        # Canonical Berlin sample: EUR 650 cold rent, EUR 1,950 deposit
        # sits exactly AT the § 551 BGB cap — never over it.
        text = (
            "2. Miete: Monatliche Kaltmiete 650 EUR, "
            "Betriebskostenvorauszahlung 120 EUR.\n"
            "3. Kaution: 1.950 EUR (3 x 650 EUR Kaltmiete), "
            "zahlbar vor Einzug."
        )
        result = services.compute_statutory_deposit_math(text, "DE")
        self.assertIsNotNone(result)
        self.assertEqual(result["currency"], "EUR")
        self.assertEqual(result["base_rent"], 650.0)
        self.assertEqual(result["stated_deposit"], 1950.0)
        self.assertEqual(result["statutory_cap"], 1950.0)
        self.assertEqual(result["excess_amount"], 0.0)
        self.assertTrue(result["within_cap"])
        self.assertEqual(result["statute"], "§ 551 BGB")

    def test_statutory_deposit_math_dorm_over_cap(self):
        # Planted dorm contract: EUR 178.47 cold-rent share (inside a
        # Gesamtpauschalmiete, which must NOT be read as the cold rent)
        # against a EUR 950.00 deposit — EUR 414.59 over the cap.
        text = (
            "§ 4 Miete, Zahlung\n"
            "(1) In der Gesamtpauschalmiete sind enthalten: "
            "wohnwertorientierter Mietanteil 178,47 EUR; "
            "pauschale Umlage, inkl. Strom 78,91 EUR.\n"
            "§ 3 Kaution\n"
            "Die  vor  dem  Einzug  zu  zahlende  Kaution  "
            "beträgt  950,00  EUR."
        )
        result = services.compute_statutory_deposit_math(text, "DE")
        self.assertIsNotNone(result)
        self.assertEqual(result["base_rent"], 178.47)
        self.assertEqual(result["stated_deposit"], 950.0)
        self.assertEqual(result["statutory_cap"], 535.41)
        self.assertEqual(result["excess_amount"], 414.59)
        self.assertFalse(result["within_cap"])

    def test_statutory_deposit_math_returns_none_without_figures(self):
        self.assertIsNone(
            services.compute_statutory_deposit_math(
                "This agreement is made between the landlord and the "
                "tenant for a furnished room.",
                "DE",
            )
        )
        berlin = (
            "Monatliche Kaltmiete 650 EUR. Kaution: 1.950 EUR."
        )
        # Figures alone are not enough: unsupported jurisdictions and
        # the auto-detect code never produce a scorecard.
        self.assertIsNone(
            services.compute_statutory_deposit_math(berlin, "GLOBAL_AUTO")
        )
        self.assertIsNone(
            services.compute_statutory_deposit_math(berlin, "JP")
        )

    def test_narration_defect_phrases_prioritise_socket_hazard(self):
        # Mention order is preserved for ordinary defects, but an
        # electrical/socket hazard leads the frame's SAM attempts even
        # when the tenant names it after a cosmetic defect.
        self.assertEqual(
            services.narration_defect_phrases(
                "A crack in the wall and an open socket by the skirting."
            ),
            ["open electrical socket", "wall crack"],
        )

    def test_mobile_handoff_http_roundtrip(self):
        from fastapi.testclient import TestClient
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (64, 48), (180, 60, 40)).save(buffer, "JPEG")
        jpeg_bytes = buffer.getvalue()
        session = "test-session-abc"
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with TestClient(main.app) as client:
                    info = client.get("/api/network-info")
                    self.assertEqual(info.status_code, 200)
                    self.assertIn("ip", info.json())
                    self.assertIn("evidence_url", info.json())

                    empty = client.get("/api/mobile-handoff/unknown-session")
                    self.assertEqual(empty.status_code, 200)
                    self.assertEqual(empty.json(), {"available": False})

                    bad = client.post(
                        "/api/mobile-handoff/bad..id",
                        files={
                            "file": ("photo.jpg", jpeg_bytes, "image/jpeg")
                        },
                    )
                    self.assertEqual(bad.status_code, 400)

                    posted = client.post(
                        f"/api/mobile-handoff/{session}",
                        files={
                            "file": ("photo.jpg", jpeg_bytes, "image/jpeg")
                        },
                    )
                    self.assertEqual(posted.status_code, 200, posted.text[:300])
                    posted_body = posted.json()
                    self.assertTrue(posted_body["available"])
                    self.assertTrue(
                        posted_body["file_url"].startswith(
                            f"/files/mobile-handoff/{session}/"
                        )
                    )

                    polled = client.get(f"/api/mobile-handoff/{session}")
                    self.assertEqual(polled.status_code, 200)
                    self.assertTrue(polled.json()["available"])
            finally:
                main.STORAGE_DIR = real_storage
                main._MOBILE_HANDOFFS.pop(session, None)

    # ------------------------------------------------------------------
    # 2026-11-02 round 2: merged-segment narration distribution, decode
    # stabiliser + deposit math, Master Case Dossier export, LAN
    # candidate ranking.
    # ------------------------------------------------------------------

    def test_narration_merged_segment_distributes_phrases_across_frames(self):
        # One merged 12-second ASR segment naming three defects: with
        # max_phrases=4 the extractor yields all three in mention
        # order, and the alignment distributes them across the covered
        # frames (first mention -> first frame, last -> last) instead
        # of every phrase landing on every frame.
        text = (
            "There is an open socket by the skirting, a dent in the "
            "door frame, and a burn mark on the table."
        )
        self.assertEqual(
            services.narration_defect_phrases(text, max_phrases=4),
            ["open electrical socket", "chipped wood", "burn mark"],
        )
        transcript = [{"start": 0.0, "end": 12.0, "text": text}]
        per_frame = main._narration_phrases_by_frame(transcript, [0, 5, 10])
        self.assertEqual(
            per_frame,
            [["open electrical socket"], ["chipped wood"], ["burn mark"]],
        )

    def test_decode_sorts_dedupes_and_includes_deposit_math(self):
        from fastapi.testclient import TestClient

        settings.CHAT_PROVIDER = "mock"
        settings.META_API_KEY = ""
        deposit_quote = "Die Kaution beträgt 950,00 EUR."
        repairs_quote = (
            "Kleinreparaturen traegt der Mieter bis 175,00 EUR je Fall."
        )
        pdf_bytes = _build_pdf_bytes(
            [
                [
                    "MIETVERTRAG",
                    "Wohnwertorientierter Mietanteil: 178,47 EUR.",
                    deposit_quote,
                    "Der Mieter zahlt eine Renovierungspauschale "
                    "von 250,00 EUR.",
                    repairs_quote,
                    "Die Wohnung befindet sich in der Musterstrasse 12 "
                    "in Musterstadt.",
                    "Dieser Vertrag wird zwischen Vermieter und Mieter "
                    "geschlossen.",
                ]
            ]
        )
        reported = {
            "summary": "Dorm lease with an over-cap deposit.",
            "possible_issues": [
                _lease_issue(
                    clause="Landlord entry",
                    severity="medium",
                    evidence_quote=(
                        "The landlord may enter the flat at any time "
                        "without notice."
                    ),
                    citation=None,
                ),
                _lease_issue(
                    clause="Kleinreparaturen",
                    severity="low",
                    evidence_quote=repairs_quote,
                    citation=None,
                ),
                _lease_issue(
                    clause="Kaution (deposit)",
                    severity="high",
                    evidence_quote=deposit_quote,
                    citation=None,
                    flagged_amount=950.0,
                ),
                _lease_issue(
                    clause="Duplicate deposit clause",
                    severity="high",
                    evidence_quote=deposit_quote,
                    citation=None,
                    flagged_amount=950.0,
                ),
            ],
            "confidence": "high",
        }

        async def fake_chat(*args, **kwargs):
            return reported

        real_chat, real_jurisdiction = main.call_meta_chat, main.get_jurisdiction
        main.call_meta_chat = fake_chat
        main.get_jurisdiction = lambda code: {"statutes": _STATUTE_TEXT}
        contracts_root = (
            Path(services.__file__).resolve().parent / "storage" / "contracts"
        )
        before = (
            {p.name for p in contracts_root.iterdir()}
            if contracts_root.is_dir()
            else set()
        )
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with TestClient(main.app) as client:
                    response = client.post(
                        "/api/decode-contract",
                        files={
                            "file": ("lease.pdf", pdf_bytes, "application/pdf")
                        },
                        data={"jurisdiction_code": "DE"},
                    )
            finally:
                main.STORAGE_DIR = real_storage
                main.call_meta_chat = real_chat
                main.get_jurisdiction = real_jurisdiction
                if contracts_root.is_dir():
                    for child in contracts_root.iterdir():
                        if child.name not in before:
                            shutil.rmtree(child, ignore_errors=True)
        self.assertEqual(response.status_code, 200, response.text[:400])
        body = response.json()
        deposit_math = body["analysis"]["deposit_math"]
        self.assertIsNotNone(deposit_math)
        self.assertEqual(deposit_math["statutory_cap"], 535.41)
        self.assertEqual(deposit_math["excess_amount"], 414.59)
        self.assertFalse(deposit_math["within_cap"])
        issues = body["analysis"]["possible_issues"]
        # The duplicate quote collapsed; order is verified-high,
        # verified-low, then the unverified finding.
        self.assertEqual(
            [issue["clause"] for issue in issues],
            ["Kaution (deposit)", "Kleinreparaturen", "Landlord entry"],
        )
        self.assertEqual(body["issue_count"], 3)
        self.assertTrue(issues[0]["verified_quote"])
        self.assertTrue(issues[1]["verified_quote"])
        self.assertFalse(issues[2]["verified_quote"])
        self.assertEqual(_FakeClient.instances, [])

    def test_export_case_dossier_pdf_and_hash(self):
        from fastapi.testclient import TestClient

        payload = {
            "contract": {
                "jurisdiction_code": "DE",
                "detected_locale": "DE - de (high)",
                "issue_count": 1,
                "high_severity_count": 1,
                "deposit_math": {
                    "currency": "EUR",
                    "base_rent": 178.47,
                    "stated_deposit": 950.0,
                    "statutory_cap": 535.41,
                    "excess_amount": 414.59,
                    "within_cap": False,
                    "statute": "§ 551 BGB",
                    "formula_note": "3 x monthly cold rent",
                },
                "issues": [
                    {
                        "clause": "Section 3 Kaution",
                        "severity": "high",
                        "evidence_quote": "Die Kaution beträgt 950,00 EUR.",
                        "citation": "§ 551 BGB",
                        "verified_quote": True,
                    }
                ],
            },
            "draft": {
                "draft_local": (
                    "Sehr geehrte Damen und Herren, die Kaution "
                    "uebersteigt die gesetzliche Hoechstgrenze."
                ),
                "draft_tenant": (
                    "Dear Sir or Madam, the deposit exceeds the "
                    "statutory cap."
                ),
            },
            "evidence": {
                "references": [
                    {
                        "label": "Table burn",
                        "prompt": "burn mark",
                        "box": {
                            "left": 100,
                            "top": 200,
                            "right": 300,
                            "bottom": 260,
                        },
                        "mask_dims": {"width": 200, "height": 60},
                        "frame_size": {"width": 1600, "height": 1200},
                    }
                ],
                "walkthrough_sha256": "a" * 64,
            },
            "moveout": {
                "comparison": {
                    "iou": 0.0,
                    "iou_registered": 0.514,
                    "registration_shift_px": {"dx": -28, "dy": 40},
                    "day1_area_px": 12000,
                    "moveout_area_px": 23272,
                    "area_growth_ratio": 1.939,
                }
            },
        }
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            created: list[Path] = []
            try:
                with TestClient(main.app) as client:
                    response = client.post(
                        "/api/export-case-dossier", json=payload
                    )
                    self.assertEqual(
                        response.status_code, 200, response.text[:400]
                    )
                    body = response.json()
                    self.assertTrue(
                        body["pdf_url"].startswith("/files/dossiers/")
                    )
                    sha = body["dossier_sha256"]
                    self.assertEqual(len(sha), 64)
                    self.assertTrue(
                        all(c in "0123456789abcdef" for c in sha)
                    )
                    pdf_file = (
                        Path(tmp) / "dossiers" / Path(body["pdf_url"]).name
                    )
                    created.append(pdf_file)
                    self.assertTrue(pdf_file.is_file())
                    pdf_bytes = pdf_file.read_bytes()
                    self.assertTrue(pdf_bytes.startswith(b"%PDF-"))
                    # The master hash is over canonical JSON + PDF bytes.
                    canonical = json.dumps(
                        payload,
                        sort_keys=True,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode("utf-8")
                    self.assertEqual(
                        sha,
                        hashlib.sha256(canonical + pdf_bytes).hexdigest(),
                    )

                    empty = client.post("/api/export-case-dossier", json={})
                    self.assertEqual(
                        empty.status_code, 200, empty.text[:400]
                    )
                    empty_file = (
                        Path(tmp)
                        / "dossiers"
                        / Path(empty.json()["pdf_url"]).name
                    )
                    created.append(empty_file)
                    self.assertTrue(
                        empty_file.read_bytes().startswith(b"%PDF-")
                    )
            finally:
                main.STORAGE_DIR = real_storage
                for path in created:
                    path.unlink(missing_ok=True)

    def test_export_master_case_dossier_complete_payload(self):
        from fastapi.testclient import TestClient

        # A realistic end-to-end case: the planted dorm contract audit
        # (3 verified issues + the deterministic deposit math), the
        # bilingual objection draft, one saved SAM move-in reference
        # with the walkthrough hash, and the registered move-out
        # comparison from the burn-mark camera-shift pair.
        payload = {
            "contract": {
                "jurisdiction_code": "DE",
                "detected_locale": "Germany · Deutsch (high)",
                "issue_count": 3,
                "high_severity_count": 2,
                "deposit_math": {
                    "currency": "EUR",
                    "base_rent": 178.47,
                    "stated_deposit": 950.0,
                    "statutory_cap": 535.41,
                    "excess_amount": 414.59,
                    "within_cap": False,
                    "statute": "§ 551 BGB",
                    "formula_note": (
                        "3 × monthly cold rent (§ 551 BGB cap on the "
                        "security deposit)"
                    ),
                },
                "issues": [
                    {
                        "clause": (
                            "§ 3 Kaution - Deposit amount exceeds "
                            "statutory cap"
                        ),
                        "severity": "high",
                        "evidence_quote": (
                            "Die vor dem Einzug zu zahlende Kaution "
                            "beträgt 950,00 EUR."
                        ),
                        "citation": "§ 551 BGB",
                        "verified_quote": True,
                    },
                    {
                        "clause": (
                            "§ 7a Kleinreparaturen - No annual cap, "
                            "high per-incident cap"
                        ),
                        "severity": "high",
                        "evidence_quote": (
                            "Der Mieter trägt die Kosten kleiner "
                            "Instandhaltungen bis zu 175 EUR je "
                            "Einzelfall selbst. Eine jährliche "
                            "Obergrenze der vom Mieter zu tragenden "
                            "Kosten besteht nicht."
                        ),
                        "citation": "BGH VIII ZR 91/88",
                        "verified_quote": True,
                    },
                    {
                        "clause": (
                            "§ 12 Abs. 5 Endreinigung - Lump-sum "
                            "cleaning fee"
                        ),
                        "severity": "medium",
                        "evidence_quote": (
                            "Bei Auszug wird eine pauschale "
                            "Endreinigungsgebühr in Höhe von 250 EUR "
                            "erhoben, unabhängig vom tatsächlichen "
                            "Zustand der Mietsache."
                        ),
                        "citation": "§ 307 BGB",
                        "verified_quote": True,
                    },
                ],
            },
            "draft": {
                "draft_local": (
                    "Sehr geehrte Damen und Herren, ich widerspreche "
                    "der in § 3 des Mietvertrags festgelegten Kaution "
                    "in Höhe von 950,00 EUR. Nach § 551 BGB darf die "
                    "Mietsicherheit höchstens das Dreifache der "
                    "monatlichen Kaltmiete betragen; bei einer "
                    "Kaltmiete von 178,47 EUR liegt die gesetzliche "
                    "Höchstgrenze bei 535,41 EUR. Ich bitte um "
                    "Anpassung des Vertrags und Rückzahlung des "
                    "übersteigenden Betrags von 414,59 EUR."
                ),
                "draft_tenant": (
                    "Dear Sir or Madam, I object to the security "
                    "deposit of EUR 950.00 set out in section 3 of "
                    "the lease. Under section 551 of the German "
                    "Civil Code (BGB), a security deposit may not "
                    "exceed three times the monthly cold rent; with "
                    "a cold rent of EUR 178.47, the statutory ceiling "
                    "is EUR 535.41. I ask that the contract be "
                    "amended and the excess of EUR 414.59 be repaid."
                ),
            },
            "evidence": {
                "references": [
                    {
                        "label": "dorm_table_burn.jpg · mask 0",
                        "prompt": "burn mark",
                        "box": {"x": 714, "y": 693, "width": 51, "height": 29},
                        "mask_dims": {"width": 51, "height": 29},
                        "frame_size": {"width": 1600, "height": 1200},
                    }
                ],
                "walkthrough_sha256": (
                    "a3f9c1e7b2d8405f96a1c3e5b7d902f4"
                    "a6c8e0b1d3f507294a6b8c1d2e3f4059"
                ),
            },
            "moveout": {
                "comparison": {
                    "iou": 0.0,
                    "iou_registered": 0.512,
                    "registered": True,
                    "registration_shift_px": {"dx": -28, "dy": 40},
                    "day1_area_px": 1479,
                    "moveout_area_px": 2865,
                    "area_growth_ratio": 1.937,
                    "prior_kind": "raster",
                    "current_kind": "raster",
                }
            },
        }
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            created: list[Path] = []
            try:
                with TestClient(main.app) as client:
                    response = client.post(
                        "/api/export-case-dossier", json=payload
                    )
                    self.assertEqual(
                        response.status_code, 200, response.text[:400]
                    )
                    body = response.json()
                    pdf_url = body["pdf_url"]
                    self.assertIsInstance(pdf_url, str)
                    self.assertTrue(pdf_url.startswith("/files/dossiers/"))
                    self.assertTrue(pdf_url.endswith(".pdf"))
                    sha = body["dossier_sha256"]
                    self.assertIsInstance(sha, str)
                    self.assertTrue(sha)
                    self.assertEqual(len(sha), 64)
                    self.assertTrue(
                        all(c in "0123456789abcdef" for c in sha)
                    )
                    pdf_file = (
                        Path(tmp) / "dossiers" / Path(pdf_url).name
                    )
                    created.append(pdf_file)
                    self.assertTrue(pdf_file.is_file())
                    pdf_bytes = pdf_file.read_bytes()
                    self.assertTrue(pdf_bytes.startswith(b"%PDF-"))
                    # A four-section dossier is a real document, not
                    # a stub. (No raw-text content assertions: the
                    # builder's font encoding keeps section titles out
                    # of the raw byte stream, as in the earlier test.)
                    self.assertGreater(len(pdf_bytes), 1000)
                    # The master hash covers canonical JSON + PDF bytes.
                    canonical = json.dumps(
                        payload,
                        sort_keys=True,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode("utf-8")
                    self.assertEqual(
                        sha,
                        hashlib.sha256(canonical + pdf_bytes).hexdigest(),
                    )
            finally:
                main.STORAGE_DIR = real_storage
                for path in created:
                    path.unlink(missing_ok=True)

    def test_resolve_storage_image_guards_paths(self):
        import pdf_builder

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            storage = Path(tmp) / "storage"
            page = storage / "contracts" / "job1" / "page-1.png"
            page.parent.mkdir(parents=True)
            page.write_bytes(b"\x89PNG\r\n\x1a\n")
            outside = Path(tmp) / "outside.png"
            outside.write_bytes(b"\x89PNG\r\n\x1a\n")
            real_storage = pdf_builder.STORAGE_DIR
            pdf_builder.STORAGE_DIR = storage
            try:
                resolve = pdf_builder._resolve_storage_image
                # /files URLs and storage-relative paths resolve.
                self.assertEqual(
                    resolve("/files/contracts/job1/page-1.png"),
                    page.resolve(),
                )
                self.assertEqual(
                    resolve("contracts/job1/page-1.png"), page.resolve()
                )
                # Escapes, absolute paths, remote URLs and missing
                # files never resolve — even when the target exists.
                self.assertIsNone(resolve("/files/../outside.png"))
                self.assertIsNone(resolve("../outside.png"))
                self.assertIsNone(resolve(str(outside)))
                self.assertIsNone(resolve("/etc/passwd"))
                self.assertIsNone(
                    resolve("https://example.com/files/page-1.png")
                )
                self.assertIsNone(resolve("/files/contracts/nope.png"))
                self.assertIsNone(resolve(""))
                self.assertIsNone(resolve(None))
            finally:
                pdf_builder.STORAGE_DIR = real_storage

    def test_build_case_dossier_embeds_storage_images(self):
        import pdf_builder
        from PIL import Image

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            storage = Path(tmp) / "storage"
            page_path = storage / "contracts" / "job1" / "page-1.png"
            page_path.parent.mkdir(parents=True)
            Image.new("RGB", (800, 1000), (247, 245, 240)).save(page_path)
            mask_path = storage / "masks" / "burn.png"
            mask_path.parent.mkdir(parents=True)
            Image.new("RGB", (200, 120), (200, 75, 49)).save(mask_path)
            mask_b64 = base64.b64encode(mask_path.read_bytes()).decode(
                "ascii"
            )

            payload = {
                "contract": {
                    "jurisdiction_code": "DE",
                    "detected_locale": "DE - de (high)",
                    "issue_count": 1,
                    "high_severity_count": 1,
                    "deposit_math": {
                        "currency": "EUR",
                        "base_rent": 178.47,
                        "stated_deposit": 950.0,
                        "statutory_cap": 535.41,
                        "excess_amount": 414.59,
                        "within_cap": False,
                        "statute": "§ 551 BGB",
                        "formula_note": "3 x monthly cold rent",
                    },
                    "issues": [
                        {
                            "clause": "Section 3 Kaution",
                            "severity": "high",
                            "evidence_quote": (
                                "Die Kaution beträgt 950,00 EUR."
                            ),
                            "citation": "§ 551 BGB",
                            "verified_quote": True,
                        }
                    ],
                    "page_previews": [
                        {
                            "page_number": 1,
                            "image_url": (
                                "/files/contracts/job1/page-1.png"
                            ),
                            "highlights": [
                                {
                                    "clause": "Section 3 Kaution",
                                    "severity": "high",
                                    "box_pct": [10.0, 20.0, 60.0, 3.0],
                                    "located": True,
                                }
                            ],
                        }
                    ],
                },
                "evidence": {
                    "references": [
                        {
                            "label": "Table burn",
                            "prompt": "burn mark",
                            "box": {
                                "left": 100,
                                "top": 200,
                                "right": 300,
                                "bottom": 260,
                            },
                            "mask_dims": {"width": 200, "height": 60},
                            "frame_size": {"width": 1600, "height": 1200},
                            "mask_url": "/files/masks/burn.png",
                        },
                        {
                            "label": "Socket mask (base64)",
                            "mask_dims": {"width": 200, "height": 120},
                            "mask_png_base64": mask_b64,
                        },
                    ],
                    "walkthrough_sha256": "b" * 64,
                },
                "moveout": {
                    "mask_url": "/files/masks/burn.png",
                    "comparison": {
                        "iou": 0.0,
                        "iou_registered": 0.512,
                        "registration_shift_px": {"dx": -28, "dy": 40},
                        "day1_area_px": 1479,
                        "moveout_area_px": 2865,
                        "area_growth_ratio": 1.937,
                    },
                },
            }

            out_path = Path(tmp) / "dossier-with-images.pdf"
            real_storage = pdf_builder.STORAGE_DIR
            pdf_builder.STORAGE_DIR = storage
            try:
                result = pdf_builder.build_case_dossier_pdf(
                    payload, out_path
                )
            finally:
                pdf_builder.STORAGE_DIR = real_storage
            self.assertGreaterEqual(result["pages"], 1)
            pdf_bytes = out_path.read_bytes()
            self.assertTrue(pdf_bytes.startswith(b"%PDF-"))
            # At least one image XObject proves the thumbnails (page-1
            # highlight composite, reference masks, move-out overlay)
            # were actually embedded, not silently skipped.
            self.assertIn(b"/Subtype /Image", pdf_bytes)

            # Negative path: unresolvable or garbage image references
            # degrade to the plain text dossier, never to an error.
            broken = json.loads(json.dumps(payload))
            broken["contract"]["page_previews"][0]["image_url"] = (
                "/files/contracts/job1/missing.png"
            )
            broken["evidence"]["references"][0]["mask_url"] = (
                "/files/masks/missing.png"
            )
            broken["evidence"]["references"][1]["mask_png_base64"] = (
                "!!! not base64 !!!"
            )
            broken["moveout"]["mask_url"] = "/files/masks/missing.png"
            broken_path = Path(tmp) / "dossier-without-images.pdf"
            pdf_builder.STORAGE_DIR = storage
            try:
                result = pdf_builder.build_case_dossier_pdf(
                    broken, broken_path
                )
            finally:
                pdf_builder.STORAGE_DIR = real_storage
            self.assertGreaterEqual(result["pages"], 1)
            broken_bytes = broken_path.read_bytes()
            self.assertTrue(broken_bytes.startswith(b"%PDF-"))
            self.assertNotIn(b"/Subtype /Image", broken_bytes)

    def test_network_info_ranks_private_lan_first(self):
        from unittest import mock

        from fastapi.testclient import TestClient

        addresses = ["198.19.0.2", "192.168.1.42", "10.0.0.5"]
        fake_addrinfo = [
            (main.socket.AF_INET, main.socket.SOCK_STREAM, 6, "", (ip, 0))
            for ip in addresses
        ]
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            real_storage = main.STORAGE_DIR
            main.STORAGE_DIR = Path(tmp)
            try:
                with TestClient(main.app) as client:
                    with mock.patch.object(
                        main.socket, "getaddrinfo", return_value=fake_addrinfo
                    ), mock.patch.object(
                        main, "_udp_source_ipv4", return_value=None
                    ), mock.patch.object(
                        main.socket,
                        "gethostbyname",
                        return_value="198.19.0.2",
                    ):
                        response = client.get("/api/network-info")
            finally:
                main.STORAGE_DIR = real_storage
        self.assertEqual(response.status_code, 200, response.text[:300])
        body = response.json()
        self.assertEqual(body["ip"], "192.168.1.42")
        self.assertEqual(
            body["candidate_ips"],
            ["192.168.1.42", "10.0.0.5", "198.19.0.2"],
        )
        self.assertEqual(
            body["evidence_url"], "http://192.168.1.42:3000/evidence"
        )

    def test_seed_demo_cache_includes_moveout_burn_mapping(self):
        import seed_demo_cache

        entries = {
            src_name: dst_names
            for src_name, dst_names in seed_demo_cache.DEMO_ASSET_COPIES
        }
        self.assertIn("dorm-burn-mark-zoom.jpg", entries)
        destinations = entries["dorm-burn-mark-zoom.jpg"]
        self.assertIn("sample_moveout_burn.jpg", destinations)
        self.assertIn("dorm_table_burn_moveout.jpg", destinations)

    def test_seed_moveout_burn_fallback_generates_valid_jpeg(self):
        import seed_demo_cache
        from PIL import Image

        # Phase 1: no source photo at all -> synthetic placeholder.
        with tempfile.TemporaryDirectory() as tmp:
            samples_dir = Path(tmp) / "samples"
            assets_dir = Path(tmp) / "assets"
            assets_dir.mkdir()
            written = seed_demo_cache._write_moveout_burn_fallback(
                samples_dir, assets_dir
            )
            self.assertEqual(
                {path.name for path in written},
                {"sample_moveout_burn.jpg", "dorm_table_burn_moveout.jpg"},
            )
            payloads = []
            for name in (
                "sample_moveout_burn.jpg",
                "dorm_table_burn_moveout.jpg",
            ):
                path = samples_dir / name
                self.assertTrue(path.is_file())
                payloads.append(path.read_bytes())
                with Image.open(path) as img:
                    self.assertEqual(img.size, (600, 400))
                    self.assertEqual(img.format, "JPEG")
            self.assertEqual(payloads[0], payloads[1])

        # Phase 2: the tracked burn photo exists -> centre-crop path,
        # still a valid 600x400 JPEG under both names.
        with tempfile.TemporaryDirectory() as tmp:
            samples_dir = Path(tmp) / "samples"
            assets_dir = Path(tmp) / "assets"
            assets_dir.mkdir()
            Image.new("RGB", (800, 600), (200, 190, 180)).save(
                assets_dir / "dorm-table-burn.jpg", format="JPEG"
            )
            written = seed_demo_cache._write_moveout_burn_fallback(
                samples_dir, assets_dir
            )
            self.assertEqual(len(written), 2)
            for path in written:
                with Image.open(path) as img:
                    self.assertEqual(img.size, (600, 400))
                    self.assertEqual(img.format, "JPEG")


if __name__ == "__main__":
    unittest.main()
