import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  qrEncodeModules,
  _qrCodewords,
  _qrGfExp,
  _qrGfMul,
  _qrRsDivisor,
  _qrRsRemainder,
} from "./qrCode.ts";

// Byte-mode ECC-M payload capacities are ~14 / 26 / 42 / 62 data
// bytes for versions 1-4, so these lengths land one per version.
const BY_VERSION: { version: number; text: string }[] = [
  { version: 1, text: "A".repeat(10) },
  { version: 2, text: "B".repeat(20) },
  { version: 3, text: "C".repeat(30) },
  { version: 4, text: "D".repeat(50) },
];

const HANDOFF_URL =
  "http://192.168.1.42:3000/evidence?mobile=1&session=kg_demo123";

function encode(text: string): boolean[][] {
  const modules = qrEncodeModules(text);
  assert.ok(modules, `expected ${JSON.stringify(text.slice(0, 24))} to encode`);
  return modules;
}

/** Assert the exact 7x7 finder centred at (cx, cy): dark ring at
 * Chebyshev distance 3 and 0-1 (the 3x3 core), light ring at 2. */
function assertFinder(m: boolean[][], cx: number, cy: number): void {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      assert.equal(
        m[cy + dy][cx + dx],
        dist !== 2,
        `finder cell (${cx + dx}, ${cy + dy})`,
      );
    }
  }
}

describe("qrEncodeModules version selection", () => {
  for (const { version, text } of BY_VERSION) {
    it(`encodes a ${text.length}-byte payload at version ${version} (size 17 + 4*${version})`, () => {
      const cw = _qrCodewords(text);
      assert.ok(cw);
      assert.equal(cw.version, version);
      const m = encode(text);
      assert.equal(m.length, 17 + 4 * version);
      assert.ok(m.every((row) => row.length === m.length));
    });
  }

  it("returns null for a payload beyond version 10-M capacity", () => {
    assert.equal(qrEncodeModules("x".repeat(300)), null);
    assert.equal(_qrCodewords("x".repeat(300)), null);
  });
});

describe("finder and timing patterns", () => {
  it("draws the exact 7x7 finder at the top-left corner (versions 1-4)", () => {
    for (const { text } of BY_VERSION) {
      const m = encode(text);
      assertFinder(m, 3, 3);
      // Representative exact cells: outer ring dark, light ring, core.
      assert.equal(m[0][0], true);
      assert.equal(m[0][6], true);
      assert.equal(m[6][0], true);
      assert.equal(m[1][1], false);
      assert.equal(m[5][5], false);
      assert.equal(m[2][2], true);
      assert.equal(m[3][3], true);
      assert.equal(m[4][4], true);
      assert.equal(m[6][6], true);
    }
  });

  it("draws the exact 7x7 finder at the top-right corner (versions 1-4)", () => {
    for (const { text } of BY_VERSION) {
      const m = encode(text);
      const size = m.length;
      assertFinder(m, size - 4, 3);
      assert.equal(m[0][size - 1], true);
      assert.equal(m[0][size - 7], true);
      assert.equal(m[1][size - 5], false);
      assert.equal(m[3][size - 4], true);
    }
  });

  it("draws the exact 7x7 finder at the bottom-left corner (versions 1-4)", () => {
    for (const { text } of BY_VERSION) {
      const m = encode(text);
      const size = m.length;
      assertFinder(m, 3, size - 4);
      assert.equal(m[size - 1][0], true);
      assert.equal(m[size - 7][0], true);
      assert.equal(m[size - 5][1], false);
      assert.equal(m[size - 4][3], true);
    }
  });

  it("keeps the separator ring around every finder light (versions 1-4)", () => {
    for (const { text } of BY_VERSION) {
      const m = encode(text);
      const size = m.length;
      // Top-left separators: column 7 and row 7 beside the finder.
      assert.equal(m[0][7], false);
      assert.equal(m[3][7], false);
      assert.equal(m[7][0], false);
      assert.equal(m[7][3], false);
      assert.equal(m[7][7], false);
      // Top-right separators.
      assert.equal(m[0][size - 8], false);
      assert.equal(m[3][size - 8], false);
      assert.equal(m[7][size - 1], false);
      assert.equal(m[7][size - 8], false);
      // Bottom-left separators.
      assert.equal(m[size - 8][0], false);
      assert.equal(m[size - 8][3], false);
      assert.equal(m[size - 1][7], false);
      assert.equal(m[size - 8][7], false);
    }
  });

  it("alternates the timing pattern on row 6 between the finders (versions 1-4)", () => {
    for (const { text } of BY_VERSION) {
      const m = encode(text);
      const size = m.length;
      for (let x = 8; x <= size - 9; x++) {
        assert.equal(m[6][x], x % 2 === 0, `timing row cell x=${x}`);
      }
    }
  });

  it("alternates the timing pattern on column 6 between the finders (versions 1-4)", () => {
    for (const { text } of BY_VERSION) {
      const m = encode(text);
      const size = m.length;
      for (let y = 8; y <= size - 9; y++) {
        assert.equal(m[y][6], y % 2 === 0, `timing column cell y=${y}`);
      }
    }
  });
});

