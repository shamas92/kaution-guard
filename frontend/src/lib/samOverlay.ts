/**
 * Overlay geometry for the SAM single-image result display.
 *
 * The alignment rule, matching the API contract: the decoded mask raster
 * (maskDims, e.g. 60x27) is drawn at the returned box origin, scaled to
 * the box size (right-left by bottom-top). It is never stretched over the
 * whole frame. The backing canvas keeps the original image dimensions;
 * CSS handles display scaling.
 */

export interface MaskBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MaskDims {
  width: number;
  height: number;
}

export interface MaskPlacement {
  /** Frame x of the mask's top-left corner (= box.left). */
  dx: number;
  /** Frame y of the mask's top-left corner (= box.top). */
  dy: number;
  /** Draw width in frame pixels (= box width, not frame width). */
  dw: number;
  /** Draw height in frame pixels (= box height, not frame height). */
  dh: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function maskPlacement(
  box: MaskBox | null | undefined,
  maskDims: MaskDims | null | undefined,
): MaskPlacement | null {
  if (!box || !maskDims) return null;
  const { left, top, right, bottom } = box;
  const { width, height } = maskDims;
  if (
    ![left, top, right, bottom, width, height].every(isFiniteNumber)
  ) {
    return null;
  }
  if (!(width > 0 && height > 0)) return null;
  const dw = right - left;
  const dh = bottom - top;
  if (!(dw > 0 && dh > 0)) return null;
  return { dx: left, dy: top, dw, dh };
}

export interface ClickPoint {
  x: number;
  y: number;
}

export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a click on the displayed preview to the original image's natural
 * pixel coordinates, accounting for CSS scaling.
 *
 * The preview shows the full image scaled to fit, so one natural pixel
 * spans natural.width / rect.width display pixels in each axis. Clicks
 * landing outside the image rect return null and must not be sent.
 */
export interface MarkerPercent {
  leftPct: number;
  topPct: number;
}

/**
 * Express a natural-pixel spot as percentages of the natural image size.
 *
 * The overlay layer that draws these percentages must cover exactly the
 * displayed image box (not a wrapper holding captions), so the dots share
 * the same rectangle and scaling basis as {@link previewToImage}: a dot
 * drawn from this value converts back to the same natural pixel.
 * Out-of-range spots return null and must never be drawn.
 */
export function markerPercent(
  point: ClickPoint,
  natural: MaskDims,
): MarkerPercent | null {
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null;
  if (!(natural.width > 0 && natural.height > 0)) return null;
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x >= natural.width ||
    point.y >= natural.height
  ) {
    return null;
  }
  return {
    leftPct: (point.x / natural.width) * 100,
    topPct: (point.y / natural.height) * 100,
  };
}

export function previewToImage(
  clientX: number,
  clientY: number,
  rect: PreviewRect,
  natural: MaskDims,
): ClickPoint | null {
  if (
    !(
      Number.isFinite(clientX) &&
      Number.isFinite(clientY) &&
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.top) &&
      rect.width > 0 &&
      rect.height > 0 &&
      natural.width > 0 &&
      natural.height > 0
    )
  ) {
    return null;
  }
  const x = Math.round(((clientX - rect.left) * natural.width) / rect.width);
  const y = Math.round(((clientY - rect.top) * natural.height) / rect.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= natural.width ||
    y >= natural.height
  ) {
    return null;
  }
  return { x, y };
}

export function maskPixelToFrame(
  px: number,
  py: number,
  placement: MaskPlacement,
  maskDims: MaskDims,
): { x: number; y: number } {
  return {
    x: placement.dx + px * (placement.dw / maskDims.width),
    y: placement.dy + py * (placement.dh / maskDims.height),
  };
}

export interface OverlayMaskRecord {
  object_id: string | null;
  box: MaskBox | null;
  mask_dims: MaskDims | null;
}

export interface OverlayMaskHolder {
  match: boolean;
  masks?: OverlayMaskRecord[] | null;
  box?: MaskBox | null;
  mask_dims?: MaskDims | null;
  object_id?: string | null;
}

export interface OverlayEntry {
  /** Stable key: the SAM object id, or a positional fallback. */
  key: string;
  /** Resolved mask image URL, or null when this mask has no file. */
  maskUrl: string | null;
  box: MaskBox | null;
  maskDims: MaskDims | null;
  objectId: string | null;
}

/**
 * Build one overlay entry per returned mask record, pairing each mask
 * with its box, dimensions, object id, and served file URL.
 *
 * Records with masks win; otherwise a single legacy entry is built from
 * the top-level match/box/dims (mock and older single-mask rows), so
 * existing responses keep rendering. Masks without a usable box still
 * get an entry, but the canvas skips drawing them (never stretched).
 */
export function overlayEntries(
  mask: OverlayMaskHolder | null | undefined,
  maskUrls: (string | null)[] | null | undefined,
  fallbackMaskUrl: string | null | undefined,
): OverlayEntry[] {
  const records: OverlayMaskRecord[] =
    mask?.masks && mask.masks.length > 0
      ? mask.masks
      : mask?.match
        ? [
            {
              object_id: mask.object_id ?? null,
              box: mask.box ?? null,
              mask_dims: mask.mask_dims ?? null,
            },
          ]
        : [];
  return records.map((record, index) => {
    const rec = record ?? { object_id: null, box: null, mask_dims: null };
    const fromList =
      maskUrls && index < maskUrls.length ? maskUrls[index] : null;
    return {
      key: String(rec.object_id ?? `mask-${index}`),
      maskUrl: fromList ?? (index === 0 ? (fallbackMaskUrl ?? null) : null),
      box: rec.box ?? null,
      maskDims: rec.mask_dims ?? null,
      objectId: rec.object_id ?? null,
    };
  });
}
