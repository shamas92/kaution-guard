/**
 * Persisted walkthrough priors for the Move-Out page.
 *
 * The walkthrough runs on the Evidence page, but Move-Out compares a
 * new photo against one of its defect outlines. Only the small subset
 * Move-Out needs is persisted: defect timestamps (for the picker),
 * region polygons (for the comparison) and the prompt that produced
 * them — in the original order, because defect *i* pairs with
 * region *i*. The full walkthrough response is never stored.
 */

import type { WalkthroughResponse } from "./api";

export const WALKTHROUGH_PRIORS_STORAGE_KEY =
  "kautionguard.walkthrough.priors.v1";

export interface WalkthroughPriorSnapshot {
  version: 1;
  savedAt: string;
  sourceName: string | null;
  prompt: string;
  defects: Array<{ timestamp: string }>;
  regions: Array<{ polygon: number[][] | null }>;
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
    regions: result.regions.map((region) => ({
      polygon: region.polygon ?? null,
    })),
  };
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
  for (const region of snap.regions) {
    if (
      typeof region !== "object" ||
      region === null ||
      !isPolygon((region as Record<string, unknown>).polygon)
    ) {
      return null;
    }
  }
  return {
    version: 1,
    savedAt: snap.savedAt,
    sourceName: snap.sourceName as string | null,
    prompt: snap.prompt,
    defects: snap.defects as Array<{ timestamp: string }>,
    regions: snap.regions as Array<{ polygon: number[][] | null }>,
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