describe("mobile handoff URL", () => {
  it("encodes to a square boolean matrix of deterministic size", () => {
    const m = encode(HANDOFF_URL);
    const cw = _qrCodewords(HANDOFF_URL);
    assert.ok(cw);
    // 61 payload bytes land at version 4 under ECC level M.
    assert.equal(cw.version, 4);
    assert.equal(m.length, 17 + 4 * cw.version);
    assert.equal(m.length, 33);
    for (const row of m) {
      assert.equal(row.length, m.length);
      assert.ok(row.every((cell) => typeof cell === "boolean"));
    }
  });

  it("is deterministic: two encodes produce identical matrices", () => {
    assert.deepEqual(encode(HANDOFF_URL), encode(HANDOFF_URL));
    assert.deepEqual(_qrCodewords(HANDOFF_URL), _qrCodewords(HANDOFF_URL));
  });

  it("starts the data stream with the byte-mode header and byte count", () => {
    const cw = _qrCodewords(HANDOFF_URL);
    assert.ok(cw);
    const len = new TextEncoder().encode(HANDOFF_URL).length;
    // Bits: 0100 (byte mode) then the 8-bit count, so the first
    // codeword is 0x40 | (len >> 4) and the second packs the low
    // count nibble with the first payload byte's high nibble ('h').
    assert.equal(cw.dataCodewords[0], 0x40 | (len >> 4));
    assert.equal(cw.dataCodewords[1], ((len & 0x0f) << 4) | (0x68 >> 4));
  });
});

describe("Reed-Solomon parity", () => {
  /** Syndromes of a full (data + ECC) block: evaluating the block
   * polynomial at alpha^0 .. alpha^(ec-1) must give all zeros for a
   * valid codeword. */
  function syndromes(codewords: number[], ecCount: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < ecCount; i++) {
      let s = 0;
      for (const cw of codewords) s = _qrGfMul(s, _qrGfExp[i]) ^ cw;
      out.push(s);
    }
    return out;
  }

  it("has all-zero syndromes for every block of the handoff URL", () => {
    const cw = _qrCodewords(HANDOFF_URL);
    assert.ok(cw);
    assert.ok(cw.blocks.length >= 2); // version 4-M splits into 2 blocks
    for (const block of cw.blocks) {
      assert.equal(block.ecc.length, cw.ecPerBlock);
      assert.deepEqual(
        syndromes([...block.data, ...block.ecc], cw.ecPerBlock),
        new Array<number>(cw.ecPerBlock).fill(0),
      );
    }
  });

  it("has all-zero syndromes for a multi-block payload (version 6)", () => {
    const cw = _qrCodewords("E".repeat(100));
    assert.ok(cw);
    assert.equal(cw.version, 6);
    assert.equal(cw.blocks.length, 4);
    for (const block of cw.blocks) {
      assert.deepEqual(
        syndromes([...block.data, ...block.ecc], cw.ecPerBlock),
        new Array<number>(cw.ecPerBlock).fill(0),
      );
    }
  });

  it("stores ECC equal to a freshly computed Reed-Solomon remainder", () => {
    for (const text of [HANDOFF_URL, "A".repeat(10), "E".repeat(100)]) {
      const cw = _qrCodewords(text);
      assert.ok(cw);
      const divisor = _qrRsDivisor(cw.ecPerBlock);
      for (const block of cw.blocks) {
        assert.deepEqual(_qrRsRemainder(block.data, divisor), block.ecc);
      }
    }
  });

  it("splits the data codewords across blocks without loss or reorder", () => {
    const cw = _qrCodewords(HANDOFF_URL);
    assert.ok(cw);
    assert.deepEqual(
      cw.blocks.flatMap((block) => block.data),
      cw.dataCodewords,
    );
  });
});
