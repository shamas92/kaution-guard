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
 * The Pattern device (V6): the sample lease's repair clause, echoed at
 * fading strengths. Echoes are decoration only — the marked instance
 * below is the real line, and it is never inside the aria-hidden
 * wrappers. The clause is quoted verbatim from page 4 of the sample
 * lease, the same sentence the contract checker flags.
 */
function ClauseEcho({ className }: { className: string }) {
  return (
    <p className={`kg-pat-line ${className}`}>
      „Der Mieter trägt die Kosten für Kleinreparaturen bis zu{" "}
      <span className="kg-pat-amt">150&nbsp;€</span> im Einzelfall.“
    </p>
  );
}

function ClauseMarked() {
  return (
    <p className="kg-pat-line kg-pat-marked">
      „Der Mieter trägt die Kosten für Kleinreparaturen bis zu{" "}
      <span className="kg-pat-amt">150&nbsp;€</span> im Einzelfall.“
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
            <span>Demos and the move-out comparison cost $0.00. Live checks are capped: $5.00 per visit, $135.00 in total.</span>
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
              word for word against page 4 of the sample lease.
            </p>
            <p>
              <b>Law check · § 307 BGB</b> — a repair clause needs a yearly
              ceiling too. The pattern never prints one.
            </p>
            <p>
              Same page: <b>€3,600</b> asked, <b>€2,700</b> allowed —{" "}
              <b className="kg-pat-amt">€900 over</b> (§
              551 BGB).
            </p>
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
          A sample pair. The move-out photo is matched against the
          move-in outline: here, 62% of the outline still matches — the
          rest is what changed.
        </p>
        <div className="kg-pat-field">
          <div className="kg-pat-pair">
            <figure className="kg-pat-frame">
              <WallSketch crack="short" />
              <figcaption className="kg-pat-frame-tag">
                Move-in — day one
              </figcaption>
            </figure>
            <p className="kg-pat-pair-vs">
              <strong>62%</strong> still matches
            </p>
            <figure className="kg-pat-frame kg-pat-frame--marked">
              <WallSketch crack="long" outlined />
              <span className="kg-pat-frame-mark">Marked</span>
              <figcaption className="kg-pat-frame-tag">
                Move-out — moving day
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
