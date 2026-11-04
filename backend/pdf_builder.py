"""Handover-condition PDF reports built with fpdf2.

Reads legal wording only from the caller-supplied ``jurisdiction_pack``;
no legal claims beyond that data are made here.
"""

from __future__ import annotations

import base64
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from fpdf import FPDF

# Conventional project-local locations for a bundled Unicode TTF.
FONT_SEARCH_DIRS = ("fonts", "assets/fonts", "assets")
FONT_FAMILY = "LeaseLens"

# fpdf2 core fonts encode latin-1 (fpdf.normalize_text rejects anything
# outside it, e.g. the en-dash that cp1252 would still accept), so the
# sanitizer must match latin-1 exactly; anything else needs a bundled TTF.
_CORE_ENCODING = "latin-1"


class UnicodeFontMissingError(RuntimeError):
    """Raised when text needs a Unicode TTF the project does not bundle."""


def _font_candidates() -> list[Path]:
    """Collect *.ttf files from conventional project-local font dirs."""
    base = Path(__file__).resolve().parent
    found: list[Path] = []
    for directory in FONT_SEARCH_DIRS:
        folder = base / directory
        if folder.is_dir():
            found.extend(sorted(folder.glob("*.ttf")))
    root = base.parent
    for directory in FONT_SEARCH_DIRS:
        folder = root / directory
        if folder.is_dir():
            for path in sorted(folder.glob("*.ttf")):
                if path not in found:
                    found.append(path)
    return found


def _pick_font_files() -> tuple[Path | None, Path | None]:
    """Choose (regular, bold) TTFs; bold falls back to the regular file."""
    candidates = _font_candidates()
    if not candidates:
        return None, None
    regular = next(
        (
            p
            for p in candidates
            if any(k in p.stem.lower() for k in ("regular", "book", "medium", "sans"))
        ),
        candidates[0],
    )
    bold = next(
        (
            p
            for p in candidates
            if "bold" in p.stem.lower() and "italic" not in p.stem.lower()
        ),
        regular,
    )
    return regular, bold


# Safe ASCII substitutes for common characters the core font cannot
# encode. Only characters with an unambiguous ASCII rendering belong here;
# anything else (e.g. Greek, Cyrillic, CJK, emoji) still raises
# UnicodeFontMissingError instead of silently corrupting legal text.
_ASCII_SUBSTITUTES = {
    "\u00a0": " ",  # no-break space
    "\u2000": " ", "\u2001": " ", "\u2002": " ", "\u2003": " ",
    "\u2009": " ", "\u200a": " ", "\u202f": " ", "\u205f": " ",
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
    "\u2014": "--", "\u2015": "--",
    "\u2018": "'", "\u2019": "'", "\u201a": ",",
    "\u201c": '"', "\u201d": '"', "\u201e": '"',
    "\u2026": "...", "\u2022": "-", "\u25aa": "-", "\u25cf": "o",
    "\u2190": "<-", "\u2192": "->", "\u21d2": "=>",
    "\u2212": "-", "\u2215": "/", "\u2044": "/",
    "\u0131": "i", "\u0142": "l", "\u0141": "L",
    "\u0111": "d", "\u0110": "D", "\u00f8": "o", "\u00d8": "O",
}


def _safe_core_text(text: str) -> tuple[str, int]:
    """Rewrite one string so the core font can encode it.

    Characters the current font already covers (ASCII plus cp1252) pass
    through untouched; only unencodable characters are substituted, and
    only when a safe ASCII mapping exists (explicit table, else NFKD
    decomposition stripped to ASCII). Returns the rewritten text and the
    number of substitutions. Raises UnicodeFontMissingError when a
    character has no safe fallback, instead of writing corrupted output.
    """
    substitutions = 0
    pieces: list[str] = []
    for char in text:
        if ord(char) < 128:
            pieces.append(char)
            continue
        try:
            char.encode(_CORE_ENCODING)
        except UnicodeEncodeError:
            pass
        else:
            pieces.append(char)
            continue
        replacement = _ASCII_SUBSTITUTES.get(char)
        if replacement is None:
            decomposed = "".join(
                c
                for c in unicodedata.normalize("NFKD", char)
                if ord(c) < 128
            )
            if decomposed:
                replacement = decomposed
        if replacement is None:
            raise UnicodeFontMissingError(
                "Non-ASCII legal text cannot be rendered: no Unicode TTF is "
                "bundled with the project (fpdf2 core fonts cover cp1252 "
                "only), and this character has no safe ASCII substitute. "
                "Add e.g. backend/fonts/DejaVuSans.ttf "
                "(plus a bold face) and retry; refusing to emit corrupted "
                f"characters. Offending text starts with: {text[:80]!r}"
            )
        pieces.append(replacement)
        substitutions += 1
    return "".join(pieces), substitutions


def _sanitize_for_core_font(
    jurisdiction_pack: Mapping[str, Any],
    user_language: str,
    evidence_sha256: str,
    defects: list[Mapping[str, Any]],
) -> tuple[dict[str, Any], str, str, list[dict[str, Any]], int]:
    """Copy all rendered inputs with only unencodable chars substituted.

    Never mutates the caller's mappings. Returns the sanitized pack,
    language, sha, defects, and the total substitution count (0 means the
    core font covered everything and no footer warning is needed).
    """
    pack_keys = (
        "protocol_title",
        "country_name",
        "official_language",
        "statutes",
        "dispute_title",
    )
    total = 0
    pack: dict[str, Any] = dict(jurisdiction_pack)
    for key in pack_keys:
        if key in pack:
            pack[key], count = _safe_core_text(str(pack[key]))
            total += count
    language, count = _safe_core_text(str(user_language))
    total += count
    sha, count = _safe_core_text(str(evidence_sha256))
    total += count
    defect_keys = (
        "timestamp",
        "sam_confidence",
        "area_percent",
        "description_local",
        "description_tenant",
        "image_path",
        "frame_image_path",
    )
    clean_defects: list[dict[str, Any]] = []
    for defect in defects:
        entry = dict(defect)
        for key in defect_keys:
            if key in entry:
                entry[key], count = _safe_core_text(str(entry[key]))
                total += count
        clean_defects.append(entry)
    return pack, language, sha, clean_defects, total


