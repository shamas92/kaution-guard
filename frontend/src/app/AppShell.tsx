"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useKautionGuard } from "./KautionGuardProvider";
import { API_BASE_URL } from "../lib/api";
import { writeDemoHandoff } from "../lib/handoff";
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

// The footer keeps the numbered step wording; the workspace menu in
// <main> carries the fuller names.
const STEPS = [
  { href: "/contract", label: "1 · Check your contract" },
  { href: "/evidence", label: "2 · Photograph the damage" },
  { href: "/move-out", label: "3 · Compare when you move out" },
];

const MENU_ITEMS = [
  { href: "/contract", label: "Contract Review & Notice" },
  { href: "/evidence", label: "Defect HUD & Walkthrough" },
  { href: "/move-out", label: "Move-Out Comparator" },
];

function MenuNavigation() {
  const pathname = usePathname();
  return (
    <nav className="kg-menu" aria-label="KautionGuard workspaces">
      {MENU_ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`kg-menu-item${active ? " kg-menu-item--active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Demo preset loading, replicated from the landing page's demo panel
 * (LandingDemo in landing-client.tsx): same POST, same error-detail
 * parsing, same ~1.2s progress animation, same handoff payloads. The
 * shell adaptation: the bar lives on every page, so once a lease
 * preset loads, its sample contract is handed to the contract page
 * and the browser navigates there; the sample-video handoff button
 * stays in the bar (the shell persists across navigation).
 */
interface DemoPreset {
  preset_id: string;
  jurisdiction_code: string;
  title: string;
  description: string;
  contract_pdf_url: string;
  walkthrough_video_url: string | null;
  walkthrough_video_available: boolean;
  demo_issues: string[];
  review_note: string;
}

const DEMO_CHOICES = [
  { id: "DE", label: "DE Berlin Lease" },
  { id: "UK", label: "UK London AST" },
  { id: "FR", label: "FR Paris Bail" },
];

function animateProgress(setter: (v: number) => void, ms = 1200): Promise<void> {
  return new Promise((resolve) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setter(100);
      resolve();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setter(Math.round(t * 100));
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function DemoPresetBar() {
  const router = useRouter();
  const { setJurisdiction } = useKautionGuard();

  const [demoLoading, setDemoLoading] = useState(false);
  const [demoProgress, setDemoProgress] = useState(0);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<DemoPreset | null>(null);

  async function onLoadDemo(presetId: string) {
    setDemoLoading(true);
    setDemoError(null);
    setDemoProgress(0);
    try {
      const fetchPreset = (async (): Promise<DemoPreset> => {
        const response = await fetch(`${API_BASE_URL}/api/load-demo-preset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset_id: presetId }),
        });
        if (!response.ok) {
          let message = `Demo load failed (${response.status})`;
          try {
            const body = await response.json();
            if (typeof body?.detail === "string") message = body.detail;
          } catch {
            /* keep default message */
          }
          throw new Error(message);
        }
        return response.json();
      })();
      const [, preset] = await Promise.all([
        animateProgress(setDemoProgress),
        fetchPreset,
      ]);
      setDemoResult(preset);
      setJurisdiction(preset.jurisdiction_code);
      if (preset.contract_pdf_url) {
        const written = writeDemoHandoff({
          version: 1,
          kind: "contract",
          presetId: preset.preset_id,
          assetUrl: preset.contract_pdf_url,
          fileName:
            preset.contract_pdf_url.split("/").pop() || "sample_contract.pdf",
          createdAt: Date.now(),
        });
        if (!written) {
          setDemoError(
            "Could not pass the sample to the contract page — this browser blocked the handoff storage.",
          );
          return;
        }
        router.push("/contract");
      }
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : "Demo load failed");
    } finally {
      setDemoLoading(false);
    }
  }

  function onUseSampleVideo() {
    // Mirrors the landing demo: the button only renders when the demo
    // response provides both the URL and the availability flag.
    if (!demoResult?.walkthrough_video_available) return;
    const videoUrl = demoResult.walkthrough_video_url;
    if (!videoUrl) return;
    const written = writeDemoHandoff({
      version: 1,
      kind: "video",
      presetId: demoResult.preset_id,
      assetUrl: videoUrl,
      fileName: "sample_walkthrough.mp4",
      createdAt: Date.now(),
    });
    if (!written) {
      setDemoError(
        "Could not pass the sample to the evidence page — this browser blocked the handoff storage.",
      );
      return;
    }
    router.push("/evidence");
  }

  return (
    <div className="kg-demo-bar">
      <span className="kg-demo-label">⚡ LOAD DEMO PRESET ($0.00):</span>
      {DEMO_CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="kg-btn kg-btn--sm"
          disabled={demoLoading}
          onClick={() => onLoadDemo(choice.id)}
        >
          {choice.label}
        </button>
      ))}
      {demoResult && (
        <span className="kg-sub">{demoResult.title}</span>
      )}
      {demoResult &&
        demoResult.walkthrough_video_available &&
        demoResult.walkthrough_video_url && (
          <button
            type="button"
            className="kg-btn kg-btn--sm kg-btn--primary"
            disabled={demoLoading}
            onClick={onUseSampleVideo}
          >
            Use This Sample Video in Walkthrough ($0.00)
          </button>
        )}
      {demoResult && !demoResult.walkthrough_video_available && (
        <span className="kg-sub">
          No sample walkthrough video on this host (FFmpeg is not
          available); video processing stays disabled for the demo.
        </span>
      )}
      {demoLoading && (
        <div
          className="kg-bar"
          role="progressbar"
          aria-valuenow={demoProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Loading demo"
        >
          <div className="kg-bar-fill" style={{ width: `${demoProgress}%` }} />
        </div>
      )}
      {demoError && (
        <p role="alert" className="kg-alert kg-alert--error">
          {demoError}
        </p>
      )}
    </div>
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
  const {
    meta,
    metaError,
    refreshMeta,
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
                aria-describedby="jurisdiction-hint"
              >
                {jurisdictions.map((code) => (
                  <option key={code} value={code}>
                    {code === "GLOBAL_AUTO"
                      ? "🌐 Auto-Detect"
                      : jurisdictionLabel(code)}
                  </option>
                ))}
              </select>
              <p id="jurisdiction-hint" className="kg-label-hint">
                The rental law your lease is checked against.
              </p>
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
              <span id="budget-heading" className="kg-sr-only">
                Budget status
              </span>
              {metaError && (
                <div
                  className="kg-backend-pill"
                  role="alert"
                  title={`Start FastAPI backend to load live CreditShield spend telemetry — Budget panel unavailable: ${metaError}`}
                >
                  <span className="kg-backend-dot" aria-hidden="true"></span>
                  <span>Backend Offline ({BACKEND_HOST})</span>
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
                <p className="kg-sub">Budget: waiting for the backend…</p>
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
                      aria-valuetext={`$${session.toFixed(2)} of $${maxSession.toFixed(2)}`}
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
                    <p className="kg-telemetry-badge">
                      <span className="kg-telemetry-provider">Disk Cache</span>{" "}
                      <span className="kg-telemetry-model">
                        {meta.disk_cache ? "On" : "Off"}
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
                        aria-valuetext={`$${cumulative.toFixed(2)} of $${maxCumulative.toFixed(2)}`}
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
      <DemoPresetBar />
      <main id="kg-main" tabIndex={-1} className="kg-workspace">
        <MenuNavigation />
        {children}
      </main>
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
            Germany · UK · New York · France · Japan
          </p>
        </div>
        <nav aria-label="KautionGuard steps">
          <p className="kg-footer-title">Steps</p>
          <p className="kg-footer-note">
            {STEPS.map((step, index) => (
              <span key={step.href}>
                {index > 0 && " · "}
                <Link href={step.href}>{step.label}</Link>
              </span>
            ))}
          </p>
        </nav>
      </footer>
    </div>
  );
}
