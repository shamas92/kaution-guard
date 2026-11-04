/**
 * Persisted walkthrough priors for the Move-Out page.
 *
 * The walkthrough runs on the Evidence page, but Move-Out compares a
 * new photo against one of its defect outlines. Only the small subset
 * Move-Out needs is persisted: defect timestamps (for the picker),
 * region outlines and the prompt that produced them — in the original
 * order, because defect *i* pairs with region *i*. An outline is a
 * polygon when the region carries one (mock mode), or a raster prior
 * payload (`priorMask`, the same shape a saved move-in reference
 * sends) for live regions, whose SAM results are mask files rather
 * than point lists. The Evidence page attaches the raster payloads
 * after the walkthrough completes; this module only shapes and
 * stores them. The full walkthrough response is never stored.
 */

import type { WalkthroughResponse } from "./api";
import type { PriorMaskPayload } from "./moveinRefs";

export const WALKTHROUGH_PRIORS_STORAGE_KEY =
  "kautionguard.walkthrough.priors.v1";

export interface WalkthroughPriorRegion {
  polygon: number[][] | null;
  priorMask: PriorMaskPayload | null;
  /**
   * Servable `/files/...` URL of the backend's baked colour
   * composite for this region (the keyframe with the defect
   * highlighted), when the walkthrough response carried one.
   * Display only — comparisons keep using the polygon / priorMask.
   * Absent on snapshots written before composites existed.
   */
  overlayUrl?: string;
}

export interface WalkthroughPriorSnapshot {
  version: 1;
  savedAt: string;
  sourceName: string | null;
  prompt: string;
  defects: Array<{ timestamp: string }>;
  regions: Array<WalkthroughPriorRegion>;
}

export function walkthroughPriorsFromResult(
  result: WalkthroughResponse,
  sourceName: string | null,
  prompt: string,
): WalkthroughPriorSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    sourceName,
    prompt,
    defects: result.defects.map((defect) => ({
      timestamp: defect.timestamp,
    })),
    regions: result.regions.map((region) => {
      // The response type does not declare the baked composite URL;
      // read it defensively so older payloads simply omit it.
      const record = region as unknown as Record<string, unknown>;
      const overlayUrl =
        typeof record.overlay_url === "string" && record.overlay_url
          ? record.overlay_url
          : undefined;
      return {
        polygon: region.polygon ?? null,
        priorMask: null,
        ...(overlayUrl ? { overlayUrl } : {}),
      };
    }),
  };
}

function isFiniteBox(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return ["left", "top", "right", "bottom"].every(
    (key) => typeof box[key] === "number" && Number.isFinite(box[key]),
  );
}

function isDims(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const dims = value as Record<string, unknown>;
  return (
    typeof dims.width === "number" &&
    Number.isFinite(dims.width) &&
    dims.width > 0 &&
    typeof dims.height === "number" &&
    Number.isFinite(dims.height) &&
    dims.height > 0
  );
}

function isPriorMaskPayload(value: unknown): value is PriorMaskPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.mask_png_base64 === "string" &&
    payload.mask_png_base64.length > 0 &&
    isDims(payload.mask_dims) &&
    isFiniteBox(payload.box) &&
    isDims(payload.frame_size) &&
    (payload.object_id === null || typeof payload.object_id === "string")
  );
}

function localStore(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return null;
  }
  return null;
}

/**
 * Persist a snapshot. Returns false when storage is unavailable or
 * full — a failed save must never fail the walkthrough itself.
 */
export function storeWalkthroughPriors(
  snapshot: WalkthroughPriorSnapshot,
): boolean {
  const store = localStore();
  if (!store) return false;
  try {
    store.setItem(WALKTHROUGH_PRIORS_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

function isPolygon(value: unknown): value is number[][] | null {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      point.every((coord) => typeof coord === "number" && Number.isFinite(coord)),
  );
}

/**
 * Load and validate a snapshot. Array order is preserved exactly —
 * never sorted, filtered or compacted, because the defect/region
 * index pairing is the contract with the comparison.
 */
export function loadWalkthroughPriors(): WalkthroughPriorSnapshot | null {
  const store = localStore();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(WALKTHROUGH_PRIORS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const snap = parsed as Record<string, unknown>;
  if (snap.version !== 1) return null;
  if (typeof snap.savedAt !== "string" || Number.isNaN(Date.parse(snap.savedAt))) {
    return null;
  }
  if (typeof snap.prompt !== "string") return null;
  if (snap.sourceName !== null && typeof snap.sourceName !== "string") {
    return null;
  }
  if (!Array.isArray(snap.defects) || !Array.isArray(snap.regions)) return null;
  for (const defect of snap.defects) {
    if (
      typeof defect !== "object" ||
      defect === null ||
      typeof (defect as Record<string, unknown>).timestamp !== "string"
    ) {
      return null;
    }
  }
  const regions: WalkthroughPriorRegion[] = [];
  for (const region of snap.regions) {
    if (typeof region !== "object" || region === null) return null;
    const entry = region as Record<string, unknown>;
    const polygon = entry.polygon;
    if (!isPolygon(polygon)) return null;
    // Snapshots written before raster priors existed have no
    // priorMask field at all; that simply means "no raster outline".
    let priorMask: PriorMaskPayload | null = null;
    const rawPriorMask = entry.priorMask ?? null;
    if (rawPriorMask !== null) {
      if (!isPriorMaskPayload(rawPriorMask)) return null;
      priorMask = rawPriorMask;
    }
    // The colour composite URL is display-only decoration: keep it
    // when it is a non-empty string, ignore anything else rather
    // than rejecting the whole snapshot over a thumbnail.
    const overlayUrl =
      typeof entry.overlayUrl === "string" && entry.overlayUrl
        ? entry.overlayUrl
        : undefined;
    regions.push({
      polygon,
      priorMask,
      ...(overlayUrl ? { overlayUrl } : {}),
    });
  }
  return {
    version: 1,
    savedAt: snap.savedAt,
    sourceName: snap.sourceName as string | null,
    prompt: snap.prompt,
    defects: snap.defects as Array<{ timestamp: string }>,
    regions,
  };
}

/** Drop any saved snapshot (a new walkthrough attempt replaces it). */
export function clearWalkthroughPriors(): void {
  const store = localStore();
  if (!store) return;
  try {
    store.removeItem(WALKTHROUGH_PRIORS_STORAGE_KEY);
  } catch {
    /* nothing to clear if storage is blocked */
  }
}
