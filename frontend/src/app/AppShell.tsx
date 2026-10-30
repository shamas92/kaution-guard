"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useKautionGuard } from "./KautionGuardProvider";
import {
  LANGUAGES,
  NOT_PROVIDED,
  jurisdictionLabel,
  ratio,
} from "../lib/uiHelpers";

// Display label for the backend-reported chat provider (`chat_provider`
// on /api/meta). Unknown values render as reported; a missing value
// falls back to NOT_PROVIDED — a provider is never assumed.
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

const STEPS = [
  { href: "/contract", label: "1 · Check your contract" },
  { href: "/evidence", label: "2 · Photograph the damage" },
  { href: "/move-out", label: "3 · Compare when you move out" },
];

function StepNavigation() {
  const pathname = usePathname();
  return (
    <nav className="kg-tabs" aria-label="KautionGuard steps">
      <div className="kg-tab-list">
        {STEPS.map((step) => {
          const active = pathname === step.href;
          return (
            <Link
              key={step.href}
              href={step.href}
              className={`kg-tab${active ? " kg-tab--active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {step.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The slim shell around every page: brand, the two shell selections,
 * the live cost meter and the step navigation. Workflow state lives
 * on the route pages, never here.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const {
    meta,
    metaError,
    jurisdictions,
    jurisdiction,
    setJurisdiction,
    language,
    setLanguage,
  } = useKautionGuard();

  const session = meta?.spend_usd.session ?? 0;
  const cumulative = meta?.spend_usd.cumulative ?? 0;
  const maxSession = meta?.limits_usd.max_session ?? 0;
  const maxCumulative = meta?.limits_usd.max_cumulative ?? 0;

  return (
    <main className="kg-root">
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
              <span className="kg-brand-title">KautionGuard</span>
            </span>
          </Link>
          <div className="kg-header-center">
            <div className="kg-header-field">
              <label htmlFor="jurisdiction" className="kg-label">
                Where is your lease?
              </label>
              <select
                id="jurisdiction"
                className="kg-control"
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
              >
                {jurisdictions.map((code) => (
                  <option key={code} value={code}>
                    {jurisdictionLabel(code)}
                  </option>
                ))}
              </select>
            </div>
            <div className="kg-header-field">
              <label htmlFor="tenant-language" className="kg-label">
                Letter &amp; document language
              </label>
              <select
                id="tenant-language"
                className="kg-control"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                aria-describedby="language-hint"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p id="language-hint" className="kg-label-hint">
                For the dispute letter and the handover report. The app
                itself stays in English.
              </p>
            </div>
          </div>
          <div className="kg-header-right">
            <section
              className={`kg-telemetry${metaError ? " kg-telemetry--error" : ""}${!meta && !metaError ? " kg-telemetry--offline" : ""}`}
              aria-labelledby="budget-heading"
            >
              <h2 id="budget-heading" className="kg-sr-only">
                Budget status
              </h2>
              {metaError && (
                <p role="alert" className="kg-alert kg-alert--error">
                  Budget panel unavailable: {metaError}. Is the backend running on
                  port 8000?
                </p>
              )}
              {meta && (
                <>
                  <div className="kg-meter">
                    <div className="kg-meter-head">
                      <span className="kg-meter-label">
                        Cost so far in this visit
                      </span>
                      <span className="kg-meter-value">
                        ${session.toFixed(2)} of ${maxSession.toFixed(2)}
                      </span>
                    </div>
                    <div
                      className="kg-meter-track"
                      role="progressbar"
                      aria-valuenow={Math.round(ratio(session, maxSession) * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Cost so far in this visit"
                    >
                      <div
                        className="kg-meter-fill kg-meter-fill--session"
                        style={{ width: `${ratio(session, maxSession) * 100}%` }}
                      />
                    </div>
                  </div>
                  <details className="kg-tech-details kg-shell-tech">
                    <summary>Technical details</summary>
                    <p className="kg-telemetry-badge">
                      <span className="kg-telemetry-provider">
                        {providerLabel(meta.chat_provider)}
                      </span>{" "}
                      <span className="kg-telemetry-model">
                        {meta.models.chat_default}
                      </span>
                    </p>
                    <div className="kg-meter">
                      <div className="kg-meter-head">
                        <span className="kg-meter-label">Cost in total</span>
                        <span className="kg-meter-value">
                          ${cumulative.toFixed(2)} of ${maxCumulative.toFixed(2)}
                        </span>
                      </div>
                      <div
                        className="kg-meter-track"
                        role="progressbar"
                        aria-valuenow={Math.round(ratio(cumulative, maxCumulative) * 100)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="Cost in total"
                      >
                        <div
                          className="kg-meter-fill kg-meter-fill--cumulative"
                          style={{ width: `${ratio(cumulative, maxCumulative) * 100}%` }}
                        />
                      </div>
                    </div>
                  </details>
                  {meta.ledger_note && (
                    <p className="kg-disclaimer">{meta.ledger_note}</p>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      </header>
      <div className="kg-workspace">
        <StepNavigation />
        {children}
      </div>
    </main>
  );
}
