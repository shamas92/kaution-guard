"""Generate local synthetic demo assets for KautionGuard.

Creates fictional leases under ``backend/storage/samples/`` using fpdf2,
plus a synthetic walkthrough video when FFmpeg is already installed.
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


def main() -> int:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for filename, title, body in CONTRACTS:
        out = _write_pdf(filename, title, body)
        print(f"WROTE {out} ({out.stat().st_size} bytes)")
    video = _write_video()
    if video is not None:
        print(f"WROTE {video} ({video.stat().st_size} bytes)")
    print("Done. No API calls made; credit_shield.sqlite untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
