"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { verifyMoveout, type VerifyResponse } from "../../lib/api";
import {
  buildPriorMaskPayload,
  MAX_SAVED_REFS,
} from "../../lib/moveinRefs";
import { NOT_PROVIDED } from "../../lib/uiHelpers";
import {
  loadWalkthroughPriors,
  type WalkthroughPriorSnapshot,
} from "../../lib/walkthroughPriors";
import { useKautionGuard } from "../KautionGuardProvider";

function overlapVerdict(iou: number, growth: number): string {
  if (!Number.isFinite(iou) || !Number.isFinite(growth)) {
    return "Comparison values unavailable.";
  }
  if (iou >= 0.8 && Math.abs(growth) < 0.2) {
    return "Masks overlap closely — little visible change between the two masks.";
  }
  if (iou < 0.3 || growth > 1) {
    return "Substantial visible change versus the move-in mask.";
  }
  return "Partial overlap — visual review needed.";
}

/**
 * Plain-words version of the backend's area change
 * (`area_growth_ratio` is the fractional change in mask area:
 * 0 = same size, 1 = twice as big, -0.5 = half the size).
 * Presentation only — the raw value stays in Technical details.
 */
function growthSentence(growth: number): string | null {
  if (!Number.isFinite(growth)) return null;
  if (growth > 0.05) {
    return `The damaged area grew by about ${Math.round(growth * 100)}% since move-in day.`;
  }
  if (growth < -0.05) {
    return `The damaged area shrank by about ${Math.round(-growth * 100)}% since move-in day.`;
  }
  return "The damaged area is about the same size as on move-in day.";
}

