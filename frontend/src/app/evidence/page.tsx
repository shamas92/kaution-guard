"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import {
  API_BASE_URL,
  processWalkthrough,
  segmentImage,
  type SegmentImageResponse,
  type WalkthroughResponse,
} from "../../lib/api";
import { MAX_SAVED_REFS, type MoveinReference } from "../../lib/moveinRefs";
import {
  combineRastersOnFrame,
  overlayEntries,
  previewToImage,
  sharedFrameSize,
} from "../../lib/samOverlay";
import type { MaskRasterInput, OverlayEntry } from "../../lib/samOverlay";
import { NOT_PROVIDED } from "../../lib/uiHelpers";
import { takeDemoHandoff } from "../../lib/handoff";
import {
  fitsPageState,
  isRecord,
  loadPageState,
  savePageState,
} from "../../lib/pageState";
import {
  clearWalkthroughPriors,
  storeWalkthroughPriors,
  walkthroughPriorsFromResult,
} from "../../lib/walkthroughPriors";
import {
  MarkerDots,
  SegmentOverlay,
  ServerOverlayPreview,
} from "../../components/evidence/SegmentOverlay";
import { useKautionGuard } from "../KautionGuardProvider";

function isSegmentResponse(value: unknown): value is SegmentImageResponse {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    isRecord(value.mask) &&
    typeof value.review_note === "string"
  );
}

function isWalkthroughResponse(value: unknown): value is WalkthroughResponse {
  return (
    isRecord(value) &&
    typeof value.pdf_url === "string" &&
    Array.isArray(value.transcript) &&
    Array.isArray(value.regions) &&
    Array.isArray(value.defects) &&
    typeof value.review_note === "string"
  );
}

function toFileUrl(fsPath: string): string | null {
  const normalised = fsPath.replace(/\\/g, "/");
  const idx = normalised.toLowerCase().indexOf("/storage/");
  if (idx === -1) return null;
  return `${API_BASE_URL}/files${normalised.slice(idx + "/storage".length)}`;
}

/**
 * Step 2 — photograph the damage. Two producers live here: the
 * single-photo check and the walkthrough video. Both can save
 * move-in records (via the shell provider's shared store) that the
 * Move-Out page later compares against; a finished walkthrough also
 * leaves its defect outlines behind for Move-Out (see
 * lib/walkthroughPriors).
 */
