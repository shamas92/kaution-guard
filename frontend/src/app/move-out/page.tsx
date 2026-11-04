"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowRightLeft, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import {
  API_BASE_URL,
  verifyMoveout,
  type VerifyMask,
  type VerifyResponse,
} from "../../lib/api";
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

/**
 * Convert an absolute backend storage path to its served `/files/...`
 * URL — the same derivation the Evidence page applies to walkthrough
 * files. Returns null for paths outside the served storage tree.
 */
function toFileUrl(fsPath: string): string | null {
  const normalised = fsPath.replace(/\\/g, "/");
  const idx = normalised.toLowerCase().indexOf("/storage/");
  if (idx === -1) return null;
  return `${API_BASE_URL}/files${normalised.slice(idx + "/storage".length)}`;
}

/**
 * Served URL of a verify result's full-frame overlay PNG. The SAM
 * record nests an absolute `overlay_path` (a frame-sized RGBA render
 * of the mask, written next to the mask file) alongside the typed
 * fields; only that frame-aligned render may be overlaid on the
 * photo — `mask_path` is a box-sized crop raster and is never
 * stretched over the frame. Null when no overlay was recorded.
 */
function verifyOverlayUrl(mask: VerifyMask): string | null {
  const nested = (mask as unknown as { overlay_path?: unknown })
    .overlay_path;
  return typeof nested === "string" && nested ? toFileUrl(nested) : null;
}

/**
 * Recolour a mask image into a translucent single-hue overlay for the
 * wipe comparison stage. Two mask encodings reach this helper:
 *
 * - Saved-reference crops are opaque L-mode PNGs (white = mask), so
 *   the mask strength lives in the pixels' luminance.
 * - SAM overlay PNGs are RGBA renders whose strength lives in the
 *   alpha channel (their RGB is already a translucent red wash), so
 *   luminance would under-report them.
 *
 * The helper detects which encoding it got — any pixel with
 * alpha < 255 means the alpha channel carries the mask — and rewrites
 * every pixel to `rgb` with alpha = strength × `alphaScale`. Returns
 * a PNG data URL; rejects when the image cannot be loaded or the
 * canvas is unreadable, so callers can fall back gracefully.
 */
