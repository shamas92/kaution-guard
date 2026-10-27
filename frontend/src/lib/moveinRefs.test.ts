import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildPriorMaskPayload,
  loadMoveinRefs,
  storeMoveinRefs,
  validatePriorMaskForFrame,
  type MoveinReference,
} from "./moveinRefs.ts";
import { verifyMoveout } from "./api.ts";

const REF: MoveinReference = {
  key: "k1",
  name: "photo.jpg · mask 0",
  savedAt: "2026-10-27T00:00:00.000Z",
  frameSize: { width: 640, height: 480 },
  objectId: "0",
  box: { left: 211, top: 228, right: 271, bottom: 255 },
  maskDims: { width: 60, height: 27 },
  maskPngBase64: "iVBORw0KGgo=",
};

describe("buildPriorMaskPayload", () => {
  it("emits the exact prior_mask shape the backend validates", () => {
    assert.deepEqual(buildPriorMaskPayload(REF), {
      mask_png_base64: "iVBORw0KGgo=",
      mask_dims: { width: 60, height: 27 },
      box: { left: 211, top: 228, right: 271, bottom: 255 },
      frame_size: { width: 640, height: 480 },
      object_id: "0",
    });
  });
});

describe("validatePriorMaskForFrame", () => {
  it("accepts a reference from the same-size photo", () => {
    assert.equal(
      validatePriorMaskForFrame(REF.frameSize, { width: 640, height: 480 }),
      null,
    );
  });

  it("refuses mismatched dimensions instead of misaligning", () => {
    const reason = validatePriorMaskForFrame(REF.frameSize, {
      width: 320,
      height: 240,
    });
    assert.ok(reason);
    assert.ok(reason.includes("640x480"));
    assert.ok(reason.includes("320x240"));
  });
});

describe("reference storage", () => {
  it("round-trips valid references and drops invalid ones", () => {
    const calls: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => calls[key] ?? null,
      setItem: (key: string, value: string) => {
        calls[key] = value;
      },
      removeItem: (key: string) => {
        delete calls[key];
      },
    };
    assert.equal(storeMoveinRefs([REF], storage), true);
    assert.deepEqual(loadMoveinRefs(storage), [REF]);
    storage.setItem(
      "kautionguard.movein.references.v1",
      JSON.stringify([REF, { key: "bad" }, "nope", null]),
    );
    assert.deepEqual(loadMoveinRefs(storage), [REF]);
  });

  it("reports failure when the store is unavailable or full", () => {
    assert.deepEqual(loadMoveinRefs(undefined), []);
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    assert.equal(storeMoveinRefs([REF], failing), false);
    assert.deepEqual(
      loadMoveinRefs({
        getItem: () => "{invalid json",
        setItem: () => {},
        removeItem: () => {},
      }),
      [],
    );
  });
});

describe("verifyMoveout request", () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; body: unknown } | null = null;

  beforeEach(() => {
    seen = null;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      seen = { url: url as string, body: (init as { body: unknown }).body };
      return { ok: true, json: async () => ({}) };
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends the raster prior_mask and clears the polygon field", async () => {
    const file = new File(["bytes"], "moveout.png", { type: "image/png" });
    await verifyMoveout(
      file,
      [[1, 1]],
      "stain",
      JSON.stringify(buildPriorMaskPayload(REF)),
    );
    assert.ok(seen);
    assert.equal(seen.url, "http://localhost:8000/api/verify-moveout");
    const form = seen.body as FormData;
    const priorMask = JSON.parse(form.get("prior_mask") as string);
    assert.equal(priorMask.object_id, "0");
    assert.deepEqual(priorMask.frame_size, { width: 640, height: 480 });
    assert.deepEqual(priorMask.box, {
      left: 211,
      top: 228,
      right: 271,
      bottom: 255,
    });
    assert.equal(priorMask.mask_png_base64, "iVBORw0KGgo=");
    assert.equal(form.get("prior_polygon"), "");
  });

  it("keeps the legacy polygon request when no raster is given", async () => {
    const file = new File(["bytes"], "moveout.png", { type: "image/png" });
    const polygon = [
      [1, 1],
      [5, 1],
      [3, 4],
    ];
    await verifyMoveout(file, polygon, "stain");
    assert.ok(seen);
    const form = seen.body as FormData;
    assert.deepEqual(JSON.parse(form.get("prior_polygon") as string), polygon);
    assert.equal(form.get("prior_mask"), null);
  });
});