def _resolve_output_path(storage_dir: str | Path, output_filename: str) -> Path:
    """Resolve the output inside storage_dir; reject path escapes."""
    base = Path(storage_dir).resolve()
    target = (base / output_filename).resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ValueError(
            f"Refusing to write outside storage_dir: {output_filename!r}"
        ) from exc
    if not target.name or target == base:
        raise ValueError(f"Invalid output filename: {output_filename!r}")
    return target


def _mask_pixel_stats(mask_path: str) -> tuple[int, int] | None:
    """Count positive pixels in a SAM mask PNG: (mask_px, total_px).

    Returns None when the file is missing or unreadable, so callers can
    fall back gracefully instead of printing a placeholder area.
    """
    try:
        from PIL import Image

        with Image.open(mask_path) as img:
            gray = img.convert("L")
            total = gray.width * gray.height
            if total <= 0:
                return None
            histogram = gray.histogram()
            mask_px = sum(histogram[17:])  # any pixel brighter than 16/255
            return mask_px, total
    except Exception:
        return None


def _composite_overlay(frame_path: str, mask_path: str, out_path: Path) -> bool:
    """Blend a translucent terracotta SAM mask over its room keyframe.

    Writes a JPEG composite and returns True on success. Any failure
    (missing files, size mismatch, decode error) returns False so the
    caller can fall back to embedding the plain keyframe.
    """
    try:
        from PIL import Image

        with Image.open(frame_path) as frame_img:
            frame = frame_img.convert("RGB")
        with Image.open(mask_path) as mask_img:
            mask = mask_img.convert("L")
        if mask.size != frame.size:
            mask = mask.resize(frame.size)
        binary = mask.point(lambda v: 255 if v > 16 else 0)
        terracotta = Image.new("RGB", frame.size, (200, 75, 49))
        blended = Image.blend(frame, terracotta, 0.45)
        composite = Image.composite(blended, frame, binary)
        composite.save(out_path, "JPEG", quality=88)
        return True
    except Exception:
        return False


def _mask_shape_binary(mask_path: str | Path) -> Any | None:
    """Binary ``L`` image of one mask-like file's shape, or None.

    The shape comes from the alpha channel when the file is an RGBA
    overlay layer (its painted pixels carry the shape) and from
    luminance otherwise (white-on-black SAM mask PNGs). Pixels above
    16/255 count as shape. Never raises.
    """
    try:
        from PIL import Image

        with Image.open(mask_path) as img:
            rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A")
        alpha_min, _alpha_max = alpha.getextrema()
        if alpha_min < 250:
            shape = alpha
        else:
            shape = rgba.convert("L")
        return shape.point(lambda v: 255 if v > 16 else 0)
    except Exception:
        return None


def _render_mask_tint(mask_path: str | Path, out_path: Path) -> bool:
    """Render a mask shape as a warm display image — never the raw mask.

    Parchment canvas (#F7F5F0) at the mask's own size, the shape filled
    with terracotta at ~85% strength and a darker solid rim, saved as
    PNG. Used when a mask is the only evidence image available, so a
    PDF shows a tinted architectural shape instead of a stark
    black-and-white binary cutout. Returns False on any failure.
    """
    try:
        from PIL import Image, ImageChops, ImageFilter

        shape = _mask_shape_binary(mask_path)
        if shape is None:
            return False
        parchment = (247, 245, 240)
        terracotta = (200, 75, 49)
        fill = tuple(
            round(terracotta[i] * 0.85 + parchment[i] * 0.15)
            for i in range(3)
        )
        canvas = Image.new("RGB", shape.size, parchment)
        canvas.paste(Image.new("RGB", shape.size, fill), (0, 0), shape)
        eroded = shape.filter(ImageFilter.MinFilter(3))
        rim = ImageChops.difference(shape, eroded)
        canvas.paste(
            Image.new("RGB", shape.size, (166, 58, 34)), (0, 0), rim
        )
        canvas.save(out_path, "PNG")
        return True
    except Exception:
        return False


def _embed_fit(pdf: Any, image_path: str, max_w: float, max_h: float) -> bool:
    """Embed an image scaled to fit max_w x max_h mm, aspect preserved.

    A tall narrow image (e.g. a mask crop) can never blow up into a
    full-page strip: whichever dimension hits its cap first wins.
    Returns False when the image cannot be measured or embedded.
    """
    try:
        from PIL import Image

        with Image.open(image_path) as img:
            iw, ih = img.size
        if iw <= 0 or ih <= 0:
            return False
        w = float(max_w)
        h = w * ih / iw
        if h > max_h:
            h = float(max_h)
            w = h * iw / ih
        if pdf.get_y() + h > pdf.page_break_trigger:
            pdf.add_page()
        pdf.image(image_path, w=w, h=h)
        return True
    except Exception:
        return False