async function tintMaskImage(
  src: string,
  rgb: [number, number, number],
  alphaScale = 0.55,
): Promise<string> {
  const img = new Image();
  // The overlay PNG is served cross-origin by the backend; request it
  // CORS-clean so the canvas stays readable. Data/blob URLs ignore
  // the attribute.
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("mask image failed to load"));
    img.src = src;
  });
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error("mask image has no size");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  const pixels = data.data;
  let hasAlpha = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) {
      hasAlpha = true;
      break;
    }
  }
  for (let i = 0; i < pixels.length; i += 4) {
    const strength = hasAlpha
      ? pixels[i + 3] / 255
      : (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) /
        255;
    pixels[i] = rgb[0];
    pixels[i + 1] = rgb[1];
    pixels[i + 2] = rgb[2];
    pixels[i + 3] = Math.round(strength * alphaScale * 255);
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Display render for a legacy mask crop saved before colour
 * previews existed: the crop's white mask pixels become a clean
 * terracotta wash over a warm parchment (#F7F5F0) ground, blended
 * by pixel luminance — never a stark black rectangle with white
 * blobs. Display only: the stored mask bytes (and therefore every
 * IoU payload built from them) are never altered. Rejects when the
 * image cannot be loaded or the canvas is unreadable, so callers
 * can simply omit the thumbnail.
 */
async function parchmentTintDataUrl(maskPngBase64: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("mask image failed to load"));
    img.src = `data:image/png;base64,${maskPngBase64}`;
  });
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error("mask image has no size");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const strength =
      (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) /
      255;
    // Parchment (247, 245, 240) → terracotta (200, 75, 49).
    pixels[i] = Math.round(247 + (200 - 247) * strength);
    pixels[i + 1] = Math.round(245 + (75 - 245) * strength);
    pixels[i + 2] = Math.round(240 + (49 - 240) * strength);
    pixels[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
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
  // Curated quick-picker busy state: the sample file name currently
  // being fetched for the move-out photo (mirrors the evidence page).
  const [quickMoveoutWorking, setQuickMoveoutWorking] = useState<
    string | null
  >(null);
  // Set when the result's overlay image fails to load (e.g. the file
  // aged out of backend storage): the panel then shows the photo
  // alone, never a broken image.
  const [overlayImgFailed, setOverlayImgFailed] = useState(false);
  // Result presentation: an interactive wipe ("curtain") between the
  // move-in and move-out outlines over today's photo, or the classic
  // side-by-side panels. The wipe position is a 0-100 percentage.
  const [compareView, setCompareView] = useState<"curtain" | "side">(
    "curtain",
  );
  const [curtainPct, setCurtainPct] = useState(50);
  // Defect zoom on the wipe stage: ON by default — every fresh
  // comparison result re-enables it, so the matched defect is
  // magnified unless the user explicitly turns the zoom off.
  const [zoomDefect, setZoomDefect] = useState(true);
  useEffect(() => {
    if (verifyResult) setZoomDefect(true);
  }, [verifyResult]);
  // Canvas-tinted mask renders for the wipe stage (terracotta =
  // today's outline, emerald = move-in outline), computed in an
  // effect below whenever a new result lands. Null = unavailable.
  const [curtainTints, setCurtainTints] = useState<{
    current: string | null;
    prior: string | null;
  }>({ current: null, prior: null });
  // Parchment-tint renders for references saved before colour
  // previews existed, keyed by reference key — the display fallback
  // until the auto-upgrade below has persisted a real preview.
  const [legacyPreviews, setLegacyPreviews] = useState<
    Record<string, string>
  >({});
  const legacyPreviewAttempted = useRef<Set<string>>(new Set());
  // Parchment-tint render of the selected walkthrough prior's mask
  // crop, used when that region has no baked colour composite.
  const [priorTint, setPriorTint] = useState<{
    forMask: string;
    url: string;
  } | null>(null);
  const [curtainCurrentFailed, setCurtainCurrentFailed] = useState(false);
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

  // Auto-upgrade legacy references: a reference saved before colour
  // previews existed carries only the binary mask crop. Render its
  // parchment-tint display once and persist it as the reference's
  // previewDataUrl, so the stored record itself becomes colour and
  // no view ever has to show the black-and-white crop again. Runs
  // once per mount, only when at least one reference lacks a
  // preview; references whose render fails are left untouched, and
  // the stored mask bytes never change.
  const previewUpgradeDone = useRef(false);
  useEffect(() => {
    if (!refsHydrated || previewUpgradeDone.current) return;
    if (!moveinRefs.some((ref) => !ref.previewDataUrl)) return;
    previewUpgradeDone.current = true;
    let cancelled = false;
    void (async () => {
      let changed = false;
      const next: MoveinReference[] = [];
      for (const ref of moveinRefs) {
        if (ref.previewDataUrl) {
          next.push(ref);
          continue;
        }
        try {
          const url = await parchmentTintDataUrl(ref.maskPngBase64);
          next.push({ ...ref, previewDataUrl: url });
          changed = true;
        } catch {
          next.push(ref);
        }
      }
      if (!cancelled && changed) {
        commitMoveinRefs(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [moveinRefs, refsHydrated, commitMoveinRefs]);

  // Display fallback while the upgrade is in flight (or after it
  // failed / for references imported later): compute the same
  // parchment-tint render per reference that still has neither a
  // stored preview nor a render. Each key is attempted at most once,
  // so a failed render cannot loop.
  useEffect(() => {
    const missing = moveinRefs.filter(
      (ref) =>
        !ref.previewDataUrl &&
        !legacyPreviews[ref.key] &&
        !legacyPreviewAttempted.current.has(ref.key),
    );
    if (missing.length === 0) return;
    for (const ref of missing) legacyPreviewAttempted.current.add(ref.key);
    let cancelled = false;
    void (async () => {
      for (const ref of missing) {
        try {
          const url = await parchmentTintDataUrl(ref.maskPngBase64);
          if (!cancelled) {
            setLegacyPreviews((prev) => ({ ...prev, [ref.key]: url }));
          }
        } catch {
          /* the thumbnail is simply omitted */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [moveinRefs, legacyPreviews]);

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

  // A new comparison result gets a fresh chance to load its overlay.
  useEffect(() => {
    setOverlayImgFailed(false);
  }, [verifyResult]);

  function onMoveoutFile(next: File | null) {
    setMoveoutFile(next);
    setVerifyResult(null);
  }

  // One-click demo photos: fetch one of the backend's curated samples
  // by file name and feed it through the same attach path as a manual
  // pick (native input sync + onMoveoutFile, which also clears any
  // previous comparison result) — the same generalisation the
  // evidence page's attachSamplePhoto uses. Fetch failures surface
  // via verifyError, this page's existing error alert.
  async function attachSampleMoveoutPhoto(sampleName: string) {
    setQuickMoveoutWorking(sampleName);
    setVerifyError(null);
    try {
      const response = await fetch(
        `${API_BASE_URL}/files/samples/${sampleName}`,
      );
      if (!response.ok) {
        throw new Error(
          "Sample photo is not available yet — the backend demo assets have not been generated.",
        );
      }
      const blob = await response.blob();
      const file = new File([blob], sampleName, {
        type: blob.type || "image/jpeg",
      });
      if (moveoutInputRef.current) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        moveoutInputRef.current.files = transfer.files;
      }
      onMoveoutFile(file);
    } catch (e: unknown) {
      setVerifyError(
        e instanceof Error && e.message.startsWith("Sample photo")
          ? e.message
          : "Sample photo is not available yet — the backend demo assets have not been generated.",
      );
    } finally {
      setQuickMoveoutWorking(null);
    }
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
          "That file isn't a LeaseLens references export — nothing was imported.",
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
      const region = walkPriors.regions[selectedDefect];
      if (region?.polygon) {
        const result = await verifyMoveout(
          moveoutFile,
          region.polygon,
          verifyPrompt,
        );
        setVerifyResult(result);
        return;
      }
      // Live walkthrough regions carry a raster mask instead of a
      // polygon: send it as the prior_mask payload, exactly like a
      // saved move-in reference.
      if (region?.priorMask) {
        const result = await verifyMoveout(
          moveoutFile,
          "",
          verifyPrompt,
          JSON.stringify(region.priorMask),
        );
        setVerifyResult(result);
        return;
      }
      throw new Error(
        "The selected defect has no polygon or mask to compare against.",
      );
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
  // When the backend registered the move-in mask onto the move-out one
  // (small viewpoint shift between the two photos), the gauge shows the
  // aligned IoU and the note keeps the raw figure visible.
  const comparisonOk =
    verifyResult && verifyResult.comparison.match !== false
      ? verifyResult.comparison
      : null;
  const displayIou =
    comparisonOk && comparisonOk.registered && Number.isFinite(comparisonOk.iou_registered)
      ? (comparisonOk.iou_registered as number)
      : comparisonOk
        ? comparisonOk.iou
        : 0;
  const registrationNote =
    comparisonOk && comparisonOk.registered
      ? `Aligned for a small viewpoint shift (${comparisonOk.registration_shift_px?.dx ?? 0}, ${comparisonOk.registration_shift_px?.dy ?? 0} px) — unaligned overlap was ${Math.round(comparisonOk.iou * 100)}%.`
      : null;
  // Display source for the selected reference: its stored colour
  // preview, or the parchment-tint render of its mask crop while no
  // preview exists yet. The raw binary crop is never an <img> src.
  const selectedRefPreviewSrc = selectedRef
    ? (selectedRef.previewDataUrl ??
      legacyPreviews[selectedRef.key] ??
      null)
    : null;
  // The selected walkthrough prior's raster payload and its baked
  // colour composite URL (absolutised like every served file URL).
  const selectedPriorRegion =
    verifySource === "polygon"
      ? (walkPriors?.regions[selectedDefect] ?? null)
      : null;
  const selectedPriorMask = selectedPriorRegion?.priorMask ?? null;
  const selectedPriorOverlayUrl = selectedPriorRegion?.overlayUrl
    ? selectedPriorRegion.overlayUrl.startsWith("/")
      ? `${API_BASE_URL}${selectedPriorRegion.overlayUrl}`
      : selectedPriorRegion.overlayUrl
    : null;

  // Parchment-tint render of the selected prior's mask crop, for
  // regions whose snapshot carries no baked colour composite.
  useEffect(() => {
    if (!selectedPriorMask || selectedPriorOverlayUrl) return;
    const maskBase64 = selectedPriorMask.mask_png_base64;
    if (priorTint?.forMask === maskBase64) return;
    let cancelled = false;
    void parchmentTintDataUrl(maskBase64)
      .then((url) => {
        if (!cancelled) setPriorTint({ forMask: maskBase64, url });
      })
      .catch(() => {
        if (!cancelled) setPriorTint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPriorMask, selectedPriorOverlayUrl, priorTint]);

  // "Move-in outline" panel visual: a colour render for whichever
  // source is active — a saved reference's colour preview (or its
  // parchment-tint fallback), or a walkthrough region's baked
  // colour composite (or its parchment-tint fallback). The binary
  // mask crop itself is never displayed. Null when the active
  // source has no colour visual yet (e.g. a polygon-only
  // walkthrough prior, or a tint still rendering): the panel then
  // shows a muted note instead of an image.
  const moveinPanelVisual = (() => {
    if (verifySource === "reference" && selectedRef) {
      if (!selectedRefPreviewSrc) return null;
      return {
        src: selectedRefPreviewSrc,
        alt: "Move-in photo with highlighted damage",
        detail: `Move-in photo with highlighted damage · ${selectedRef.maskDims.width} × ${selectedRef.maskDims.height} px · box ${selectedRef.box.left}, ${selectedRef.box.top} → ${selectedRef.box.right}, ${selectedRef.box.bottom}`,
      };
    }
    if (verifySource === "polygon" && selectedPriorMask) {
      const src =
        selectedPriorOverlayUrl ??
        (priorTint?.forMask === selectedPriorMask.mask_png_base64
          ? priorTint.url
          : null);
      if (!src) return null;
      const caption = selectedPriorOverlayUrl
        ? "Walkthrough photo with highlighted damage"
        : "Walkthrough outline with highlighted damage";
      return {
        src,
        alt: caption,
        detail: `${caption} · ${selectedPriorMask.mask_dims.width} × ${selectedPriorMask.mask_dims.height} px · box ${selectedPriorMask.box.left}, ${selectedPriorMask.box.top} → ${selectedPriorMask.box.right}, ${selectedPriorMask.box.bottom}`,
      };
    }
    return null;
  })();
  // "Move-out outline" panel overlay: the result's frame-aligned
  // overlay PNG, for match results only — a no-match result has no
  // mask to draw, so its panel shows the photo alone.
  const moveoutOverlayUrl =
    verifyResult && verifyResult.comparison.match !== false
      ? verifyOverlayUrl(verifyResult.mask)
      : null;
  // Wipe-stage prior geometry: the active source's mask crop plus the
  // box/frame it belongs to, for whichever source produced the
  // comparison — the same two sources as `moveinPanelVisual`, keeping
  // the box and frame size alongside the image. Null when the active
  // source has no raster prior to draw.
  const curtainPrior = (() => {
    if (verifySource === "reference" && selectedRef) {
      return {
        src: `data:image/png;base64,${selectedRef.maskPngBase64}`,
        box: selectedRef.box,
        frameSize: selectedRef.frameSize,
        // The reference's colour preview (photo + highlighted
        // defect), when one is stored: the wipe then shows the
        // colour photo on the move-in side instead of a tinted
        // mask crop.
        previewSrc: selectedRef.previewDataUrl ?? null,
      };
    }
    const priorMask = walkPriors?.regions[selectedDefect]?.priorMask;
    if (verifySource === "polygon" && priorMask) {
      return {
        src: `data:image/png;base64,${priorMask.mask_png_base64}`,
        box: priorMask.box,
        frameSize: priorMask.frame_size,
        previewSrc: null,
      };
    }
    return null;
  })();
  const curtainPriorSrc = curtainPrior?.src ?? null;
  const curtainPriorPreviewSrc = curtainPrior?.previewSrc ?? null;

  // Tint both masks for the wipe stage whenever a new result (or a
  // different prior/overlay behind it) arrives. Failures degrade to
  // fewer layers — the raw overlay PNG is already a red wash, so it
  // stands in for its own tint; a failed prior tint simply omits the
  // emerald layer. The side-by-side panels are unaffected either way.
  useEffect(() => {
    let cancelled = false;
    setCurtainTints({ current: null, prior: null });
    setCurtainCurrentFailed(false);
    if (!verifyResult || verifyResult.comparison.match === false) {
      return;
    }
    void (async () => {
      const [current, prior] = await Promise.all([
        moveoutOverlayUrl
          ? tintMaskImage(moveoutOverlayUrl, [200, 75, 49]).catch(
              () => moveoutOverlayUrl,
            )
          : Promise.resolve(null),
        // When the reference carries a colour preview photo, the
        // wipe's move-in side renders that photo directly and no
        // prior tint is needed.
        curtainPriorPreviewSrc
          ? Promise.resolve(null)
          : curtainPriorSrc
            ? tintMaskImage(curtainPriorSrc, [29, 107, 66]).catch(() => null)
            : Promise.resolve(null),
      ]);
      if (!cancelled) {
        setCurtainTints({ current, prior });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verifyResult, moveoutOverlayUrl, curtainPriorSrc, curtainPriorPreviewSrc]);

  // Wipe-stage prior placement: the mask crop positioned over the
  // move-out photo by percentage of its own frame (percentages are
  // scale-free, so this stays correct when the two photos differ in
  // pixel size — the same normalisation the backend comparator
  // applies). Null when the box/frame geometry is unusable.
  const curtainPriorStyle: CSSProperties | null = (() => {
    if (!curtainPrior) return null;
    const { box, frameSize } = curtainPrior;
    if (
      !frameSize ||
      !(frameSize.width > 0) ||
      !(frameSize.height > 0) ||
      !box
    ) {
      return null;
    }
    return {
      left: `${(box.left / frameSize.width) * 100}%`,
      top: `${(box.top / frameSize.height) * 100}%`,
      width: `${((box.right - box.left) / frameSize.width) * 100}%`,
      height: `${((box.bottom - box.top) / frameSize.height) * 100}%`,
    };
  })();
  // Registration shift for the wipe stage: applied to a stage-sized
  // inner layer, so translate percentages resolve against the full
  // frame and (dx / cw, dy / ch) lands as exactly the backend's pixel
  // shift in display terms. Only when the backend actually
  // registered the masks onto the comparison frame.
  const curtainShiftStyle: CSSProperties | undefined = (() => {
    const frame = comparisonOk?.frame_size;
    const shift = comparisonOk?.registration_shift_px;
    if (!comparisonOk?.registered || !frame || !shift) return undefined;
    if (!(frame.width > 0) || !(frame.height > 0)) return undefined;
    return {
      transform: `translate(${(shift.dx / frame.width) * 100}%, ${(shift.dy / frame.height) * 100}%)`,
    };
  })();
  // Registration badge figures: the comparison's RAW and REGISTERED
  // IoU (never the gauge's display value), shown when the backend
  // compensated a viewpoint shift.
  const registeredBadge =
    comparisonOk?.registered &&
    Number.isFinite(comparisonOk.iou_registered)
      ? {
          rawPct: ((comparisonOk.iou as number) * 100).toFixed(1),
          regPct: ((comparisonOk.iou_registered as number) * 100).toFixed(1),
          dx: comparisonOk.registration_shift_px?.dx ?? 0,
          dy: comparisonOk.registration_shift_px?.dy ?? 0,
        }
      : null;
  // Defect zoom geometry for the wipe stage. PRIMARY source: the
  // matched move-out mask's own polygon, whose points live in the
  // current frame's pixel space — its bounding-box centre IS where
  // the defect sits on stage, so scaling about it can never push the
  // masks out of view. (The earlier prior-box-plus-shift origin could
  // land on empty wall when the stored reference geometry diverged.)
  // FALLBACK: the prior box shifted by the registration offset.
  const zoomBox = (() => {
    const frame = comparisonOk?.frame_size;
    const polygon = verifyResult?.mask?.polygon;
    if (frame && Array.isArray(polygon) && polygon.length >= 3) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of polygon) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const [x, y] = point;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
        return {
          frameSize: frame,
          cx: (minX + maxX) / 2,
          cy: (minY + maxY) / 2,
        };
      }
    }
    if (!curtainPrior || !curtainPrior.box || !curtainPrior.frameSize) {
      return null;
    }
    const { box, frameSize } = curtainPrior;
    let cx = (box.left + box.right) / 2;
    let cy = (box.top + box.bottom) / 2;
    const shift = comparisonOk?.registration_shift_px;
    if (
      comparisonOk?.registered &&
      frame &&
      shift &&
      frame.width === frameSize.width &&
      frame.height === frameSize.height
    ) {
      cx += shift.dx;
      cy += shift.dy;
    }
    return { frameSize, cx, cy };
  })();
  const zoomOn = zoomBox ? zoomDefect : false;
  const zoomOrigin = zoomBox
    ? `${(zoomBox.cx / zoomBox.frameSize.width) * 100}% ${(zoomBox.cy / zoomBox.frameSize.height) * 100}%`
    : "50% 50%";

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
      <div className="kg-compare-grid kg-compare-grid--setup">
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
                        {selectedRefPreviewSrc && (
                          <img
                            src={selectedRefPreviewSrc}
                            alt="Move-in photo with highlighted damage"
                            className="kg-img"
                          />
                        )}
                        <span className="kg-dim-badge">
                          {selectedRef.maskDims.width} × {selectedRef.maskDims.height} px
                        </span>
                        <span className="kg-dim-badge">
                          {selectedRef.box.left}, {selectedRef.box.top} → {selectedRef.box.right}, {selectedRef.box.bottom}
                        </span>
                      </div>
                      <p className="kg-sub">Move-in photo with highlighted damage</p>
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
            className={clsx("kg-dropzone", moveoutDrag && "kg-dropzone--drag")}
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
                <span className="kg-file-meta">
                  <span className="kg-file-icon" aria-hidden="true">
                    📄
                  </span>
                  <span className="kg-file-name">{moveoutFile.name}</span>
                  <span className="kg-file-size">
                    {formatFileSize(moveoutFile.size)}
                  </span>
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
              <Sparkles size={14} aria-hidden="true" /> Attach Sample Move-Out Photo
            </button>
            <div
              className="kg-quick-strip"
              aria-label="Curated move-out test photos"
            >
              <button
                type="button"
                className="kg-quick-btn"
                onClick={() =>
                  void attachSampleMoveoutPhoto("dorm_table_burn_moveout.jpg")
                }
                disabled={quickMoveoutWorking !== null}
              >
                🔥 Table Burn (Move-Out Crop / Camera-Shift Demo)
              </button>
              <button
                type="button"
                className="kg-quick-btn"
                onClick={() =>
                  void attachSampleMoveoutPhoto("dorm_open_socket.jpg")
                }
                disabled={quickMoveoutWorking !== null}
              >
                ⚡ Open Wall Socket (Move-Out Check)
              </button>
            </div>
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
        {verifying ? "Comparing…" : (<><ArrowRightLeft size={16} aria-hidden="true" /> Compare the photos</>)}
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
          {verifyResult.comparison.match !== false && (
            <div
              className="kg-view-toggle"
              role="group"
              aria-label="Comparison view"
            >
              <button
                type="button"
                className={
                  compareView === "curtain"
                    ? "kg-view-toggle--active"
                    : undefined
                }
                aria-pressed={compareView === "curtain"}
                onClick={() => setCompareView("curtain")}
              >
                Wipe comparison
              </button>
              <button
                type="button"
                className={
                  compareView === "side" ? "kg-view-toggle--active" : undefined
                }
                aria-pressed={compareView === "side"}
                onClick={() => setCompareView("side")}
              >
                Side by side
              </button>
            </div>
          )}
          {verifyResult.comparison.match !== false &&
            compareView === "curtain" &&
            zoomBox && (
              <button
                type="button"
                className="kg-btn kg-btn--sm kg-zoom-toggle"
                aria-pressed={zoomOn}
                onClick={() => setZoomDefect(!zoomOn)}
              >
                🔍 2.2× Zoom on Defect
              </button>
            )}
          {verifyResult.comparison.match !== false &&
          compareView === "curtain" &&
          moveoutPreviewUrl ? (
            <>
              <div className="kg-curtain-stage">
                <span className="kg-curtain-badge kg-curtain-badge--prior">
                  ◀ DAY-1 MOVE-IN MASK
                  {registeredBadge ? " (REGISTERED)" : ""}
                </span>
                <span className="kg-curtain-badge kg-curtain-badge--current">
                  MOVE-OUT MASK (TODAY) ▶
                </span>
                <div
                  className="kg-curtain-zoom"
                  style={{
                    transform: zoomOn ? "scale(2.2)" : "scale(1)",
                    transformOrigin: zoomOrigin,
                  }}
                >
                <img
                  className="kg-curtain-base"
                  src={moveoutPreviewUrl}
                  alt="Move-out photo"
                />
                {curtainTints.current && !curtainCurrentFailed && (
                  <div
                    className="kg-curtain-layer"
                    style={{ clipPath: `inset(0 0 0 ${curtainPct}%)` }}
                  >
                    <img
                      src={curtainTints.current}
                      alt=""
                      aria-hidden="true"
                      onError={() => setCurtainCurrentFailed(true)}
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                      }}
                    />
                  </div>
                )}
                {curtainPriorPreviewSrc && (
                  <div
                    className="kg-curtain-layer"
                    style={{ clipPath: `inset(0 ${100 - curtainPct}% 0 0)` }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        ...curtainShiftStyle,
                      }}
                    >
                      <img
                        src={curtainPriorPreviewSrc}
                        alt=""
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    </div>
                  </div>
                )}
                {curtainTints.prior && curtainPriorStyle && (
                  <div
                    className="kg-curtain-layer"
                    style={{ clipPath: `inset(0 ${100 - curtainPct}% 0 0)` }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        ...curtainShiftStyle,
                      }}
                    >
                      <div
                        style={{ position: "absolute", ...curtainPriorStyle }}
                      >
                        <img
                          src={curtainTints.prior}
                          alt=""
                          aria-hidden="true"
                          style={{
                            display: "block",
                            width: "100%",
                            height: "100%",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
                <div
                  className="kg-curtain-divider"
                  style={{ left: `${curtainPct}%` }}
                />
                </div>
              </div>
              <input
                type="range"
                className="kg-curtain-range"
                min={0}
                max={100}
                value={curtainPct}
                onChange={(e) => setCurtainPct(Number(e.target.value))}
                aria-label="Wipe between the move-in and move-out outlines"
              />
            </>
          ) : (
          <div className="kg-compare-grid">
            <figure className="kg-compare-panel">
              <figcaption className="kg-compare-pane-title">
                Move-in outline
              </figcaption>
              {moveinPanelVisual ? (
                <>
                  <img
                    src={moveinPanelVisual.src}
                    alt={moveinPanelVisual.alt}
                    className="kg-img"
                  />
                  <p className="kg-sub">{moveinPanelVisual.detail}</p>
                </>
              ) : (
                <p className="kg-sub">
                  Move-in outline preview not available
                </p>
              )}
            </figure>
            <figure className="kg-compare-panel">
              <figcaption className="kg-compare-pane-title">
                Move-out outline
              </figcaption>
              {moveoutPreviewUrl ? (
                <div className="kg-stage-wrap">
                  <img
                    src={moveoutPreviewUrl}
                    alt="Move-out photo"
                    className="kg-stage-img"
                  />
                  {moveoutOverlayUrl && !overlayImgFailed && (
                    <img
                      src={moveoutOverlayUrl}
                      alt=""
                      aria-hidden="true"
                      onError={() => setOverlayImgFailed(true)}
                      className="kg-stage-overlay-img"
                    />
                  )}
                </div>
              ) : (
                <p className="kg-sub">
                  Move-out photo preview not available
                </p>
              )}
            </figure>
          </div>
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
                    displayIou,
                    verifyResult.comparison.area_growth_ratio,
                  )}
                </h3>
                {growthLine && <p className="kg-sub">{growthLine}</p>}
                {registrationNote && <p className="kg-sub">{registrationNote}</p>}
              </div>
              {registeredBadge && (
                <>
                  <p>
                    <span className="kg-shift-badge">
                      🎯 Camera Shift Compensated: Raw IoU{" "}
                      {registeredBadge.rawPct}% → Registered IoU{" "}
                      {registeredBadge.regPct}% (Aligned by Δx=
                      {registeredBadge.dx}px, Δy={registeredBadge.dy}px)
                    </span>
                  </p>
                  <p className="kg-shift-caption">
                    LeaseLens automatically corrected for camera
                    zoom/angle drift between the move-in and move-out
                    photos before computing the overlap.
                  </p>
                </>
              )}
              <div className="kg-gauge">
                <div
                  className="kg-gauge-track"
                  role="progressbar"
                  aria-valuenow={Math.round(displayIou * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="How much the two masks overlap"
                >
                  <div
                    className="kg-gauge-fill"
                    style={{ width: `${displayIou * 100}%`, "--kg-p": displayIou } as CSSProperties}
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
                    {Number.isFinite(displayIou)
                      ? `${Math.round(displayIou * 100)}%`
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
                  className={clsx("kg-saved-ref-badge", ref.key === selectedRefKey && "kg-saved-ref-badge--selected")}
                  aria-current={ref.key === selectedRefKey || undefined}
                >
                  {(ref.previewDataUrl ?? legacyPreviews[ref.key]) && (
                    <img
                      className="kg-ref-thumb"
                      src={ref.previewDataUrl ?? legacyPreviews[ref.key]}
                      alt=""
                    />
                  )}
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
