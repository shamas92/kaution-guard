import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { segmentImage } from "./api.ts";

function segmentPayload(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "abc123",
    mask: { match: true },
    mask_url: "/files/segment/abc/mask-abc123.png",
    mask_urls: ["/files/segment/abc/mask-abc123.png"],
    image_url: "/files/segment/abc/image-abc123.png",
    review_note: "note",
    ...overrides,
  };
}

describe("segmentImage overlay URL", () => {
  const realFetch = globalThis.fetch;
  let payload: unknown = null;

  beforeEach(() => {
    payload = null;
    globalThis.fetch = (async (url: unknown, init: unknown) => ({
      ok: true,
      json: async () => payload,
    })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function segment() {
    const file = new File(["bytes"], "photo.png", { type: "image/png" });
    return segmentImage(file, "stain");
  }

  it("derives a usable overlay URL on fresh responses", async () => {
    payload = segmentPayload({ cached: false });
    const result = await segment();
    assert.equal(
      result.overlay_url,
      "/files/segment/abc/mask-abc123-overlay.png",
    );
  });

  it("derives the same overlay URL on cached responses", async () => {
    payload = segmentPayload({ cached: true });
    const result = await segment();
    assert.equal(
      result.overlay_url,
      "/files/segment/abc/mask-abc123-overlay.png",
    );
  });

  it("returns null when no mask file was served", async () => {
    payload = segmentPayload({ mask_url: null, mask_urls: [] });
    const result = await segment();
    assert.equal(result.overlay_url, null);
  });

  it("never exposes the absolute overlay_path from the payload", async () => {
    payload = segmentPayload({
      mask: {
        match: true,
        overlay_path:
          "E:\\kaution-guard\\backend\\storage\\segment\\abc\\mask-abc123-overlay.png",
      },
    });
    const result = await segment();
    assert.equal(
      result.overlay_url,
      "/files/segment/abc/mask-abc123-overlay.png",
    );
    assert.ok(!JSON.stringify(result).includes("E:"));
    assert.ok(!JSON.stringify(result).includes("\\"));
  });
});
