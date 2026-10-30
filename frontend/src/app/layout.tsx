import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./kautionguard.css";
import KautionGuardProvider from "./KautionGuardProvider";
import AppShell from "./AppShell";

const LP_TITLE = "KautionGuard — Rental Contract Checker & Deposit Evidence";
const LP_DESCRIPTION =
  "Check your lease for unfair clauses — every flag shown with the exact words from your contract — and turn move-in photos and videos into a sealed deposit-evidence record.";

export const viewport: Viewport = {
  themeColor: "#F5F2EC",
};

export const metadata: Metadata = {
  title: LP_TITLE,
  description: LP_DESCRIPTION,
  keywords: [
    "rental contract checker",
    "tenancy deposit",
    "Kaution",
    "lease review",
    "tenant rights",
    "move-in evidence",
  ],
  authors: [{ name: "KautionGuard" }],
  robots: { index: true, follow: true },
  openGraph: {
    title: LP_TITLE,
    description: LP_DESCRIPTION,
    type: "website",
    siteName: "KautionGuard",
  },
  twitter: {
    card: "summary",
    title: LP_TITLE,
    description: LP_DESCRIPTION,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <KautionGuardProvider>
          <AppShell>{children}</AppShell>
        </KautionGuardProvider>
      </body>
    </html>
  );
}
