"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_BASE_URL } from "../lib/api";
import { useKautionGuard } from "./KautionGuardProvider";
import { writeDemoHandoff } from "../lib/handoff";

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

const LP_VARIANT_KEY = "kautionguard.lp.variant";
const LP_EVENTS_KEY = "kautionguard.lp.events";
const LP_FEEDBACK_KEY = "kautionguard.lp.feedback";

type LpVariant = "A" | "B";

/**
 * Landing-page event log (A/B measurement, demo build): appends to a
 * JSON array in localStorage, capped at the most recent 100 entries so
 * the log cannot grow without bound. Best-effort — storage may be
 * blocked, and losing an event must never break the page.
 */
function logLpEvent(name: string, detail: string, variant: LpVariant) {
  try {
    const raw = window.localStorage.getItem(LP_EVENTS_KEY);
    const events: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : [];
    events.push({ name, variant, detail, at: new Date().toISOString() });
    window.localStorage.setItem(
      LP_EVENTS_KEY,
      JSON.stringify(events.slice(-100)),
    );
  } catch {
    /* storage unavailable — ignore */
  }
}

/**
 * The variant assigned to this browser, read at event time (never
 * during render). The hero island assigns and persists it on mount,
 * so by the time any CTA can be clicked the stored value is the one
 * the visitor actually saw.
 */
function storedVariant(): LpVariant {
  try {
    return window.localStorage.getItem(LP_VARIANT_KEY) === "B" ? "B" : "A";
  } catch {
    return "A";
  }
}

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
 * Client island for the landing page: everything interactive on `/`
 * lives here (hero + A/B variant, demo panel, feedback widget, sticky
 * mobile bar, and the tracked final-band CTA), so the per-frame
 * demo-progress re-render stays inside this island instead of
 * re-rendering the whole page. All state, handlers, storage keys and
 * copy moved verbatim from the former single-component page.tsx,
 * except the fixes the V7 spec mandates. The static sections are
 * server-rendered by app/page.tsx.
 */
export function LandingHero() {
  // A/B headline variant: assigned once per browser, then sticky.
  const [variant, setVariant] = useState<LpVariant>("A");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LP_VARIANT_KEY);
      if (stored === "A" || stored === "B") {
        setVariant(stored);
      } else {
        const assigned: LpVariant = Math.random() < 0.5 ? "A" : "B";
        window.localStorage.setItem(LP_VARIANT_KEY, assigned);
        setVariant(assigned);
      }
    } catch {
      /* storage unavailable — stay on variant A */
    }
  }, []);

  return (
    <section className="kg-lp-hero" data-variant={variant}>
      <p className="kg-lp-eyebrow">
        For tenants in Berlin · London · Paris · New York · Tokyo
      </p>
      <h1 className="kg-lp-h1">
        {variant === "B" ? (
          "Check your lease. Photograph the damage. Protect your deposit."
        ) : (
          <>
            It was in the sample lease.
            <br />
            It might be in yours.
          </>
        )}
      </h1>
      <p className="kg-lp-lead">
        KautionGuard reads your rental contract against the law where
        you live and flags the clauses that could cost you money —
        every flag shown with the exact words from your lease. Then it
        turns your move-in photos and videos into a sealed evidence
        record, so your deposit has proof behind it.
      </p>
      <div className="kg-lp-cta-row">
        <Link
          href="/contract"
          className="kg-btn kg-btn--primary kg-btn--lg kg-lp-cta"
          data-lp-cta="hero-primary"
          onClick={() => logLpEvent("cta_click", "hero-primary", variant)}
        >
          Check my contract — free
        </Link>
        <a href="#demo" className="kg-btn kg-btn--ghost kg-btn--lg">
          Try the 60-second demo
        </a>
      </div>
      <p className="kg-lp-micro">
        Demo is free · No account needed · Live checks are capped by
        the app at $5.00 per visit
      </p>
      <ul className="kg-lp-trust">
        <li>
          <span aria-hidden="true">✓</span> Every quote checked word
          for word
        </li>
        <li>
          <span aria-hidden="true">✓</span> Costs shown before you run
          a check
        </li>
        <li>
          <span aria-hidden="true">✓</span> Information, not legal
          advice — nothing is sent to your landlord
        </li>
      </ul>
    </section>
  );
}

