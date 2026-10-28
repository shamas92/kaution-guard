"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  API_BASE_URL,
  decodeContract,
  draftDispute,
  getMeta,
  processWalkthrough,
  segmentImage,
  verifyMoveout,
  type DecodeResponse,
  type DisputeResponse,
  type MetaStatus,
  type SegmentImageBox,
  type SegmentImageResponse,
  type VerifyResponse,
  type WalkthroughResponse,
} from "../lib/api";
import {
  buildPriorMaskPayload,
  loadMoveinRefs,
  storeMoveinRefs,
  MAX_SAVED_REFS,
  type MoveinReference,
} from "../lib/moveinRefs";
import {
  combineRastersOnFrame,
  markerPercent,
  maskPlacement,
  overlayEntries,
  previewToImage,
  sharedFrameSize,
} from "../lib/samOverlay";
import type { MaskRasterInput, OverlayEntry } from "../lib/samOverlay";

const FALLBACK_JURISDICTIONS = ["GLOBAL_AUTO", "DE", "UK", "US_NY", "FR", "JP"];
const LANGUAGES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "ja", label: "日本語" },
];
const NOT_PROVIDED = "Not provided by backend";

const theme = {
  page: {
    backgroundColor: "#10141a",
    color: "#e9e7e1",
    minHeight: "100vh",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    lineHeight: 1.5,
  } as const,
  wrap: { maxWidth: "880px", margin: "0 auto", padding: "32px 20px 64px" } as const,
  panel: {
    backgroundColor: "#1b222c",
    border: "1px solid #2e3947",
    borderRadius: "10px",
    padding: "20px",
    marginTop: "20px",
  } as const,
  heading: { margin: "0 0 4px", fontSize: "28px" } as const,
  sub: { margin: "0 0 8px", color: "#c6cdd6" } as const,
  sectionTitle: { margin: "0 0 12px", fontSize: "19px" } as const,
  label: { display: "block", fontWeight: 600, margin: "12px 0 4px" } as const,
  control: {
    backgroundColor: "#10141a",
    color: "#e9e7e1",
    border: "1px solid #4a5665",
    borderRadius: "6px",
    padding: "8px 10px",
    width: "100%",
    fontSize: "15px",
  } as const,
  row: { display: "flex", gap: "12px", flexWrap: "wrap" } as const,
  half: { flex: "1 1 220px" } as const,
  button: {
    backgroundColor: "#d9a441",
    color: "#191407",
    border: "none",
    borderRadius: "6px",
    padding: "10px 18px",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    marginTop: "14px",
  } as const,
  buttonDisabled: { opacity: 0.55, cursor: "not-allowed" } as const,
  error: {
    backgroundColor: "#3a1d1d",
    border: "1px solid #8a3b3b",
    borderRadius: "6px",
    padding: "10px 12px",
    marginTop: "12px",
  } as const,
  note: {
    backgroundColor: "#232d1a",
    border: "1px solid #5a7038",
    borderRadius: "6px",
    padding: "10px 12px",
    marginTop: "12px",
    color: "#d7dfc4",
  } as const,
  bar: { backgroundColor: "#0b0e12", borderRadius: "4px", height: "10px" } as const,
  barFill: { backgroundColor: "#d9a441", borderRadius: "4px", height: "10px" } as const,
  mono: {
    fontFamily: "ui-monospace, Consolas, monospace",
    fontSize: "13px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as const,
  quote: {
    borderLeft: "3px solid #22d3ee",
    margin: "12px 0",
    padding: "8px 12px",
    backgroundColor: "#16202a",
    borderRadius: "0 6px 6px 0",
  } as const,
  issue: {
    borderTop: "1px solid #2e3947",
    padding: "12px 0",
  } as const,
  badge: {
    display: "inline-block",
    border: "1px solid #4a5665",
    borderRadius: "20px",
    padding: "2px 10px",
    fontSize: "13px",
    marginRight: "8px",
  } as const,
  skip: {
    position: "absolute",
    left: "-9999px",
  } as const,
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function ratio(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, used / max));
}

function toFileUrl(fsPath: string): string | null {
  const normalised = fsPath.replace(/\\/g, "/");
  const idx = normalised.toLowerCase().indexOf("/storage/");
  if (idx === -1) return null;
  return `${API_BASE_URL}/files${normalised.slice(idx + "/storage".length)}`;
}

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
  { id: "DE", label: "Germany" },
  { id: "UK", label: "United Kingdom" },
  { id: "FR", label: "France" },
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

// One translucent fill + box outline per mask, cycled so masks stay
// distinguishable. Index 0 matches the previous single-mask look
// (cyan fill, amber box).
const OVERLAY_FILLS = [
  "rgba(34, 211, 238, 0.45)",
  "rgba(217, 163, 65, 0.45)",
  "rgba(244, 114, 182, 0.45)",
  "rgba(163, 230, 53, 0.45)",
];
const OVERLAY_STROKES = ["#d9a441", "#22d3ee", "#f472b6", "#a3e635"];

/**
 * Numbered target dots, positioned by percentage over exactly the
 * displayed image box they were clicked on. The containing layer must
 * wrap only the image (no captions), so the dots share the click
 * conversion's rectangle and scaling basis.
 */
function MarkerDots({
  points,
  natural,
}: {
  points: { x: number; y: number }[];
  natural: { width: number; height: number };
}) {
  if (natural.width <= 0 || natural.height <= 0) return null;
  return (
    <>
      {points.map((point, index) => {
        const pct = markerPercent(point, natural);
        if (!pct) return null;
        return (
          <span
            key={index}
            title={`Target ${index}: ${point.x}, ${point.y}`}
            style={{
              position: "absolute",
              left: `${pct.leftPct}%`,
              top: `${pct.topPct}%`,
              transform: "translate(-50%,-50%)",
              width: "22px",
              height: "22px",
              borderRadius: "50%",
              backgroundColor: "rgba(217, 65, 65, 0.9)",
              color: "#fff",
              fontSize: "12px",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              border: "2px solid #fff",
            }}
          >
            {index}
          </span>
        );
      })}
    </>
  );
}

