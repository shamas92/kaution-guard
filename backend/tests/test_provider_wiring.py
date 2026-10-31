"""Provider wiring checks: mock makes no network calls, live modes target
the documented URLs/models, streaming SAM output parses, and missing keys
fail before any request.

Runs entirely offline with a fake ``httpx.AsyncClient`` and an in-memory
credit-shield stub. No API keys or network access required.
"""

import asyncio
import base64
import hashlib
import json
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
        self.assertEqual(kwargs["data"]["model"], "muse-voice-transcribe-1.0")
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
                    result["mask"]["mask_dims"], {"width": 320, "height": 240}
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
            self.assertEqual((dims["width"], dims["height"]), (320, 240))
            served = Path(tmp) / result["mask_url"][len("/files/"):]
            width, height = struct.unpack(">II", served.read_bytes()[16:24])
            self.assertEqual((width, height), (320, 240))

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
        self.assertEqual(comparison["current_kind"], "polygon")
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
            "possible_issues": [
                _lease_issue(flagged_amount=150, severity="high"),
                _lease_issue(
                    flagged_amount=49.5,
                    severity="medium",
                    citation="Tenant Fees Act 2019",
                ),
                _lease_issue(flagged_amount=True, severity="low"),
                _lease_issue(flagged_amount="300", severity="low"),
                _lease_issue(flagged_amount=float("inf"), severity="low"),
                _lease_issue(severity="weird"),
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
            self.assertEqual((width, height), (320, 240))

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


if __name__ == "__main__":
    unittest.main()
