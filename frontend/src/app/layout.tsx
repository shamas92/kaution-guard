import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./kautionguard.css";
import KautionGuardProvider from "./KautionGuardProvider";
import AppShell from "./AppShell";

export const metadata: Metadata = {
  title: "KautionGuard",
  description: "Tenant document review and apartment evidence workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="de">
      <body>
        <KautionGuardProvider>
          <AppShell>{children}</AppShell>
        </KautionGuardProvider>
      </body>
    </html>
  );
}
