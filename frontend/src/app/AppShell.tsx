"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Cpu, Database, Mic, ScanEye, Wallet } from "lucide-react";
import { useKautionGuard } from "./KautionGuardProvider";
import {
  API_BASE_URL,
  exportCaseDossier,
  type CaseDossierPayload,
  type DepositMath,
} from "../lib/api";
import {
  notifyDemoHandoff,
  stashDemoFile,
  writeDemoHandoff,
  type DemoHandoff,
} from "../lib/handoff";
import {
  LANGUAGES,
  NOT_PROVIDED,
  jurisdictionLabel,
  ratio,
} from "../lib/uiHelpers";
import {
  EMPTY_CASE_SUMMARY,
  isRecord,
  loadPageState,
  readCaseSummary,
  type CaseSummary,
} from "../lib/pageState";
import { loadMoveinRefs } from "../lib/moveinRefs";

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
 * Demo preset loading, replicated from the landing page's demo panel
 * (LandingDemo in landing-client.tsx): same POST, same error-detail
 * parsing, same ~1.2s progress animation, same handoff payloads. The
 * shell adaptation: the bar lives on every page, so once a lease
 * preset loads, its sample contract is handed to the contract page
 * and the browser navigates there. The sample walkthrough video is
 * not loaded from here — it lives only in the evidence page's
 * Walkthrough card.
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
        const handoff: DemoHandoff = {
          version: 1,
          kind: "contract",
          presetId: preset.preset_id,
          assetUrl: preset.contract_pdf_url,
          fileName:
            preset.contract_pdf_url.split("/").pop() || "sample_contract.pdf",
          createdAt: Date.now(),
          presetTitle: preset.title,
          presetDescription: preset.description,
          demoIssues: preset.demo_issues,
        };
        const written = writeDemoHandoff(handoff);
        if (!written) {
          setDemoError(
            "Could not pass the sample to the contract page — this browser blocked the handoff storage.",
          );
          return;
        }
        // Fetch the sample now and stash the File itself in memory:
        // delivery through the stored intent alone races with the
        // route transition (the fetching page instance may be replaced
        // before it can apply the file). A failed prefetch is not
        // fatal — the destination page falls back to fetching via
        // the intent.
        try {
          const fileResponse = await fetch(
            `${API_BASE_URL}${handoff.assetUrl}`,
          );
          if (fileResponse.ok) {
            const blob = await fileResponse.blob();
            stashDemoFile(
              handoff,
              new File([blob], handoff.fileName, {
                type: blob.type || "application/pdf",
              }),
            );
          }
        } catch {
          /* the destination page retries via the stored intent */
        }
        notifyDemoHandoff();
        router.push("/contract");
      }
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : "Demo load failed");
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="kg-demo-bar">
      <span className="kg-demo-label">⚡ LOAD DEMO PRESET ($0.00):</span>
      {DEMO_CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="kg-btn kg-btn--sm kg-btn--quick"
          disabled={demoLoading}
          onClick={() => onLoadDemo(choice.id)}
        >
          {choice.label}
        </button>
      ))}
      {demoResult && (
        <span className="kg-sub">{demoResult.title}</span>
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

function dossierString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dossierNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The persisted decode result carries the locale as an object; the
 * dossier payload wants one line of text (the same parts the
 * contract page's locale badge shows). */
function dossierLocale(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isRecord(value)) return undefined;
  const parts = [value.detected_jurisdiction, value.detected_language].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (parts.length === 0) return undefined;
  const confidence =
    typeof value.confidence === "string" && value.confidence.length > 0
      ? ` (${value.confidence})`
      : "";
  return parts.join(" · ") + confidence;
}

/** The statutory deposit math, rebuilt field by field so a partial
 * or malformed record degrades to null instead of leaking through. */
function dossierDepositMath(value: unknown): DepositMath | null {
  if (!isRecord(value)) return null;
  const currency = dossierString(value.currency);
  const statute = dossierString(value.statute);
  const formulaNote = dossierString(value.formula_note);
  const baseRent = dossierNumber(value.base_rent);
  const statedDeposit = dossierNumber(value.stated_deposit);
  const statutoryCap = dossierNumber(value.statutory_cap);
  const excessAmount = dossierNumber(value.excess_amount);
  if (
    currency === null ||
    statute === null ||
    formulaNote === null ||
    baseRent === null ||
    statedDeposit === null ||
    statutoryCap === null ||
    excessAmount === null ||
    typeof value.within_cap !== "boolean"
  ) {
    return null;
  }
  return {
    currency,
    base_rent: baseRent,
    stated_deposit: statedDeposit,
    statutory_cap: statutoryCap,
    excess_amount: excessAmount,
    within_cap: value.within_cap,
    statute,
    formula_note: formulaNote,
  };
}

/**
 * Assemble the Master Case Dossier payload from the browser's
 * persisted case state — the same pagestate payloads the ribbon
 * summary reads, plus the saved move-in references. The pages save
 * the raw API responses, so every field below is read in the API's
 * snake_case shape. Anything missing or malformed degrades to null
 * for that section only; the backend compiles whichever sections it
 * receives. Called only from the export click handler (client-side),
 * never during render.
 */
function buildCaseDossierPayload(): CaseDossierPayload {
  // Section 1 + 2: the contract page saves the raw decode and draft
  // responses. Counts sit at the decode result's top level and are
  // mirrored inside `analysis` (read top level first, as the ribbon
  // does); issues and deposit math live inside `analysis`.
  let contract: CaseDossierPayload["contract"] = null;
  let draft: CaseDossierPayload["draft"] = null;
  const contractState = loadPageState("contract");
  if (contractState && isRecord(contractState.decodeResult)) {
    const result = contractState.decodeResult;
    const analysis = isRecord(result.analysis) ? result.analysis : null;
    const rawIssues =
      analysis && Array.isArray(analysis.possible_issues)
        ? analysis.possible_issues
        : [];
    contract = {
      jurisdiction_code: dossierString(result.jurisdiction_code) ?? undefined,
      detected_locale: dossierLocale(result.detected_locale),
      issue_count:
        dossierNumber(result.issue_count) ??
        (analysis ? dossierNumber(analysis.issue_count) : null) ??
        undefined,
      high_severity_count:
        dossierNumber(result.high_severity_count) ??
        (analysis ? dossierNumber(analysis.high_severity_count) : null) ??
        undefined,
      deposit_math: analysis
        ? dossierDepositMath(analysis.deposit_math)
        : null,
      issues: rawIssues.filter(isRecord).map((issue) => ({
        clause: dossierString(issue.clause) ?? undefined,
        severity: dossierString(issue.severity) ?? undefined,
        evidence_quote: dossierString(issue.evidence_quote) ?? undefined,
        citation: dossierString(issue.citation) ?? undefined,
        verified_quote: issue.verified_quote === true,
      })),
    };
  }
  if (
    contractState &&
    isRecord(contractState.draftResult) &&
    isRecord(contractState.draftResult.draft)
  ) {
    const draftRecord = contractState.draftResult.draft;
    draft = {
      draft_local: dossierString(draftRecord.draft_local) ?? undefined,
      draft_tenant: dossierString(draftRecord.draft_tenant) ?? undefined,
    };
  }

  // Section 3: saved move-in references (validated by the canonical
  // loader; the stored record's human label is its `name`, its dims
  // are `maskDims`/`frameSize`) plus the walkthrough seal hash from
  // the evidence pagestate.
  const references = loadMoveinRefs().map((ref) => ({
    label: ref.name,
    box: ref.box,
    mask_dims: ref.maskDims,
    frame_size: ref.frameSize,
  }));
  let walkthroughSha: string | null = null;
  const evidenceState = loadPageState("evidence");
  if (evidenceState && isRecord(evidenceState.walkResult)) {
    walkthroughSha = dossierString(evidenceState.walkResult.evidence_sha256);
  }

  // Section 4: the move-out comparison, passed through as saved
  // (nested under `comparison`, per the payload contract).
  let moveout: CaseDossierPayload["moveout"] = null;
  const moveoutState = loadPageState("moveout");
  if (
    moveoutState &&
    isRecord(moveoutState.verifyResult) &&
    isRecord(moveoutState.verifyResult.comparison)
  ) {
    moveout = { comparison: moveoutState.verifyResult.comparison };
  }

  return {
    contract,
    draft,
    evidence: {
      references,
      walkthrough_sha256: walkthroughSha ?? undefined,
    },
    moveout,
  };
}

/**
 * The Case Dossier ribbon: one line under the header showing how far
 * the tenant's case has progressed across the three steps, read from
 * the persisted page state (lib/pageState.readCaseSummary). Each pill
 * links to its step. The summary refreshes on mount, on navigation,
 * on window focus and every 3 seconds, because the steps write their
 * state from other pages and other moments than shell renders.
 */
function CaseDossierRibbon({ pathname }: { pathname: string | null }) {
  const [summary, setSummary] = useState<CaseSummary>(EMPTY_CASE_SUMMARY);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setSummary(readCaseSummary());
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 3000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [pathname]);

  const { contract, refCount, walkthroughSha, moveout } = summary;
  // The dossier can be compiled as soon as any step has produced
  // data — the same summary the pills render from.
  const canExport = Boolean(
    contract || refCount > 0 || walkthroughSha || moveout,
  );

  async function onExportDossier() {
    setExporting(true);
    setExportError(null);
    try {
      const result = await exportCaseDossier(buildCaseDossierPayload());
      window.open(API_BASE_URL + result.pdf_url, "_blank", "noopener");
    } catch (e: unknown) {
      setExportError(
        e instanceof Error ? e.message : "Dossier export failed",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <nav className="kg-dossier" aria-label="Case dossier status">
      <Link
        href="/contract"
        className={clsx("kg-dossier-pill", contract && "kg-dossier-pill--done")}
      >
        Step 1 · Lease Audit:{" "}
        {contract
          ? `✓ ${contract.issueCount} Clauses Flagged (${contract.highCount} High Risk)`
          : "Pending"}
      </Link>
      <Link
        href="/evidence"
        className={clsx(
          "kg-dossier-pill",
          (refCount > 0 || walkthroughSha) && "kg-dossier-pill--done",
        )}
      >
        Step 2 · Move-In Shield:{" "}
        {refCount > 0
          ? `✓ ${refCount} SAM 3.1 Outlines Locked in Browser`
          : "0 Saved"}
        {walkthroughSha && (
          <span className="kg-hash-badge" title={walkthroughSha}>
            SHA-256 ✓
          </span>
        )}
      </Link>
      <Link
        href="/move-out"
        className={clsx("kg-dossier-pill", moveout && "kg-dossier-pill--done")}
      >
        Step 3 · Move-Out Proof:{" "}
        {moveout
          ? `✓ ${moveout.registered ? "Registered IoU" : "IoU"}: ${(moveout.iou * 100).toFixed(1)}%`
          : "Ready"}
      </Link>
      <span
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          className="kg-btn kg-btn--sm"
          disabled={!canExport || exporting}
          title={
            canExport
              ? undefined
              : "Do at least one step first — check a contract, save an outline, or compare at move-out"
          }
          onClick={() => void onExportDossier()}
        >
          {exporting
            ? "Building PDF…"
            : "📄 Export Master Dossier PDF ($0.00)"}
        </button>
        {exportError && (
          <span role="alert" className="kg-sub">
            {exportError}
          </span>
        )}
      </span>
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
  const {
    meta,
    metaError,
    refreshMeta,
    jurisdiction,
    setJurisdiction,
    jurisdictions,
    language,
    setLanguage,
  } = useKautionGuard();
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [xrayOpen, setXrayOpen] = useState(false);

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
          <div className="kg-shell-selectors">
            <div className="kg-pill-group" role="group" aria-label="Jurisdiction">
              <span className="kg-pill-label">Jurisdiction</span>
              {[...jurisdictions]
                .sort(
                  (a, b) =>
                    ["GLOBAL_AUTO", "DE", "UK", "US_NY", "FR", "JP"].indexOf(a) -
                    ["GLOBAL_AUTO", "DE", "UK", "US_NY", "FR", "JP"].indexOf(b),
                )
                .map((code) => (
                <button key={code} type="button" className={clsx("kg-pill", jurisdiction === code && "kg-pill--active")} aria-pressed={jurisdiction === code} title={jurisdictionLabel(code)} onClick={() => setJurisdiction(code)}>
                  {code === "GLOBAL_AUTO" ? "Auto" : code === "US_NY" ? "NY" : code}
                </button>
              ))}
            </div>
            <div className="kg-pill-group" role="group" aria-label="Letter language">
              <span className="kg-pill-label">Language</span>
              {LANGUAGES.map((l) => (
                <button key={l.code} type="button" className={clsx("kg-pill", language === l.code && "kg-pill--active")} aria-pressed={language === l.code} title={l.label} onClick={() => setLanguage(l.code)}>
                  {l.code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="kg-header-right">
            {meta && (
              <span className="kg-header-models" title={`${meta.models.chat_default} · ${meta.models.sam31} · ${meta.models.voice}`}>
                {providerLabel(meta.chat_provider)} · SAM 3.1 · Voice
              </span>
            )}
            <button
              type="button"
              className="kg-xray-toggle"
              aria-expanded={xrayOpen}
              onClick={() => setXrayOpen((v) => !v)}
            >
              Architecture X-Ray
            </button>
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
      <CaseDossierRibbon pathname={pathname} />
      {xrayOpen && (
        <div className="kg-xray">
          <div className="kg-xray-inner">
            <div className="kg-xray-grid">
              <div className="kg-xray-col">
                <h4>Baseten — meta-models/muse-spark-open-1026</h4>
                <p>Zero-Hallucination Lease Audit, Vision Defect Discovery &amp; Bilingual Objection Drafting.</p>
              </div>
              <div className="kg-xray-col">
                <h4>Meta — sam-3.1 + muse-voice-transcribe-1.0</h4>
                <p>Narration-Guided Keyframe Segmentation, Lexicon + Center-Point Retry &amp; Specificity Guard.</p>
              </div>
              <div className="kg-xray-col">
                <h4>Local Deterministic Engine — CreditShield</h4>
                <p>Verbatim Quote Substring Validator, Translation-Registered IoU Comparator &amp; SQLite WAL Cache.</p>
              </div>
            </div>
          </div>
        </div>
      )}
      <DemoPresetBar />
      <main id="kg-main" tabIndex={-1} className="kg-workspace">
        <AnimatePresence mode="wait" initial={false}><motion.div key={pathname} className="kg-page-motion" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18, ease: "easeOut" }}>{children}</motion.div></AnimatePresence>
      </main>
      <footer className="kg-footer kg-footer--single">
        <p>Automated findings are preliminary and uncertain. Have a qualified professional review everything before use.</p>
      </footer>
    </div>
  );
}