function savedDateLabel(savedAt: string): string {
  const parsed = new Date(savedAt);
  if (Number.isNaN(parsed.getTime())) return savedAt;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Step 3 — compare a photo from today with move-in day. The move-in
 * side is either a saved problem (shared store from the shell
 * provider) or a defect outline from a walkthrough (persisted
 * snapshot, see lib/walkthroughPriors). This page owns its own
 * "what to look for" prompt, initialised from the walkthrough's.
 */
export default function MoveOutPage() {
  const {
    moveinRefs,
    selectedRefKey,
    setSelectedRefKey,
    removeMoveinRef,
  } = useKautionGuard();

  const [selectedDefect, setSelectedDefect] = useState(0);
  const [moveoutFile, setMoveoutFile] = useState<File | null>(null);
  const [moveoutNatural, setMoveoutNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [moveoutPreviewUrl, setMoveoutPreviewUrl] = useState<string | null>(
    null,
  );
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [verifySource, setVerifySource] = useState<"reference" | "polygon">(
    "reference",
  );
  const [verifyPrompt, setVerifyPrompt] = useState("visible damage or stain");
  const [walkPriors, setWalkPriors] =
    useState<WalkthroughPriorSnapshot | null>(null);
  const [walkPriorsHydrated, setWalkPriorsHydrated] = useState(false);

  // Load the walkthrough snapshot once: it enables the defect-outline
  // source and provides the starting prompt for the comparison.
  useEffect(() => {
    const snapshot = loadWalkthroughPriors();
    setWalkPriors(snapshot);
    if (snapshot) {
      setVerifyPrompt(snapshot.prompt);
    }
    setWalkPriorsHydrated(true);
  }, []);

  // Keep the defect selection inside the loaded snapshot's range.
  useEffect(() => {
    if (walkPriors && selectedDefect >= walkPriors.defects.length) {
      setSelectedDefect(0);
    }
  }, [walkPriors, selectedDefect]);

  // Local preview of the move-out photo; its natural size validates the
  // reference frame before anything is sent.
  useEffect(() => {
    if (!moveoutFile) {
      setMoveoutPreviewUrl(null);
      setMoveoutNatural(null);
      return;
    }
    const url = URL.createObjectURL(moveoutFile);
    setMoveoutPreviewUrl(url);
    setMoveoutNatural(null);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [moveoutFile]);

  function onMoveoutFile(next: File | null) {
    setMoveoutFile(next);
    setVerifyResult(null);
  }

  function onRemoveRef(key: string) {
    removeMoveinRef(key);
  }

  async function onVerify() {
    if (!moveoutFile) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      if (verifySource === "reference") {
        const ref = moveinRefs.find((item) => item.key === selectedRefKey);
        if (!ref) {
          throw new Error(
            moveinRefs.length === 0
              ? "No move-in reference saved yet. Segment a move-in photo on the Evidence page and save one of its masks first."
              : "Select a saved move-in reference first.",
          );
        }
        // Cross-size references are sent as-is: the backend resizes the
        // move-in mask to the move-out dimensions before comparing (see
        // `dimension_normalized` on the result). Malformed or missing
        // evidence is still rejected with a clear error below.
        const result = await verifyMoveout(
          moveoutFile,
          "",
          verifyPrompt,
          JSON.stringify(buildPriorMaskPayload(ref)),
        );
        setVerifyResult(result);
        return;
      }
      if (!walkPriors) {
        throw new Error("Process a walkthrough first to use a defect polygon.");
      }
      const priorPolygon = walkPriors.regions[selectedDefect]?.polygon;
      if (!priorPolygon) {
        throw new Error("The selected defect has no polygon to compare against.");
      }
      const result = await verifyMoveout(moveoutFile, priorPolygon, verifyPrompt);
      setVerifyResult(result);
    } catch (e: unknown) {
      setVerifyError(e instanceof Error ? e.message : "Move-out verification failed");
    } finally {
      setVerifying(false);
    }
  }

  const selectedRef =
    moveinRefs.find((ref) => ref.key === selectedRefKey) ?? null;
  const hasWalkthrough =
    walkPriorsHydrated && walkPriors !== null && walkPriors.defects.length > 0;
  const growthLine =
    verifyResult && verifyResult.comparison.match !== false
      ? growthSentence(verifyResult.comparison.area_growth_ratio)
      : null;

  return (
    <section className="kg-panel" aria-labelledby="moveout-heading">
      <p className="kg-overline" aria-hidden="true">03 · Compare when you move out</p>
      <h2 id="moveout-heading" className="kg-section-title">
        Compare when you move out
      </h2>
      <p className="kg-sub">
        Pick a problem you saved on move-in day, add a photo of the same
        spot now, and we&apos;ll show what changed. This compares outlines
        only — it doesn&apos;t prove damage or who caused it.
      </p>
      <div role="radiogroup" aria-label="Prior evidence source" className="kg-radiogroup">
        <label className="kg-radio-label">
          <input
            type="radio"
            name="verify-source"
            value="reference"
            checked={verifySource === "reference"}
            onChange={() => setVerifySource("reference")}
          />{" "}
          A problem I saved earlier
        </label>
        <label
          className="kg-radio-label"
          title={
            hasWalkthrough
              ? undefined
              : "Process a walkthrough first to use a defect polygon"
          }
        >
          <input
            type="radio"
            name="verify-source"
            value="polygon"
            checked={verifySource === "polygon"}
            onChange={() => setVerifySource("polygon")}
            disabled={!hasWalkthrough}
          />{" "}
          A problem from my walkthrough video
        </label>
      </div>
      <div className="kg-compare-grid">
        <div className="kg-compare-pane">
          {verifySource === "reference" ? (
            <div>
              <label htmlFor="reference-select" className="kg-label">
                A problem you saved on move-in day
              </label>
              {moveinRefs.length === 0 ? (
                <p className="kg-sub">
                  No reference saved yet. Segment a move-in photo on the
                  Evidence page and save one of its masks first.
                </p>
              ) : (
                <>
                  <select
                    id="reference-select"
                    className="kg-control"
                    value={selectedRefKey ?? ""}
                    onChange={(e) => {
                      setSelectedRefKey(e.target.value || null);
                      setVerifyResult(null);
                    }}
                  >
                    <option value="">Select a reference…</option>
                    {moveinRefs.map((ref) => (
                      <option key={ref.key} value={ref.key}>
                        {ref.name}
                      </option>
                    ))}
                  </select>
                  {selectedRefKey && (
                    <button
                      type="button"
                      className="kg-btn kg-btn--sm kg-btn--danger"
                      onClick={() => onRemoveRef(selectedRefKey)}
                    >
                      Remove this reference
                    </button>
                  )}
                  {selectedRef && (
                    <div className="kg-card kg-mt12">
                      <p className="kg-compare-pane-title">Move-in day</p>
                      <div className="kg-compare-preview">
                        <img
                          src={`data:image/png;base64,${selectedRef.maskPngBase64}`}
                          alt="Saved mask (crop)"
                          className="kg-img"
                        />
                      </div>
                      <p className="kg-sub">Saved mask (crop)</p>
                      <details className="kg-tech-details">
                        <summary>Technical details</summary>
                        <p className="kg-mono">
                          saved {selectedRef.savedAt} · frame {selectedRef.frameSize.width}×{selectedRef.frameSize.height} · box {selectedRef.box.left},{selectedRef.box.top}–{selectedRef.box.right},{selectedRef.box.bottom} · mask {selectedRef.maskDims.width}×{selectedRef.maskDims.height}
                        </p>
                      </details>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div>
              <label htmlFor="defect-select" className="kg-label">
                Defect to compare
              </label>
              <select
                id="defect-select"
                className="kg-control"
                value={selectedDefect}
                onChange={(e) => {
                  setSelectedDefect(Number(e.target.value));
                  setVerifyResult(null);
                }}
              >
                {(walkPriors?.defects ?? []).map((defect, i) => (
                  <option key={i} value={i}>
                    Defect {i + 1} — {defect.timestamp}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="kg-compare-vs" aria-hidden="true">
          <span>VS</span>
        </div>
        <div className="kg-compare-pane">
          <label htmlFor="moveout-file" className="kg-label">
            Move-out image
          </label>
          <input
            id="moveout-file"
            type="file"
            accept="image/*"
            onChange={(e) => onMoveoutFile(e.target.files?.[0] ?? null)}
          />
          {moveoutPreviewUrl && (
            <div className="kg-mt12">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={moveoutPreviewUrl}
                alt="Selected move-out photo"
                onLoad={(e) =>
                  setMoveoutNatural({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  })
                }
                className="kg-img"
              />
              {moveoutNatural && (
                <>
                  <p className="kg-sub">
                    If your move-in photo was a different size, we&apos;ll
                    stretch the outline to fit before comparing.
                  </p>
                  <details className="kg-tech-details">
                    <summary>Technical details</summary>
                    <p className="kg-sub">
                      Move-out photo: {moveoutNatural.width}×{moveoutNatural.height} px.
                    </p>
                  </details>
                </>
              )}
            </div>
          )}
          <label htmlFor="verify-prompt" className="kg-label">
            What should we look for in the new photo?
          </label>
          <input
            id="verify-prompt"
            type="text"
            className="kg-control"
            value={verifyPrompt}
            onChange={(e) => setVerifyPrompt(e.target.value)}
          />
        </div>
      </div>
      <button
        type="button"
        className="kg-btn kg-btn--primary kg-verify-cta"
        disabled={!moveoutFile || verifying}
        onClick={onVerify}
      >
        {verifying ? "Comparing…" : "Compare the photos"}
      </button>
      {verifyError && (
        <p role="alert" className="kg-alert kg-alert--error">
          {verifyError}
        </p>
      )}
      {verifyResult && (
        <div aria-live="polite">
          {verifyResult.comparison.match === false ? (
            <>
              <p className="kg-alert kg-alert--warning">
                {verifyResult.comparison.note ?? NOT_PROVIDED}
              </p>
              <p className="kg-note">
                This describes mask overlap only — it does not prove damage
                or fault. Have a qualified professional review it before use.
              </p>
            </>
          ) : (
            <>
              <h3 className="kg-verdict-line">
                {overlapVerdict(
                  verifyResult.comparison.iou,
                  verifyResult.comparison.area_growth_ratio,
                )}
              </h3>
              {growthLine && <p className="kg-sub">{growthLine}</p>}
              <div className="kg-gauge">
                <div
                  className="kg-gauge-track"
                  role="progressbar"
                  aria-valuenow={Math.round(verifyResult.comparison.iou * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="How much the two photos match"
                >
                  <div
                    className="kg-gauge-fill"
                    style={{ width: `${verifyResult.comparison.iou * 100}%`, "--kg-p": verifyResult.comparison.iou } as CSSProperties}
                  />
                </div>
                <div className="kg-gauge-scale">
                  <span>0%</span>
                  <span>100%</span>
                </div>
              </div>
              <p className="kg-note">
                This describes mask overlap only — it does not prove damage
                or fault. Have a qualified professional review it before use.
              </p>
            </>
          )}
          <details className="kg-tech-details">
            <summary>Technical details</summary>
            {verifyResult.comparison.match !== false && (
              <p className="kg-sub">
                IoU {verifyResult.comparison.iou} · Move-in area{" "}
                {verifyResult.comparison.day1_area_px} px · Move-out area{" "}
                {verifyResult.comparison.moveout_area_px} px · Area growth{" "}
                {verifyResult.comparison.area_growth_ratio}
              </p>
            )}
            {(verifyResult.comparison.prior_kind ||
              verifyResult.comparison.frame_size) && (
              <p className="kg-sub">
                Prior: {verifyResult.comparison.prior_kind ?? "?"} ·
                Current: {verifyResult.comparison.current_kind ?? "?"} ·
                Frame: {verifyResult.comparison.frame_size?.width}×
                {verifyResult.comparison.frame_size?.height}
                {verifyResult.comparison.compared_object_id
                  ? ` · compared mask id ${verifyResult.comparison.compared_object_id}`
                  : ""}
              </p>
            )}
          </details>
          {verifyResult.comparison.dimension_normalized === true && (
            <p className="kg-note">
              Your move-in photo was a different size, so we resized its
              outline to fit. That only lines the two up — it doesn&apos;t
              prove damage or responsibility.
            </p>
          )}
          <p className="kg-note">{verifyResult.review_note}</p>
        </div>
      )}

      <div className="kg-saved-refs-wrap">
        <h3 className="kg-panel-title">
          Your saved move-in problems ({moveinRefs.length}/{MAX_SAVED_REFS})
        </h3>
        <p className="kg-sub">
          Stored only in this browser (localStorage) — not synced or
          backed up anywhere.
        </p>
        {moveinRefs.length === 0 ? (
          <p className="kg-empty">
            <span className="kg-empty-icon" aria-hidden="true">🖼</span>
            No references saved yet.
          </p>
        ) : (
          <div className="kg-saved-refs">
            {moveinRefs.map((ref) => (
              <span key={ref.key} className="kg-saved-ref-item">
                <span
                  className={`kg-saved-ref-badge${ref.key === selectedRefKey ? " kg-saved-ref-badge--selected" : ""}`}
                >
                  <img
                    className="kg-ref-thumb"
                    src={`data:image/png;base64,${ref.maskPngBase64}`}
                    alt=""
                  />
                  <span>{ref.name}</span>
                  <span className="kg-saved-ref-meta">
                    Saved {savedDateLabel(ref.savedAt)}
                  </span>
                  <button
                    type="button"
                    className="kg-btn kg-btn--sm kg-btn--ghost"
                    onClick={() => onRemoveRef(ref.key)}
                  >
                    Remove
                  </button>
                </span>
                <details className="kg-tech-details">
                  <summary>Technical details</summary>
                  <p className="kg-sub">
                    {ref.frameSize.width}×{ref.frameSize.height} · box {ref.box.left},{ref.box.top}–{ref.box.right},{ref.box.bottom} · mask {ref.maskDims.width}×{ref.maskDims.height} · {ref.savedAt}
                  </p>
                </details>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