def build_handover_pdf(
    jurisdiction_pack: Mapping[str, Any],
    user_language: str,
    evidence_sha256: str,
    defects: list[Mapping[str, Any]],
    storage_dir: str | Path,
    output_filename: str,
) -> str:
    """Build a move-in/move-out handover PDF and return its path.

    ``jurisdiction_pack`` supplies ``protocol_title``, ``country_name``,
    ``official_language``, ``statutes`` (and ``dispute_title``); every legal
    statement in the PDF comes from that pack alone. Each defect maps
    ``timestamp``, ``sam_confidence``, ``area_percent``,
    ``description_local``, ``description_tenant`` and ``image_path``.
    """
    out_path = _resolve_output_path(storage_dir, output_filename)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    regular, bold = _pick_font_files()
    unicode_font = regular is not None
    # Count of unencodable characters replaced with ASCII substitutes (0
    # when the core font covered everything, or when a Unicode TTF is
    # bundled and no substitution happens at all).
    fallback_substitutions = 0
    if not unicode_font:
        (
            jurisdiction_pack,
            user_language,
            evidence_sha256,
            defects,
            fallback_substitutions,
        ) = _sanitize_for_core_font(
            jurisdiction_pack, user_language, evidence_sha256, defects
        )

    pdf = FPDF()
    pdf.set_auto_page_break(True, margin=20)
    if unicode_font:
        assert regular is not None and bold is not None
        pdf.add_font(FONT_FAMILY, "", str(regular), uni=True)
        pdf.add_font(FONT_FAMILY, "B", str(bold), uni=True)
        body, strong = FONT_FAMILY, FONT_FAMILY
    else:
        body, strong = "Helvetica", "Helvetica"

    def heading(text: str, size: int = 16) -> None:
        pdf.set_font(strong, "B", size)
        pdf.multi_cell(0, 8, text, new_x="LMARGIN", new_y="NEXT")

    def field(label: str, value: str) -> None:
        pdf.set_font(strong, "B", 11)
        pdf.multi_cell(0, 6, label, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font(body, "", 11)
        pdf.multi_cell(0, 6, value, new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)

    pdf.add_page()
    heading("LeaseLens", 20)
    heading(str(jurisdiction_pack.get("protocol_title", "Handover Report")))
    pdf.set_font(body, "", 11)
    pdf.multi_cell(
        0,
        6,
        f"Country: {jurisdiction_pack.get('country_name', '')}\n"
        f"Record language: {jurisdiction_pack.get('official_language', '')} / "
        f"Tenant language: {user_language}\n"
        f"Generated (UTC): {datetime.now(timezone.utc).isoformat()}\n"
        f"Evidence SHA-256: {evidence_sha256}",
        new_x="LMARGIN",
        new_y="NEXT",
    )
    pdf.ln(4)

    heading("Defects", 14)
    if not defects:
        pdf.set_font(body, "", 11)
        pdf.multi_cell(0, 6, "No defects recorded.", new_x="LMARGIN", new_y="NEXT")
    for index, defect in enumerate(defects, start=1):
        heading(f"Defect {index}", 12)
        field("Timestamp", str(defect.get("timestamp", "")))
        # Only a real confidence value is printed — never "Unknown".
        confidence = str(defect.get("sam_confidence") or "").strip()
        if confidence and confidence.lower() != "unknown":
            field("SAM confidence", confidence)
        image_path = str(defect.get("image_path", ""))
        mask_file = Path(image_path) if image_path else None
        # The real mask area comes from the mask pixels themselves; the
        # polygon-based area_percent is None for raster masks and must
        # never surface as a placeholder.
        stats = (
            _mask_pixel_stats(image_path)
            if mask_file is not None and mask_file.is_file()
            else None
        )
        if stats is not None:
            mask_px, total_px = stats
            field(
                "Mask area",
                f"{mask_px:,} px ({100.0 * mask_px / total_px:.1f}% of frame)",
            )
        elif isinstance(defect.get("area_percent"), (int, float)):
            field("Mask area", f"{defect['area_percent']} % of frame")
        field(
            f"Description ({jurisdiction_pack.get('official_language', 'local')})",
            str(defect.get("description_local", "")),
        )
        field(
            f"Translation ({user_language})",
            str(defect.get("description_tenant", "")),
        )
        # Evidence image: ONLY the room keyframe with the translucent
        # terracotta mask composited over it, constrained to
        # 115mm x 85mm — a raw binary mask is never embedded at large
        # size (a tall mask crop once blew up into a full-page strip).
        frame_path = str(defect.get("frame_image_path", ""))
        frame_file = Path(frame_path) if frame_path else None
        embedded = False
        if frame_file is not None and frame_file.is_file():
            display_path = frame_path
            if mask_file is not None and mask_file.is_file():
                composite_path = mask_file.with_name(
                    f"composite-{index:03d}.jpg"
                )
                if _composite_overlay(frame_path, image_path, composite_path):
                    display_path = str(composite_path)
            embedded = _embed_fit(pdf, display_path, 115, 85)
            if embedded:
                pdf.ln(2)
        elif mask_file is not None and mask_file.is_file():
            # No keyframe to composite over: render the mask shape as
            # a parchment/terracotta tint — a raw binary mask is never
            # embedded in the PDF.
            tint_path = mask_file.with_name(f"tint-{index:03d}.png")
            if _render_mask_tint(image_path, tint_path):
                embedded = _embed_fit(pdf, str(tint_path), 115, 85)
                if embedded:
                    pdf.ln(2)
        if not embedded:
            pdf.set_font(body, "", 11)
            pdf.multi_cell(
                0,
                6,
                f"[annotated frame image not available: {image_path}]",
                new_x="LMARGIN",
                new_y="NEXT",
            )

    heading("Legal basis (jurisdiction pack only)", 14)
    pdf.set_font(body, "", 10)
    pdf.multi_cell(
        0, 5, str(jurisdiction_pack.get("statutes", "")), new_x="LMARGIN", new_y="NEXT"
    )
    pdf.ln(2)
    pdf.set_font(body, "", 11)
    pdf.multi_cell(
        0,
        6,
        "Cautious note: whether an item counts as ordinary wear and tear "
        "depends solely on the jurisdiction rules quoted above. Items "
        "consistent with normal use and ageing under those rules are not "
        "tenant damage. Have a qualified professional review this report "
        "before use.",
        new_x="LMARGIN",
        new_y="NEXT",
    )

    heading("Signatures", 14)
    pdf.set_font(body, "", 11)
    for party in ("Landlord", "Tenant"):
        pdf.multi_cell(0, 6, f"{party}:", new_x="LMARGIN", new_y="NEXT")
        y = pdf.get_y() + 12
        pdf.line(pdf.l_margin, y, pdf.l_margin + 80, y)
        pdf.set_y(y + 4)
        pdf.multi_cell(0, 6, "Date:", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(4)

    if fallback_substitutions:
        pdf.set_font(body, "", 9)
        pdf.multi_cell(
            0,
            5,
            "Font fallback warning: no Unicode font is bundled, so "
            f"{fallback_substitutions} character(s) the built-in font "
            "cannot encode were replaced with ASCII equivalents. Verify "
            "names and figures against the source document.",
            new_x="LMARGIN",
            new_y="NEXT",
        )

    pdf.output(str(out_path))
    return str(out_path)


# Extra substitutions for dossier text, which arrives from the browser's
# persisted case state and can contain anything a letter or clause ever
# held. Unlike the jurisdiction-pack wording above, this content must
# never abort the export, so the dossier sanitizer below drops what it
# cannot map instead of raising.
_DOSSIER_EXTRA_SUBSTITUTES = {
    "\u20ac": "EUR",  # euro sign (cp1252 has it; latin-1 does not)
    "\u2713": "[verified]",
    "\u2714": "[verified]",
    "\u26a0": "(!)",
}


def _dossier_safe_text(text: str) -> str:
    """Rewrite one string for the core font without ever raising.

    ASCII and latin-1 characters pass through; known symbols map to
    readable ASCII via the shared table plus the dossier extras;
    anything else is decomposed (NFKD) to ASCII when possible and
    dropped when not (emoji, CJK, ...). Only used when no Unicode TTF
    is bundled — a bundled font renders the original text untouched.
    """
    pieces: list[str] = []
    for char in text:
        if ord(char) < 128:
            pieces.append(char)
            continue
        try:
            char.encode(_CORE_ENCODING)
        except UnicodeEncodeError:
            pass
        else:
            pieces.append(char)
            continue
        replacement = _ASCII_SUBSTITUTES.get(char)
        if replacement is None:
            replacement = _DOSSIER_EXTRA_SUBSTITUTES.get(char)
        if replacement is None:
            decomposed = "".join(
                c
                for c in unicodedata.normalize("NFKD", char)
                if ord(c) < 128
            )
            replacement = decomposed or ""
        pieces.append(replacement)
    return "".join(pieces)


def _dossier_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _dossier_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _dossier_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _dossier_box_text(box: Any) -> str:
    """Compact ``x0,y0-x1,y1`` rendering of a stored mask box."""
    if not isinstance(box, dict):
        return ""
    keys = ("left", "top", "right", "bottom")
    values = [_dossier_number(box.get(key)) for key in keys]
    if all(v is not None for v in values):
        return (
            f"{values[0]:.0f},{values[1]:.0f}-"
            f"{values[2]:.0f},{values[3]:.0f}"
        )
    return ""


def _dossier_dims_text(dims: Any) -> str:
    """Compact ``W×H`` rendering of a stored dimensions dict."""
    if not isinstance(dims, dict):
        return ""
    width = _dossier_number(dims.get("width"))
    height = _dossier_number(dims.get("height"))
    if width is None or height is None:
        return ""
    return f"{width:.0f}x{height:.0f}"


def _dossier_percent(value: Any) -> str:
    """Format a 0..1 ratio as a percent; anything else as a plain number."""
    number = _dossier_number(value)
    if number is None:
        return ""
    if 0.0 <= number <= 1.0:
        return f"{number * 100:.1f}%"
    return f"{number:.3f}"


# The storage tree the dossier may read evidence images from: the same
# ``backend/storage`` directory main.py serves through the /files mount
# (main.py defines its STORAGE_DIR identically, from its own location).
STORAGE_DIR = Path(__file__).resolve().parent / "storage"


def _resolve_storage_image(file_url_or_path: str) -> Path | None:
    """Map a ``/files/...`` URL or storage-relative path to a real file.

    Returns the resolved path only when it stays inside ``STORAGE_DIR``
    and names an existing file. Absolute paths outside the storage
    tree, non-/files URLs and ``..`` escapes all yield None. Never
    raises: dossier payloads are loosely-typed browser state, and a bad
    image reference must degrade to a text-only dossier, not an error.
    """
    try:
        if not isinstance(file_url_or_path, str):
            return None
        value = file_url_or_path.strip()
        if not value:
            return None
        if value.startswith("/files/"):
            relative = value[len("/files/"):]
        elif "://" in value:
            return None
        elif Path(value).is_absolute():
            # Warm-cache SAM records carry absolute overlay paths; allow
            # the ones that genuinely live inside the storage tree (the
            # containment check still rejects every other absolute path).
            base = STORAGE_DIR.resolve()
            candidate = Path(
                value.split("?", 1)[0].split("#", 1)[0]
            ).resolve()
            if not candidate.is_relative_to(base):
                return None
            return candidate if candidate.is_file() else None
        elif value.startswith("/"):
            return None
        else:
            relative = value
        relative = relative.split("?", 1)[0].split("#", 1)[0].strip()
        if not relative:
            return None
        base = STORAGE_DIR.resolve()
        candidate = (base / relative).resolve()
        if not candidate.is_relative_to(base):
            return None
        return candidate if candidate.is_file() else None
    except Exception:
        return None


def _dossier_temp_image_from_base64(
    value: Any, temp_sink: list[Path]
) -> Path | None:
    """Decode a base64 PNG/JPEG payload to a tracked temp file.

    Accepts raw base64 or a ``data:`` URL. Anything that does not
    decode to PNG/JPEG magic bytes yields None. Never raises.
    """
    try:
        if not isinstance(value, str) or not value.strip():
            return None
        encoded = value.strip()
        if encoded.startswith("data:"):
            _, _, encoded = encoded.partition(",")
        raw = base64.b64decode(encoded, validate=True)
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            suffix = ".png"
        elif raw.startswith(b"\xff\xd8\xff"):
            suffix = ".jpg"
        else:
            return None
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        try:
            handle.write(raw)
        finally:
            handle.close()
        path = Path(handle.name)
        temp_sink.append(path)
        return path
    except Exception:
        return None


# Base64 keys that carry a full-colour photo thumbnail (the frontend's
# saved-reference preview is a JPEG data URL under ``previewDataUrl``;
# ``color_preview_base64`` is the raw-base64 spelling).
_PREVIEW_B64_KEYS = (
    "color_preview_base64",
    "previewDataUrl",
    "preview_data_url",
    "colorPreviewBase64",
    "preview_base64",
)


def _dossier_is_alpha_layer(path: Path) -> bool:
    """True when an image is mostly transparent (an overlay layer).

    The servable SAM overlay PNG is translucent fill + contour over
    transparency; embedded alone in a PDF it would render as pale
    shapes on white, so the picker composites it over its photo or
    re-renders its shape as a tint instead. Opaque images (JPEGs,
    baked composites, photos) are never alpha layers. Never raises.
    """
    try:
        from PIL import Image

        with Image.open(path) as img:
            if img.mode in ("RGB", "L", "CMYK"):
                return False
            alpha = img.convert("RGBA").getchannel("A")
        histogram = alpha.histogram()
        total = max(1, sum(histogram))
        transparent = sum(histogram[:128])
        return transparent / total > 0.5
    except Exception:
        return False


def _dossier_bake_overlay(
    overlay_path: Path, source_path: Path, temp_sink: list[Path]
) -> Path | None:
    """Composite an RGBA overlay layer over its source photo (JPEG temp)."""
    try:
        from PIL import Image

        with Image.open(source_path) as source_img:
            base = source_img.convert("RGBA")
        with Image.open(overlay_path) as overlay_img:
            layer = overlay_img.convert("RGBA")
        if layer.size != base.size:
            layer = layer.resize(base.size)
        baked = Image.alpha_composite(base, layer).convert("RGB")
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
        handle.close()
        baked.save(handle.name, "JPEG", quality=88)
        path = Path(handle.name)
        temp_sink.append(path)
        return path
    except Exception:
        return None


def _dossier_tint_temp(
    mask_path: Path, temp_sink: list[Path]
) -> Path | None:
    """Parchment-tint render of a lone mask, as a tracked temp PNG."""
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    handle.close()
    path = Path(handle.name)
    if _render_mask_tint(mask_path, path):
        temp_sink.append(path)
        return path
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass
    return None


def _dossier_mask_temp(
    entry: dict, temp_sink: list[Path]
) -> Path | None:
    """The entry's raw mask as a file (URL fields, then base64).

    Background material only: callers composite it over the source
    photo or tint-render it — it is never embedded directly.
    """
    for key in ("mask_url", "mask_path"):
        resolved = _resolve_storage_image(entry.get(key))
        if resolved is not None:
            return resolved
    return _dossier_temp_image_from_base64(
        entry.get("mask_png_base64"), temp_sink
    )


def _dossier_entry_image(entry: Any, temp_sink: list[Path]) -> Path | None:
    """Resolve one evidence entry's DISPLAY image, if it carries one.

    The returned file is always fit to show — a baked colour
    composite or a full-colour photo; a raw black-and-white binary
    mask is never returned. Preference order: (a) ``overlay_url`` /
    ``overlay_path`` through the traversal-guarded storage resolver —
    embedded directly when already a baked colour image, composited
    over the entry's photo (``image_url``, else ``frame_url``) when
    it is a transparency layer, or re-rendered as a parchment tint
    from its alpha shape when no photo exists; (b) a full-colour
    base64 preview thumbnail; (c) mask + photo composited in
    translucent terracotta; (d) the plain photo; (e) a lone mask
    rendered as a parchment tint. Never raises.
    """
    try:
        if not isinstance(entry, dict):
            return None
        source = _resolve_storage_image(entry.get("image_url"))
        if source is None:
            source = _resolve_storage_image(entry.get("frame_url"))
        overlay = None
        for key in ("overlay_url", "overlay_path"):
            overlay = _resolve_storage_image(entry.get(key))
            if overlay is not None:
                break
        if overlay is not None:
            if not _dossier_is_alpha_layer(overlay):
                return overlay
            if source is not None:
                baked = _dossier_bake_overlay(overlay, source, temp_sink)
                if baked is not None:
                    return baked
            tinted = _dossier_tint_temp(overlay, temp_sink)
            if tinted is not None:
                return tinted
        for key in _PREVIEW_B64_KEYS:
            preview = _dossier_temp_image_from_base64(
                entry.get(key), temp_sink
            )
            if preview is not None:
                return preview
        mask = _dossier_mask_temp(entry, temp_sink)
        if mask is not None and source is not None:
            handle = tempfile.NamedTemporaryFile(
                delete=False, suffix=".jpg"
            )
            handle.close()
            composite_path = Path(handle.name)
            if _composite_overlay(
                str(source), str(mask), composite_path
            ):
                temp_sink.append(composite_path)
                return composite_path
            try:
                composite_path.unlink(missing_ok=True)
            except Exception:
                pass
            return source
        if source is not None:
            return source
        if mask is not None:
            return _dossier_tint_temp(mask, temp_sink)
        return None
    except Exception:
        return None


def _dossier_highlight_composite(
    page_path: Path, boxes: Any
) -> Path | None:
    """Draw percent-based highlight boxes onto a temp copy of a page.

    ``boxes`` are ``box_pct`` values: ``[x, y, w, h]`` in percent of
    the page image's dimensions. Returns the temp PNG path, or None
    when nothing could be drawn (the caller then embeds the plain
    page image). Never raises.
    """
    try:
        from PIL import Image, ImageDraw

        if not isinstance(boxes, list):
            return None
        with Image.open(page_path) as image:
            canvas = image.convert("RGB")
        draw = ImageDraw.Draw(canvas)
        width, height = canvas.size
        line_width = max(2, round(min(width, height) * 0.004))
        drawn = 0
        for box in boxes:
            if not isinstance(box, (list, tuple)) or len(box) != 4:
                continue
            values = [_dossier_number(component) for component in box]
            if any(component is None for component in values):
                continue
            x, y, w, h = (float(component) for component in values)
            draw.rectangle(
                [
                    x / 100.0 * width,
                    y / 100.0 * height,
                    (x + w) / 100.0 * width,
                    (y + h) / 100.0 * height,
                ],
                outline=(198, 74, 49),
                width=line_width,
            )
            drawn += 1
        if not drawn:
            return None
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
        handle.close()
        canvas.save(handle.name, format="PNG")
        return Path(handle.name)
    except Exception:
        return None


def build_case_dossier_pdf(payload: dict, output_path: Path) -> dict:
    """Build the Master Case Dossier PDF from browser-persisted case state.

    Purely local (no provider calls): every section is optional and
    rendered only when the payload carries it, and every field access
    is defensive because the browser sends loosely-typed stored state.
    An empty payload still yields a valid minimal dossier. Returns a
    small metadata dict with the page count.
    """
    data = payload if isinstance(payload, dict) else {}
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    regular, bold = _pick_font_files()
    unicode_font = regular is not None

    pdf = FPDF()
    pdf.set_auto_page_break(True, margin=20)
    if unicode_font:
        assert regular is not None and bold is not None
        pdf.add_font(FONT_FAMILY, "", str(regular), uni=True)
        pdf.add_font(FONT_FAMILY, "B", str(bold), uni=True)
        body, strong = FONT_FAMILY, FONT_FAMILY
    else:
        body, strong = "Helvetica", "Helvetica"

    def safe(text: str) -> str:
        return text if unicode_font else _dossier_safe_text(text)

    def heading(text: str, size: int = 14) -> None:
        pdf.set_font(strong, "B", size)
        pdf.multi_cell(0, 8, safe(text), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(1)

    def para(text: str, size: int = 11) -> None:
        pdf.set_font(body, "", size)
        pdf.multi_cell(0, 6, safe(text), new_x="LMARGIN", new_y="NEXT")

    def row(label: str, value: str) -> None:
        pdf.set_font(strong, "B", 11)
        # 74mm label column: the longest scorecard label ("Residual
        # area growth (after alignment):", ~69mm at 11pt bold) must
        # fit inside its cell -- at 58mm it overprinted the value.
        pdf.cell(74, 6, safe(label))
        pdf.set_font(body, "", 11)
        pdf.multi_cell(0, 6, safe(value), new_x="LMARGIN", new_y="NEXT")

    # Temp files created for embedded evidence images (highlight
    # composites, decoded base64 masks); removed after pdf.output.
    temp_files: list[Path] = []

    def embed_thumbnail(
        image_path: Path, width_mm: float, reserve_mm: float
    ) -> None:
        """Embed one evidence image beside its section's text.

        Fully guarded: a missing or corrupt image is skipped silently
        so the text-only rendering is always the fallback.
        """
        try:
            if pdf.get_y() > 297 - 20 - reserve_mm:
                pdf.add_page()
            pdf.image(str(image_path), w=width_mm)
            pdf.ln(2)
        except Exception:
            pass

    contract = _dossier_dict(data.get("contract"))
    draft = _dossier_dict(data.get("draft"))
    evidence = _dossier_dict(data.get("evidence"))
    moveout_root = _dossier_dict(data.get("moveout"))
    moveout = _dossier_dict(moveout_root.get("comparison"))

    sections_rendered = 0

    pdf.add_page()
    heading("LeaseLens \u2014 Master Case Dossier", 18)
    para(
        "Generated (UTC): "
        f"{datetime.now(timezone.utc).isoformat()}"
    )
    jurisdiction = _dossier_text(contract.get("jurisdiction_code"))
    if jurisdiction:
        para(f"Jurisdiction: {jurisdiction}")
    pdf.ln(3)

    # -- Section 1: statutory lease audit & verbatim quotes --------------
    issues = contract.get("issues")
    issue_items = (
        [item for item in issues if isinstance(item, dict)]
        if isinstance(issues, list)
        else []
    )
    deposit_math = _dossier_dict(contract.get("deposit_math"))
    locale_text = _dossier_text(contract.get("detected_locale"))
    previews = contract.get("page_previews")
    preview_items = (
        [item for item in previews if isinstance(item, dict)]
        if isinstance(previews, list)
        else []
    )
    page_one = next(
        (
            item
            for item in preview_items
            if _dossier_number(item.get("page_number")) == 1
        ),
        preview_items[0] if preview_items else None,
    )
    page_image = (
        _resolve_storage_image(page_one.get("image_url"))
        if page_one is not None
        else None
    )
    if contract and (
        issue_items or deposit_math or locale_text or page_image is not None
    ):
        sections_rendered += 1
        heading("Statutory Lease Audit & Verbatim Quotes")
        if locale_text:
            row("Detected locale:", locale_text)
        issue_count = _dossier_number(contract.get("issue_count"))
        high_count = _dossier_number(contract.get("high_severity_count"))
        if issue_count is not None:
            counts = f"{issue_count:.0f} flagged"
            if high_count is not None:
                counts += f" ({high_count:.0f} high severity)"
            row("Issues:", counts)
        if deposit_math:
            currency = _dossier_text(deposit_math.get("currency")) or "EUR"
            base_rent = _dossier_number(deposit_math.get("base_rent"))
            stated = _dossier_number(deposit_math.get("stated_deposit"))
            cap = _dossier_number(deposit_math.get("statutory_cap"))
            excess = _dossier_number(deposit_math.get("excess_amount"))
            statute = _dossier_text(deposit_math.get("statute"))
            if base_rent is not None:
                row("Base rent:", f"{base_rent:.2f} {currency}")
            if stated is not None:
                row("Stated deposit:", f"{stated:.2f} {currency}")
            if cap is not None:
                label = "Statutory cap"
                if statute:
                    label += f" ({statute})"
                row(label + ":", f"{cap:.2f} {currency}")
            if excess is not None:
                row("Excess over cap:", f"{excess:.2f} {currency}")
            within = deposit_math.get("within_cap")
            if isinstance(within, bool):
                row("Within cap:", "Yes" if within else "No")
            note = _dossier_text(deposit_math.get("formula_note"))
            if note:
                para(note, size=10)
            pdf.ln(2)
        if page_image is not None:
            try:
                embed_path = page_image
                highlight_boxes: list[Any] = []
                # Only genuinely located highlights OF PAGE 1 belong on
                # the page-1 image. Unlocated quotes carry a synthetic
                # fallback band (located=False) that the web viewer
                # styles as approximate — drawing those bands, or any
                # other page's boxes, would stamp stray rectangles onto
                # page 1's margins.
                if (
                    page_one is not None
                    and _dossier_number(page_one.get("page_number")) == 1
                ):
                    raw_highlights = page_one.get("highlights")
                    if isinstance(raw_highlights, list):
                        highlight_boxes = [
                            item.get("box_pct")
                            for item in raw_highlights
                            if isinstance(item, dict)
                            and item.get("located") is True
                        ]
                if highlight_boxes:
                    composite = _dossier_highlight_composite(
                        page_image, highlight_boxes
                    )
                    if composite is not None:
                        temp_files.append(composite)
                        embed_path = composite
                embed_thumbnail(embed_path, 95, 140)
            except Exception:
                pass
        verified_mark = (
            "Quote verified verbatim \u2713"
            if unicode_font
            else "Quote verified verbatim [verified]"
        )
        for index, issue in enumerate(issue_items, start=1):
            clause = _dossier_text(issue.get("clause")) or f"Issue {index}"
            severity = _dossier_text(issue.get("severity"))
            title = f"{index}. {clause}"
            if severity:
                title += f" \u2014 severity: {severity}"
            # Keep-together guard: estimate the block height (title +
            # quote lines + marker line) and start a fresh page when it
            # would be sliced across a page break.
            quote_text = _dossier_text(issue.get("evidence_quote"))
            quote_lines = max(1, -(-len(quote_text) // 78)) if quote_text else 0
            block_height = 6 + quote_lines * 6 + 8
            if (
                block_height < 120
                and pdf.get_y() + block_height > pdf.page_break_trigger
            ):
                pdf.add_page()
            pdf.set_font(strong, "B", 11)
            pdf.multi_cell(0, 6, safe(title), new_x="LMARGIN", new_y="NEXT")
            quote = _dossier_text(issue.get("evidence_quote"))
            if quote:
                para(f'"{quote}"')
            citation = _dossier_text(issue.get("citation"))
            markers: list[str] = []
            if citation:
                markers.append(f"Citation: {citation}")
            if issue.get("verified_quote"):
                markers.append(verified_mark)
            if markers:
                para(" \u00b7 ".join(markers), size=10)
            pdf.ln(2)

    # -- Section 2: bilingual landlord objection notice ------------------
    draft_local = _dossier_text(draft.get("draft_local"))
    draft_tenant = _dossier_text(draft.get("draft_tenant"))
    if draft_local or draft_tenant:
        sections_rendered += 1
        heading("Landlord Objection Notice")
        if draft_local:
            pdf.set_font(strong, "B", 12)
            pdf.multi_cell(
                0, 7, safe("(Local language)"),
                new_x="LMARGIN", new_y="NEXT",
            )
            para(draft_local)
            pdf.ln(2)
        if draft_tenant:
            pdf.set_font(strong, "B", 12)
            pdf.multi_cell(
                0, 7, safe("(Tenant language)"),
                new_x="LMARGIN", new_y="NEXT",
            )
            para(draft_tenant)
            pdf.ln(2)

    # -- Section 3: move-in visual evidence shield -----------------------
    references = evidence.get("references")
    ref_items = (
        [item for item in references if isinstance(item, dict)]
        if isinstance(references, list)
        else []
    )
    walkthrough_sha = _dossier_text(evidence.get("walkthrough_sha256"))
    raw_regions = evidence.get("regions")
    region_items = (
        [item for item in raw_regions if isinstance(item, dict)]
        if isinstance(raw_regions, list)
        else []
    )
    # Walkthrough regions render only when they carry a resolvable
    # image (the builder has never rendered region text on its own).
    region_images: list[tuple[dict, Path]] = []
    for region in region_items:
        resolved_region = _dossier_entry_image(region, temp_files)
        if resolved_region is not None:
            region_images.append((region, resolved_region))
    if ref_items or walkthrough_sha or region_images:
        sections_rendered += 1
        heading("Move-In Visual Evidence Shield")
        for index, reference in enumerate(ref_items, start=1):
            name = (
                _dossier_text(reference.get("label"))
                or _dossier_text(reference.get("name"))
                or _dossier_text(reference.get("prompt"))
                or f"Reference {index}"
            )
            parts = [name]
            prompt = _dossier_text(reference.get("prompt"))
            if prompt and prompt != name:
                parts.append(f"prompt: {prompt}")
            box_text = _dossier_box_text(reference.get("box"))
            if box_text:
                parts.append(f"box {box_text}")
            mask_dims = _dossier_dims_text(reference.get("mask_dims"))
            if mask_dims:
                parts.append(f"mask {mask_dims}")
            frame_size = _dossier_dims_text(reference.get("frame_size"))
            if frame_size:
                parts.append(f"frame {frame_size}")
            para(" \u00b7 ".join(parts))
            ref_image = _dossier_entry_image(reference, temp_files)
            if ref_image is not None:
                embed_thumbnail(ref_image, 55, 80)
        for index, (region, region_image) in enumerate(
            region_images, start=1
        ):
            name = (
                _dossier_text(region.get("label"))
                or _dossier_text(region.get("name"))
                or _dossier_text(region.get("prompt"))
                or _dossier_text(region.get("description"))
                or f"Walkthrough region {index}"
            )
            parts = [name]
            prompt = _dossier_text(region.get("prompt"))
            if prompt and prompt != name:
                parts.append(f"prompt: {prompt}")
            box_text = _dossier_box_text(region.get("box"))
            if box_text:
                parts.append(f"box {box_text}")
            mask_dims = _dossier_dims_text(region.get("mask_dims"))
            if mask_dims:
                parts.append(f"mask {mask_dims}")
            frame_size = _dossier_dims_text(region.get("frame_size"))
            if frame_size:
                parts.append(f"frame {frame_size}")
            para(" \u00b7 ".join(parts))
            embed_thumbnail(region_image, 55, 80)
        if walkthrough_sha:
            row("Walkthrough SHA-256:", walkthrough_sha)
        pdf.ln(2)

    # -- Section 4: move-out registered IoU comparison ------------------
    if moveout:
        sections_rendered += 1
        heading("Move-Out Comparison")
        iou_text = _dossier_percent(moveout.get("iou"))
        if iou_text:
            row("IoU:", iou_text)
        registered_text = _dossier_percent(moveout.get("iou_registered"))
        if registered_text:
            row("Registered IoU:", registered_text)
        shift = _dossier_dict(moveout.get("registration_shift_px"))
        dx = _dossier_number(shift.get("dx"))
        dy = _dossier_number(shift.get("dy"))
        if dx is not None and dy is not None:
            row("Registration shift:", f"dx={dx:+.0f} px, dy={dy:+.0f} px")
        scale = _dossier_number(moveout.get("registration_scale"))
        if scale is not None:
            row("Registration scale:", f"{scale:.2f}x")
        day1 = _dossier_number(moveout.get("day1_area_px"))
        if day1 is not None:
            row("Day-1 area:", f"{day1:.0f} px")
        aligned_day1 = _dossier_number(moveout.get("aligned_day1_area_px"))
        if aligned_day1 is not None:
            row("Day-1 area (aligned):", f"{aligned_day1:.0f} px")
        moveout_area = _dossier_number(moveout.get("moveout_area_px"))
        if moveout_area is not None:
            row("Move-out area:", f"{moveout_area:.0f} px")
        growth = _dossier_number(moveout.get("area_growth_ratio"))
        if growth is not None:
            row("Residual area growth (after alignment):", f"{growth:.3f}")
        moveout_image = _dossier_entry_image(moveout_root, temp_files)
        if moveout_image is None:
            moveout_image = _dossier_entry_image(
                _dossier_dict(moveout_root.get("mask")), temp_files
            )
        if moveout_image is not None:
            embed_thumbnail(moveout_image, 55, 80)
        pdf.ln(2)

    if not sections_rendered:
        para("No case data supplied.")

    try:
        pdf.output(str(out_path))
    finally:
        for temp_path in temp_files:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass
    return {"pages": pdf.pages_count}
