"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  API_BASE_URL,
  decodeContract,
  draftDispute,
  processWalkthrough,
  segmentImage,
} from "../lib/api";
import type {
  DecodeResponse,
  DetectedLocale,
  DisputeResponse,
  SegmentImageResponse,
  WalkthroughResponse,
} from "../lib/api";
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
 * The Pattern device (V6): the sample lease's repair clause, echoed at
 * fading strengths. Echoes are decoration only — the marked instance
 * below is the real line, and it is never inside the aria-hidden
 * wrappers. The clause is quoted verbatim from the sample lease,
 * the same sentence the contract checker flags.
 */
function ClauseEcho({ className }: { className: string }) {
  return (
    <p className={`kg-pat-line ${className}`}>
      „Der Mieter traegt die Kosten kleiner Instandhaltungen bis zu{" "}
      <span className="kg-pat-amt">150 EUR</span> je Einzelfall.“
    </p>
  );
}

function ClauseMarked() {
  return (
    <p className="kg-pat-line kg-pat-marked">
      „Der Mieter traegt die Kosten kleiner Instandhaltungen bis zu{" "}
      <span className="kg-pat-amt">150 EUR</span> je Einzelfall.“
    </p>
  );
}

/**
 * A plain drawn stand-in for a stored apartment photo: a wall, a
 * window, and — where the record has one — the crack, with the
 * damage outline drawn around it on the marked variant.
 */
function WallSketch({
  crack = "none",
  outlined = false,
}: {
  crack?: "none" | "short" | "long";
  outlined?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 160 120"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="160" height="120" fill="#EAE3D0" />
      <rect x="0" y="92" width="160" height="28" fill="#D9CFB6" />
      <rect
        x="98"
        y="18"
        width="44"
        height="56"
        fill="#F4EFDF"
        stroke="#B7AD99"
        strokeWidth="2"
      />
      <line x1="120" y1="18" x2="120" y2="74" stroke="#B7AD99" strokeWidth="2" />
      {crack !== "none" && (
        <polyline
          points={
            crack === "long"
              ? "52,14 58,34 50,52 60,74 54,92"
              : "52,14 58,34 50,52 60,74"
          }
          fill="none"
          stroke="#45403A"
          strokeWidth="2"
        />
      )}
      {crack === "long" && (
        <polyline
          points="56,58 68,66 78,64"
          fill="none"
          stroke="#45403A"
          strokeWidth="1.5"
        />
      )}
      {outlined && crack !== "none" && (
        <ellipse
          cx="55"
          cy={crack === "long" ? "52" : "45"}
          rx="16"
          ry={crack === "long" ? "44" : "36"}
          fill="none"
          strokeWidth="2.5"
          transform={`rotate(6 55 ${crack === "long" ? "52" : "45"})`}
          stroke="var(--kg-pat-red)"
        />
      )}
    </svg>
  );
}

/**
 * Start page: what KautionGuard does, what it costs, and the fastest
 * way in — a made-up sample lease. The workflows themselves live on
 * their own pages; the sample buttons below hand the chosen file to
 * the right page (see lib/handoff) instead of loading it here.
 */
interface LeaseIssue {
  clause?: unknown;
  why_risky?: unknown;
  severity?: unknown;
  evidence_quote?: unknown;
  citation?: unknown;
}