function SegmentOverlay({
  imageUrl,
  entries,
  markers,
}: {
  imageUrl: string;
  entries: OverlayEntry[];
  markers?: { x: number; y: number }[] | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [drawError, setDrawError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDrawError(null);
    setSize(null);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const loadImage = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () =>
          reject(new Error(`Overlay image failed to load: ${src}`));
        img.src = src;
      });
    (async () => {
      try {
        const photo = await loadImage(imageUrl);
        if (cancelled) return;
        // Backing store keeps the original image dimensions; CSS scales
        // the display. The mask is drawn at the box origin, sized to the
        // box — never stretched over the whole frame.
        canvas.width = photo.naturalWidth;
        canvas.height = photo.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2d context unavailable");
        ctx.drawImage(photo, 0, 0);
        const lineWidth = Math.max(
          2,
          Math.round(photo.naturalWidth / 300),
        );
        entries.forEach((entry, index) => {
          const placement = maskPlacement(entry.box, entry.maskDims);
          if (!placement) return;
          ctx.strokeStyle =
            OVERLAY_STROKES[index % OVERLAY_STROKES.length];
          ctx.lineWidth = lineWidth;
          ctx.strokeRect(
            placement.dx,
            placement.dy,
            placement.dw,
            placement.dh,
          );
          if (entry.objectId) {
            ctx.font = "12px monospace";
            ctx.fillStyle = OVERLAY_STROKES[index % OVERLAY_STROKES.length];
            ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
            ctx.shadowBlur = 4;
            ctx.fillText(
              `mask ${entry.objectId}`,
              placement.dx + 2,
              Math.max(12, placement.dy - 4),
            );
            ctx.shadowBlur = 0;
          }
        });
        for (const [index, entry] of entries.entries()) {
          const placement = maskPlacement(entry.box, entry.maskDims);
          if (!placement || !entry.maskUrl || !entry.maskDims) continue;
          const mask = await loadImage(entry.maskUrl);
          if (cancelled) return;
          const tint = document.createElement("canvas");
          tint.width = entry.maskDims.width;
          tint.height = entry.maskDims.height;
          const tintCtx = tint.getContext("2d");
          if (!tintCtx) throw new Error("Canvas 2d context unavailable");
          tintCtx.drawImage(
            mask,
            0,
            0,
            entry.maskDims.width,
            entry.maskDims.height,
          );
          tintCtx.globalCompositeOperation = "source-in";
          tintCtx.fillStyle = OVERLAY_FILLS[index % OVERLAY_FILLS.length];
          tintCtx.fillRect(
            0,
            0,
            entry.maskDims.width,
            entry.maskDims.height,
          );
          ctx.drawImage(
            tint,
            placement.dx,
            placement.dy,
            placement.dw,
            placement.dh,
          );
        }
        if (!cancelled) {
          setSize({ width: photo.naturalWidth, height: photo.naturalHeight });
        }
      } catch {
        if (!cancelled) {
          setDrawError(
            "Overlay preview unavailable: an image failed to load.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageUrl, entries]);

  const placed = entries.filter(
    (entry) => maskPlacement(entry.box, entry.maskDims) !== null,
  );

  return (
    <div>
      {/* This wrapper shrink-wraps only the canvas (the displayed image
          box, captions excluded) so marker percentages resolve against
          the same rectangle the click conversion measures. The canvas is
          block to remove the inline baseline gap that would otherwise
          stretch the wrapper below the image. */}
      <div
        style={{
          position: "relative",
          display: "inline-block",
          maxWidth: "100%",
          lineHeight: 0,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            maxWidth: "100%",
            height: "auto",
            borderRadius: "6px",
            display: "block",
          }}
          role="img"
          aria-label={
            placed.length > 0
              ? `Original photo with ${placed.length} SAM mask${placed.length > 1 ? "s" : ""} overlaid in translucent color and the returned bounding boxes`
              : "Original photo (no mask matched)"
          }
        />
        {size && markers && markers.length > 0 && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              lineHeight: 1.5,
            }}
          >
            <MarkerDots points={markers} natural={size} />
          </div>
        )}
      </div>
      {size && (
        <p style={theme.sub}>
          Original: {size.width}×{size.height} px
          {placed.length > 0
            ? ` · ${placed.length} mask${placed.length > 1 ? "s" : ""} placed at box size: ` +
              placed
                .map(
                  (entry) =>
                    `#${entry.objectId ?? entry.key} ` +
                    `${entry.box?.left},${entry.box?.top}–` +
                    `${entry.box?.right},${entry.box?.bottom} ` +
                    `(raster ${entry.maskDims?.width}×${entry.maskDims?.height})`,
                )
                .join("; ")
            : " · no mask to place"}
        </p>
      )}
      {drawError && (
        <p role="alert" style={theme.error}>
          {drawError}
        </p>
      )}
    </div>
  );
}

/**
 * Still-image preview using the backend's full-frame overlay PNG when
 * available, falling back to the client-rendered SegmentOverlay when the
 * URL is absent or the overlay image fails to load. Marker dots render
 * over either preview.
 */
function ServerOverlayPreview({
  imageUrl,
  overlayUrl,
  entries,
  markers,
}: {
  imageUrl: string;
  overlayUrl: string;
  entries: OverlayEntry[];
  markers?: { x: number; y: number }[] | null;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [overlayFailed, setOverlayFailed] = useState(false);
  useEffect(() => {
    setNatural(null);
    setOverlayFailed(false);
  }, [imageUrl, overlayUrl]);
  if (overlayFailed) {
    return (
      <SegmentOverlay imageUrl={imageUrl} entries={entries} markers={markers} />
    );
  }
  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        maxWidth: "100%",
        lineHeight: 0,
      }}
    >
      <img
        src={imageUrl}
        alt="Original photo with the server-rendered SAM mask overlay"
        onLoad={(e) =>
          setNatural({
            width: e.currentTarget.naturalWidth,
            height: e.currentTarget.naturalHeight,
          })
        }
        style={{
          maxWidth: "100%",
          height: "auto",
          borderRadius: "6px",
          display: "block",
        }}
      />
      <img
        src={overlayUrl}
        alt=""
        aria-hidden="true"
        onError={() => setOverlayFailed(true)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          borderRadius: "6px",
          pointerEvents: "none",
        }}
      />
      {natural && markers && markers.length > 0 && (
        <div
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, lineHeight: 1.5 }}
        >
          <MarkerDots points={markers} natural={natural} />
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [jurisdiction, setJurisdiction] = useState("GLOBAL_AUTO");
  const [language, setLanguage] = useState("de");
  const [file, setFile] = useState<File | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decodeResult, setDecodeResult] = useState<DecodeResponse | null>(null);
  const [facts, setFacts] = useState("");
  const [outcome, setOutcome] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<DisputeResponse | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [samPrompt, setSamPrompt] = useState("visible damage or stain");
  const [maxFrames, setMaxFrames] = useState(5);
  const [working, setWorking] = useState(false);
  const [workStatus, setWorkStatus] = useState<string | null>(null);
  const [walkError, setWalkError] = useState<string | null>(null);
  const [walkResult, setWalkResult] = useState<WalkthroughResponse | null>(null);
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
  // Initialized empty so the server and the first client render match;
  // saved references load in an effect after hydration (see below).
  const [moveinRefs, setMoveinRefs] = useState<MoveinReference[]>([]);
  const [refsHydrated, setRefsHydrated] = useState(false);
  const [verifySource, setVerifySource] = useState<"reference" | "polygon">(
    "reference",
  );
  const [selectedRefKey, setSelectedRefKey] = useState<string | null>(null);
  const [savingRefKey, setSavingRefKey] = useState<string | null>(null);
  const [selectedSegmentKeys, setSelectedSegmentKeys] = useState<string[]>([]);
  const [savingCombined, setSavingCombined] = useState(false);
  const [selectedRegionMasks, setSelectedRegionMasks] = useState<
    {
      region: number;
      key: string;
      url: string;
      box: { left: number; top: number; right: number; bottom: number };
      maskDims: { width: number; height: number };
      frameWidth: number;
      frameHeight: number;
    }[]
  >([]);
  const [savingRegions, setSavingRegions] = useState(false);
  const [demoVideoLoading, setDemoVideoLoading] = useState(false);
  const [demoVideoError, setDemoVideoError] = useState<string | null>(null);
  const walkthroughFileRef = useRef<HTMLInputElement | null>(null);
  const [segmentFile, setSegmentFile] = useState<File | null>(null);
  const [segmentPrompt, setSegmentPrompt] = useState("visible damage or stain");
  const [segmentMode, setSegmentMode] = useState<"concept" | "points">(
    "concept",
  );
  const [segmentPoints, setSegmentPoints] = useState<
    { x: number; y: number }[]
  >([]);
  const [segmentNatural, setSegmentNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [segmentPreviewUrl, setSegmentPreviewUrl] = useState<string | null>(
    null,
  );
  const [segmenting, setSegmenting] = useState(false);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [segmentResult, setSegmentResult] = useState<SegmentImageResponse | null>(
    null,
  );
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoProgress, setDemoProgress] = useState(0);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<DemoPreset | null>(null);

  useEffect(() => {
    getMeta().then(setMeta).catch((e: unknown) => {
      setMetaError(e instanceof Error ? e.message : "Budget status unavailable");
    });
  }, []);

  // Local object URL for click-to-mark: the points UI needs a preview of
  // the selected photo before any segmentation result exists.
  useEffect(() => {
    if (!segmentFile) {
      setSegmentPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(segmentFile);
    setSegmentPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [segmentFile]);

  // Load saved references after hydration, when localStorage exists.
  // Both state updates apply on the next render, so the persist effect
  // below still sees refsHydrated as false in this commit and cannot
  // overwrite the store with the initial empty list.
  useEffect(() => {
    setMoveinRefs(loadMoveinRefs());
    setRefsHydrated(true);
  }, []);

  // Persist saved move-in references; a full or unavailable store keeps
  // the in-memory list and reports the failure on save instead.
  useEffect(() => {
    if (!refsHydrated) return;
    storeMoveinRefs(moveinRefs);
  }, [moveinRefs, refsHydrated]);

  // Keep the selected reference valid as the list changes.
  useEffect(() => {
    if (
      selectedRefKey &&
      !moveinRefs.some((ref) => ref.key === selectedRefKey)
    ) {
      setSelectedRefKey(moveinRefs[0]?.key ?? null);
    }
  }, [moveinRefs, selectedRefKey]);

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

  const jurisdictions =
    meta && meta.jurisdictions.length > 0 ? meta.jurisdictions : FALLBACK_JURISDICTIONS;
  const analysis = asRecord(decodeResult?.analysis);
  const resultObj = asRecord(analysis.result);
  const verification = asRecord(analysis.verification);
  const issues = list(analysis.possible_issues).map((item) => {
    const entry = asRecord(item);
    return {
      clause: text(entry.clause) ?? NOT_PROVIDED,
      explanation: text(entry.why_risky) ?? NOT_PROVIDED,
      severity: text(entry.severity) ?? NOT_PROVIDED,
      citation: text(entry.citation) ?? NOT_PROVIDED,
      flaggedAmount: num(entry.flagged_amount),
      verified: entry.verified_quote === true,
      evidenceQuote: text(entry.evidence_quote),
      verificationNote: text(entry.verification_note),
    };
  });
  const findingStrings = [...list(analysis.findings), ...list(resultObj.findings)]
    .filter((f) => typeof f === "string")
    .map((f) => ({
      clause: "(finding)",
      explanation: f as string,
      severity: NOT_PROVIDED,
      citation: NOT_PROVIDED,
      flaggedAmount: null as number | null,
      verified: false,
      evidenceQuote: null as string | null,
      verificationNote: "Not checked against the lease text.",
    }));
  const issueCount = num(analysis.issue_count);
  const highSeverityCount = num(analysis.high_severity_count);
  const totalFlaggedAmount = num(analysis.total_flagged_amount);
  const allIssues = [...issues, ...findingStrings];

  async function onDecode() {
    if (!file) return;
    setDecoding(true);
    setDecodeError(null);
    try {
      const result = await decodeContract(file, jurisdiction);
      setDecodeResult(result);
    } catch (e: unknown) {
      setDecodeError(e instanceof Error ? e.message : "Contract analysis failed");
    } finally {
      setDecoding(false);
    }
  }

  async function onDraft() {
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await draftDispute({
        jurisdiction_code: jurisdiction,
        facts,
        desired_outcome: outcome,
        user_language: language,
      });
      setDraftResult(result);
    } catch (e: unknown) {
      setDraftError(e instanceof Error ? e.message : "Draft request failed");
    } finally {
      setDrafting(false);
    }
  }

  interface RegionMaskChoice {
    key: string;
    url: string | null;
    box: { left: number; top: number; right: number; bottom: number } | null;
    maskDims: { width: number; height: number } | null;
    objectId: string | null;
  }

  function regionMaskChoices(region: {
    masks?: {
      object_id: string | null;
      box: { left: number; top: number; right: number; bottom: number } | null;
      mask_dims: { width: number; height: number } | null;
      mask_url: string | null;
    }[] | null;
    mask_path: string;
    box?: { left: number; top: number; right: number; bottom: number } | null;
    object_id?: string | null;
    mask_dims?: { width: number; height: number } | null;
  }): RegionMaskChoice[] {
    const listed = Array.isArray(region.masks) ? region.masks : [];
    if (listed.length > 0) {
      return listed.map((mask, index) => ({
        key: String(mask?.object_id ?? `mask-${index}`),
        url: typeof mask?.mask_url === "string" ? mask.mask_url : null,
        box: mask?.box ?? null,
        maskDims: mask?.mask_dims ?? null,
        objectId: mask?.object_id ?? null,
      }));
    }
    // Legacy single-mask rows (older or mock responses).
    return [
      {
        key: String(region.object_id ?? "mask-0"),
        url: region.mask_path ? toFileUrl(region.mask_path) : null,
        box: region.box ?? null,
        maskDims: region.mask_dims ?? null,
        objectId: region.object_id ?? null,
      },
    ];
  }

  function toggleSelectedRegionMask(choice: {
    region: number;
    key: string;
    url: string;
    box: { left: number; top: number; right: number; bottom: number };
    maskDims: { width: number; height: number };
    frameWidth: number;
    frameHeight: number;
  }) {
    setSelectedRegionMasks((prev) =>
      prev.some((s) => s.region === choice.region && s.key === choice.key)
        ? prev.filter(
            (s) => !(s.region === choice.region && s.key === choice.key),
          )
        : [...prev, choice],
    );
  }

  async function onSaveSelectedRegionMasks() {
    if (!walkResult || !video || selectedRegionMasks.length === 0) return;
    setSavingRegions(true);
    setWalkError(null);
    try {
      const shared = sharedFrameSize(
        selectedRegionMasks.map((s) => ({
          width: s.frameWidth,
          height: s.frameHeight,
        })),
      );
      if (!shared) {
        const seen = Array.from(
          new Set(
            selectedRegionMasks.map((s) => `${s.frameWidth}x${s.frameHeight}`),
          ),
        ).join(", ");
        throw new Error(
          `Selected masks come from different-size frames (${seen}). ` +
            `Select masks from a single frame size; nothing was saved.`,
        );
      }
      const rasters: MaskRasterInput[] = [];
      for (const selected of selectedRegionMasks) {
        rasters.push({
          pixels: await loadMaskRaster(
            selected.url,
            selected.maskDims.width,
            selected.maskDims.height,
          ),
          width: selected.maskDims.width,
          height: selected.maskDims.height,
          box: selected.box,
        });
      }
      await storeCombinedReference(
        video.name,
        shared,
        rasters,
        setWalkError,
      );
    } catch (e: unknown) {
      setWalkError(
        e instanceof Error ? e.message : "Could not save the reference.",
      );
    } finally {
      setSavingRegions(false);
    }
  }

  async function onLoadSampleVideo() {
    const videoUrl = demoResult?.walkthrough_video_url;
    // The button only renders when the demo response provides both the
    // URL and the availability flag; anything else is a programming
    // error, not a fetch.
    if (!demoResult?.walkthrough_video_available || !videoUrl) return;
    setDemoVideoLoading(true);
    setDemoVideoError(null);
    try {
      const response = await fetch(`${API_BASE_URL}${videoUrl}`);
      if (!response.ok) {
        throw new Error(`Sample video fetch failed (${response.status})`);
      }
      const blob = await response.blob();
      const file = new File([blob], "sample_walkthrough.mp4", {
        type: blob.type || "video/mp4",
      });
      setVideo(file);
      const input = walkthroughFileRef.current;
      if (input) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
      }
    } catch (e: unknown) {
      setDemoVideoError(
        e instanceof Error ? e.message : "Sample video load failed",
      );
    } finally {
      setDemoVideoLoading(false);
    }
  }

  async function onWalkthrough() {
    if (!video) return;
    setWorking(true);
    setWalkError(null);
    setWalkResult(null);
    setSelectedRegionMasks([]);
    setWorkStatus("Uploading video and processing frames, transcript and masks…");
    try {
      const result = await processWalkthrough(video, {
        jurisdictionCode: jurisdiction,
        userLanguage: language,
        textPrompt: samPrompt,
        maxFrames: Number.isFinite(maxFrames) && maxFrames > 0 ? Math.floor(maxFrames) : 5,
      });
      setWalkResult(result);
      setSelectedDefect(0);
      setWorkStatus(null);
    } catch (e: unknown) {
      setWalkError(e instanceof Error ? e.message : "Walkthrough processing failed");
      setWorkStatus(null);
    } finally {
      setWorking(false);
    }
  }

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

  function readBlobAsBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? "");
        const comma = url.indexOf(",");
        if (!url.startsWith("data:") || comma < 0) {
          reject(new Error("Could not read the mask file."));
          return;
        }
        resolve(url.slice(comma + 1));
      };
      reader.onerror = () =>
        reject(new Error("Could not read the mask file."));
      reader.readAsDataURL(blob);
    });
  }

  function loadNaturalSize(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () =>
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      img.onerror = () => reject(new Error("Could not read the image size."));
      img.src = url;
    });
  }

  function loadImageElement(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Overlay image failed to load: ${url}`));
      img.src = url;
    });
  }

  async function loadMaskRaster(
    url: string,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Could not read the mask file.");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImageElement(objectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas 2d context unavailable");
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const out = new Uint8Array(width * height);
      for (let i = 0; i < out.length; i++) {
        out[i] = data[i * 4] > 127 ? 1 : 0;
      }
      return out;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function gridToPngBase64(
    pixels: Uint8Array,
    width: number,
    height: number,
  ): Promise<string> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(new Error("Canvas 2d context unavailable"));
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < pixels.length; i++) {
      const value = pixels[i] ? 255 : 0;
      image.data[i * 4] = value;
      image.data[i * 4 + 1] = value;
      image.data[i * 4 + 2] = value;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Could not encode the combined mask."));
          return;
        }
        readBlobAsBase64(blob).then(resolve, reject);
      }, "image/png");
    });
  }

  async function storeCombinedReference(
    sourceName: string,
    frameSize: { width: number; height: number },
    rasters: MaskRasterInput[],
    setError: (message: string | null) => void,
  ): Promise<void> {
    if (moveinRefs.length >= MAX_SAVED_REFS) {
      setError(
        `Reference list is full (${MAX_SAVED_REFS}). Remove one in the move-out section first.`,
      );
      return;
    }
    const combined = combineRastersOnFrame(rasters, frameSize.width, frameSize.height);
    if (!combined) {
      setError("None of the selected masks could be placed on the frame.");
      return;
    }
    const maskPngBase64 = await gridToPngBase64(
      combined.pixels,
      combined.width,
      combined.height,
    );
    // The stored PNG spans the whole frame, so the box spans it too:
    // the backend stamps the raster at the box without stretching.
    const ref: MoveinReference = {
      key: `${Date.now()}-combined`,
      name: `${sourceName} · ${rasters.length} masks combined`,
      savedAt: new Date().toISOString(),
      frameSize,
      objectId: null,
      box: { left: 0, top: 0, right: frameSize.width, bottom: frameSize.height },
      maskDims: { width: combined.width, height: combined.height },
      maskPngBase64,
    };
    const next = [ref, ...moveinRefs].slice(0, MAX_SAVED_REFS);
    setMoveinRefs(next);
    setSelectedRefKey(ref.key);
    if (!storeMoveinRefs(next)) {
      setError(
        "Reference kept for this session, but the browser store is unavailable or full.",
      );
    }
  }

  function onMoveoutFile(next: File | null) {
    setMoveoutFile(next);
    setVerifyResult(null);
  }

  async function onSaveReference(entry: OverlayEntry) {
    if (
      !segmentResult?.image_url ||
      !entry.maskUrl ||
      !entry.box ||
      !entry.maskDims
    ) {
      setSegmentError("That mask has no file, box, or dimensions to save.");
      return;
    }
    if (moveinRefs.length >= MAX_SAVED_REFS) {
      setSegmentError(
        `Reference list is full (${MAX_SAVED_REFS}). Remove one in the move-out section first.`,
      );
      return;
    }
    setSavingRefKey(entry.key);
    setSegmentError(null);
    try {
      const maskResponse = await fetch(entry.maskUrl);
      if (!maskResponse.ok) throw new Error("Could not read the mask file.");
      const [maskPngBase64, frameSize] = await Promise.all([
        readBlobAsBase64(await maskResponse.blob()),
        loadNaturalSize(`${API_BASE_URL}${segmentResult.image_url}`),
      ]);
      const ref: MoveinReference = {
        key: `${Date.now()}-${entry.key}`,
        name: `${segmentFile?.name ?? "photo"} · mask ${entry.objectId ?? entry.key}`,
        savedAt: new Date().toISOString(),
        frameSize,
        objectId: entry.objectId,
        box: entry.box,
        maskDims: entry.maskDims,
        maskPngBase64,
      };
      const next = [ref, ...moveinRefs].slice(0, MAX_SAVED_REFS);
      setMoveinRefs(next);
      setSelectedRefKey(ref.key);
      if (!storeMoveinRefs(next)) {
        setSegmentError(
          "Reference kept for this session, but the browser store is unavailable or full.",
        );
      }
    } catch (e: unknown) {
      setSegmentError(
        e instanceof Error ? e.message : "Could not save the reference.",
      );
    } finally {
      setSavingRefKey(null);
    }
  }

  function onRemoveRef(key: string) {
    setMoveinRefs((prev) => prev.filter((ref) => ref.key !== key));
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
              ? "No move-in reference saved yet. Segment a move-in photo below and save one of its masks first."
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
          samPrompt,
          JSON.stringify(buildPriorMaskPayload(ref)),
        );
        setVerifyResult(result);
        return;
      }
      if (!walkResult) {
        throw new Error("Process a walkthrough first to use a defect polygon.");
      }
      const priorPolygon = walkResult.regions[selectedDefect]?.polygon;
      if (!priorPolygon) {
        throw new Error("The selected defect has no polygon to compare against.");
      }
      const result = await verifyMoveout(moveoutFile, priorPolygon, samPrompt);
      setVerifyResult(result);
    } catch (e: unknown) {
      setVerifyError(e instanceof Error ? e.message : "Move-out verification failed");
    } finally {
      setVerifying(false);
    }
  }

  function onSegmentFile(next: File | null) {
    setSegmentFile(next);
    // Spots belong to one photo: a new file clears them and the old size.
    setSegmentPoints([]);
    setSegmentNatural(null);
  }

  function onSegmentMode(next: "concept" | "points") {
    setSegmentMode(next);
    setSegmentError(null);
  }

  function onPreviewClick(e: ReactMouseEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const point = previewToImage(
      e.clientX,
      e.clientY,
      {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      { width: img.naturalWidth, height: img.naturalHeight },
    );
    if (!point) {
      setSegmentError("That click landed outside the photo — click on the photo itself.");
      return;
    }
    setSegmentError(null);
    setSegmentPoints((prev) => [...prev, point]);
  }

  function toggleSelectedSegmentKey(key: string) {
    setSelectedSegmentKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  async function onSaveSelectedSegmentMasks() {
    if (!segmentResult?.image_url || selectedSegmentKeys.length === 0) return;
    setSavingCombined(true);
    setSegmentError(null);
    try {
      const entries = overlayEntries(
        segmentResult.mask,
        (segmentResult.mask_urls ?? []).map((u) => `${API_BASE_URL}${u}`),
        segmentResult.mask_url ? `${API_BASE_URL}${segmentResult.mask_url}` : null,
      ).filter((entry) => selectedSegmentKeys.includes(entry.key));
      const frameSize = await loadNaturalSize(
        `${API_BASE_URL}${segmentResult.image_url}`,
      );
      const rasters: MaskRasterInput[] = [];
      for (const entry of entries) {
        if (!entry.maskUrl || !entry.box || !entry.maskDims) {
          throw new Error("A selected mask has no file, box, or dimensions.");
        }
        rasters.push({
          pixels: await loadMaskRaster(
            entry.maskUrl,
            entry.maskDims.width,
            entry.maskDims.height,
          ),
          width: entry.maskDims.width,
          height: entry.maskDims.height,
          box: entry.box,
        });
      }
      await storeCombinedReference(
        segmentFile?.name ?? "photo",
        frameSize,
        rasters,
        setSegmentError,
      );
    } catch (e: unknown) {
      setSegmentError(
        e instanceof Error ? e.message : "Could not save the reference.",
      );
    } finally {
      setSavingCombined(false);
    }
  }

  async function onSegment() {
    if (!segmentFile) return;
    const pointMode = segmentMode === "points";
    if (pointMode && segmentPoints.length === 0) return;
    setSegmenting(true);
    setSegmentError(null);
    setSegmentResult(null);
    setSelectedSegmentKeys([]);
    try {
      const result = await segmentImage(
        segmentFile,
        segmentPrompt,
        pointMode
          ? segmentPoints.map((point) => ({ x: point.x, y: point.y }))
          : undefined,
      );
      setSegmentResult(result);
    } catch (e: unknown) {
      setSegmentError(e instanceof Error ? e.message : "Segmentation failed");
    } finally {
      setSegmenting(false);
    }
  }

  const draft = asRecord(draftResult?.draft);
  const session = meta?.spend_usd.session ?? 0;
  const cumulative = meta?.spend_usd.cumulative ?? 0;
  const maxSession = meta?.limits_usd.max_session ?? 0;
  const maxCumulative = meta?.limits_usd.max_cumulative ?? 0;

  return (
    <main style={theme.page}>
      <a href="#results" style={theme.skip}>
        Skip to results
      </a>
      <div style={theme.wrap}>
        <h1 style={theme.heading}>KautionGuard</h1>
        <p style={theme.sub}>
          Tenant document review and apartment evidence workspace. Findings are
          preliminary — have a qualified professional review them.
        </p>

        <section style={theme.panel} aria-labelledby="budget-heading">
          <h2 id="budget-heading" style={theme.sectionTitle}>
            Budget status
          </h2>
          {metaError && (
            <p role="alert" style={theme.error}>
              Budget panel unavailable: {metaError}. Is the backend running on
              port 8000?
            </p>
          )}
          {meta && (
            <div>
              <p style={theme.sub}>
                Session spend ${session.toFixed(2)} of ${maxSession.toFixed(2)}
              </p>
              <div
                style={theme.bar}
                role="progressbar"
                aria-valuenow={Math.round(ratio(session, maxSession) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Session spend"
              >
                <div
                  style={{ ...theme.barFill, width: `${ratio(session, maxSession) * 100}%` }}
                />
              </div>
              <p style={{ ...theme.sub, marginTop: "12px" }}>
                Cumulative spend ${cumulative.toFixed(2)} of $
                {maxCumulative.toFixed(2)}
              </p>
              <div
                style={theme.bar}
                role="progressbar"
                aria-valuenow={Math.round(ratio(cumulative, maxCumulative) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Cumulative spend"
              >
                <div
                  style={{
                    ...theme.barFill,
                    width: `${ratio(cumulative, maxCumulative) * 100}%`,
                  }}
                />
              </div>
              <p style={{ ...theme.sub, marginTop: "12px" }}>
                <span style={theme.badge}>
                  Offline lock: {meta.offline_lock ? "on" : "off"}
                </span>
                <span style={theme.badge}>
                  Disk cache: {meta.disk_cache ? "on" : "off"}
                </span>
              </p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="demo-heading">
          <h2 id="demo-heading" style={theme.sectionTitle}>
            Try a demo
          </h2>
          <p style={theme.sub}>
            Load local synthetic demo assets (fictional leases). Loading a
            demo makes no API calls — analyse or dispute only if you choose to
            below.
          </p>
          <div style={theme.row}>
            {DEMO_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                style={{
                  ...theme.button,
                  ...(demoLoading ? theme.buttonDisabled : {}),
                  marginTop: "6px",
                }}
                disabled={demoLoading}
                onClick={() => onLoadDemo(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          {demoLoading && (
            <div
              style={{ ...theme.bar, marginTop: "12px" }}
              role="progressbar"
              aria-valuenow={demoProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Loading demo"
            >
              <div style={{ ...theme.barFill, width: `${demoProgress}%` }} />
            </div>
          )}
          {demoError && (
            <p role="alert" style={theme.error}>
              {demoError}
            </p>
          )}
          {demoResult && (
            <div aria-live="polite">
              <h3>{demoResult.title}</h3>
              <p style={theme.sub}>{demoResult.description}</p>
              <ul>
                {demoResult.demo_issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
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
              {!demoResult.walkthrough_video_available && (
                <p style={theme.sub}>
                  No sample walkthrough video on this host (FFmpeg is not
                  available); video processing stays disabled for the demo.
                </p>
              )}
              {demoResult.walkthrough_video_available &&
                demoResult.walkthrough_video_url && (
                  <p>
                    <button
                      type="button"
                      onClick={onLoadSampleVideo}
                      disabled={demoVideoLoading}
                    >
                      {demoVideoLoading
                        ? "Loading sample video…"
                        : "Load Sample Walkthrough Video"}
                    </button>
                  </p>
                )}
              {demoVideoError && (
                <p role="alert" style={theme.error}>
                  {demoVideoError}
                </p>
              )}
              <p style={theme.note}>{demoResult.review_note}</p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="contract-heading">
          <h2 id="contract-heading" style={theme.sectionTitle}>
            Contract review
          </h2>
          <div style={theme.row}>
            <div style={theme.half}>
              <label htmlFor="jurisdiction" style={theme.label}>
                Jurisdiction
              </label>
              <select
                id="jurisdiction"
                style={theme.control}
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
              >
                {jurisdictions.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div style={theme.half}>
              <label htmlFor="tenant-language" style={theme.label}>
                Tenant language
              </label>
              <select
                id="tenant-language"
                style={theme.control}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label htmlFor="contract-file" style={theme.label}>
            Rental contract (PDF)
          </label>
          <input
            id="contract-file"
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-describedby="contract-help"
          />
          <p id="contract-help" style={theme.sub}>
            Text is extracted locally in the backend; only the text is sent for
            analysis.
          </p>
          <button
            type="button"
            style={{ ...theme.button, ...(!file || decoding ? theme.buttonDisabled : {}) }}
            disabled={!file || decoding}
            onClick={onDecode}
          >
            {decoding ? "Analysing…" : "Analyse contract"}
          </button>
          {decodeError && (
            <p role="alert" style={theme.error}>
              {decodeError}
            </p>
          )}
        </section>

        <section id="results" style={theme.panel} aria-labelledby="results-heading" aria-live="polite">
          <h2 id="results-heading" style={theme.sectionTitle}>
            Results
          </h2>
          {!decodeResult && <p style={theme.sub}>No analysis yet — upload a contract above.</p>}
          {decodeResult && (
            <div>
              <p style={theme.sub}>
                Risk score: {text(analysis.risk_score) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Estimated savings: {text(analysis.estimated_savings) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Confidence: {text(analysis.confidence) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Summary: {text(analysis.summary) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Deposit terms: {text(analysis.deposit_terms) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Flagged issues: {issueCount ?? NOT_PROVIDED} · High
                severity: {highSeverityCount ?? NOT_PROVIDED} · Total
                flagged amount:{" "}
                {totalFlaggedAmount ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Analysed characters: {decodeResult.truncated_chars} of{" "}
                {decodeResult.total_chars}
              </p>
              {allIssues.length === 0 && (
                <p style={theme.sub}>
                  Cited clauses: {NOT_PROVIDED} — the backend returned no
                  clause list for this analysis.
                </p>
              )}
              {typeof verification.verified_quotes === "number" &&
                typeof verification.checked_issues === "number" &&
                verification.checked_issues > 0 && (
                  <p style={theme.sub}>
                    Excerpts verified against the uploaded lease text:{" "}
                    {verification.verified_quotes} of{" "}
                    {verification.checked_issues}.
                  </p>
                )}
              {allIssues.map((issue, i) => (
                <article key={i} style={theme.issue} aria-label={`Issue ${i + 1}`}>
                  <p>
                    <strong>Clause:</strong> {issue.clause}
                  </p>
                  <p>
                    <strong>Severity:</strong> {issue.severity}
                  </p>
                  <p>
                    <strong>Explanation:</strong> {issue.explanation}
                  </p>
                  <p>
                    <strong>Citation:</strong> {issue.citation}
                  </p>
                  <p>
                    <strong>Flagged amount:</strong>{" "}
                    {issue.flaggedAmount ?? NOT_PROVIDED}
                  </p>
                  {issue.evidenceQuote ? (
                    issue.verified ? (
                      <blockquote style={theme.quote}>
                        {issue.evidenceQuote}
                        <footer style={theme.sub}>
                          Verified verbatim excerpt from the uploaded lease.
                        </footer>
                      </blockquote>
                    ) : (
                      <p role="alert" style={theme.error}>
                        Unverified excerpt — could not be matched to the
                        uploaded lease text
                        {issue.verificationNote
                          ? ` (${issue.verificationNote})`
                          : ""}
                        . Treat it as model output, not document evidence:{" "}
                        {issue.evidenceQuote}
                      </p>
                    )
                  ) : (
                    issue.verificationNote && (
                      <p style={theme.sub}>
                        Evidence status: {issue.verificationNote}
                      </p>
                    )
                  )}
                </article>
              ))}
              <p style={theme.note}>{decodeResult.review_note}</p>
              <details>
                <summary>Full backend response</summary>
                <pre style={theme.mono}>{JSON.stringify(analysis, null, 2)}</pre>
              </details>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="dispute-heading">
          <h2 id="dispute-heading" style={theme.sectionTitle}>
            Bilingual dispute notice
          </h2>
          <label htmlFor="facts" style={theme.label}>
            What happened (facts for the letter)
          </label>
          <textarea
            id="facts"
            style={{ ...theme.control, minHeight: "90px" }}
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
            placeholder="e.g. Deposit of €900 retained without an itemised statement…"
          />
          <label htmlFor="outcome" style={theme.label}>
            Desired outcome (optional)
          </label>
          <input
            id="outcome"
            type="text"
            style={theme.control}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="e.g. Full deposit return within 14 days"
          />
          <button
            type="button"
            style={{ ...theme.button, ...(drafting || !facts.trim() ? theme.buttonDisabled : {}) }}
            disabled={drafting || !facts.trim()}
            onClick={onDraft}
          >
            {drafting ? "Drafting…" : "Request bilingual notice"}
          </button>
          {draftError && (
            <p role="alert" style={theme.error}>
              {draftError}
            </p>
          )}
          {draftResult && (
            <div aria-live="polite">
              <p style={theme.sub}>
                Requested for jurisdiction {jurisdiction}, tenant language{" "}
                {language}.
              </p>
              <h3>Draft (record language)</h3>
              <p>{text(draft.draft_local) ?? NOT_PROVIDED}</p>
              <h3>Draft (tenant language)</h3>
              <p>{text(draft.draft_tenant) ?? NOT_PROVIDED}</p>
              {text(draft.caveats) && (
                <p style={theme.note}>Caveats: {text(draft.caveats)}</p>
              )}
              <p style={theme.note}>{draftResult.review_note}</p>
              <details>
                <summary>Full backend response</summary>
                <pre style={theme.mono}>{JSON.stringify(draft, null, 2)}</pre>
              </details>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="walkthrough-heading">
          <h2 id="walkthrough-heading" style={theme.sectionTitle}>
            Walkthrough video
          </h2>
          <label htmlFor="walkthrough-file" style={theme.label}>
            Walkthrough video
          </label>
          <input
            id="walkthrough-file"
            ref={walkthroughFileRef}
            type="file"
            accept="video/*"
            onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
          />
          <div style={theme.row}>
            <div style={theme.half}>
              <label htmlFor="sam-prompt" style={theme.label}>
                SAM text prompt
              </label>
              <input
                id="sam-prompt"
                type="text"
                style={theme.control}
                value={samPrompt}
                onChange={(e) => setSamPrompt(e.target.value)}
              />
            </div>
            <div style={theme.half}>
              <label htmlFor="max-frames" style={theme.label}>
                Max frames
              </label>
              <input
                id="max-frames"
                type="number"
                min={1}
                style={theme.control}
                value={maxFrames}
                onChange={(e) => setMaxFrames(Number(e.target.value))}
              />
            </div>
          </div>
          <button
            type="button"
            style={{ ...theme.button, ...(!video || working ? theme.buttonDisabled : {}) }}
            disabled={!video || working}
            onClick={onWalkthrough}
          >
            {working ? "Processing…" : "Process walkthrough"}
          </button>
          {workStatus && (
            <p role="status" style={theme.sub}>
              {workStatus}
            </p>
          )}
          {walkError && (
            <p role="alert" style={theme.error}>
              {walkError}
            </p>
          )}
          {walkResult && (
            <div aria-live="polite">
              <h3>Transcript</h3>
              {walkResult.transcript.length === 0 && (
                <p style={theme.sub}>No transcript segments returned.</p>
              )}
              {walkResult.transcript.map((seg, i) => (
                <p key={i} style={theme.sub}>
                  {seg.start}s – {seg.end ?? "?"}s: {seg.text}
                </p>
              ))}
              <h3>Segmented regions</h3>
              {walkResult.regions.map((region, i) => {
                const choices = regionMaskChoices(region);
                const frameKnown =
                  Number.isInteger(region.frame_width) &&
                  Number.isInteger(region.frame_height) &&
                  (region.frame_width as number) > 0 &&
                  (region.frame_height as number) > 0;
                return (
                  <article key={i} style={theme.issue} aria-label={`Region ${i + 1}`}>
                    <p>
                      <strong>Frame:</strong> {region.frame} (t={region.second}s)
                      {frameKnown
                        ? ` · ${region.frame_width}×${region.frame_height}`
                        : " · frame size unknown"}
                    </p>
                    <p style={theme.sub}>
                      SAM prompt: {samPrompt} ·{" "}
                      {region.cached ? "served from cache" : "freshly segmented"} ·{" "}
                      {region.polygon ? `${region.polygon.length} polygon points` : "no polygon"}
                    </p>
                    {choices.map((choice) => {
                      const selectable =
                        !!choice.url &&
                        !!choice.box &&
                        !!choice.maskDims &&
                        frameKnown;
                      const checked = selectedRegionMasks.some(
                        (s) => s.region === i && s.key === choice.key,
                      );
                      return (
                        <p key={choice.key}>
                          <label>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!selectable}
                              title={
                                selectable
                                  ? `Select mask ${choice.objectId ?? choice.key} for a combined reference`
                                  : "This mask has no servable file, box, dimensions, or known frame size"
                              }
                              onChange={() =>
                                selectable &&
                                toggleSelectedRegionMask({
                                  region: i,
                                  key: choice.key,
                                  url: choice.url as string,
                                  box: choice.box as NonNullable<typeof choice.box>,
                                  maskDims: choice.maskDims as NonNullable<typeof choice.maskDims>,
                                  frameWidth: region.frame_width as number,
                                  frameHeight: region.frame_height as number,
                                })
                              }
                              aria-label={`Select mask ${choice.objectId ?? choice.key} from region ${i + 1} for combined reference`}
                            />{" "}
                          </label>
                          Mask {choice.objectId ?? choice.key}
                        </p>
                      );
                    })}
                  </article>
                );
              })}
              <p>
                <button
                  type="button"
                  onClick={onSaveSelectedRegionMasks}
                  disabled={selectedRegionMasks.length === 0 || savingRegions || !video}
                >
                  {savingRegions
                    ? "Saving…"
                    : `Save ${selectedRegionMasks.length} selected mask${selectedRegionMasks.length === 1 ? "" : "s"} as one move-in reference`}
                </button>
              </p>
              <p style={theme.sub}>
                Selected masks are combined pixel-by-pixel in their shared
                frame coordinates before saving — not just their boxes.
                Masks from different-size frames cannot be combined.
              </p>
              <h3>Defects</h3>
              {walkResult.defects.map((defect, i) => {
                const maskUrl = toFileUrl(defect.image_path);
                return (
                  <article key={i} style={theme.issue} aria-label={`Defect ${i + 1}`}>
                    <p>
                      <strong>Timestamp:</strong> {defect.timestamp}
                    </p>
                    <p>
                      <strong>Description:</strong> {defect.description_local}
                    </p>
                    <p>
                      <strong>Translation:</strong> {defect.description_tenant}
                    </p>
                    <p style={theme.sub}>
                      SAM confidence: {String(defect.sam_confidence)} · Mask area:{" "}
                      {String(defect.area_percent)} % of frame
                    </p>
                    {maskUrl ? (
                      <img
                        src={maskUrl}
                        alt={`Annotated mask for defect ${i + 1}`}
                        style={{ maxWidth: "100%", borderRadius: "6px" }}
                      />
                    ) : (
                      <p style={theme.sub}>
                        Annotated frame not servable: {defect.image_path}
                      </p>
                    )}
                  </article>
                );
              })}
              <p style={theme.sub}>
                Evidence SHA-256:{" "}
                <span style={theme.mono}>{walkResult.evidence_sha256}</span>
              </p>
              <p>
                <a
                  href={`${API_BASE_URL}${walkResult.pdf_url}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open handover PDF
                </a>
              </p>
              <p style={theme.note}>{walkResult.review_note}</p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="moveout-heading">
          <h2 id="moveout-heading" style={theme.sectionTitle}>
            Move-out verification
          </h2>
          <p style={theme.sub}>
            Compare a move-out photo against a saved move-in mask, or —
            after a walkthrough — against one of its defect polygons. The
            comparison runs locally on aligned mask rasters; nothing here
            proves damage or fault.
          </p>
          <div role="radiogroup" aria-label="Prior evidence source">
            <label style={{ marginRight: "16px" }}>
              <input
                type="radio"
                name="verify-source"
                value="reference"
                checked={verifySource === "reference"}
                onChange={() => setVerifySource("reference")}
              />{" "}
              Saved move-in reference
            </label>
            <label
              style={walkResult ? {} : { opacity: 0.5 }}
              title={
                walkResult
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
                disabled={!walkResult}
              />{" "}
              Walkthrough defect polygon (legacy)
            </label>
          </div>
          {verifySource === "reference" ? (
            <div>
              <label htmlFor="reference-select" style={theme.label}>
                Move-in reference
              </label>
              {moveinRefs.length === 0 ? (
                <p style={theme.sub}>
                  No reference saved yet. Segment a move-in photo below and
                  save one of its masks first.
                </p>
              ) : (
                <>
                  <select
                    id="reference-select"
                    style={theme.control}
                    value={selectedRefKey ?? ""}
                    onChange={(e) => {
                      setSelectedRefKey(e.target.value || null);
                      setVerifyResult(null);
                    }}
                  >
                    <option value="">Select a reference…</option>
                    {moveinRefs.map((ref) => (
                      <option key={ref.key} value={ref.key}>
                        {ref.name} · {ref.frameSize.width}×
                        {ref.frameSize.height}
                        {ref.objectId ? ` · id ${ref.objectId}` : ""}
                      </option>
                    ))}
                  </select>
                  {selectedRefKey && (
                    <button
                      type="button"
                      onClick={() => onRemoveRef(selectedRefKey)}
                    >
                      Remove this reference
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div>
              <label htmlFor="defect-select" style={theme.label}>
                Defect to compare
              </label>
              <select
                id="defect-select"
                style={theme.control}
                value={selectedDefect}
                onChange={(e) => {
                  setSelectedDefect(Number(e.target.value));
                  setVerifyResult(null);
                }}
              >
                {(walkResult?.defects ?? []).map((defect, i) => (
                  <option key={i} value={i}>
                    Defect {i + 1} — {defect.timestamp}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label htmlFor="moveout-file" style={theme.label}>
            Move-out image
          </label>
          <input
            id="moveout-file"
            type="file"
            accept="image/*"
            onChange={(e) => onMoveoutFile(e.target.files?.[0] ?? null)}
          />
          {moveoutPreviewUrl && (
            <div>
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
                style={{ maxWidth: "100%", height: "auto", borderRadius: "6px" }}
              />
              {moveoutNatural && (
                <p style={theme.sub}>
                  Move-out photo: {moveoutNatural.width}×{moveoutNatural.height}{" "}
                  px. References from a different-size photo are resized to
                  these dimensions before comparison.
                </p>
              )}
            </div>
          )}
          <label htmlFor="verify-prompt" style={theme.label}>
            Concept for the move-out segmentation
          </label>
          <input
            id="verify-prompt"
            type="text"
            style={theme.control}
            value={samPrompt}
            onChange={(e) => setSamPrompt(e.target.value)}
          />
          <button
            type="button"
            style={{
              ...theme.button,
              ...(!moveoutFile || verifying ? theme.buttonDisabled : {}),
            }}
            disabled={!moveoutFile || verifying}
            onClick={onVerify}
          >
            {verifying ? "Comparing…" : "Verify move-out"}
          </button>
          {verifyError && (
            <p role="alert" style={theme.error}>
              {verifyError}
            </p>
          )}
          {verifyResult && (
            <div aria-live="polite">
              <h3>Comparison</h3>
              <p>
                IoU: {verifyResult.comparison.iou} · Move-in area:{" "}
                {verifyResult.comparison.day1_area_px} px · Move-out area:{" "}
                {verifyResult.comparison.moveout_area_px} px · Area growth:{" "}
                {verifyResult.comparison.area_growth_ratio}
              </p>
              {(verifyResult.comparison.prior_kind ||
                verifyResult.comparison.frame_size) && (
                <p style={theme.sub}>
                  Prior: {verifyResult.comparison.prior_kind ?? "?"} ·
                  Current: {verifyResult.comparison.current_kind ?? "?"} ·
                  Frame: {verifyResult.comparison.frame_size?.width}×
                  {verifyResult.comparison.frame_size?.height}
                  {verifyResult.comparison.compared_object_id
                    ? ` · compared mask id ${verifyResult.comparison.compared_object_id}`
                    : ""}
                </p>
              )}
              {verifyResult.comparison.dimension_normalized === true && (
                <p style={theme.note}>
                  The move-in reference came from a different-size photo, so
                  its mask was resized to{" "}
                  {verifyResult.comparison.frame_size?.width}×
                  {verifyResult.comparison.frame_size?.height} before
                  comparing. Resizing only aligns the comparison — it does
                  not prove damage or responsibility.
                </p>
              )}
              <p style={theme.note}>
                {overlapVerdict(
                  verifyResult.comparison.iou,
                  verifyResult.comparison.area_growth_ratio,
                )}{" "}
                This describes mask overlap only — it does not prove damage
                or fault. Have a qualified professional review it before use.
              </p>
              <p style={theme.note}>{verifyResult.review_note}</p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="segment-heading">
          <h2 id="segment-heading" style={theme.sectionTitle}>
            Single-image SAM segmentation
          </h2>
          <p style={theme.sub}>
            Segment one photo with a short noun phrase (for example,
            &ldquo;stain&rdquo;). Shows the original with the mask overlaid
            plus the returned bounding box.
          </p>
          <label htmlFor="segment-file" style={theme.label}>
            Photo (JPEG or PNG)
          </label>
          <input
            id="segment-file"
            type="file"
            accept="image/jpeg,image/png"
            onChange={(e) => onSegmentFile(e.target.files?.[0] ?? null)}
          />
          <div role="radiogroup" aria-label="Prompt mode" style={{ margin: "12px 0 4px" }}>
            <label style={{ marginRight: "16px" }}>
              <input
                type="radio"
                name="segment-mode"
                value="concept"
                checked={segmentMode === "concept"}
                onChange={() => onSegmentMode("concept")}
              />{" "}
              Concept
            </label>
            <label>
              <input
                type="radio"
                name="segment-mode"
                value="points"
                checked={segmentMode === "points"}
                onChange={() => onSegmentMode("points")}
              />{" "}
              Points (click the photo)
            </label>
          </div>
          {segmentMode === "concept" ? (
            <>
              <label htmlFor="segment-prompt" style={theme.label}>
                Concept (short noun phrase)
              </label>
              <input
                id="segment-prompt"
                type="text"
                style={theme.control}
                value={segmentPrompt}
                onChange={(e) => setSegmentPrompt(e.target.value)}
              />
            </>
          ) : (
            <>
              <p style={theme.sub}>
                Click the photo to mark target spots. Each spot becomes its
                own target id sent with Meta&apos;s documented point-prompt
                grammar; the concept phrase is ignored in this mode.
              </p>
              {segmentPreviewUrl ? (
                <div
                  style={{
                    position: "relative",
                    display: "inline-block",
                    maxWidth: "100%",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={segmentPreviewUrl}
                    alt="Selected photo — click to mark target spots"
                    onClick={onPreviewClick}
                    onLoad={(e) =>
                      setSegmentNatural({
                        width: e.currentTarget.naturalWidth,
                        height: e.currentTarget.naturalHeight,
                      })
                    }
                    style={{
                      maxWidth: "100%",
                      height: "auto",
                      borderRadius: "6px",
                      cursor: "crosshair",
                      display: "block",
                    }}
                  />
                  {segmentNatural && (
                    <MarkerDots
                      points={segmentPoints}
                      natural={segmentNatural}
                    />
                  )}
                </div>
              ) : (
                <p style={theme.sub}>Choose a photo first, then click it to mark spots.</p>
              )}
              {segmentPoints.length > 0 && (
                <div>
                  <ul>
                    {segmentPoints.map((point, index) => (
                      <li key={index}>
                        Target {index}: {point.x}, {point.y}{" "}
                        <button
                          type="button"
                          onClick={() =>
                            setSegmentPoints((prev) =>
                              prev.filter((_, i) => i !== index),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => setSegmentPoints([])}
                  >
                    Clear all spots
                  </button>
                </div>
              )}
            </>
          )}
          <button
            type="button"
            style={{
              ...theme.button,
              ...(!segmentFile ||
              segmenting ||
              (segmentMode === "points" && segmentPoints.length === 0)
                ? theme.buttonDisabled
                : {}),
            }}
            disabled={
              !segmentFile ||
              segmenting ||
              (segmentMode === "points" && segmentPoints.length === 0)
            }
            onClick={onSegment}
          >
            {segmenting ? "Segmenting…" : "Segment image"}
          </button>
          {segmentError && (
            <p role="alert" style={theme.error}>
              {segmentError}
            </p>
          )}
          {segmentResult && (
            <div aria-live="polite">
              <h3>Overlay preview</h3>
              {segmentResult.mask.match && segmentResult.image_url ? (
                <div>
                  {segmentResult.overlay_url ? (
                    <ServerOverlayPreview
                      imageUrl={`${API_BASE_URL}${segmentResult.image_url}`}
                      overlayUrl={`${API_BASE_URL}${segmentResult.overlay_url}`}
                      entries={overlayEntries(
                        segmentResult.mask,
                        (segmentResult.mask_urls ?? []).map(
                          (u) => `${API_BASE_URL}${u}`,
                        ),
                        segmentResult.mask_url
                          ? `${API_BASE_URL}${segmentResult.mask_url}`
                          : null,
                      )}
                      markers={
                        segmentMode === "points" ? segmentPoints : null
                      }
                    />
                  ) : (
                    <SegmentOverlay
                      imageUrl={`${API_BASE_URL}${segmentResult.image_url}`}
                      entries={overlayEntries(
                        segmentResult.mask,
                        (segmentResult.mask_urls ?? []).map(
                          (u) => `${API_BASE_URL}${u}`,
                        ),
                        segmentResult.mask_url
                          ? `${API_BASE_URL}${segmentResult.mask_url}`
                          : null,
                      )}
                      markers={
                        segmentMode === "points" ? segmentPoints : null
                      }
                    />
                  )}
                  {segmentResult.mask.prompt && (
                    <p style={theme.sub}>
                      Prompt sent ({segmentResult.mask.prompt.mode}):{" "}
                      <code>{segmentResult.mask.prompt.text}</code>
                    </p>
                  )}
                  {overlayEntries(
                    segmentResult.mask,
                    (segmentResult.mask_urls ?? []).map(
                      (u) => `${API_BASE_URL}${u}`,
                    ),
                    segmentResult.mask_url
                      ? `${API_BASE_URL}${segmentResult.mask_url}`
                      : null,
                  )
                    .filter((entry) => entry.maskUrl)
                    .map((entry, index, list) => (
                      <p key={entry.key}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedSegmentKeys.includes(entry.key)}
                            onChange={() => toggleSelectedSegmentKey(entry.key)}
                            aria-label={`Select mask ${entry.objectId ?? index} for combined reference`}
                          />{" "}
                        </label>
                        <a
                          href={entry.maskUrl as string}
                          download={`sam-mask-${entry.key}.png`}
                        >
                          Download binary mask
                          {list.length > 1
                            ? ` ${entry.objectId ?? index}`
                            : ""}{" "}
                          (PNG)
                        </a>{" "}
                        <button
                          type="button"
                          onClick={() => onSaveReference(entry)}
                          disabled={savingRefKey === entry.key}
                        >
                          {savingRefKey === entry.key
                            ? "Saving…"
                            : "Save as move-in reference"}
                        </button>
                      </p>
                    ))}
                  <p>
                    <button
                      type="button"
                      onClick={onSaveSelectedSegmentMasks}
                      disabled={selectedSegmentKeys.length === 0 || savingCombined}
                    >
                      {savingCombined
                        ? "Saving…"
                        : `Save ${selectedSegmentKeys.length} selected mask${selectedSegmentKeys.length === 1 ? "" : "s"} as one move-in reference`}
                    </button>
                  </p>
                  <p style={theme.sub}>
                    Selected masks are combined pixel-by-pixel on the
                    original frame before saving — not just their boxes.
                  </p>
                  {segmentResult.overlay_url && (
                    <p>
                      <a
                        href={`${API_BASE_URL}${segmentResult.overlay_url}`}
                        download="sam-overlay.png"
                      >
                        Download full-frame overlay (PNG)
                      </a>
                    </p>
                  )}
                  <p style={theme.sub}>
                    Standalone binary mask
                    {overlayEntries(
                      segmentResult.mask,
                      segmentResult.mask_urls ?? [],
                      segmentResult.mask_url,
                    ).length > 1
                      ? "s"
                      : ""}
                    : white pixels mark each matched region at its own
                    raster size.
                  </p>
                </div>
              ) : (
                <div>
                  <p style={theme.sub}>
                    No region matched
                    {segmentResult.mask.outcome
                      ? ` (parser outcome: ${segmentResult.mask.outcome})`
                      : ""}
                    .
                  </p>
                  {(segmentResult.mask.diagnostics ?? []).map((d, i) => (
                    <p key={i} style={theme.sub}>
                      {d.severity}: {d.message} (code {d.code})
                    </p>
                  ))}
                  {segmentResult.mask.prompt && (
                    <p style={theme.sub}>
                      Prompt sent ({segmentResult.mask.prompt.mode}):{" "}
                      <code>{segmentResult.mask.prompt.text}</code>
                    </p>
                  )}
                  {segmentResult.image_url && (
                    <img
                      src={`${API_BASE_URL}${segmentResult.image_url}`}
                      alt="Uploaded photo (no mask matched)"
                      style={{ maxWidth: "100%", borderRadius: "6px" }}
                    />
                  )}
                </div>
              )}
              <p style={theme.note}>{segmentResult.review_note}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
