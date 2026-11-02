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
        pdf.cell(58, 6, safe(label))
        pdf.set_font(body, "", 11)
        pdf.multi_cell(0, 6, safe(value), new_x="LMARGIN", new_y="NEXT")

    contract = _dossier_dict(data.get("contract"))
    draft = _dossier_dict(data.get("draft"))
    evidence = _dossier_dict(data.get("evidence"))
    moveout = _dossier_dict(_dossier_dict(data.get("moveout")).get("comparison"))

    sections_rendered = 0

    pdf.add_page()
    heading("KautionGuard \u2014 Master Case Dossier", 18)
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
    if contract and (issue_items or deposit_math or locale_text):
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
    if ref_items or walkthrough_sha:
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
        day1 = _dossier_number(moveout.get("day1_area_px"))
        if day1 is not None:
            row("Day-1 area:", f"{day1:.0f} px")
        moveout_area = _dossier_number(moveout.get("moveout_area_px"))
        if moveout_area is not None:
            row("Move-out area:", f"{moveout_area:.0f} px")
        growth = _dossier_number(moveout.get("area_growth_ratio"))
        if growth is not None:
            row("Area growth ratio:", f"{growth:.3f}")
        pdf.ln(2)

    if not sections_rendered:
        para("No case data supplied.")

    pdf.output(str(out_path))
    return {"pages": pdf.pages_count}