function leaseIssues(analysis: Record<string, unknown>): LeaseIssue[] {
  const raw = analysis["possible_issues"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is LeaseIssue => typeof item === "object" && item !== null,
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type TraceStage = "locale" | "understand" | "discover" | "outline" | "seal";

const TRACE_LABELS: Record<TraceStage, string> = {
  locale: "Locale",
  understand: "Understand",
  discover: "Discover",
  outline: "Outline",
  seal: "Seal",
};

function LocaleBadge({ locale }: { locale: DetectedLocale | null | undefined }) {
  if (!locale) return null;
  return (
    <p className="kg-demo-tag" role="status">
      Auto-Detected Jurisdiction &amp; Language: {locale.detected_jurisdiction}{" "}
      · {locale.detected_language} ({locale.confidence})
    </p>
  );
}

/**
 * Interactive autonomous checks: contract decoding with locale badge and
 * 1-click objection drafting, zero-prompt SAM defect discovery, and
 * walkthrough processing with silent-vision reporting. Every result feeds
 * the pipeline trace bar below, which marks each completed stage.
 */
function AutonomousChecks({ jurisdictions }: { jurisdictions: string[] }) {
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [contractJurisdiction, setContractJurisdiction] =
    useState("GLOBAL_AUTO");
  const [decoded, setDecoded] = useState<DecodeResponse | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);

  const [facts, setFacts] = useState("");
  const [outcome, setOutcome] = useState("");
  const [tenantLang, setTenantLang] = useState("en");
  const [dispute, setDispute] = useState<DisputeResponse | null>(null);
  const [disputeError, setDisputeError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [segment, setSegment] = useState<SegmentImageResponse | null>(null);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [segmenting, setSegmenting] = useState(false);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [maxFrames, setMaxFrames] = useState(3);
  const [walk, setWalk] = useState<WalkthroughResponse | null>(null);
  const [walkError, setWalkError] = useState<string | null>(null);
  const [walking, setWalking] = useState(false);

  async function onDecode() {
    if (!contractFile || decoding) return;
    setDecoding(true);
    setDecodeError(null);
    try {
      setDecoded(await decodeContract(contractFile, contractJurisdiction));
    } catch (e: unknown) {
      setDecodeError(e instanceof Error ? e.message : "Decode failed");
    } finally {
      setDecoding(false);
    }
  }

  async function onDraft() {
    if (!facts.trim() || drafting) return;
    setDrafting(true);
    setDisputeError(null);
    try {
      setDispute(
        await draftDispute({
          jurisdiction_code: contractJurisdiction,
          facts,
          desired_outcome: outcome,
          user_language: tenantLang,
        }),
      );
    } catch (e: unknown) {
      setDisputeError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setDrafting(false);
    }
  }

  function onDraftObjection(issue: LeaseIssue) {
    const parts = [
      `Objection to clause: ${str(issue.clause) || "(unlabelled clause)"}.`,
      str(issue.why_risky),
      str(issue.evidence_quote)
        ? `Quoted contract wording: "${str(issue.evidence_quote)}".`
        : "",
      str(issue.citation) ? `Cited reference: ${str(issue.citation)}.` : "",
    ].filter(Boolean);
    setFacts(parts.join(" "));
    if (!outcome) setOutcome("Remove or correct the flagged clause.");
  }

  async function onSegment() {
    if (!imageFile || segmenting) return;
    setSegmenting(true);
    setSegmentError(null);
    try {
      setSegment(
        await segmentImage(
          imageFile,
          imagePrompt,
          undefined,
          "GLOBAL_AUTO",
          "en",
        ),
      );
    } catch (e: unknown) {
      setSegmentError(e instanceof Error ? e.message : "Segmentation failed");
    } finally {
      setSegmenting(false);
    }
  }

  async function onWalkthrough() {
    if (!videoFile || walking) return;
    setWalking(true);
    setWalkError(null);
    try {
      setWalk(
        await processWalkthrough(videoFile, {
          jurisdictionCode: "GLOBAL_AUTO",
          userLanguage: "en",
          textPrompt: "",
          maxFrames,
        }),
      );
    } catch (e: unknown) {
      setWalkError(e instanceof Error ? e.message : "Walkthrough failed");
    } finally {
      setWalking(false);
    }
  }

  const trace: { key: TraceStage; done: boolean }[] = [
    {
      key: "locale",
      done: Boolean(decoded?.detected_locale ?? dispute?.detected_locale),
    },
    { key: "understand", done: decoded !== null || walk !== null },
    {
      key: "discover",
      done: Boolean(segment?.auto_discovered_prompt ?? walk?.auto_discovered_prompt),
    },
    {
      key: "outline",
      done: Boolean(segment?.mask?.match) || (walk?.regions?.length ?? 0) > 0,
    },
    { key: "seal", done: Boolean(walk?.pdf_url) },
  ];

  return (
    <section className="kg-panel" aria-label="Try the autonomous checks">
      <p className="kg-overline" aria-hidden="true">
        Try it now
      </p>
      <h2 className="kg-section-title">Autonomous checks, live</h2>
      <ol className="kg-demo-tags" aria-label="AI Pipeline Trace">
        {trace.map(({ key, done }) => (
          <li key={key} className="kg-demo-tag" aria-current={done}>
            {done ? "✓" : "○"} {TRACE_LABELS[key]}
          </li>
        ))}
      </ol>

      <h3 className="kg-section-title">Contract Decoder &amp; Dispute</h3>
      <p className="kg-sub">
        Leave the jurisdiction on Global Auto: the app detects the lease
        language and country itself and shows an auto-detected badge.
      </p>
      <label className="kg-label" htmlFor="auto-contract-file">
        Lease PDF
      </label>
      <input
        id="auto-contract-file"
        type="file"
        accept="application/pdf"
        onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
      />
      <label className="kg-label" htmlFor="auto-jurisdiction">
        Jurisdiction
      </label>
      <select
        id="auto-jurisdiction"
        className="kg-control"
        value={contractJurisdiction}
        onChange={(e) => setContractJurisdiction(e.target.value)}
      >
        {jurisdictions.map((code) => (
          <option key={code} value={code}>
            {jurisdictionLabel(code)}
          </option>
        ))}
      </select>
      <p>
        <button
          type="button"
          className="kg-btn kg-btn--primary kg-btn--sm"
          disabled={!contractFile || decoding}
          onClick={onDecode}
        >
          {decoding ? "Decoding…" : "Decode Contract"}
        </button>
      </p>
      {decodeError && (
        <p role="alert" className="kg-alert kg-alert--error">
          {decodeError}
        </p>
      )}
      <LocaleBadge locale={decoded?.detected_locale} />
      {decoded && (
        <ul className="kg-demo-tags">
          {leaseIssues(decoded.analysis).map((issue, i) => (
            <li key={i} className="kg-demo-tag">
              <strong>{str(issue.clause) || `Finding ${i + 1}`}</strong>
              {str(issue.severity) && <span> · {str(issue.severity)}</span>}
              {str(issue.why_risky) && <p>{str(issue.why_risky)}</p>}
              {str(issue.evidence_quote) && (
                <p>“{str(issue.evidence_quote)}”</p>
              )}
              <button
                type="button"
                className="kg-btn kg-btn--sm"
                onClick={() => onDraftObjection(issue)}
              >
                Draft Objection for This Finding
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="kg-section-title">Dispute Notice</h3>
      <label className="kg-label" htmlFor="auto-facts">
        Facts
      </label>
      <textarea
        id="auto-facts"
        className="kg-control"
        value={facts}
        onChange={(e) => setFacts(e.target.value)}
        rows={4}
      />
      <label className="kg-label" htmlFor="auto-outcome">
        Desired outcome
      </label>
      <input
        id="auto-outcome"
        className="kg-control"
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
      />
      <label className="kg-label" htmlFor="auto-lang">
        Tenant language
      </label>
      <input
        id="auto-lang"
        className="kg-control"
        value={tenantLang}
        onChange={(e) => setTenantLang(e.target.value)}
      />
      <p>
        <button
          type="button"
          className="kg-btn kg-btn--primary kg-btn--sm"
          disabled={!facts.trim() || drafting}
          onClick={onDraft}
        >
          {drafting ? "Drafting…" : "Draft Dispute Notice"}
        </button>
      </p>
      {disputeError && (
        <p role="alert" className="kg-alert kg-alert--error">
          {disputeError}
        </p>
      )}
      <LocaleBadge locale={dispute?.detected_locale} />
      {dispute && (
        <div>
          <p>{str(dispute.draft["draft_local"])}</p>
          <p>{str(dispute.draft["draft_tenant"])}</p>
        </div>
      )}

      <h3 className="kg-section-title">SAM 3.1 Image Defect Discovery</h3>
      <p className="kg-sub">
        Leave the prompt empty and the app discovers the defects itself.
      </p>
      <label className="kg-label" htmlFor="auto-image-file">
        Photo
      </label>
      <input
        id="auto-image-file"
        type="file"
        accept="image/*"
        onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
      />
      <label className="kg-label" htmlFor="auto-image-prompt">
        Defect prompt (optional)
      </label>
      <input
        id="auto-image-prompt"
        className="kg-control"
        value={imagePrompt}
        onChange={(e) => setImagePrompt(e.target.value)}
        placeholder="✨ Auto-Detect Defects (No Prompt Needed)"
      />
      <p>
        <button
          type="button"
          className="kg-btn kg-btn--primary kg-btn--sm"
          disabled={!imageFile || segmenting}
          onClick={onSegment}
        >
          {segmenting
            ? "Scanning…"
            : imagePrompt.trim()
              ? "Segment Image"
              : "✨ Auto-Detect Defects (No Prompt Needed)"}
        </button>
      </p>
      {segmentError && (
        <p role="alert" className="kg-alert kg-alert--error">
          {segmentError}
        </p>
      )}
      {segment?.auto_discovered_prompt && (
        <p className="kg-demo-tag" role="status">
          Auto-discovered defect: {segment.auto_discovered_prompt}
        </p>
      )}
      {segment?.auto_descriptions?.map((d, i) => (
        <p key={i} className="kg-sub">
          {d.description_local} — {d.description_tenant}
        </p>
      ))}
      {segment?.overlay_url && (
        <img
          src={`${API_BASE_URL}${segment.overlay_url}`}
          alt="Segmented defect overlay"
        />
      )}

      <h3 className="kg-section-title">Silent Walkthrough Video</h3>
      <p className="kg-sub">
        No narration needed: silent videos are scanned autonomously.
      </p>
      <label className="kg-label" htmlFor="auto-video-file">
        Walkthrough video
      </label>
      <input
        id="auto-video-file"
        type="file"
        accept="video/*"
        onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
      />
      <label className="kg-label" htmlFor="auto-max-frames">
        Max frames
      </label>
      <input
        id="auto-max-frames"
        className="kg-control"
        type="number"
        min={1}
        value={maxFrames}
        onChange={(e) => setMaxFrames(Number(e.target.value) || 3)}
      />
      <p>
        <button
          type="button"
          className="kg-btn kg-btn--primary kg-btn--sm"
          disabled={!videoFile || walking}
          onClick={onWalkthrough}
        >
          {walking ? "Processing…" : "Process Walkthrough"}
        </button>
      </p>
      {walkError && (
        <p role="alert" className="kg-alert kg-alert--error">
          {walkError}
        </p>
      )}
      {walk?.detection_mode && (
        <p className="kg-demo-tag" role="status">
          {walk.detection_mode === "silent_vision_auto"
            ? "Silent Video Vision Auto-Scan: defects found without narration"
            : `Detection mode: ${walk.detection_mode}`}
        </p>
      )}
      {walk?.auto_discovered_prompt && (
        <p className="kg-sub">
          Auto-discovered defect: {walk.auto_discovered_prompt}
        </p>
      )}
      {walk && walk.defects.length > 0 && (
        <ul className="kg-demo-tags">
          {walk.defects.map((defect, i) => (
            <li key={i} className="kg-demo-tag">
              <strong>{defect.timestamp}</strong>
              <p>{defect.description_tenant}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
      <details className="kg-panel kg-hero-banner" open>
        <summary className="kg-hero-banner-title">
          New: autonomous detection — no prompt, no narration, no manual locale needed
        </summary>
        <ul className="kg-hero-banner-list">
          <li>
            <strong>Auto-Locale Statutory Grounding.</strong> Leave the
            jurisdiction on Global Auto and the app reads the lease language
            itself, then shows an “Auto-Detected Jurisdiction &amp; Language”
            badge on the result.
          </li>
          <li>
            <strong>Zero-Prompt Autonomous SAM 3.1 Defect Discovery.</strong>
            Submit a photo with an empty prompt (“Auto-Detect Defects”) and
            the app finds up to 2 surface defects on its own before outlining
            them.
          </li>
          <li>
            <strong>Silent Walkthrough Video Auditing.</strong> A video with
            no narration is no longer a failure: keyframes are scanned
            autonomously and the report is marked “Silent Video Vision
            Auto-Scan”.
          </li>
        </ul>
        <p className="kg-sub">
          <Link href="/contract">Try the Contract Decoder →</Link>
          {" · "}
          <Link href="/evidence">Try the Evidence page →</Link>
        </p>
      </details>
      <section className="kg-hero" aria-label="KautionGuard overview">
        <div className="kg-hero-main">
          <p className="kg-hero-title">
            It was in the sample lease.
            <br />
            It might be in yours.
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
            <span>Trying the demos costs $0.00. Live checks are capped by the app: $5.00 per visit, $135.00 in total.</span>
          </li>
          <li>
            <strong>The limits</strong>
            <span>Information, not legal advice. Nothing is sent to your landlord — the app only drafts text for you to review.</span>
          </li>
        </ul>
      </section>

      <section aria-label="The clause, checked">
        <div className="kg-pat-field">
          <div className="kg-pat-head">
            <div className="kg-pat-lines">
              <div aria-hidden="true">
                <ClauseEcho className="kg-pat-line--f5" />
                <ClauseEcho className="kg-pat-line--f3 kg-pat-line--o1" />
                <ClauseEcho className="kg-pat-line--f1" />
              </div>
              <ClauseMarked />
              <div aria-hidden="true">
                <ClauseEcho className="kg-pat-line--f2 kg-pat-line--o2" />
                <ClauseEcho className="kg-pat-line--f4" />
              </div>
            </div>
            <aside className="kg-pat-note kg-pat-note--end">
            <span className="kg-pat-note-stamp">This one was checked</span>
            <h3 className="kg-pat-note-title">
              Same sentence. This time, somebody read it.
            </h3>
            <p>
              <span className="kg-pat-ok">✓ Quote check</span> — matched
              word for word against the sample lease.
            </p>
            <p>
              <b>Law check</b> — potential issue: repair clauses are only
              effective with two limits (BGH VIII ZR 91/88, in the
              app&apos;s law registry): roughly €75–100 per case and a
              yearly ceiling. This clause sets €150 per case and no
              yearly ceiling.
            </p>
            <p>
              <b>Deposit check · § 551 BGB</b> — sample lease:{" "}
              <b>€650</b> monthly cold rent, <b>€1,950</b> deposit. That
              is exactly three months&apos; cold rent — the most § 551
              allows — so in this example the deposit itself is not the
              problem.
            </p>
            <p>Example — not a real result.</p>
            </aside>
          </div>
        </div>
        <p className="kg-sub">
          <Link href="/contract">
            Check your contract — break the pattern in yours →
          </Link>
        </p>
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

      <AutonomousChecks jurisdictions={jurisdictions} />

      <section aria-labelledby="voice-heading">
        <h2 id="voice-heading" className="kg-section-title">
          Your voice, written down and marked
        </h2>
        <p className="kg-sub">
          Sample narration from a walkthrough. You talk while you walk;
          the words are transcribed, and the line that names the damage
          is pinned to its outline in the photo.
        </p>
        <div className="kg-pat-field">
          <div aria-hidden="true">
            <p className="kg-pat-line kg-pat-line--voice kg-pat-line--f3">
              0:07 — Bathroom — the cabinet floor is swollen.
            </p>
            <p className="kg-pat-line kg-pat-line--voice kg-pat-line--f1 kg-pat-line--o1">
              0:12 — Hallway — paint is bubbling above the skirting board.
            </p>
          </div>
          <p className="kg-pat-line kg-pat-line--voice kg-pat-marked">
            0:19 — Kitchen, north wall — there&apos;s a crack by the
            window, about thirty centimetres.
          </p>
          <p className="kg-pat-check">
            <span className="kg-pat-ok">✓ Transcribed</span> — your words,
            written down as you said them.
          </p>
          <p className="kg-pat-check">
            <span className="kg-pat-ok">✓ Marked</span> — this line is
            pinned to the crack, outlined on the photo as region 1.
          </p>
        </div>
        <p className="kg-sub">
          <Link href="/evidence">Open the evidence page →</Link>
        </p>
      </section>

      <section aria-labelledby="photos-heading">
        <h2 id="photos-heading" className="kg-section-title">
          Photos, stored and marked
        </h2>
        <p className="kg-sub">
          Sample frames. Move-in photos are kept together in one record;
          the damage in the one that matters is outlined — so it can be
          compared against later.
        </p>
        <div className="kg-pat-field">
          <div className="kg-pat-frames">
            <figure
              className="kg-pat-frame kg-pat-frame--faint"
              aria-hidden="true"
            >
              <WallSketch />
              <figcaption className="kg-pat-frame-tag">
                Kitchen — window wall
              </figcaption>
            </figure>
            <figure
              className="kg-pat-frame kg-pat-frame--faint"
              aria-hidden="true"
            >
              <WallSketch />
              <figcaption className="kg-pat-frame-tag">
                Bathroom — cabinet
              </figcaption>
            </figure>
            <figure className="kg-pat-frame kg-pat-frame--marked">
              <WallSketch crack="short" outlined />
              <span className="kg-pat-frame-mark">Stored · Marked</span>
              <figcaption className="kg-pat-frame-tag">
                Kitchen — north wall, crack outlined
              </figcaption>
            </figure>
            <figure
              className="kg-pat-frame kg-pat-frame--faint"
              aria-hidden="true"
            >
              <WallSketch />
              <figcaption className="kg-pat-frame-tag">
                Hallway — door frame
              </figcaption>
            </figure>
            <figure
              className="kg-pat-frame kg-pat-frame--faint"
              aria-hidden="true"
            >
              <WallSketch />
              <figcaption className="kg-pat-frame-tag">
                Bedroom — skirting
              </figcaption>
            </figure>
            <figure
              className="kg-pat-frame kg-pat-frame--faint"
              aria-hidden="true"
            >
              <WallSketch />
              <figcaption className="kg-pat-frame-tag">
                Kitchen — floor
              </figcaption>
            </figure>
          </div>
        </div>
        <p className="kg-sub">
          <Link href="/evidence">Open the evidence page →</Link>
        </p>
      </section>

      <section aria-labelledby="video-heading">
        <h2 id="video-heading" className="kg-section-title">
          The walkthrough video, kept in frames
        </h2>
        <p className="kg-sub">
          Sample frames. The whole video is stored with the record — and
          the moment the narration reaches the damage is the marked
          frame.
        </p>
        <div className="kg-pat-strip">
          <div className="kg-pat-strip-frames">
            <figure className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:00</span>
            </figure>
            <figure className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:07</span>
            </figure>
            <figure className="kg-pat-frame kg-pat-frame--marked">
              <span className="kg-pat-frame-mark">Marked</span>
              <span className="kg-pat-frame-tag">
                0:19 — crack, north wall
              </span>
            </figure>
            <figure className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:26</span>
            </figure>
            <figure className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:34</span>
            </figure>
            <figure className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:41</span>
            </figure>
          </div>
        </div>
        <p className="kg-sub">
          <Link href="/evidence">Open the evidence page →</Link>
        </p>
      </section>

      <section aria-labelledby="moveout-heading">
        <h2 id="moveout-heading" className="kg-section-title">
          Same wall, two different days
        </h2>
        <p className="kg-sub">
          An illustrated sample pair — drawings, not photographs. In
          this example, 62% of the move-in outline still matches in the
          move-out drawing. The 62% is an example figure, not a
          measurement of a real flat, and it does not show damage to
          any home.
        </p>
        <div className="kg-pat-field">
          <div className="kg-pat-pair">
            <figure className="kg-pat-frame">
              <WallSketch crack="short" />
              <figcaption className="kg-pat-frame-tag">
                Illustration — move-in day
              </figcaption>
            </figure>
            <p className="kg-pat-pair-vs">
              <strong>62%</strong> still matches — example figure
            </p>
            <figure className="kg-pat-frame kg-pat-frame--marked">
              <WallSketch crack="long" outlined />
              <span className="kg-pat-frame-mark">Marked</span>
              <figcaption className="kg-pat-frame-tag">
                Illustration — move-out day
              </figcaption>
            </figure>
          </div>
        </div>
        <p className="kg-sub">
          <Link href="/move-out">Open the move-out page →</Link>
        </p>
      </section>

      <section aria-labelledby="seal-heading">
        <h2 id="seal-heading" className="kg-section-title">
          The record, sealed
        </h2>
        <p className="kg-sub">
          The sample report&apos;s seal. The finished handover report is
          sealed with a SHA-256 hash: if anything in it changes, the
          seal stops matching.
        </p>
        <div className="kg-pat-field kg-pat-field--paper">
          <div aria-hidden="true">
            <p className="kg-pat-hash">
              sha256 · 9f2c…a41b · sha256 · 9f2c…a41b · sha256 · 9f2c…a41b
            </p>
            <p className="kg-pat-hash">
              9f2c…a41b · sha256 · 9f2c…a41b · sha256 · 9f2c…a41b · sha256
            </p>
          </div>
          <p className="kg-pat-hash kg-pat-hash--marked">
            sha256 · 9f2c…a41b — the seal on the sample handover report
          </p>
          <p className="kg-pat-seal-line">
            <span className="kg-pat-seal">✓ Sealed · sha256 9f2c…a41b</span>
          </p>
        </div>
        <p className="kg-sub">
          <Link href="/evidence">Open the evidence page →</Link>
        </p>
      </section>

      <section className="kg-panel" aria-label="AI Pipeline Trace">
        <p className="kg-overline" aria-hidden="true">How a check flows</p>
        <ol className="kg-hero-banner-list">
          <li><strong>Locale</strong><span> — auto-detect jurisdiction &amp; language, or use your pick.</span></li>
          <li><strong>Understand</strong><span> — decode the contract, or transcribe the walkthrough (silent videos fall back to vision).</span></li>
          <li><strong>Discover</strong><span> — blank image prompt? SAM concepts are discovered autonomously.</span></li>
          <li><strong>Outline</strong><span> — SAM 3.1 segments each defect; every mask keeps its own file &amp; box.</span></li>
          <li><strong>Seal</strong><span> — the handover report is hashed (SHA-256) so changes break the seal.</span></li>
        </ol>
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
              changed. Today&apos;s photo is outlined by a live check; the
              overlap is then calculated by the app.
            </span>
          </Link>
        </div>
      </section>
    </>
  );
}
