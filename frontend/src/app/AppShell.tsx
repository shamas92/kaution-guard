"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Cpu, Database, Mic, ScanEye, Wallet } from "lucide-react";
import { useKautionGuard } from "./KautionGuardProvider";
import { API_BASE_URL } from "../lib/api";
import { NOT_PROVIDED, ratio } from "../lib/uiHelpers";

// Display label for the backend-reported chat provider (`chat_provider`
// on /api/meta). Unknown values render as reported; a missing value
// falls back to NOT_PROVIDED - a provider is never assumed.
function providerLabel(provider: string | undefined): string {
  switch ((provider ?? "").toLowerCase()) {
    case "baseten":
      return "Baseten";
    case "meta":
      return "Meta";
    case "mock":
      return "Mock";
    default:
      return provider && provider.trim() !== "" ? provider : NOT_PROVIDED;
  }
}

// Host:port of the backend the shell polls for /api/meta, shown in
// the offline pill. Derived from the configured API base URL so the
// pill always names the backend actually being called (127.0.0.1:8000
// when NEXT_PUBLIC_API_BASE_URL points there; the built-in default in
// lib/api is localhost:8000).
const BACKEND_HOST = (() => {
  try {
    return new URL(API_BASE_URL).host;
  } catch {
    return API_BASE_URL;
  }
})();

// The three steps live in the header now, so every page carries the
// full journey. Short titles up front; the fuller explanation follows
// on each page head.
const STEPS = [
  { href: "/", step: "Step 1", title: "Check your contract" },
  { href: "/evidence", step: "Step 2", title: "Photograph the damage" },
  { href: "/move-out", step: "Step 3", title: "Compare at move-out" },
];

