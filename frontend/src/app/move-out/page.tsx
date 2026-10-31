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
  loadMoveinRefs,
  MAX_SAVED_REFS,
  type MoveinReference,
  type RefStorage,
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

/** Human file size for the dropzone's file chip (KB below 1 MB). */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NOT_PROVIDED;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate one imported entry with the reference library's own
 * normaliser: `loadMoveinRefs` runs every stored entry through its
 * shape guard, so feeding it a one-entry in-memory store returns the
 * entry back only when it is a well-formed reference.
 */
function validateImportedRef(candidate: unknown): MoveinReference | null {
  const shim: RefStorage = {
    getItem: () => JSON.stringify([candidate]),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  const checked = loadMoveinRefs(shim);
  return checked.length === 1 ? checked[0] : null;
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
    commitMoveinRefs,
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
  const [moveoutDrag, setMoveoutDrag] = useState(false);
  const moveoutInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [transferNotice, setTransferNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

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

  /**
   * One-click sample for judges: draw a warm parquet floor with a
   * large damage mark on a canvas and feed the resulting JPEG through
   * the exact same state path as a manual photo pick (`onMoveoutFile`,
   * which also clears any previous comparison result).
   */
  function onAttachSampleMoveoutPhoto() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 420;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Warm parquet: base coat, then horizontal plank bands in varied
    // warm browns with thin seams and subtle grain.
    ctx.fillStyle = "#AE8652";
    ctx.fillRect(0, 0, 640, 420);
    const plankTones = [
      "#B78D55",
      "#A67C4A",
      "#BA905C",
      "#9C7443",
      "#B0824E",
      "#AC8149",
      "#A17843",
    ];
    const plankHeight = 60;
    for (let row = 0; row * plankHeight < 420; row += 1) {
      const top = row * plankHeight;
      ctx.fillStyle = plankTones[row % plankTones.length];
      ctx.fillRect(0, top, 640, plankHeight);
      // Staggered vertical joint for this band.
      ctx.fillStyle = "rgba(84, 58, 30, 0.55)";
      ctx.fillRect(((row * 197) % 520) + 60, top, 2, plankHeight);
      // Subtle grain lines.
      ctx.strokeStyle = "rgba(84, 58, 30, 0.18)";
      ctx.lineWidth = 1;
      for (let g = 0; g < 4; g += 1) {
        const gy = top + 10 + g * 13 + ((row + g) % 3);
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.bezierCurveTo(180, gy + 3, 420, gy - 3, 640, gy + 2);
        ctx.stroke();
      }
      // Seam between bands.
      ctx.fillStyle = "rgba(62, 42, 20, 0.8)";
      ctx.fillRect(0, top, 640, 2);
    }
    // Damage mark — deliberately larger than a typical move-in mark:
    // a soft wide under-stroke, then the dark diagonal stroke itself.
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(36, 23, 8, 0.35)";
    ctx.lineWidth = 28;
    ctx.beginPath();
    ctx.moveTo(120, 320);
    ctx.lineTo(500, 110);
    ctx.stroke();
    ctx.strokeStyle = "#241708";
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(120, 320);
    ctx.lineTo(500, 110);
    ctx.stroke();
    // Small secondary scuff arc.
    ctx.strokeStyle = "rgba(36, 23, 8, 0.75)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(520, 330, 42, Math.PI * 1.05, Math.PI * 1.7);
    ctx.stroke();
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onMoveoutFile(
          new File([blob], "sample-moveout-photo.jpg", {
            type: "image/jpeg",
          }),
        );
      },
      "image/jpeg",
      0.9,
    );
  }

  function onRemoveRef(key: string) {
    if (key === selectedRefKey) {
      // The selected reference is going away: its comparison result
      // must not survive it as a stale verdict.
      setVerifyResult(null);
    }
    removeMoveinRef(key);
  }

  function onClearMoveoutFile() {
    // Same reset as picking no file, plus clearing the native input
    // so the same photo can be picked again straight away.
    onMoveoutFile(null);
    if (moveoutInputRef.current) {
      moveoutInputRef.current.value = "";
    }
  }

  function onExportRefs() {
    // Serialise the canonical store via the library's own loader.
    const refs = loadMoveinRefs();
    const payload = {
      app: "kautionguard",
      kind: "movein-references",
      version: 1,
      exportedAt: new Date().toISOString(),
      references: refs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kautionguard-references.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setTransferNotice({
      kind: "ok",
      text: `Exported ${refs.length} saved reference${refs.length === 1 ? "" : "s"} to kautionguard-references.json.`,
    });
  }

  async function onImportRefsFile(file: File | null) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !isRecord(parsed) ||
        parsed.app !== "kautionguard" ||
        parsed.kind !== "movein-references" ||
        !Array.isArray(parsed.references)
      ) {
        throw new Error(
          "That file isn't a KautionGuard references export — nothing was imported.",
        );
      }
      if (parsed.version !== 1) {
        throw new Error(
          "That export uses an unsupported format version — nothing was imported.",
        );
      }
      // Keep only entries the library's own guard accepts.
      const valid: MoveinReference[] = [];
      for (const candidate of parsed.references) {
        const checked = validateImportedRef(candidate);
        if (checked) valid.push(checked);
      }
      const skippedInvalid = parsed.references.length - valid.length;
      if (valid.length === 0) {
        throw new Error(
          "No usable references in that file — nothing was imported.",
        );
      }
      // Skip references that are already saved (same key), and
      // duplicates inside the file itself.
      const existingKeys = new Set(moveinRefs.map((ref) => ref.key));
      const seen = new Set<string>();
      const fresh: MoveinReference[] = [];
      for (const ref of valid) {
        if (existingKeys.has(ref.key) || seen.has(ref.key)) continue;
        seen.add(ref.key);
        fresh.push(ref);
      }
      if (fresh.length === 0) {
        setTransferNotice({
          kind: "ok",
          text: "Those references are already saved — nothing new to import.",
        });
        return;
      }
      // Respect the store cap: import only what fits.
      const room = Math.max(0, MAX_SAVED_REFS - moveinRefs.length);
      const accepted = fresh.slice(0, room);
      if (accepted.length === 0) {
        setTransferNotice({
          kind: "error",
          text: `Your saved references are full (${MAX_SAVED_REFS}/${MAX_SAVED_REFS}) — nothing was imported.`,
        });
        return;
      }
      // Save through the shared store's commit path (which persists
      // via storeMoveinRefs and refreshes this page's list).
      const stored = commitMoveinRefs([...moveinRefs, ...accepted]);
      const notes: string[] = [];
      if (fresh.length > accepted.length) {
        notes.push(
          `${fresh.length - accepted.length} more didn't fit — the limit is ${MAX_SAVED_REFS}.`,
        );
      }
      if (skippedInvalid > 0) {
        notes.push(
          `${skippedInvalid} unreadable entr${skippedInvalid === 1 ? "y was" : "ies were"} skipped.`,
        );
      }
      if (!stored) {
        notes.push(
          "The browser store rejected the write (it may be full), so they may not survive a reload.",
        );
      }
      setTransferNotice({
        kind: "ok",
        text: `Imported ${accepted.length} reference${accepted.length === 1 ? "" : "s"}.${notes.length ? ` ${notes.join(" ")}` : ""}`,
      });
    } catch (e: unknown) {
      // A malformed file never touches the existing references:
      // every failure path above throws before any save happens.
      setTransferNotice({
        kind: "error",
        text:
          e instanceof Error
            ? e.message
            : "That file couldn't be imported — nothing was changed.",
      });
    }
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
        Your comparison
      </h2>
      <p className="kg-sub">
        Pick a problem you saved on move-in day, add a photo of the same
        spot now, and we&apos;ll show what changed. This compares outlines
        only — it doesn&apos;t prove damage or who caused it.
      </p>
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
                      <div className="kg-mask-stage">
                        <img
                          src={`data:image/png;base64,${selectedRef.maskPngBase64}`}
                          alt="Saved mask (crop)"
                          className="kg-img"
                        />
                        <span className="kg-dim-badge">
                          {selectedRef.maskDims.width} × {selectedRef.maskDims.height} px
                        </span>
                        <span className="kg-dim-badge">
                          {selectedRef.box.left}, {selectedRef.box.top} → {selectedRef.box.right}, {selectedRef.box.bottom}
                        </span>
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
          <div
            className={`kg-dropzone${moveoutDrag ? " kg-dropzone--drag" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setMoveoutDrag(true);
            }}
            onDragLeave={() => setMoveoutDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setMoveoutDrag(false);
              onMoveoutFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <label htmlFor="moveout-file" className="kg-label">
              Move-out image
            </label>
            <input
              id="moveout-file"
              ref={moveoutInputRef}
              type="file"
              accept="image/*"
              className="kg-dropzone-input"
              onChange={(e) => onMoveoutFile(e.target.files?.[0] ?? null)}
            />
            {moveoutFile && (
              <div className="kg-file-chip">
                <span className="kg-file-name">{moveoutFile.name}</span>
                <span className="kg-file-size">
                  {formatFileSize(moveoutFile.size)}
                </span>
                <button
                  type="button"
                  className="kg-btn kg-btn--sm"
                  onClick={onClearMoveoutFile}
                >
                  Remove / Change
                </button>
              </div>
            )}
            <button
              type="button"
              className="kg-btn kg-btn--quick"
              onClick={onAttachSampleMoveoutPhoto}
            >
              Attach Sample Move-Out Photo
            </button>
          </div>
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
          {Number.isFinite(verifyResult.elapsed_ms) && (
            <span className="kg-elapsed-pill">⚡ {verifyResult.elapsed_ms} ms · Meta SAM 3.1 + local IoU</span>
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
              <div className="kg-metric-pills">
                <div className="kg-metric-pill">
                  <span className="kg-metric-label">IoU</span>
                  <span className="kg-metric-value">
                    {Number.isFinite(verifyResult.comparison.iou)
                      ? `${Math.round(verifyResult.comparison.iou * 100)}%`
                      : NOT_PROVIDED}
                  </span>
                </div>
                <div className="kg-metric-pill">
                  <span className="kg-metric-label">Day-1 Area (px)</span>
                  <span className="kg-metric-value">
                    {Number.isFinite(verifyResult.comparison.day1_area_px)
                      ? verifyResult.comparison.day1_area_px
                      : NOT_PROVIDED}
                  </span>
                </div>
                <div className="kg-metric-pill">
                  <span className="kg-metric-label">Move-Out Area (px)</span>
                  <span className="kg-metric-value">
                    {Number.isFinite(verifyResult.comparison.moveout_area_px)
                      ? verifyResult.comparison.moveout_area_px
                      : NOT_PROVIDED}
                  </span>
                </div>
                <div className="kg-metric-pill">
                  <span className="kg-metric-label">Area Growth</span>
                  <span className="kg-metric-value">
                    {Number.isFinite(verifyResult.comparison.area_growth_ratio)
                      ? `${verifyResult.comparison.area_growth_ratio > 0 ? "+" : ""}${Math.round(verifyResult.comparison.area_growth_ratio * 100)}%`
                      : NOT_PROVIDED}
                  </span>
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
        <div className="kg-refs-transfer">
          <button
            type="button"
            className="kg-btn kg-btn--sm kg-btn--quick"
            disabled={moveinRefs.length === 0}
            onClick={onExportRefs}
          >
            Export Saved References (.json)
          </button>
          <button
            type="button"
            className="kg-btn kg-btn--sm"
            onClick={() => importInputRef.current?.click()}
          >
            Import References
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Import saved references from a JSON file"
            onChange={(e) => {
              void onImportRefsFile(e.target.files?.[0] ?? null);
              // Reset so picking the same file again re-runs the import.
              e.target.value = "";
            }}
          />
        </div>
        {transferNotice &&
          (transferNotice.kind === "error" ? (
            <p role="alert" className="kg-alert kg-alert--error">
              {transferNotice.text}
            </p>
          ) : (
            <p role="status" className="kg-sub">
              {transferNotice.text}
            </p>
          ))}
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
