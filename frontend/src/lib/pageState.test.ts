import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_CASE_SUMMARY, readCaseSummary } from "./pageState.ts";

// Node has no DOM storage: install minimal in-memory stubs plus a
// `window` global (readCaseSummary returns the empty summary during
// SSR, i.e. when `window` is undefined).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const CONTRACT_KEY = "kautionguard.pagestate.contract.v1";
const EVIDENCE_KEY = "kautionguard.pagestate.evidence.v1";
const MOVEOUT_KEY = "kautionguard.pagestate.moveout.v1";
const REFS_KEY = "kautionguard.movein.references.v1";

const SHA =
  "9f2c4a7b1d8e3f605a2b4c6d8e0f1a3b5c7d9e2f4a6b8c0d1e3f5a7b9c2d4e6f80";

let session: MemoryStorage;
let local: MemoryStorage;

beforeEach(() => {
  session = new MemoryStorage();
  local = new MemoryStorage();
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.sessionStorage = session;
  g.localStorage = local;
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.sessionStorage;
  delete g.localStorage;
});

function saveContract(decodeResult: unknown): void {
  session.setItem(CONTRACT_KEY, JSON.stringify({ version: 1, decodeResult }));
}

function saveRefs(count: number): void {
  const refs = Array.from({ length: count }, (_, i) => ({
    key: `ref-${i}`,
    name: `photo-${i}.jpg · mask 0`,
    savedAt: "2026-11-02T08:00:00.000Z",
    frameSize: { width: 640, height: 480 },
    objectId: "0",
    box: { left: 10, top: 10, right: 60, bottom: 40 },
    maskDims: { width: 50, height: 30 },
    maskPngBase64: "iVBORw0KGgo=",
  }));
  local.setItem(REFS_KEY, JSON.stringify(refs));
}

function saveWalkthrough(evidenceSha256: unknown): void {
  session.setItem(
    EVIDENCE_KEY,
    JSON.stringify({
      version: 1,
      walkResult: { evidence_sha256: evidenceSha256 },
    }),
  );
}

function saveMoveout(comparison: unknown): void {
  session.setItem(
    MOVEOUT_KEY,
    JSON.stringify({ version: 1, verifyResult: { comparison } }),
  );
}

describe("readCaseSummary with empty storage", () => {
  it("returns the empty case summary", () => {
    assert.deepEqual(readCaseSummary(), EMPTY_CASE_SUMMARY);
  });

  it("reports no contract, zero references, no walkthrough and no move-out", () => {
    const summary = readCaseSummary();
    assert.equal(summary.contract, null);
    assert.equal(summary.refCount, 0);
    assert.equal(summary.walkthroughSha, null);
    assert.equal(summary.moveout, null);
  });
});

describe("readCaseSummary contract step", () => {
  it("reads clause and high-severity counts from the decode result", () => {
    saveContract({ issue_count: 11, high_severity_count: 5 });
    assert.deepEqual(readCaseSummary().contract, {
      issueCount: 11,
      highCount: 5,
    });
  });

  it("falls back to the counts mirrored inside analysis", () => {
    saveContract({ analysis: { issue_count: 7, high_severity_count: 2 } });
    assert.deepEqual(readCaseSummary().contract, {
      issueCount: 7,
      highCount: 2,
    });
  });

  it("leaves the step empty when the saved payload has no counts", () => {
    saveContract({ analysis: {} });
    assert.equal(readCaseSummary().contract, null);
  });
});

describe("readCaseSummary evidence step", () => {
  it("counts the locked SAM 3.1 move-in references", () => {
    saveRefs(3);
    assert.equal(readCaseSummary().refCount, 3);
  });

  it("reports the walkthrough SHA-256 when one was saved", () => {
    saveWalkthrough(SHA);
    assert.equal(readCaseSummary().walkthroughSha, SHA);
  });

  it("ignores an empty walkthrough hash", () => {
    saveWalkthrough("");
    assert.equal(readCaseSummary().walkthroughSha, null);
  });
});

describe("readCaseSummary move-out step", () => {
  it("reports the registered IoU percentage when the comparison registered", () => {
    saveMoveout({ registered: true, iou_registered: 0.512, iou: 0.0 });
    const moveout = readCaseSummary().moveout;
    assert.ok(moveout);
    assert.equal(moveout.registered, true);
    assert.equal(moveout.iou, 0.512);
    assert.equal((moveout.iou * 100).toFixed(1), "51.2");
  });

  it("reports the raw IoU when the comparison did not register", () => {
    saveMoveout({ registered: false, iou_registered: 0.9, iou: 0.34 });
    assert.deepEqual(readCaseSummary().moveout, {
      iou: 0.34,
      registered: false,
    });
  });

  it("leaves the step empty for a no-match comparison without an IoU", () => {
    saveMoveout({ match: false });
    assert.equal(readCaseSummary().moveout, null);
  });
});

describe("readCaseSummary combined and degraded state", () => {
  it("assembles the full summary from populated storage", () => {
    saveContract({ issue_count: 11, high_severity_count: 5 });
    saveRefs(2);
    saveWalkthrough(SHA);
    saveMoveout({ registered: true, iou_registered: 0.512, iou: 0.0 });
    assert.deepEqual(readCaseSummary(), {
      contract: { issueCount: 11, highCount: 5 },
      refCount: 2,
      walkthroughSha: SHA,
      moveout: { iou: 0.512, registered: true },
    });
  });

  it("degrades per step: a malformed contract payload keeps the other steps", () => {
    session.setItem(CONTRACT_KEY, "{not json");
    saveRefs(2);
    saveWalkthrough(SHA);
    const summary = readCaseSummary();
    assert.equal(summary.contract, null);
    assert.equal(summary.refCount, 2);
    assert.equal(summary.walkthroughSha, SHA);
  });
});
