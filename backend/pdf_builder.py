"""Handover-condition PDF reports built with fpdf2.

Reads legal wording only from the caller-supplied ``jurisdiction_pack``;
no legal claims beyond that data are made here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from fpdf import FPDF

# Conventional project-local locations for a bundled Unicode TTF.
FONT_SEARCH_DIRS = ("fonts", "assets/fonts", "assets")
FONT_FAMILY = "KautionGuard"

# fpdf2 core fonts only cover cp1252; anything else needs a bundled TTF.
_CORE_ENCODING = "cp1252"


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


def _collect_texts(
    jurisdiction_pack: Mapping[str, Any],
    user_language: str,
    evidence_sha256: str,
    defects: list[Mapping[str, Any]],
) -> list[str]:
    """Gather every string that will be written, for encodability checks."""
    texts = [
        "KautionGuard",
        str(jurisdiction_pack.get("protocol_title", "")),
        str(jurisdiction_pack.get("country_name", "")),
        str(jurisdiction_pack.get("official_language", "")),
        str(user_language),
        str(evidence_sha256),
        str(jurisdiction_pack.get("statutes", "")),
        str(jurisdiction_pack.get("dispute_title", "")),
    ]
    for defect in defects:
        texts.extend(
            str(defect.get(key, ""))
            for key in (
                "timestamp",
                "sam_confidence",
                "area_percent",
                "description_local",
                "description_tenant",
                "image_path",
            )
        )
    return texts


def _ensure_encodable(texts: list[str]) -> None:
    """Fail fast instead of writing corrupted (e.g. '????') characters."""
    for text in texts:
        try:
            text.encode(_CORE_ENCODING)
        except UnicodeEncodeError as exc:
            raise UnicodeFontMissingError(
                "Non-ASCII legal text cannot be rendered: no Unicode TTF is "
                "bundled with the project (fpdf2 core fonts cover cp1252 "
                "only). Add e.g. backend/fonts/DejaVuSans.ttf "
                "(plus a bold face) and retry; refusing to emit corrupted "
                f"characters. Offending text starts with: {text[:80]!r}"
            ) from exc


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
    if not unicode_font:
        _ensure_encodable(
            _collect_texts(jurisdiction_pack, user_language, evidence_sha256, defects)
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
    heading("KautionGuard", 20)
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
        field("SAM confidence", str(defect.get("sam_confidence", "")))
        field("Mask area", f"{defect.get('area_percent', '')} % of frame")
        field(
            f"Description ({jurisdiction_pack.get('official_language', 'local')})",
            str(defect.get("description_local", "")),
        )
        field(
            f"Translation ({user_language})",
            str(defect.get("description_tenant", "")),
        )
        image_path = str(defect.get("image_path", ""))
        if image_path and Path(image_path).is_file():
            if pdf.get_y() > 200:
                pdf.add_page()
            pdf.image(image_path, w=170)
            pdf.ln(2)
        else:
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

    pdf.output(str(out_path))
    return str(out_path)
