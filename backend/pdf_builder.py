"""Handover-condition PDF reports built with fpdf2.

Reads legal wording only from the caller-supplied ``jurisdiction_pack``;
no legal claims beyond that data are made here.
"""

from __future__ import annotations

import unicodedata
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
