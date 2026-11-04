"""Generate local synthetic demo assets for LeaseLens.

Creates fictional leases under ``backend/storage/samples/`` using fpdf2,
plus a synthetic walkthrough video when FFmpeg is already installed.
Also copies curated real-world demo assets (an anonymised dorm contract,
photos and walkthrough videos) from ``backend/demo-assets/`` into
``backend/storage/samples/`` when present; the curated narrated video
then serves as the walkthrough sample, and the synthetic video is
generated only as a fallback when that asset is missing.
It also seeds the Step 3 move-out comparison assets (the zoom half of
the table-burn pair) from the same copy step, with a deterministic
Pillow-generated fallback, so the Move-Out Comparator demo chip works
on a fresh clone without manual file staging.
Nothing here calls any AI API, touches credit_shield.sqlite, or reads .env.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from fpdf import FPDF

BASE_DIR = Path(__file__).resolve().parent
SAMPLES_DIR = BASE_DIR / "storage" / "samples"
DEMO_ASSETS_DIR = BASE_DIR / "demo-assets"

# Curated real-world demo assets tracked in backend/demo-assets/ (an
# anonymised dorm contract, dorm defect photos and walkthrough videos).
# Each entry maps one source file to its destination name(s) under
# storage/samples/. Missing sources are skipped, not fatal.
DEMO_ASSET_COPIES = (
    ("dorm-walkthrough-narrated-v2.mp4", ("sample_walkthrough.mp4",)),
    ("dorm-walkthrough-silent.mp4", ("dorm_walkthrough_silent.mp4",)),
    ("dorm-open-socket.jpg", ("sample_defect_photo.jpg", "dorm_open_socket.jpg")),
    ("dorm-doorframe-dent.jpg", ("dorm_doorframe_dent.jpg",)),
    ("dorm-table-burn.jpg", ("dorm_table_burn.jpg",)),
    # Zoom half of the burn pair: the Step 3 move-out photo. Its partner
    # (dorm-table-burn.jpg above) is the move-in reference the frontend
    # segments; the comparator chip fetches dorm_table_burn_moveout.jpg.
    ("dorm-burn-mark-zoom.jpg", ("sample_moveout_burn.jpg", "dorm_table_burn_moveout.jpg")),
    # Damage-spread variant of the move-out burn photo: the same real
    # photo with the burn enlarged from its own pixels (x1.69 area),
    # so the Step 3 comparison shows a visible area growth.
    ("dorm-table-burn-moveout-grown.jpg", ("dorm_table_burn_moveout_grown.jpg",)),
    # The user's own second move-out photo of the burn (tighter,
    # near-square phone shot), added 2026-11-04 as a fourth sample.
    ("dorm-table-burn-moveout-2.jpg", ("dorm_table_burn_moveout_2.jpg",)),
    ("dorm-vertrag-planted.pdf", ("sample_dorm_contract.pdf",)),
    ("dorm-vertrag-clean.pdf", ("dorm_vertrag_clean.pdf",)),
)

FICTIONAL_BANNER = (
    "FICTIONAL DEMO DOCUMENT - all names, addresses and figures are invented "
    "for software testing. Not a real lease."
)

BERLIN_BODY = """MIETVERTRAG - Wohnung, Berlin (fiktiv)

Vermieter: Erika Mustermann, Musterstr. 1, 10115 Berlin
Mieter: Max Beispiel, Beispielweg 2, 10243 Berlin

1. Mietgegenstand: 2-Zimmer-Wohnung, 3. OG, ca. 58 qm, inkl. Kueche und Bad.
2. Miete: Monatliche Kaltmiete 650 EUR, Betriebskostenvorauszahlung 120 EUR.
3. Kaution: 1.950 EUR (3 x 650 EUR Kaltmiete), zahlbar in drei Monatsraten.
4. Kleinreparaturen: Der Mieter traegt die Kosten kleiner Instandhaltungen
   bis zu 150 EUR je Einzelfall.
5. Schoenheitsreparaturen: Der Mieter renoviert nach starrem Fristenplan -
   Kueche, Bad und WC alle drei Jahre, Wohn- und Schlafzimmer alle fuenf
   Jahre, jeweils vollstaendig, unabhaengig vom tatsaechlichen Zustand.
6. Rueckgabe: Die Wohnung ist besenrein zurueckzugeben; die Kaution wird nach
   Pruefung und Abrechnung zurueckgezahlt.

Unterschriften: ________________ (Vermieter)  ________________ (Mieter)"""

LONDON_BODY = """ASSURED SHORTHOLD TENANCY AGREEMENT (fictional demo)

Landlord: A. Landlord, 1 Example Road, London E1 6AN
Tenant: J. Tenant, Flat 4, 2 Sample Street, London E2 8DP

