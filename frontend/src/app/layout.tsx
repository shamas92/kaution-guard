import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Newsreader, Plus_Jakarta_Sans } from "next/font/google";
import "./leaselens.css";
import LeaseLensProvider from "./LeaseLensProvider";
import AppShell from "./AppShell";

const TITLE = "LeaseLens — Global AI Lease Auditor & SAM 3.1 Deposit Shield";
const DESCRIPTION =
  "Check your lease for unfair clauses — every flagged quote is verified word-for-word against your uploaded contract and the law registry — and turn move-in photos and videos into SAM 3.1 damage outlines with a tamper-evident handover report. For tenants in Berlin, London, Paris, New York and Tokyo.";

const serifDossier = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-serif-dossier",
});

const sansDossier = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-sans-dossier",
});

const monoDossier = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-mono-dossier",
});

export const viewport: Viewport = {
  themeColor: "#F7F5F0",
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "rental contract checker",
    "tenancy deposit",
    "Kaution",
    "lease review",
    "tenant rights",
    "move-in evidence",
  ],
  authors: [{ name: "LeaseLens" }],
  robots: { index: true, follow: true },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "LeaseLens",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${serifDossier.variable} ${sansDossier.variable} ${monoDossier.variable}`}
    >
      <body>
        <LeaseLensProvider>
          <AppShell>{children}</AppShell>
        </LeaseLensProvider>
      </body>
    </html>
  );
}