export default function EvidencePage() {
  const { jurisdiction, language, moveinRefs, addMoveinRef } =
    useKautionGuard();

  const [video, setVideo] = useState<File | null>(null);
  const [samPrompt, setSamPrompt] = useState("visible damage or stain");
  const [maxFrames, setMaxFrames] = useState(5);
  const [working, setWorking] = useState(false);
  const [workStatus, setWorkStatus] = useState<string | null>(null);
  const [walkError, setWalkError] = useState<string | null>(null);
  const [walkResult, setWalkResult] = useState<WalkthroughResponse | null>(null);
  const [walkPriorsNote, setWalkPriorsNote] = useState<string | null>(null);
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
  const [stateHydrated, setStateHydrated] = useState(false);

  // One-time sample handoff from the Start page: reconstruct the File
  // the user picked there. Processing never starts on its own.
  const handoffStarted = useRef(false);
  useEffect(() => {
    if (handoffStarted.current) return;
    handoffStarted.current = true;
    const intent = takeDemoHandoff("video");
    if (!intent) return;
    let cancelled = false;
    setDemoVideoLoading(true);
    setDemoVideoError(null);
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}${intent.assetUrl}`);
        if (!response.ok) {
          throw new Error(`Sample video fetch failed (${response.status})`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        const file = new File([blob], intent.fileName, {
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
        if (!cancelled) {
          setDemoVideoError(
            e instanceof Error ? e.message : "Sample video load failed",
          );
        }
      } finally {
        if (!cancelled) setDemoVideoLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore this visit's earlier work — the two "what to look for"
  // prompts, the marking mode and any results that fit in storage —
  // so navigating away and back never discards it. (Files and marked
  // spots belong to a chosen photo and cannot be restored.)
  useEffect(() => {
    const saved = loadPageState("evidence");
    if (saved) {
      if (typeof saved.samPrompt === "string") setSamPrompt(saved.samPrompt);
      if (typeof saved.segmentPrompt === "string") {
        setSegmentPrompt(saved.segmentPrompt);
      }
      if (saved.segmentMode === "concept" || saved.segmentMode === "points") {
        setSegmentMode(saved.segmentMode);
      }
      if (
        typeof saved.maxFrames === "number" &&
        Number.isFinite(saved.maxFrames)
      ) {
        setMaxFrames(saved.maxFrames);
      }
      if (isSegmentResponse(saved.segmentResult)) {
        setSegmentResult(saved.segmentResult);
      }
      if (isWalkthroughResponse(saved.walkResult)) {
        setWalkResult(saved.walkResult);
      }
    }
    setStateHydrated(true);
  }, []);

  // Persist the same fields whenever they change — only after
  // hydration. Oversized results are left out (the size guard in
  // lib/pageState decides); the prompts and mode still persist.
  useEffect(() => {
    if (!stateHydrated) return;
    const full = {
      version: 1,
      samPrompt,
      segmentPrompt,
      segmentMode,
      maxFrames,
      segmentResult,
      walkResult,
    };
    if (fitsPageState(full)) {
      savePageState("evidence", full);
    } else {
      savePageState("evidence", {
        ...full,
        segmentResult: null,
        walkResult: null,
      });
    }
  }, [
    stateHydrated,
    samPrompt,
    segmentPrompt,
    segmentMode,
    maxFrames,
    segmentResult,
    walkResult,
  ]);

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

  async function onWalkthrough() {
    if (!video) return;
    // Capture the prompt now: an edit made while processing must not
    // rewrite the prompt associated with the returned result.
    const requestPrompt = samPrompt;
    setWorking(true);
    setWalkError(null);
    setWalkResult(null);
    setSelectedRegionMasks([]);
    setWalkPriorsNote(null);
    // A new attempt replaces the old walkthrough: its outlines must
    // stop being selectable on the Move-Out page right away.
    clearWalkthroughPriors();
    setWorkStatus("Uploading your video and checking it — this can take a moment…");
    try {
      const result = await processWalkthrough(video, {
        jurisdictionCode: jurisdiction,
        userLanguage: language,
        textPrompt: requestPrompt,
        maxFrames: Number.isFinite(maxFrames) && maxFrames > 0 ? Math.floor(maxFrames) : 5,
      });
      setWalkResult(result);
      if (
        !storeWalkthroughPriors(
          walkthroughPriorsFromResult(result, video.name, requestPrompt),
        )
      ) {
        setWalkPriorsNote(
          "This walkthrough is ready on this page, but its damage outlines could not be saved for the Move-Out page — the browser store is unavailable or full.",
        );
      }
      setWorkStatus(null);
    } catch (e: unknown) {
      setWalkError(e instanceof Error ? e.message : "Walkthrough processing failed");
      setWorkStatus(null);
    } finally {
      setWorking(false);
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
    if (!addMoveinRef(ref)) {
      setError(
        "Reference kept for this session, but the browser store is unavailable or full.",
      );
    }
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
      if (!addMoveinRef(ref)) {
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

  const segmentEntries = segmentResult
    ? overlayEntries(
        segmentResult.mask,
        (segmentResult.mask_urls ?? []).map((u) => `${API_BASE_URL}${u}`),
        segmentResult.mask_url
          ? `${API_BASE_URL}${segmentResult.mask_url}`
          : null,
      )
    : [];

  // Walkthrough checking trail — the same honesty rules as the
  // contract check: stage 1 ticks when the request is dispatched,
  // the remaining stages tick when the response arrives, and the
  // counts are fields of that response.
  const walkStage2 = walkResult ? "done" : "active";
  const walkStage3 = walkResult ? "done" : "todo";
  const walkTrail = (
    <div className="kg-trail">
      <p className="kg-trail-title">
        {walkResult ? "How this was checked" : "How this check works"}
      </p>
      <ol className="kg-trail-list">
        <li className="kg-trail-step kg-trail-step--done">
          <span className="kg-trail-dot" aria-hidden="true">
            ✓
          </span>
          <span>
            <span className="kg-trail-label">Sending your video</span>
            <span className="kg-sr-only"> (done)</span>
          </span>
        </li>
        <li className={`kg-trail-step kg-trail-step--${walkStage2}`}>
          <span className="kg-trail-dot" aria-hidden="true">
            {walkStage2 === "done" ? "✓" : ""}
          </span>
          <span>
            <span className="kg-trail-label">Writing down what was said</span>
            <span className="kg-sr-only">
              {walkStage2 === "done" ? " (done)" : " (in progress)"}
            </span>
            {walkResult && (
              <span className="kg-trail-note">
                {walkResult.transcript.length} spoken part
                {walkResult.transcript.length === 1 ? "" : "s"} written
                down.
              </span>
            )}
          </span>
        </li>
        <li className={`kg-trail-step kg-trail-step--${walkStage3}`}>
          <span className="kg-trail-dot" aria-hidden="true">
            {walkStage3 === "done" ? "✓" : ""}
          </span>
          <span>
            <span className="kg-trail-label">
              Marking the damage in the frames
            </span>
            <span className="kg-sr-only">
              {walkStage3 === "done" ? " (done)" : " (waiting)"}
            </span>
            {walkResult && (
              <span className="kg-trail-note">
                {walkResult.regions.length} problem area
                {walkResult.regions.length === 1 ? "" : "s"} marked.
              </span>
            )}
          </span>
        </li>
      </ol>
    </div>
  );

  return (
    <>
      <section className="kg-panel" aria-labelledby="evidence-pattern-heading">
        <p className="kg-overline" aria-hidden="true">02 · Stored &amp; marked</p>
        <h2 id="evidence-pattern-heading" className="kg-section-title">
          Your evidence, stored and marked
        </h2>
        <p className="kg-sub">
          Samples — this is how your photos and your walkthrough video
          are kept: stored in this browser, the damage outlined, ready
          for the move-out comparison.
        </p>
        <div className="kg-pat-field">
        <div className="kg-pat-frames">
          <div className="kg-pat-frame kg-pat-frame--faint" aria-hidden="true">
            <svg viewBox="0 0 160 120" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M10 42 H150 M10 74 H150" stroke="currentColor" strokeWidth="2" />
              <circle cx="122" cy="90" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
            <span className="kg-pat-frame-tag">Bathroom — tiles</span>
          </div>
          <div className="kg-pat-frame kg-pat-frame--faint" aria-hidden="true">
            <svg viewBox="0 0 160 120" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="22" y="18" width="38" height="92" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M10 96 H150" stroke="currentColor" strokeWidth="2" />
            </svg>
            <span className="kg-pat-frame-tag">Hallway — door frame</span>
          </div>
          <div className="kg-pat-frame kg-pat-frame--marked">
            <svg viewBox="0 0 160 120" aria-hidden="true" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="#6E675C" strokeWidth="2" />
              <rect x="98" y="22" width="34" height="42" fill="none" stroke="#6E675C" strokeWidth="2" />
              <path d="M98 64 C92 76 97 86 89 98" fill="none" stroke="#1E1B16" strokeWidth="2" />
              <path
                d="M104 58 C88 62 82 80 86 96 C88 106 100 108 106 100 C114 90 116 70 104 58 Z"
                fill="none"
                stroke="#A62B1F"
                strokeWidth="2.5"
                strokeDasharray="5 4"
              />
            </svg>
            <span className="kg-pat-frame-mark">Stored · Marked</span>
            <span className="kg-pat-frame-tag">Sample — crack outlined</span>
          </div>
          <div className="kg-pat-frame kg-pat-frame--faint" aria-hidden="true">
            <svg viewBox="0 0 160 120" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="18" y="20" width="38" height="46" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M10 96 H150" stroke="currentColor" strokeWidth="2" />
            </svg>
            <span className="kg-pat-frame-tag">Bedroom — window wall</span>
          </div>
          <div className="kg-pat-frame kg-pat-frame--faint" aria-hidden="true">
            <svg viewBox="0 0 160 120" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="58" y="26" width="44" height="34" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M10 96 H150" stroke="currentColor" strokeWidth="2" />
            </svg>
            <span className="kg-pat-frame-tag">Living room — corner</span>
          </div>
          <div className="kg-pat-frame kg-pat-frame--faint" aria-hidden="true">
            <svg viewBox="0 0 160 120" focusable="false">
              <rect x="10" y="10" width="140" height="100" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="104" y="20" width="30" height="36" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M10 78 H96" stroke="currentColor" strokeWidth="2" />
            </svg>
            <span className="kg-pat-frame-tag">Kitchen — wide view</span>
          </div>
        </div>
        <div className="kg-pat-strip kg-mt12">
          <div className="kg-pat-strip-frames">
            <div className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:00</span>
            </div>
            <div className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:07</span>
            </div>
            <div className="kg-pat-frame kg-pat-frame--marked">
              <span className="kg-pat-frame-mark">Marked</span>
              <span className="kg-pat-frame-tag">0:19 · sample</span>
            </div>
            <div className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:26</span>
            </div>
            <div className="kg-pat-frame" aria-hidden="true">
              <span className="kg-pat-frame-tag">0:34</span>
            </div>
          </div>
        </div>
        </div>
      </section>

      <section className="kg-panel" aria-labelledby="segment-heading">
        <p className="kg-overline" aria-hidden="true">02 · Photo check</p>
        <h2 id="segment-heading" className="kg-section-title">
          Check one photo for damage
        </h2>
        <p className="kg-sub">
          Upload a photo and tell us what to look for — for example,
          &ldquo;stain&rdquo;. We&apos;ll highlight it on your photo.
        </p>
        <div className="kg-seg-grid">
          <div className="kg-seg-controls">
            <label htmlFor="segment-file" className="kg-label">
              Photo (JPEG or PNG)
            </label>
            <input
              id="segment-file"
              type="file"
              accept="image/jpeg,image/png"
              onChange={(e) => onSegmentFile(e.target.files?.[0] ?? null)}
            />
            <p className="kg-click-tip">
              Tip: For a big patch of damage, type what it is. For a tiny
              mark, switch to tapping spots on the photo.
            </p>
            <div role="radiogroup" aria-label="Prompt mode" className="kg-radiogroup">
              <label className="kg-radio-label">
                <input
                  type="radio"
                  name="segment-mode"
                  value="concept"
                  checked={segmentMode === "concept"}
                  onChange={() => onSegmentMode("concept")}
                />{" "}
                Describe it in words
              </label>
              <label className="kg-radio-label">
                <input
                  type="radio"
                  name="segment-mode"
                  value="points"
                  checked={segmentMode === "points"}
                  onChange={() => onSegmentMode("points")}
                />{" "}
                Tap spots on the photo
              </label>
            </div>
            {segmentMode === "concept" ? (
              <>
                <label htmlFor="segment-prompt" className="kg-label">
                  What should we look for?
                </label>
                <input
                  id="segment-prompt"
                  type="text"
                  className="kg-control"
                  value={segmentPrompt}
                  onChange={(e) => setSegmentPrompt(e.target.value)}
                  placeholder="e.g. stain, wall crack"
                />
              </>
            ) : (
              <>
                <p className="kg-sub">
                  Tap the photo to mark each spot.
                </p>
                {segmentPreviewUrl ? (
                  <div className="kg-hud-stage kg-hud-stage--mini">
                    <div className="kg-stage-wrap">
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
                        className="kg-stage-img kg-clickable"
                      />
                      {segmentNatural && (
                        <MarkerDots
                          points={segmentPoints}
                          natural={segmentNatural}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="kg-sub">Choose a photo first, then click it to mark spots.</p>
                )}
                {segmentPoints.length > 0 && (
                  <div>
                    <ul>
                      {segmentPoints.map((point, index) => (
                        <li key={index}>
                          Spot {index + 1}{" "}
                          <button
                            type="button"
                            className="kg-btn kg-btn--sm kg-btn--ghost"
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
                      className="kg-btn kg-btn--sm kg-btn--ghost"
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
              className="kg-btn kg-btn--primary"
              disabled={
                !segmentFile ||
                segmenting ||
                (segmentMode === "points" && segmentPoints.length === 0)
              }
              onClick={onSegment}
            >
              {segmenting ? "Looking…" : "Highlight the damage"}
            </button>
            {segmentError && (
              <p role="alert" className="kg-alert kg-alert--error">
                {segmentError}
              </p>
            )}
            <div className="kg-saved-refs-wrap">
              <h3 className="kg-panel-title">
                Saved for the move-out check ({moveinRefs.length}/{MAX_SAVED_REFS})
              </h3>
              {moveinRefs.length === 0 ? (
                <p className="kg-sub">
                  Nothing saved yet — highlight damage in a photo above and
                  save it here.
                </p>
              ) : (
                <p className="kg-sub">
                  Saved ✓ — you&apos;ll use it on the Move-out page.
                </p>
              )}
              <p>
                <Link href="/move-out">Go to the Move-out page</Link>
              </p>
            </div>
          </div>
          <div className="kg-seg-stage">
            {!segmentResult && (
              <div className="kg-hud-main">
                <div className="kg-hud-head">
                  <span className="kg-hud-label">Photo stage</span>
                </div>
                <div className="kg-hud-stage">
                  <div className="kg-hud-empty">
                    <svg
                      className="kg-hud-ghost-outline"
                      viewBox="0 0 200 120"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        d="M60 78 C50 55 70 34 96 36 C124 38 142 52 138 74 C134 96 112 104 92 100 C74 97 66 92 60 78 Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="6 5"
                      />
                      <circle cx="98" cy="66" r="3" fill="currentColor" />
                    </svg>
                    Your photo will appear here, with the damage highlighted.
                  </div>
                </div>
              </div>
            )}
            {segmentResult && (
              <div aria-live="polite">
                <div className="kg-hud">
                  <div className="kg-hud-main">
                    <div className="kg-hud-head">
                      <span className="kg-hud-label">Highlighted photo</span>
                    </div>
                    <h3>Your photo, with the damage highlighted</h3>
                    {segmentResult.mask.match && segmentResult.image_url ? (
                      <div>
                        <div className="kg-hud-stage">
                          {segmentResult.overlay_url ? (
                            <ServerOverlayPreview
                              imageUrl={`${API_BASE_URL}${segmentResult.image_url}`}
                              overlayUrl={`${API_BASE_URL}${segmentResult.overlay_url}`}
                              entries={segmentEntries}
                              markers={
                                segmentMode === "points" ? segmentPoints : null
                              }
                            />
                          ) : (
                            <SegmentOverlay
                              imageUrl={`${API_BASE_URL}${segmentResult.image_url}`}
                              entries={segmentEntries}
                              markers={
                                segmentMode === "points" ? segmentPoints : null
                              }
                            />
                          )}
                        </div>
                        {segmentEntries
                          .filter((entry) => entry.maskUrl)
                          .map((entry, index) => (
                            <p key={entry.key}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selectedSegmentKeys.includes(entry.key)}
                                  onChange={() => toggleSelectedSegmentKey(entry.key)}
                                  aria-label={`Select mask ${entry.objectId ?? index} for combined reference`}
                                />{" "}
                              </label>
                              <button
                                type="button"
                                className="kg-btn kg-btn--sm"
                                onClick={() => onSaveReference(entry)}
                                disabled={savingRefKey === entry.key}
                              >
                                {savingRefKey === entry.key
                                  ? "Saving…"
                                  : "Save this for the move-out check"}
                              </button>
                            </p>
                          ))}
                        <p>
                          <button
                            type="button"
                            className="kg-btn kg-btn--primary"
                            onClick={onSaveSelectedSegmentMasks}
                            disabled={selectedSegmentKeys.length === 0 || savingCombined}
                          >
                            {savingCombined
                              ? "Saving…"
                              : `Save ${selectedSegmentKeys.length} ticked area${selectedSegmentKeys.length === 1 ? "" : "s"} as one move-in record`}
                          </button>
                        </p>
                        <p className="kg-sub">
                          The ticked areas are merged into one saved outline
                          of the damage.
                        </p>
                        {segmentResult.overlay_url && (
                          <p>
                            <a
                              href={`${API_BASE_URL}${segmentResult.overlay_url}`}
                              download="sam-overlay.png"
                            >
                              Download the highlighted photo (PNG)
                            </a>
                          </p>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div className="kg-hud-stage">
                          <p className="kg-sub">
                            We couldn&apos;t find that in this photo — try
                            different words, or tap the spot instead.
                          </p>
                          {segmentResult.image_url && (
                            <img
                              src={`${API_BASE_URL}${segmentResult.image_url}`}
                              alt="Uploaded photo (no mask matched)"
                              className="kg-img"
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <details className="kg-tech-details">
                  <summary>Technical details</summary>
                  <div className="kg-telemetry-table">
                    <div className="kg-telemetry-row">
                      <span className="kg-telemetry-key">job_id</span>
                      <span className="kg-telemetry-value">{segmentResult.job_id}</span>
                    </div>
                    <div className="kg-telemetry-row">
                      <span className="kg-telemetry-key">mask_encoding</span>
                      <span className="kg-telemetry-value">
                        {segmentResult.mask.mask_encoding ?? NOT_PROVIDED}
                      </span>
                    </div>
                    {segmentResult.mask.prompt && (
                      <div className="kg-telemetry-row">
                        <span className="kg-telemetry-key">Prompt sent</span>
                        <span className="kg-telemetry-value">
                          ({segmentResult.mask.prompt.mode}){" "}
                          {segmentResult.mask.prompt.text}
                        </span>
                      </div>
                    )}
                    {segmentEntries.map((entry) => (
                      <div key={entry.key} className="kg-telemetry-row">
                        <span className="kg-telemetry-key">
                          mask {entry.objectId ?? entry.key}
                        </span>
                        <span className="kg-telemetry-value">
                          bbox{" "}
                          {entry.box
                            ? `(${entry.box.left},${entry.box.top},${entry.box.right},${entry.box.bottom})`
                            : NOT_PROVIDED}{" "}
                          · dims{" "}
                          {entry.maskDims
                            ? `(${entry.maskDims.width}×${entry.maskDims.height})`
                            : NOT_PROVIDED}
                        </span>
                      </div>
                    ))}
                    {(segmentResult.mask.diagnostics ?? []).map((d, i) => (
                      <div key={i} className="kg-telemetry-row">
                        <span className="kg-telemetry-key">{d.severity}</span>
                        <span className="kg-telemetry-value">
                          {d.message} (code {d.code})
                        </span>
                      </div>
                    ))}
                    {segmentResult.mask.outcome && (
                      <div className="kg-telemetry-row">
                        <span className="kg-telemetry-key">Parser outcome</span>
                        <span className="kg-telemetry-value">
                          {segmentResult.mask.outcome}
                        </span>
                      </div>
                    )}
                  </div>
                  {segmentEntries
                    .filter((entry) => entry.maskUrl)
                    .map((entry, index, list) => (
                      <p key={entry.key}>
                        <a
                          href={entry.maskUrl as string}
                          download={`sam-mask-${entry.key}.png`}
                        >
                          Download binary mask
                          {list.length > 1
                            ? ` ${entry.objectId ?? index}`
                            : ""}{" "}
                          (PNG)
                        </a>
                      </p>
                    ))}
                </details>
                <p className="kg-note kg-pat-note">{segmentResult.review_note}</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="kg-panel" aria-labelledby="walkthrough-heading">
        <p className="kg-overline" aria-hidden="true">02 · Walkthrough video</p>
        <h2 id="walkthrough-heading" className="kg-section-title">
          Walkthrough video
        </h2>
        <div className="kg-walk-grid">
          <div className="kg-walk-controls">
            <label htmlFor="walkthrough-file" className="kg-label">
              Video file
            </label>
            <input
              id="walkthrough-file"
              ref={walkthroughFileRef}
              type="file"
              accept="video/*"
              onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
            />
            {demoVideoLoading && (
              <p className="kg-sub">Loading sample video…</p>
            )}
            {demoVideoError && (
              <p role="alert" className="kg-alert kg-alert--error">
                {demoVideoError}
              </p>
            )}
            <label htmlFor="sam-prompt" className="kg-label">
              What damage should we look for?
            </label>
            <input
              id="sam-prompt"
              type="text"
              className="kg-control"
              value={samPrompt}
              onChange={(e) => setSamPrompt(e.target.value)}
            />
            <details className="kg-tech-details">
              <summary>Technical details</summary>
              <label htmlFor="max-frames" className="kg-label">
                Max frames
              </label>
              <input
                id="max-frames"
                type="number"
                min={1}
                className="kg-control"
                value={maxFrames}
                onChange={(e) => setMaxFrames(Number(e.target.value))}
              />
            </details>
            <button
              type="button"
              className="kg-btn kg-btn--primary"
              disabled={!video || working}
              onClick={onWalkthrough}
            >
              {working ? "Checking…" : "Check my video"}
            </button>
            {workStatus && (
              <p role="status" className="kg-sub">
                {workStatus}
              </p>
            )}
            {walkError && (
              <p role="alert" className="kg-alert kg-alert--error">
                {walkError}
              </p>
            )}
            {walkPriorsNote && <p className="kg-note">{walkPriorsNote}</p>}
          </div>
          <div className="kg-walk-results">
            {!walkResult && !working && (
              <p className="kg-empty">
                <span className="kg-empty-icon" aria-hidden="true">🎞</span>
                Check a walkthrough video to get a written record of what
                was said, photos of each problem, and a sealed handover
                report.
              </p>
            )}
            {!walkResult && working && walkTrail}
            {walkResult && (
              <div aria-live="polite">
                {walkTrail}
                <h3>What was said in the video</h3>
                {walkResult.transcript.length === 0 && (
                  <p className="kg-sub">No transcript segments returned.</p>
                )}
                <div className="kg-timeline">
                  {walkResult.transcript.map((seg, i) => (
                    <p key={i} className="kg-timeline-pill">
                      <span className="kg-timeline-time">
                        {seg.start}s – {seg.end ?? "?"}s:
                      </span>{" "}
                      {seg.text}
                    </p>
                  ))}
                </div>
                <h3>Problems found in the video</h3>
                {walkResult.regions.map((region, i) => {
                  const choices = regionMaskChoices(region);
                  const frameKnown =
                    Number.isInteger(region.frame_width) &&
                    Number.isInteger(region.frame_height) &&
                    (region.frame_width as number) > 0 &&
                    (region.frame_height as number) > 0;
                  return (
                    <article key={i} className="kg-issue" aria-label={`Region ${i + 1}`}>
                      <p>
                        <strong>At {region.second} seconds</strong>
                      </p>
                      {choices.map((choice, ci) => {
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
                            Damaged area {ci + 1}
                          </p>
                        );
                      })}
                      <details className="kg-tech-details">
                        <summary>Technical details</summary>
                        <p className="kg-sub">
                          Frame: {region.frame} (t={region.second}s)
                          {frameKnown
                            ? ` · ${region.frame_width}×${region.frame_height}`
                            : " · frame size unknown"}{" "}
                          · SAM prompt: {samPrompt} ·{" "}
                          {region.cached ? "served from cache" : "freshly segmented"} ·{" "}
                          {region.polygon ? `${region.polygon.length} polygon points` : "no polygon"}
                        </p>
                      </details>
                    </article>
                  );
                })}
                <p>
                  <button
                    type="button"
                    className="kg-btn kg-btn--sm"
                    onClick={onSaveSelectedRegionMasks}
                    disabled={selectedRegionMasks.length === 0 || savingRegions || !video}
                  >
                    {savingRegions
                      ? "Saving…"
                      : `Save ${selectedRegionMasks.length} ticked area${selectedRegionMasks.length === 1 ? "" : "s"} as one move-in record`}
                  </button>
                </p>
                <h3>Defects</h3>
                {walkResult.defects.map((defect, i) => {
                  const maskUrl = toFileUrl(defect.image_path);
                  return (
                    <article key={i} className="kg-issue" aria-label={`Defect ${i + 1}`}>
                      <p>
                        <strong>Timestamp:</strong> {defect.timestamp}
                      </p>
                      <p>
                        <strong>Description:</strong> {defect.description_local}
                      </p>
                      <p>
                        <strong>Translation:</strong> {defect.description_tenant}
                      </p>
                      <p className="kg-sub">
                        Covers about {String(defect.area_percent)}% of the picture.
                      </p>
                      <details className="kg-tech-details">
                        <summary>Technical details</summary>
                        <p className="kg-sub">
                          SAM confidence: {String(defect.sam_confidence)}
                        </p>
                      </details>
                      {maskUrl ? (
                        <img
                          src={maskUrl}
                          alt={`Annotated mask for defect ${i + 1}`}
                          className="kg-img"
                        />
                      ) : (
                        <p className="kg-sub">Photo not available.</p>
                      )}
                    </article>
                  );
                })}
                <p className="kg-sub">
                  This evidence is sealed with a digital fingerprint so any
                  later change would show.
                </p>
                <details className="kg-tech-details">
                  <summary>Technical details</summary>
                  <p className="kg-hash-badge">
                    <span className="kg-hash-badge-label">Evidence SHA-256:</span>
                    <span className="kg-hash">{walkResult.evidence_sha256}</span>
                  </p>
                </details>
                <p>
                  <a
                    className="kg-btn kg-btn--emerald"
                    href={`${API_BASE_URL}${walkResult.pdf_url}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the handover report (PDF)
                  </a>
                </p>
                <p className="kg-note kg-pat-note">{walkResult.review_note}</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