1. Property: One-bedroom flat, second floor, including kitchen and bathroom.
2. Rent: 1,450 GBP per calendar month, payable in advance.
3. Deposit: Eight weeks' rent (2,676.92 GBP), protected in a deposit scheme.
4. Exit cleaning: The tenant must pay a mandatory professional exit-cleaning
   charge of 300 GBP at check-out, deducted from the deposit.
5. Repairs: The tenant must report defects promptly; fair wear and tear is
   expected during normal use.
6. End of tenancy: The flat must be returned in the condition recorded in the
   check-in inventory, allowing for fair wear and tear.

Signatures: ________________ (Landlord)  ________________ (Tenant)"""

PARIS_BODY = """BAIL D'HABITATION NON MEUBLEE (document fictif de demonstration)

Bailleur: Marie Exemple, 1 rue des Tests, 75011 Paris
Locataire: Jean Exemple, 2 avenue des Demos, 75020 Paris

1. Logement: Appartement de 2 pieces, 3eme etage, environ 45 m2, non meuble.
2. Loyer: 1.100 EUR par mois, hors charges (120 EUR de provision).
3. Depot de garantie: Deux mois de loyer hors charges, soit 2.200 EUR,
   verse a la signature du bail.
4. Vetuste: Le locataire renonce au benefice de la vetuste liee au temps
   et a un usage normal; toute trace d'usure sera facturee a la sortie.
5. Etat des lieux: Etabli contradictoirement a l'entree et a la sortie.
6. Restitution: Le depot est restitue apres l'etat des lieux de sortie,
   deduction faite des sommes justifiees.