function HeaderSteps() {
  const pathname = usePathname();
  return (
    <nav className="kg-header-nav" aria-label="KautionGuard steps">
      {STEPS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "kg-header-nav-item",
              active && "kg-header-nav-item--active",
            )}
            aria-current={active ? "page" : undefined}
          >
            <span className="kg-header-nav-step">{item.step}</span>
            <span className="kg-header-nav-title">{item.title}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The compact command shell around every page: brand and tagline, the
 * two shell selections, the live cost telemetry, the demo preset bar
 * and the workspace menu navigation. Workflow state lives on the route
 * pages, never here.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { meta, metaError, refreshMeta } = useKautionGuard();
  const [budgetOpen, setBudgetOpen] = useState(false);

  const session = meta?.spend_usd.session ?? 0;
  const cumulative = meta?.spend_usd.cumulative ?? 0;
  const maxSession = meta?.limits_usd.max_session ?? 0;
  const maxCumulative = meta?.limits_usd.max_cumulative ?? 0;

  return (
    <div className="kg-root">
      <a className="kg-skip" href="#kg-main">
        Skip to main content
      </a>
      <header className="kg-header">
        <div className="kg-header-inner">
          <Link
            href="/"
            className="kg-brand"
            aria-current={pathname === "/" ? "page" : undefined}
          >
            <span className="kg-brand-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" />
                <path d="M9.3 12.2l2 2 3.6-4.2" />
              </svg>
            </span>
            <span>
              <span className="kg-brand-title">KautionGuard</span>{" "}
              <span className="kg-command-tag">
                Global AI Lease Auditor &amp; SAM 3.1 Deposit Shield
              </span>
            </span>
          </Link>
          <HeaderSteps />
          <div className="kg-header-right">
            <button
              type="button"
              className="kg-btn kg-btn--sm kg-budget-trigger"
              aria-expanded={budgetOpen}
              aria-controls="kg-budget-pop"
              onClick={() => setBudgetOpen((v) => !v)}
            >
              <Wallet size={14} aria-hidden="true" />{" "}
              {meta
                ? `$${session.toFixed(2)} of $${maxSession.toFixed(2)}`
                : "Budget"}
            </button>
            {budgetOpen && (
              <>
                <button
                  type="button"
                  className="kg-pop-overlay"
                  aria-label="Close budget panel"
                  onClick={() => setBudgetOpen(false)}
                />
                <section
                  id="kg-budget-pop"
                  role="dialog"
                  aria-labelledby="budget-heading"
                  className={clsx("kg-telemetry", "kg-budget-pop", metaError && "kg-telemetry--error", !meta && !metaError && "kg-telemetry--offline")}
                  onKeyDown={(e) => { if (e.key === "Escape") setBudgetOpen(false); }}
                >
                  <div className="kg-budget-pop-head">
                    <span id="budget-heading" className="kg-panel-title">Demo budget</span>
                    <button
                      type="button"
                      className="kg-btn kg-btn--sm kg-btn--ghost"
                      onClick={() => setBudgetOpen(false)}
                      autoFocus
                    >
                      Close
                    </button>
                  </div>
                  {metaError && (
                    <div
                      className="kg-backend-pill"
                      role="alert"
                      title={`Start the backend to load live spend figures - Budget panel unavailable: ${metaError}`}
                    >
                      <span className="kg-backend-dot" aria-hidden="true"></span>
                      <span>Backend offline ({BACKEND_HOST})</span>
                      <span className="kg-sr-only">
                        Budget panel unavailable: {metaError}. Costs can&apos;t
                        be shown until the backend responds.
                      </span>
                      <button
                        type="button"
                        className="kg-btn kg-btn--sm"
                        onClick={refreshMeta}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {!meta && !metaError && (
                    <p className="kg-sub">Starting up - connecting to the backend...</p>
                  )}
                  {meta && (
                    <>
                      <div className="kg-budget">
                        <div className="kg-budget-body">
                          <p className="kg-budget-line">
                            Free demo budget -{" "}
                            <strong>
                              ${session.toFixed(2)} of ${maxSession.toFixed(2)} used
                            </strong>
                          </p>
                          <div
                            className="kg-meter-track"
                            role="progressbar"
                            aria-valuenow={Math.round(ratio(session, maxSession) * 100)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuetext={`$${session.toFixed(2)} of $${maxSession.toFixed(2)} used`}
                            aria-label="Free demo budget used"
                          >
                            <div
                              className="kg-meter-fill kg-meter-fill--session"
                              style={{ width: `${ratio(session, maxSession) * 100}%` }}
                            />
                          </div>
                          <p className="kg-budget-sub">
                            Lifetime ${cumulative.toFixed(2)} of ${maxCumulative.toFixed(2)}
                          </p>
                        </div>
                      </div>
                      <ul className="kg-model-badges" aria-label="Helpers doing the work">
                        <li className="kg-model-badge" title={meta.models.chat_default}>
                          <Cpu size={13} aria-hidden="true" /> Lease reader - {providerLabel(meta.chat_provider)}
                        </li>
                        <li className="kg-model-badge" title={meta.models.sam31}>
                          <ScanEye size={13} aria-hidden="true" /> Damage camera - {meta.models.sam31}
                        </li>
                        <li className="kg-model-badge" title={meta.models.voice}>
                          <Mic size={13} aria-hidden="true" /> Voice notes
                        </li>
                        <li className={clsx("kg-model-badge", meta.disk_cache && "kg-model-badge--live")} title="Disk cache">
                          <Database size={13} aria-hidden="true" /> {meta.disk_cache ? "Saving on" : "Saving off"}
                        </li>
                      </ul>
                      {meta.ledger_note && (
                        <p className="kg-disclaimer">{meta.ledger_note}</p>
                      )}
                    </>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </header>
      <main id="kg-main" tabIndex={-1} className="kg-workspace">
        <AnimatePresence mode="wait" initial={false}><motion.div key={pathname} className="kg-page-motion" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18, ease: "easeOut" }}>{children}</motion.div></AnimatePresence>
      </main>
      {pathname !== "/" && (
      <footer className="kg-footer">
        <div>
          <p className="kg-footer-title">What KautionGuard is</p>
          <p className="kg-footer-note">Information, not legal advice.</p>
        </div>
        <div>
          <p className="kg-footer-title">Data</p>
          <p className="kg-footer-note">
            Uploads are stored by the app&apos;s backend; saved outlines stay
            in this browser.
          </p>
        </div>
        <div>
          <p className="kg-footer-title">Coverage</p>
          <p className="kg-footer-note">
            Germany | UK | New York | France | Japan
          </p>
        </div>
        <nav aria-label="KautionGuard steps">
          <p className="kg-footer-title">Steps</p>
          <p className="kg-footer-note">
            {STEPS.map((step, index) => (
              <span key={step.href}>
                {index > 0 && " | "}
                <Link href={step.href}>{step.step}: {step.title}</Link>
              </span>
            ))}
          </p>
        </nav>
      </footer>
      )}
    </div>
  );
}
