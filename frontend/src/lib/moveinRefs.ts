/**
 * Saved move-in mask references for the move-out comparison.
 *
 * A reference keeps everything `/api/verify-moveout` needs as
 * `prior_mask`: the mask PNG bytes (base64), its box, dimensions, and
 * the original frame dimensions. References persist in localStorage so
 * a move-in segmentation can be reused when the move-out photo arrives.
 */

export interface FrameSize {
  width: number;
  height: number;
}

export interface RefBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MoveinReference {
  key: string;
  name: string;
  savedAt: string;
  frameSize: FrameSize;
  objectId: string | null;
  box: RefBox;
  maskDims: FrameSize;
  maskPngBase64: string;
}

export interface PriorMaskPayload {
  mask_png_base64: string;
  mask_dims: FrameSize;
  box: RefBox;
  frame_size: FrameSize;
  object_id: string | null;
}

export const MOVEIN_REFS_STORAGE_KEY = "kautionguard.movein.references.v1";
export const MAX_SAVED_REFS = 10;

function isFrameSize(value: unknown): value is FrameSize {
  if (typeof value !== "object" || value === null) return false;
  const size = value as Record<string, unknown>;
  return (
    Number.isInteger(size.width) &&
    (size.width as number) > 0 &&
    Number.isInteger(size.height) &&
    (size.height as number) > 0
  );
}

function isRefBox(value: unknown): value is RefBox {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (["left", "top", "right", "bottom"] as const).every(
    (edge) => typeof box[edge] === "number" && Number.isFinite(box[edge]),
  );
}

function isMoveinReference(value: unknown): value is MoveinReference {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.key === "string" &&
    ref.key.length > 0 &&
    typeof ref.name === "string" &&
    typeof ref.savedAt === "string" &&
    isFrameSize(ref.frameSize) &&
    (typeof ref.objectId === "string" || ref.objectId === null) &&
    isRefBox(ref.box) &&
    isFrameSize(ref.maskDims) &&
    typeof ref.maskPngBase64 === "string" &&
    ref.maskPngBase64.length > 0
  );
}

export interface RefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): RefStorage | undefined {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Load saved references, dropping anything that fails shape validation. */
export function loadMoveinRefs(
  storage: RefStorage | undefined = defaultStorage(),
): MoveinReference[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(MOVEIN_REFS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isMoveinReference).slice(0, MAX_SAVED_REFS);
}

/**
 * Persist references. Returns false when the store is unavailable or
 * full (quota); callers surface that instead of silently losing evidence.
 */
export function storeMoveinRefs(
  refs: MoveinReference[],
  storage: RefStorage | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      MOVEIN_REFS_STORAGE_KEY,
      JSON.stringify(refs.slice(0, MAX_SAVED_REFS)),
    );
  } catch {
    return false;
  }
  return true;
}

/**
 * Serialize one reference to the exact `prior_mask` shape the backend
 * validates: mask bytes plus box, dimensions, and frame dimensions.
 * The object id rides along for the report; the backend ignores it.
 */
export function buildPriorMaskPayload(
  ref: MoveinReference,
): PriorMaskPayload {
  return {
    mask_png_base64: ref.maskPngBase64,
    mask_dims: { width: ref.maskDims.width, height: ref.maskDims.height },
    box: {
      left: ref.box.left,
      top: ref.box.top,
      right: ref.box.right,
      bottom: ref.box.bottom,
    },
    frame_size: {
      width: ref.frameSize.width,
      height: ref.frameSize.height,
    },
    object_id: ref.objectId,
  };
}

/* Note: a same-size reference gate used to live here. It was removed
 * because the backend now normalizes the move-in mask to the move-out
 * dimensions (see `dimension_normalized` on the verify response). The UI
 * sends every well-formed reference regardless of frame size; malformed
 * or missing evidence is still rejected by the backend and by the
 * missing-reference checks in the UI. */
