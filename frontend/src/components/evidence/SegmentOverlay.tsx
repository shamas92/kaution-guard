"use client";

import { useEffect, useRef, useState } from "react";
import { markerPercent, maskPlacement } from "../../lib/samOverlay";
import type { OverlayEntry } from "../../lib/samOverlay";

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
export function MarkerDots({
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
            className="kg-marker-dot"
            style={{ left: `${pct.leftPct}%`, top: `${pct.topPct}%` }}
          >
            {index}
          </span>
        );
      })}
    </>
  );
}

export function SegmentOverlay({
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
        className="kg-stage-wrap"
      >
        <canvas
          ref={canvasRef}
          className="kg-stage-canvas"
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
            className="kg-marker-layer"
          >
            <MarkerDots points={markers} natural={size} />
          </div>
        )}
      </div>
      {size && (
        <details className="kg-tech-details">
          <summary>Technical details</summary>
          <p className="kg-sub">
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
        </details>
      )}
      {drawError && (
        <p role="alert" className="kg-alert kg-alert--error">
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
export function ServerOverlayPreview({
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
      className="kg-stage-wrap"
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
        className="kg-stage-img"
      />
      <img
        src={overlayUrl}
        alt=""
        aria-hidden="true"
        onError={() => setOverlayFailed(true)}
        className="kg-stage-overlay-img"
      />
      {natural && markers && markers.length > 0 && (
        <div
          aria-hidden="true"
          className="kg-marker-layer"
        >
          <MarkerDots points={markers} natural={natural} />
        </div>
      )}
    </div>
  );
}
