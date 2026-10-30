"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { verifyMoveout, type VerifyResponse } from "../../lib/api";
import {
  isRecord,
  loadPageState,
  savePageState,
} from "../../lib/pageState";
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

function isVerifyResponse(value: unknown): value is VerifyResponse {
  return (
    isRecord(value) &&
    isRecord(value.mask) &&
    isRecord(value.comparison) &&
    typeof value.review_note === "string"
  );
}

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
    return `The outlined area grew by about ${Math.round(growth * 100)}% since move-in day.`;
  }
  if (growth < -0.05) {
    return `The outlined area shrank by about ${Math.round(-growth * 100)}% since move-in day.`;
  }
  return "The outlined area is about the same size as on move-in day.";
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
    refsHydrated,
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
  const [stateHydrated, setStateHydrated] = useState(false);
  const storedRefKey = useRef<string | null>(null);

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

  // Restore this visit's earlier work on this page: source choice,
  // defect selection, prompt, reference selection and a finished
  // comparison. Declared after the priors effect above, so a prompt
  // the user edited here wins over the walkthrough's starting one.
  useEffect(() => {
    const saved = loadPageState("moveout");
    if (saved) {
      if (
        saved.verifySource === "reference" ||
        saved.verifySource === "polygon"
      ) {
        setVerifySource(saved.verifySource);
      }
      if (
        typeof saved.selectedDefect === "number" &&
        Number.isInteger(saved.selectedDefect) &&
        saved.selectedDefect >= 0
      ) {
        setSelectedDefect(saved.selectedDefect);
      }
      if (typeof saved.verifyPrompt === "string") {
        setVerifyPrompt(saved.verifyPrompt);
      }
      if (typeof saved.selectedRefKey === "string") {
        storedRefKey.current = saved.selectedRefKey;
      }
      if (isVerifyResponse(saved.verifyResult)) {
        setVerifyResult(saved.verifyResult);
      }
    }
    setStateHydrated(true);
  }, []);

  // Apply the stored reference selection once the shared store has
  // hydrated and the key is known to still exist.
  const refSelectionApplied = useRef(false);
  useEffect(() => {
    if (refSelectionApplied.current || !stateHydrated || !refsHydrated) {
      return;
    }
    refSelectionApplied.current = true;
    const key = storedRefKey.current;
    if (key && moveinRefs.some((ref) => ref.key === key)) {
      setSelectedRefKey(key);
    } else if (moveinRefs.length === 1) {
      // Exactly one saved problem and no stored selection to apply:
      // select it for the user. This effect is one-shot, so a later
      // deliberate deselect is never overridden.
      setSelectedRefKey(moveinRefs[0].key);
    }
  }, [stateHydrated, refsHydrated, moveinRefs, setSelectedRefKey]);

  // Persist the page's work whenever it changes (after hydration).
  useEffect(() => {
    if (!stateHydrated) return;
    savePageState("moveout", {
      version: 1,
      verifySource,
      selectedDefect,
      verifyPrompt,
      selectedRefKey,
      verifyResult,
    });
  }, [
    stateHydrated,
    verifySource,
    selectedDefect,
    verifyPrompt,
    selectedRefKey,
    verifyResult,
  ]);

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
    if (key === selectedRefKey) {
      // The selected reference is going away: its comparison result
      // must not survive it as a stale verdict.
      setVerifyResult(null);
    }
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
  const selectedDefectLabel = walkPriors?.defects[selectedDefect]
    ? `Defect ${selectedDefect + 1} — ${walkPriors.defects[selectedDefect].timestamp}`
    : null;
  // Readiness mirrors the Compare button's disabled conditions, in
  // words, so keyboard and screen-reader users get the same signal.
  const readinessText = (() => {
    if (verifySource === "reference") {
      if (selectedRef && moveoutFile) {
        return `Ready to compare: ${selectedRef.name} against your move-out photo.`;
      }
      if (!selectedRef && !moveoutFile) {
        return "To compare: pick a saved move-in problem and add a move-out photo.";
      }
      if (!selectedRef) {
        return "To compare: pick a saved move-in problem.";
      }
      return "To compare: add a move-out photo.";
    }
    if (hasWalkthrough && moveoutFile) {
      return `Ready to compare: ${selectedDefectLabel ?? "the walkthrough problem"} against your move-out photo.`;
    }
    if (!hasWalkthrough && !moveoutFile) {
      return "To compare: process a walkthrough on the Evidence page to get a problem outline, and add a move-out photo.";
    }
    if (!hasWalkthrough) {
      return "To compare: process a walkthrough on the Evidence page to get a problem outline.";
    }
    return "To compare: add a move-out photo.";
  })();
  const growthLine =
    verifyResult && verifyResult.comparison.match !== false
      ? growthSentence(verifyResult.comparison.area_growth_ratio)
      : null;

  return (
    <>
      <header className="kg-page-head">
        <p className="kg-overline">Step 3 of 3 · Move-out</p>
        <h1 className="kg-page-title">Compare when you move out</h1>
        <p className="kg-page-lede">
          Pick a saved move-in outline, add today&apos;s photo of the
          same spot, and see how much of the outline still matches —
          that overlap shows what changed in the outline; it does not
          establish damage or fault.
        </p>
      </header>
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
      <div className="kg-pat-field">
        <div className="kg-pat-pair">
          <div className="kg-pat-frame">
            <svg viewBox="0 0 160 120" aria-hidden="true" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="#6E675C" strokeWidth="2" />
              <rect x="98" y="22" width="34" height="42" fill="none" stroke="#6E675C" strokeWidth="2" />
              <path d="M98 64 C92 76 97 86 89 98" fill="none" stroke="#1E1B16" strokeWidth="2" />
              <path
                d="M104 58 C88 62 82 80 86 96 C88 106 100 108 106 100 C114 90 116 70 104 58 Z"
                fill="none"
                stroke="#45403A"
                strokeWidth="2.5"
                strokeDasharray="5 4"
              />
            </svg>
            <span className="kg-pat-frame-tag">Illustration — sample, move-in day</span>
          </div>
          <p className="kg-pat-pair-vs">
            <strong>62%</strong> still matches — example figure
          </p>
          <div className="kg-pat-frame kg-pat-frame--marked">
            <svg viewBox="0 0 160 120" aria-hidden="true" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="#6E675C" strokeWidth="2" />
              <rect x="98" y="22" width="34" height="42" fill="none" stroke="#6E675C" strokeWidth="2" />
              <path d="M98 64 C92 76 97 86 89 98 C86 104 90 108 88 112" fill="none" stroke="#1E1B16" strokeWidth="2" />
              <path
                d="M106 56 C86 60 78 82 84 100 C87 110 102 112 109 102 C118 90 120 66 106 56 Z"
                fill="none"
                stroke="#A62B1F"
                strokeWidth="2.5"
                strokeDasharray="5 4"
              />
            </svg>
            <span className="kg-pat-frame-mark">Marked</span>
            <span className="kg-pat-frame-tag">Illustration — sample, move-out day</span>
          </div>
        </div>
        <p className="kg-sub kg-mt12">
          Illustrated sample pair — drawings, not photographs. The 62% is
          an example figure showing how a result is presented; it is not a
          measurement of a real flat and does not show damage to any home.
          Your own pair is compared below.
        </p>
      </div>
      <fieldset className="kg-source-fieldset">
        <legend className="kg-source-legend">
          Move-in evidence to compare against
        </legend>
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
            aria-describedby={
              !hasWalkthrough ? "walkthrough-source-hint" : undefined
            }
          />{" "}
          A problem from my walkthrough video
        </label>
      </fieldset>
      {!hasWalkthrough && (
        <p id="walkthrough-source-hint" className="kg-sub">
          Process a walkthrough on the Evidence page to use this.
        </p>
      )}
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
                  <p id="reference-hint" className="kg-sub">
                    {selectedRef
                      ? `Selected: ${selectedRef.name}. Add today's photo, then Compare.`
                      : "Pick the move-in problem to compare against — Compare stays off until you pick one and add today's photo."}
                  </p>
                  <select
                    id="reference-select"
                    className="kg-control"
                    aria-describedby="reference-hint"
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
                      aria-label={
                        selectedRef
                          ? `Remove saved reference ${selectedRef.name}`
                          : undefined
                      }
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
            className="kg-control kg-file"
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
      <p role="status" className="kg-sub">
        {readinessText}
      </p>
      <p className="kg-note">
        Comparing sends today&apos;s photo and the saved outline to this
        app&apos;s backend. The photo is outlined by Meta&apos;s SAM 3.1
        service and the overlap is calculated on the backend; uploaded
        photos are kept in the backend&apos;s storage.
      </p>
      <button
        type="button"
        className="kg-btn kg-btn--primary kg-verify-cta"
        disabled={
          !moveoutFile ||
          verifying ||
          (verifySource === "reference" ? !selectedRef : !hasWalkthrough)
        }
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
          {!moveoutFile && (
            <p className="kg-stale-note">
              Result from earlier in this visit — add the photo again to
              re-check.
            </p>
          )}
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
              <div className="kg-pat-note">
                <h3 className="kg-verdict-line">
                  {overlapVerdict(
                    verifyResult.comparison.iou,
                    verifyResult.comparison.area_growth_ratio,
                  )}
                </h3>
                {growthLine && <p className="kg-sub">{growthLine}</p>}
              </div>
              <div className="kg-gauge">
                <div
                  className="kg-gauge-track"
                  role="progressbar"
                  aria-valuenow={Math.round(verifyResult.comparison.iou * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="How much the two masks overlap"
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

      {!verifyResult && (
        <div className="kg-ghost" aria-hidden="true">
          <div className="kg-ghost-compare">
            <div className="kg-ghost-pane">
              <svg
                width="72"
                height="44"
                viewBox="0 0 200 120"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M60 78 C50 55 70 34 96 36 C124 38 142 52 138 74 C134 96 112 104 92 100 C74 97 66 92 60 78 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="6"
                  strokeDasharray="14 10"
                />
                <circle cx="98" cy="66" r="7" fill="currentColor" />
              </svg>
              Move-in day — the problem you saved
            </div>
            <div className="kg-ghost-vs">VS</div>
            <div className="kg-ghost-pane">
              <svg
                width="72"
                height="44"
                viewBox="0 0 200 120"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M60 78 C50 55 70 34 96 36 C124 38 142 52 138 74 C134 96 112 104 92 100 C74 97 66 92 60 78 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="6"
                  strokeDasharray="14 10"
                />
                <circle cx="98" cy="66" r="7" fill="currentColor" />
              </svg>
              Today — your new photo
            </div>
          </div>
          <p className="kg-sub">
            Your comparison will appear here.
            <span className="kg-ghost-tag">Example</span>
          </p>
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
                  aria-current={ref.key === selectedRefKey || undefined}
                >
                  <img
                    className="kg-ref-thumb"
                    src={`data:image/png;base64,${ref.maskPngBase64}`}
                    alt=""
                  />
                  <span>{ref.name}</span>
                  {ref.key === selectedRefKey && (
                    <span className="kg-selected-tag">✓ Selected</span>
                  )}
                  <span className="kg-saved-ref-meta">
                    Saved {savedDateLabel(ref.savedAt)}
                  </span>
                  <button
                    type="button"
                    className="kg-btn kg-btn--sm kg-btn--ghost"
                    aria-label={`Remove saved reference ${ref.name}`}
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
    </>
  );
}