export function LandingDemo() {
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
    <section id="demo" className="kg-panel kg-demo-panel kg-lp-demo" aria-labelledby="demo-heading">
      <p className="kg-overline" aria-hidden="true">Start the 60-second demo</p>
      <h2 id="demo-heading" className="kg-section-title">
        Try a demo
      </h2>
      <p className="kg-sub">
        Pick a fictional sample lease — clicking one asks the
        app&apos;s backend to load that sample. Nothing of yours is
        uploaded.
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
              Open sample contract (PDF){" "}
              <span className="kg-sr-only">(opens in new tab)</span>
            </a>
          </p>
          {demoResult.contract_pdf_url && (
            <p>
              <button
                type="button"
                className="kg-btn kg-btn--primary"
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
                  className="kg-btn kg-btn--primary"
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
  );
}

/**
 * The final band's primary CTA. The band itself is server-rendered by
 * page.tsx; only this link is client, because its click is logged
 * against the visitor's A/B variant (read from storage at click time).
 */
export function LandingFinalCta() {
  return (
    <Link
      href="/contract"
      className="kg-btn kg-btn--primary kg-btn--lg kg-lp-cta"
      data-lp-cta="final-primary"
      onClick={() => logLpEvent("cta_click", "final-primary", storedVariant())}
    >
      Check my contract — free
    </Link>
  );
}

export function LandingFeedback() {
  // Page feedback (stored only in this browser in this demo build).
  const [fbVote, setFbVote] = useState<string | null>(null);
  const [fbText, setFbText] = useState("");
  const [fbDone, setFbDone] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LP_FEEDBACK_KEY);
      if (raw && (JSON.parse(raw) as unknown[]).length > 0) setFbDone(true);
    } catch {
      /* storage unavailable — just show the form */
    }
  }, []);

  function onFeedbackSubmit(e: React.FormEvent) {
    e.preventDefault();
    const variant = storedVariant();
    try {
      const raw = window.localStorage.getItem(LP_FEEDBACK_KEY);
      const entries: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : [];
      entries.push({
        vote: fbVote,
        text: fbText.trim(),
        variant,
        at: new Date().toISOString(),
      });
      window.localStorage.setItem(LP_FEEDBACK_KEY, JSON.stringify(entries));
    } catch {
      /* storage unavailable — the thanks state below still applies */
    }
    logLpEvent("feedback", fbVote ?? "no-vote", variant);
    setFbDone(true);
  }

  return (
    <section className="kg-lp-feedback" aria-label="Page feedback">
      {fbDone ? (
        <p role="status" className="kg-lp-feedback-thanks">
          Thanks — noted. Feedback is stored only in this browser in
          this demo build.
        </p>
      ) : (
        <form onSubmit={onFeedbackSubmit}>
          <p className="kg-lp-feedback-q" id="lp-feedback-question">
            Was this page clear about what KautionGuard does?
          </p>
          <div
            className="kg-lp-vote-row"
            role="group"
            aria-labelledby="lp-feedback-question"
          >
            {(["Yes", "Partly", "No"] as const).map((vote) => (
              <button
                key={vote}
                type="button"
                className="kg-btn kg-btn--ghost"
                aria-pressed={fbVote === vote}
                onClick={() => setFbVote(vote)}
              >
                {vote}
              </button>
            ))}
          </div>
          <label className="kg-label" htmlFor="lp-feedback-text">
            Anything missing? (optional)
          </label>
          <input
            id="lp-feedback-text"
            className="kg-control"
            type="text"
            value={fbText}
            onChange={(e) => setFbText(e.target.value)}
          />
          <p>
            <button type="submit" className="kg-btn kg-btn--primary">
              Submit feedback
            </button>
          </p>
        </form>
      )}
    </section>
  );
}

export function LandingStickyBar() {
  return (
    <div className="kg-lp-sticky">
      <Link
        href="/contract"
        className="kg-btn kg-btn--primary kg-lp-cta"
        data-lp-cta="sticky-primary"
        onClick={() => logLpEvent("cta_click", "sticky-primary", storedVariant())}
      >
        Check my contract — free
      </Link>
      <a href="#demo" className="kg-btn kg-btn--ghost">
        Demo
      </a>
    </div>
  );
}
