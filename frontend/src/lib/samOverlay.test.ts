import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  markerPercent,
  maskPixelToFrame,
  maskPlacement,
  overlayEntries,
  previewToImage,
} from "./samOverlay.ts";

// Documented SAM example geometry: box 211,228-271,255 in a 320x334
// frame with a 60x27 decoded mask. The mask maps onto the box at ~1:1,
// never onto the whole frame.
const BOX = { left: 211, top: 228, right: 271, bottom: 255 };
const MASK_DIMS = { width: 60, height: 27 };
const FRAME = { width: 320, height: 334 };

describe("maskPlacement", () => {
  it("places the mask at the box origin sized to the box", () => {
    assert.deepEqual(maskPlacement(BOX, MASK_DIMS), {
      dx: 211,
      dy: 228,
      dw: 60,
      dh: 27,
    });
  });

  it("does not stretch the mask over the whole frame", () => {
    const placement = maskPlacement(BOX, MASK_DIMS);
    assert.ok(placement);
    assert.notEqual(placement.dw, FRAME.width);
    assert.notEqual(placement.dh, FRAME.height);
    assert.ok(placement.dw < FRAME.width);
    assert.ok(placement.dh < FRAME.height);
  });

  it("maps mask pixels onto box pixels, not frame pixels", () => {
    const placement = maskPlacement(BOX, MASK_DIMS);
    assert.ok(placement);
    const topLeft = maskPixelToFrame(0, 0, placement, MASK_DIMS);
    assert.deepEqual(topLeft, { x: 211, y: 228 });
    const bottomRight = maskPixelToFrame(
      MASK_DIMS.width,
      MASK_DIMS.height,
      placement,
      MASK_DIMS,
    );
    assert.deepEqual(bottomRight, { x: 271, y: 255 });
    // A mid-mask pixel lands inside the box, scaled by box/mask ratio.
    const mid = maskPixelToFrame(30, 13.5, placement, MASK_DIMS);
    assert.ok(mid.x > BOX.left && mid.x < BOX.right);
    assert.ok(mid.y > BOX.top && mid.y < BOX.bottom);
  });

  describe("overlayEntries", () => {
    const BOX0 = { left: 211, top: 228, right: 271, bottom: 255 };
    const BOX1 = { left: 155, top: 228, right: 203, bottom: 255 };
    const DIMS0 = { width: 60, height: 27 };
    const DIMS1 = { width: 48, height: 27 };

    it("pairs every mask with its box, dims, id, and file URL", () => {
      const entries = overlayEntries(
        {
          match: true,
          masks: [
            { object_id: "0", box: BOX0, mask_dims: DIMS0 },
            { object_id: "1", box: BOX1, mask_dims: DIMS1 },
          ],
        },
        ["/files/segment/j/mask-j.png", "/files/segment/j/mask-j-1.png"],
        "/files/segment/j/mask-j.png",
      );
      assert.equal(entries.length, 2);
      assert.deepEqual(entries[0], {
        key: "0",
        maskUrl: "/files/segment/j/mask-j.png",
        box: BOX0,
        maskDims: DIMS0,
        objectId: "0",
      });
      assert.deepEqual(entries[1], {
        key: "1",
        maskUrl: "/files/segment/j/mask-j-1.png",
        box: BOX1,
        maskDims: DIMS1,
        objectId: "1",
      });
      // Each entry still lands on its own box, not the frame.
      for (const entry of entries) {
        assert.ok(entry.box);
        const placement = maskPlacement(entry.box, entry.maskDims);
        assert.ok(placement);
        assert.equal(placement.dw, entry.box.right - entry.box.left);
        assert.equal(placement.dh, entry.box.bottom - entry.box.top);
      }
    });

    it("falls back to the legacy single entry with the first URL", () => {
      const entries = overlayEntries(
        { match: true, box: BOX0, mask_dims: DIMS0, object_id: null },
        null,
        "/files/segment/j/mask-j.png",
      );
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0], {
        key: "mask-0",
        maskUrl: "/files/segment/j/mask-j.png",
        box: BOX0,
        maskDims: DIMS0,
        objectId: null,
      });
    });

    it("returns no entries on no-match and null URLs past the list", () => {
      assert.deepEqual(overlayEntries({ match: false }, [], null), []);
      assert.deepEqual(overlayEntries(null, null, null), []);
      const entries = overlayEntries(
        {
          match: true,
          masks: [
            { object_id: "0", box: BOX0, mask_dims: DIMS0 },
            { object_id: "1", box: BOX1, mask_dims: DIMS1 },
          ],
        },
        ["/files/segment/j/mask-j.png"],
        null,
      );
      assert.equal(entries[0].maskUrl, "/files/segment/j/mask-j.png");
      assert.equal(entries[1].maskUrl, null);
    });
  });

  describe("previewToImage", () => {
    // A 640x480 photo shown at 320x240 CSS px: one display pixel is
    // two natural pixels in each axis.
    const RECT = { left: 50, top: 100, width: 320, height: 240 };
    const NATURAL = { width: 640, height: 480 };

    it("scales clicks from the CSS preview to natural pixels", () => {
      assert.deepEqual(previewToImage(50, 100, RECT, NATURAL), { x: 0, y: 0 });
      assert.deepEqual(previewToImage(210, 220, RECT, NATURAL), {
        x: 320,
        y: 240,
      });
      assert.deepEqual(previewToImage(369, 339, RECT, NATURAL), {
        x: 638,
        y: 478,
      });
    });

    it("maps 1:1 when the preview matches the natural size", () => {
      const rect = { left: 0, top: 0, width: 640, height: 480 };
      assert.deepEqual(previewToImage(123, 45, rect, NATURAL), {
        x: 123,
        y: 45,
      });
    });

    it("rejects clicks outside the image instead of fabricating spots", () => {
      assert.equal(previewToImage(49, 100, RECT, NATURAL), null);
      assert.equal(previewToImage(50, 99, RECT, NATURAL), null);
      assert.equal(previewToImage(370, 220, RECT, NATURAL), null);
      assert.equal(previewToImage(210, 340, RECT, NATURAL), null);
      assert.equal(
        previewToImage(210, 220, { ...RECT, width: 0 }, NATURAL),
        null,
      );
      assert.equal(
        previewToImage(210, 220, RECT, { width: 0, height: 480 }),
        null,
      );
    });
  });

  describe("markerPercent", () => {
    const NATURAL = { width: 640, height: 480 };

    it("expresses spots as percentages of the natural image", () => {
      assert.deepEqual(markerPercent({ x: 320, y: 240 }, NATURAL), {
        leftPct: 50,
        topPct: 50,
      });
      assert.deepEqual(markerPercent({ x: 0, y: 0 }, NATURAL), {
        leftPct: 0,
        topPct: 0,
      });
    });

    it("rejects out-of-range spots instead of misplacing dots", () => {
      assert.equal(markerPercent({ x: 640, y: 10 }, NATURAL), null);
      assert.equal(markerPercent({ x: 10, y: -1 }, NATURAL), null);
      assert.equal(
        markerPercent({ x: 10, y: 10 }, { width: 0, height: 480 }),
        null,
      );
    });

    it("round-trips with previewToImage at different preview sizes", () => {
      // A dot drawn from these percentages, clicked at its display
      // position, must convert back to the same natural pixel: dots and
      // clicks share one rectangle and scaling basis.
      const rects = [
        { left: 0, top: 0, width: 640, height: 480 },
        { left: 50, top: 100, width: 320, height: 240 },
        { left: 10, top: 20, width: 213, height: 160 },
      ];
      const spots = [
        { x: 0, y: 0 },
        { x: 5, y: 7 },
        { x: 320, y: 240 },
        { x: 639, y: 479 },
      ];
      for (const rect of rects) {
        for (const spot of spots) {
          const pct = markerPercent(spot, NATURAL);
          assert.ok(pct);
          const displayX =
            rect.left + (pct.leftPct / 100) * rect.width;
          const displayY = rect.top + (pct.topPct / 100) * rect.height;
          assert.deepEqual(
            previewToImage(displayX, displayY, rect, NATURAL),
            spot,
          );
        }
      }
    });
  });

  it("rejects degenerate geometry instead of misplacing the mask", () => {
    assert.equal(maskPlacement(null, MASK_DIMS), null);
    assert.equal(maskPlacement(BOX, null), null);
    assert.equal(
      maskPlacement({ ...BOX, right: BOX.left }, MASK_DIMS),
      null,
    );
    assert.equal(
      maskPlacement({ ...BOX, bottom: BOX.top - 1 }, MASK_DIMS),
      null,
    );
    assert.equal(maskPlacement(BOX, { width: 0, height: 27 }), null);
    assert.equal(maskPlacement(BOX, { width: 60, height: -2 }), null);
    assert.equal(
      maskPlacement(
        { left: Number.NaN, top: 228, right: 271, bottom: 255 },
        MASK_DIMS,
      ),
      null,
    );
  });
});