Signatures: ________________ (Bailleur)  ________________ (Locataire)"""

CONTRACTS = (
    ("sample_berlin_mietvertrag.pdf", "Mietvertrag - Berlin (Demo)", BERLIN_BODY),
    ("sample_london_ast_lease.pdf", "AST Lease - London (Demo)", LONDON_BODY),
    ("sample_paris_bail.pdf", "Bail - Paris (Demo)", PARIS_BODY),
)

# Concise one-page digest of the anonymised Studentenwerk dorm
# contract (the full planted contract stays untouched in
# demo-assets/dorm-vertrag-planted.pdf for the unit tests). The
# clause sentences mirror the planted originals verbatim, so a live
# decode flags the same five planted defects and quote verification
# passes; the rent/deposit figures feed the deterministic deposit
# math (178.47 cold rent, 950.00 deposit -> 535.41 cap, 414.59 over).
DORM_SHORT_TITLE = "Mietvertrag - Studentenwohnheim (Demo-Kurzfassung)"

DORM_SHORT_SECTIONS = (
    (
        None,
        "Studentenwerk Musterstadt\n"
        "Geschäftsbereich Wohnen · Musterstraße 18 · 01099 Musterstadt\n"
        "Vermieter: Studentenwerk Musterstadt, Anstalt des öffentlichen Rechts\n"
        "Mieter: Max Mustermann, geb. am 01.01.2000, Debitorennummer 0000000\n"
        "Mietsache: Ein-Bett-Zimmer A101 in einer 4er WG, vollmöbliert, "
        "Musterweg 12, 01099 Musterstadt, ca. 11,01 qm\n"
        "Mietzeit: 16.09.2026 bis 30.09.2028 (befristet)\n"
        "Gesamtpauschalmiete: 257,38 EUR monatlich\n"
        "Darin enthaltene Nettokaltmiete: 178,47 EUR; pauschale Umlage "
        "inkl. Strom: 78,91 EUR",
    ),
    (
        "§ 3 Kaution",
        "Die vor dem Einzug zu zahlende Kaution beträgt 950,00 EUR.",
    ),
    (
        "§ 7a Kleinreparaturen",
        "Der Mieter trägt die Kosten kleiner Instandhaltungen an den ihm "
        "zugänglichen Teilen der Mietsache bis zu 175 EUR je Einzelfall "
        "selbst. Eine jährliche Obergrenze der vom Mieter zu tragenden "
        "Kosten besteht nicht. Übersteigen die Kosten einer Reparatur "
        "175 EUR, trägt sie der Vermieter.",
    ),
    (
        "§ 9a Besucherregelung",
        "Übernachtungsbesuche sind dem Mieter untersagt. Besucher haben "
        "das Wohnheim bis spätestens 20:00 Uhr zu verlassen.",
    ),
    (
        "§ 12 Pflichten nach Beendigung des Mietverhältnisses",
        "(5) Bei Auszug wird eine pauschale Endreinigungsgebühr von "
        "250 EUR von der Kaution einbehalten. Dies gilt unabhängig vom "
        "tatsächlichen Reinigungszustand der Mietsache und auch dann, "
        "wenn der Mieter die Mietsache in gesäubertem Zustand übergibt.",
    ),
    (
        "§ 13 Schönheitsreparaturen",
        "(1) Der Mieter hat Schönheitsreparaturen auf seine Kosten "
        "spätestens alle 3 Jahre in Küche und Bad, alle 5 Jahre in den "
        "Wohnräumen und alle 7 Jahre in den Nebenräumen auszuführen, und "
        "zwar unabhängig vom tatsächlichen Zustand der Mietsache und "
        "unabhängig davon, ob die Räume bei Mietbeginn renoviert "
        "übergeben wurden. Bei Auszug ist die Wohnung in jedem Fall "
        "frisch gestrichen und mit neuem Farbanstrich zu übergeben.",
    ),
    (
        None,
        "Unterschriften: ________________ (Vermieter)   "
        "________________ (Mieter)",
    ),
)


def _write_pdf(filename: str, title: str, body: str) -> Path:
    for chunk in (FICTIONAL_BANNER, title, body):
        chunk.encode("cp1252")  # fail fast: fpdf2 core fonts cover cp1252 only
    pdf = FPDF()
    pdf.set_auto_page_break(True, margin=20)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 14)
    pdf.multi_cell(0, 7, FICTIONAL_BANNER, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 18)
    pdf.multi_cell(0, 9, title, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.set_font("Helvetica", "", 12)
    pdf.multi_cell(0, 6, body, new_x="LMARGIN", new_y="NEXT")
    out = SAMPLES_DIR / filename
    pdf.output(str(out))
    return out


def _write_dorm_short_pdf() -> Path:
    """Write the one-page dorm-contract digest (sample_dorm_short.pdf).

    Compact layout (11pt body, bold clause headings) so the whole
    digest — header figures plus the five planted clauses — fits a
    single page and the Visual Annotated Contract viewer shows every
    highlight on Page 1.
    """
    for chunk in (FICTIONAL_BANNER, DORM_SHORT_TITLE):
        chunk.encode("cp1252")  # fail fast: fpdf2 core fonts cover cp1252 only
    for heading, body in DORM_SHORT_SECTIONS:
        if heading is not None:
            heading.encode("cp1252")
        body.encode("cp1252")
    pdf = FPDF()
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 11)
    pdf.multi_cell(0, 5.5, FICTIONAL_BANNER, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 15)
    pdf.multi_cell(0, 7.5, DORM_SHORT_TITLE, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)
    for heading, body in DORM_SHORT_SECTIONS:
        if heading is not None:
            pdf.ln(2)
            pdf.set_font("Helvetica", "B", 11.5)
            pdf.multi_cell(0, 5.5, heading, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
        pdf.multi_cell(0, 5.5, body, new_x="LMARGIN", new_y="NEXT")
    out = SAMPLES_DIR / "sample_dorm_short.pdf"
    pdf.output(str(out))
    return out


def _write_video() -> Path | None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        print("SKIP sample_walkthrough.mp4: FFmpeg is not available "
              "(not searching for or installing it).")
        return None
    out = SAMPLES_DIR / "sample_walkthrough.mp4"
    seg1 = SAMPLES_DIR / "_seg1.mp4"
    seg2 = SAMPLES_DIR / "_seg2.mp4"
    wood = f"color=c=0x8B5A2B:s=1280x720:r=30:d=5[bg];[bg]drawbox=x=500:y=300:w=300:h=12:color=black@0.9:thickness=fill:enable='gte(t,3)',format=yuv420p"
    tile = f"color=c=0x9AA5A8:s=1280x720:r=30:d=5[bg];[bg]drawbox=x=640:y=200:w=10:h=320:color=black@0.9:thickness=fill:enable='gte(t,2)',format=yuv420p"
    silence = ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=5"]
    for seg, filt in ((seg1, wood), (seg2, tile)):
        proc = subprocess.run(
            [ffmpeg, "-y", "-f", "lavfi", "-i", filt, *silence,
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
             "-shortest", str(seg)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(f"SKIP sample_walkthrough.mp4: FFmpeg failed: {proc.stderr[-300:]}")
            return None
    concat = SAMPLES_DIR / "_concat.txt"
    concat.write_text(f"file '{seg1.name}'\nfile '{seg2.name}'\n", encoding="utf-8")
    proc = subprocess.run(
        [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
         "-c", "copy", str(out)],
        capture_output=True, text=True,
    )
    seg1.unlink(missing_ok=True)
    seg2.unlink(missing_ok=True)
    concat.unlink(missing_ok=True)
    if proc.returncode != 0:
        print(f"SKIP sample_walkthrough.mp4: concat failed: {proc.stderr[-300:]}")
        return None
    return out


def _copy_demo_assets() -> set[str]:
    """Copy curated assets from DEMO_ASSETS_DIR into SAMPLES_DIR.

    Returns the set of destination filenames written, so main() can
    tell whether the synthetic fallbacks are still needed. A missing
    source prints a SKIP line and is not fatal.
    """
    written: set[str] = set()
    for src_name, dst_names in DEMO_ASSET_COPIES:
        src = DEMO_ASSETS_DIR / src_name
        if not src.is_file():
            for dst_name in dst_names:
                print(f"SKIP {dst_name}: demo asset {src_name} not found "
                      f"in {DEMO_ASSETS_DIR} (continuing without it).")
            continue
        for dst_name in dst_names:
            dst = SAMPLES_DIR / dst_name
            shutil.copyfile(src, dst)
            written.add(dst_name)
            print(f"COPIED {src} -> {dst} ({dst.stat().st_size} bytes)")
    return written


def _write_moveout_burn_fallback(samples_dir: Path, demo_assets_dir: Path) -> list[Path]:
    """Deterministically generate the Step 3 move-out burn photo.

    Used only when the curated zoom asset (dorm-burn-mark-zoom.jpg) was
    not copied from demo-assets. Writes both destination names with
    identical bytes as valid 600x400 JPEGs: preferably a centre crop of
    the tracked dorm-table-burn.jpg (the middle 50% of the frame is the
    zoom region the real asset shows); if that photo is missing too, a
    synthetic placeholder drawn with Pillow primitives. No randomness
    anywhere, so repeated runs produce identical files.
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("SKIP move-out burn fallback: Pillow is not available "
              "(not searching for or installing it).")
        return []
    try:
        resample = Image.Resampling.LANCZOS
    except AttributeError:  # older Pillow
        resample = Image.LANCZOS

    image = None
    burn_photo = demo_assets_dir / "dorm-table-burn.jpg"
    if burn_photo.is_file():
        try:
            with Image.open(burn_photo) as src:
                src = src.convert("RGB")
                width, height = src.size
                crop = src.crop((
                    int(width * 0.25), int(height * 0.25),
                    int(width * 0.75), int(height * 0.75),
                ))
                image = crop.resize((600, 400), resample)
        except Exception as exc:  # unreadable source: fall through to synthetic
            print(f"Move-out burn fallback: centre crop of {burn_photo} "
                  f"failed ({exc}); drawing the synthetic placeholder.")
            image = None
    if image is None:
        # Synthetic placeholder: light warm-grey table surface, a table
        # edge band, and a dark burn blob slightly right of centre.
        image = Image.new("RGB", (600, 400), (216, 211, 203))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 252, 600, 264), fill=(148, 116, 84))
        draw.line((0, 252, 600, 252), fill=(104, 80, 58), width=2)
        cx, cy = 350, 180
        draw.ellipse((cx - 64, cy - 44, cx + 64, cy + 44), fill=(188, 174, 158))
        draw.ellipse((cx - 46, cy - 32, cx + 46, cy + 32), fill=(74, 52, 38))
        draw.ellipse((cx - 30, cy - 21, cx + 30, cy + 21), fill=(38, 30, 26))
        draw.ellipse((cx - 16, cy - 11, cx + 16, cy + 11), fill=(12, 10, 9))

    import io

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88)
    payload = buffer.getvalue()
    samples_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name in ("sample_moveout_burn.jpg", "dorm_table_burn_moveout.jpg"):
        out = samples_dir / name
        out.write_bytes(payload)
        written.append(out)
    return written


def main() -> int:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for filename, title, body in CONTRACTS:
        out = _write_pdf(filename, title, body)
        print(f"WROTE {out} ({out.stat().st_size} bytes)")
    out = _write_dorm_short_pdf()
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    copied = _copy_demo_assets()
    if "dorm_table_burn_moveout.jpg" not in copied:
        # Fallback only: the curated zoom crop from demo-assets/ is the
        # real move-out photo when present.
        print("FALLBACK move-out burn assets: dorm-burn-mark-zoom.jpg was "
              "not found in demo-assets; generating a deterministic "
              "substitute so the Step 3 demo still works.")
        for out in _write_moveout_burn_fallback(SAMPLES_DIR, DEMO_ASSETS_DIR):
            print(f"WROTE {out} ({out.stat().st_size} bytes)")
    if "sample_walkthrough.mp4" not in copied:
        # Fallback only: the curated narrated walkthrough from
        # demo-assets/ replaces the synthetic video when present.
        video = _write_video()
        if video is not None:
            print(f"WROTE {video} ({video.stat().st_size} bytes)")
    print("Done. No API calls made; credit_shield.sqlite untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
