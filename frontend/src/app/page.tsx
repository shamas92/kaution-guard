"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_BASE_URL } from "../lib/api";
import { useKautionGuard } from "./KautionGuardProvider";
import { writeDemoHandoff } from "../lib/handoff";
import { jurisdictionLabel } from "../lib/uiHelpers";

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

/**
 * Start page: what KautionGuard does, what it costs, and the fastest
 * way in — a made-up sample lease. The workflows themselves live on
 * their own pages; the sample buttons below hand the chosen file to
 * the right page (see lib/handoff) instead of loading it here.
 */
export default function StartPage() {
  const router = useRouter();
  const { jurisdictions, jurisdiction, setJurisdiction } = useKautionGuard();
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
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : "Demo load failed");
    } finally {
      setDemoLoading(false);
    }
  }

  function onUseSampleContract() {
    if (!demoResult?.contract_pdf_url) return;
    const written = writeDemoHandoff({
      version: 1,
      kind: "contract",
      presetId: demoResult.preset_id,
      assetUrl: demoResult.contract_pdf_url,
      fileName:
        demoResult.contract_pdf_url.split("/").pop() || "sample_contract.pdf",
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

  function onUseSampleVideo() {
    // The button only renders when the demo response provides both the
    // URL and the availability flag; anything else is a programming
    // error, not a handoff.
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
    <>
      <section className="kg-hero" aria-label="KautionGuard overview">
        <div className="kg-hero-main">
          <p className="kg-hero-title">
            The tenant lawyer that <em>shows its evidence</em>.
          </p>
          <p className="kg-sub">
            Check a rental contract, photograph damage, and compare photos
            when you move out — every problem we flag is shown with the
            exact words from your contract.
          </p>
          <p className="kg-sub kg-hero-disclaimer">
            Tenant document review and apartment evidence workspace. Findings are
            preliminary — have a qualified professional review them.
          </p>
        </div>
        <ul className="kg-hero-trust" aria-label="What to know before you start">
          <li>
            <strong>What you need</strong>
            <span>A lease PDF — or use a demo lease below. Apartment photos for the evidence steps.</span>
          </li>
          <li>
            <strong>What it costs</strong>
            <span>Demos and the move-out comparison cost $0.00. Live checks are capped: $5.00 per visit, $135.00 in total.</span>
          </li>
          <li>
            <strong>The limits</strong>
            <span>Information, not legal advice. Nothing is sent to your landlord — the app only drafts text for you to review.</span>
          </li>
        </ul>
      </section>

      <section className="kg-panel kg-start-choice">
        <label htmlFor="start-jurisdiction" className="kg-label">
          Where is your lease?
        </label>
        <select
          id="start-jurisdiction"
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
        <p className="kg-sub">
          Pick the place whose rental rules apply to your contract. You can
          change this at any time at the top of the page.
        </p>
      </section>

      <section className="kg-panel kg-demo-panel" aria-labelledby="demo-heading">
        <p className="kg-overline" aria-hidden="true">Start the 60-second demo</p>
        <h2 id="demo-heading" className="kg-section-title">
          Try a demo
        </h2>
        <p className="kg-sub">
          Try a made-up sample lease — it&apos;s free, and nothing is sent
          anywhere until you ask for a check.
        </p>
        <div className="kg-demo-cards">
          {DEMO_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="kg-demo-card"
              disabled={demoLoading}
              onClick={() => onLoadDemo(choice.id)}
            >
              <span className="kg-demo-card-name">{choice.label}</span>
              <span className="kg-demo-card-sub">Demo preset · {choice.id}</span>
            </button>
          ))}
        </div>
        {demoLoading && (
          <div
            className="kg-bar kg-mt12"
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
        {demoResult && (
          <div aria-live="polite" className="kg-demo-banner">
            <h3>{demoResult.title}</h3>
            <p className="kg-sub">{demoResult.description}</p>
            <ul className="kg-demo-tags">
              {demoResult.demo_issues.map((issue, i) => (
                <li key={i} className="kg-demo-tag">{issue}</li>
              ))}
            </ul>
            <p>
              <a
                href={`${API_BASE_URL}${demoResult.contract_pdf_url}`}
                target="_blank"
                rel="noreferrer"
              >
                Open sample contract (PDF)
              </a>
            </p>
            {demoResult.contract_pdf_url && (
              <p>
                <button
                  type="button"
                  className="kg-btn kg-btn--primary kg-btn--sm"
                  onClick={onUseSampleContract}
                >
                  Use This Sample PDF in Contract Decoder ($0.00)
                </button>
              </p>
            )}
            {!demoResult.walkthrough_video_available && (
              <p className="kg-sub">
                No sample walkthrough video on this host (FFmpeg is not
                available); video processing stays disabled for the demo.
              </p>
            )}
            {demoResult.walkthrough_video_available &&
              demoResult.walkthrough_video_url && (
                <p>
                  <button
                    type="button"
                    className="kg-btn kg-btn--primary kg-btn--sm"
                    onClick={onUseSampleVideo}
                  >
                    Use This Sample Video in Walkthrough ($0.00)
                  </button>
                </p>
              )}
            <p className="kg-note">{demoResult.review_note}</p>
          </div>
        )}
      </section>

      <section aria-label="What you can do">
        <div className="kg-page-cards">
          <Link href="/contract" className="kg-page-card">
            <span className="kg-page-card-step">1 · Check your contract</span>
            <span className="kg-page-card-text">
              Upload your lease and see the unfair clauses — each one shown
              with the exact words from your contract, then turned into a
              letter to your landlord.
            </span>
          </Link>
          <Link href="/evidence" className="kg-page-card">
            <span className="kg-page-card-step">2 · Photograph the damage</span>
            <span className="kg-page-card-text">
              Highlight damage in a photo or a walkthrough video, and keep a
              sealed record of what your home looked like on move-in day.
            </span>
          </Link>
          <Link href="/move-out" className="kg-page-card">
            <span className="kg-page-card-step">3 · Compare when you move out</span>
            <span className="kg-page-card-text">
              Compare a photo from today with the move-in record and see what
              changed. Always $0.00 — the comparison runs on this device.
            </span>
          </Link>
        </div>
      </section>
    </>
  );
}
