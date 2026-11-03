// ---------------------------------------------------------------------------
// Minimal self-contained QR encoder (no external packages), used to show the
// phone-upload URL on the desktop. Byte mode, error-correction level M,
// versions 1-10, one fixed mask pattern (mask 0: flip when (x + y) is even).
// Reed-Solomon over GF(256) with primitive polynomial 0x11D; data and ECC
// blocks are interleaved per the standard ECC-M block table; format and
// version information are BCH-coded per the standard generators (0x537 /
// 0x1F25). The tables below are the canonical spec values:
//   ECC-M blocks: ecPerBlock + groups of [block count, data codewords].
//   Alignment centres and remainder bits per version 1-10.
// ---------------------------------------------------------------------------

const QR_MASK = 0;

const QR_ECC_M: { ecPerBlock: number; groups: [number, number][] }[] = [
  { ecPerBlock: 10, groups: [[1, 16]] }, // version 1
  { ecPerBlock: 16, groups: [[1, 28]] }, // version 2
  { ecPerBlock: 26, groups: [[1, 44]] }, // version 3
  { ecPerBlock: 18, groups: [[2, 32]] }, // version 4
  { ecPerBlock: 24, groups: [[2, 43]] }, // version 5
  { ecPerBlock: 16, groups: [[4, 27]] }, // version 6
  { ecPerBlock: 18, groups: [[4, 31]] }, // version 7
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] }, // version 8
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] }, // version 9
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] }, // version 10
];

const QR_ALIGNMENT: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const QR_REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 2];

// GF(256) log/exp tables (generator 2, primitive polynomial 0x11D).
const QR_GF_EXP: number[] = [];
const QR_GF_LOG: number[] = new Array<number>(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_GF_EXP.push(x);
    QR_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

function qrGfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return QR_GF_EXP[(QR_GF_LOG[a] + QR_GF_LOG[b]) % 255];
}

/** Generator polynomial coefficients for `degree` ECC codewords. */
function qrRsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = qrGfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = qrGfMul(root, 0x02);
  }
  return result;
}

function qrRsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= qrGfMul(divisor[i], factor);
    }
  }
  return result;
}

/** 15-bit format information for ECC level M (bits 00) and the given mask. */
function qrFormatBits(mask: number): number {
  const data = mask; // (0b00 << 3) | mask
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions >= 7). */
function qrVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | rem;
}


/** Data + ECC codewords assembled for one payload at one version. */
interface QrBuiltData {
  version: number;
  ecPerBlock: number;
  blocksData: number[][];
  blocksEc: number[][];
  /** All data codewords (payload + terminator + pads), pre-split. */
  dataCodewords: number[];
  /** Interleaved data + ECC + remainder bits, as placed in the matrix. */
  finalBits: number[];
}

/**
 * Assemble the data and ECC codewords for `text` at the smallest
 * version 1-10 (ECC level M) that fits, or null when nothing fits.
 */
function qrBuildData(text: string): QrBuiltData | null {
  const payload = new TextEncoder().encode(text);
  for (let version = 1; version <= 10; version++) {
    const spec = QR_ECC_M[version - 1];
    const dataCwTotal = spec.groups.reduce((sum, [count, dcw]) => sum + count * dcw, 0);
    const countBits = version === 10 ? 16 : 8;
    if (4 + countBits + payload.length * 8 > dataCwTotal * 8) continue;

    // Assemble the data bit stream: mode, count, bytes, terminator, pads.
    const bits: number[] = [];
    const pushBits = (value: number, length: number) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    pushBits(0b0100, 4); // byte mode
    pushBits(payload.length, countBits);
    for (const b of payload) pushBits(b, 8);
    const capacityBits = dataCwTotal * 8;
    pushBits(0, Math.min(4, capacityBits - bits.length));
    pushBits(0, (8 - (bits.length % 8)) % 8);
    const dataBytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      dataBytes.push(v);
    }
    for (let pad = 0xec; dataBytes.length < dataCwTotal; pad ^= 0xec ^ 0x11) {
      dataBytes.push(pad);
    }

    // Split into blocks, compute ECC per block, interleave data then ECC.
    const divisor = qrRsDivisor(spec.ecPerBlock);
    const blocksData: number[][] = [];
    const blocksEc: number[][] = [];
    let offset = 0;
    for (const [count, dcw] of spec.groups) {
      for (let k = 0; k < count; k++) {
        const block = dataBytes.slice(offset, offset + dcw);
        offset += dcw;
        blocksData.push(block);
        blocksEc.push(qrRsRemainder(block, divisor));
      }
    }
    const finalBits: number[] = [];
    const pushByte = (b: number) => {
      for (let i = 7; i >= 0; i--) finalBits.push((b >>> i) & 1);
    };
    const maxDataLen = Math.max(...blocksData.map((b) => b.length));
    for (let i = 0; i < maxDataLen; i++) {
      for (const block of blocksData) if (i < block.length) pushByte(block[i]);
    }
    for (let i = 0; i < spec.ecPerBlock; i++) {
      for (const block of blocksEc) pushByte(block[i]);
    }
    for (let i = 0; i < QR_REMAINDER_BITS[version - 1]; i++) finalBits.push(0);
    return {
      version,
      ecPerBlock: spec.ecPerBlock,
      blocksData,
      blocksEc,
      dataCodewords: dataBytes,
      finalBits,
    };
  }
  return null;
}

/**
 * Encode `text` as a QR module matrix (true = dark), or null when it does
 * not fit in version 10-M. Side length is always 17 + 4 * version.
 */
export function qrEncodeModules(text: string): boolean[][] | null {
  const built = qrBuildData(text);
  if (!built) return null;
  const { version, finalBits } = built;
  // Build the matrix: function patterns first, then data in the
  // standard bottom-right zigzag (column 6 skipped), mask applied to
  // data modules only.
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const setFn = (x: number, y: number, dark: boolean) => {
    if (0 <= x && x < size && 0 <= y && y < size) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }
  };
  const bitAt = (value: number, i: number) => ((value >>> i) & 1) !== 0;

  // Timing patterns (the finder patterns drawn next overwrite their
  // own areas, including the separator rings).
  for (let i = 0; i < size; i++) {
    setFn(i, 6, i % 2 === 0);
    setFn(6, i, i % 2 === 0);
  }
  // Finder patterns (centre-anchored, with light separator ring).
  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  // Alignment patterns (skipping the three finder corners).
  const centres = QR_ALIGNMENT[version - 1];
  for (const cy of centres) {
    for (const cx of centres) {
      const nearCorner =
        (cx === centres[0] && cy === centres[0]) ||
        (cx === centres[0] && cy === centres[centres.length - 1]) ||
        (cx === centres[centres.length - 1] && cy === centres[0]);
      if (nearCorner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Format information (fixed mask) + the dark module. Drawn now so
  // the cells are reserved before data placement.
  const format = qrFormatBits(QR_MASK);
  for (let i = 0; i <= 5; i++) setFn(8, i, bitAt(format, i));
  setFn(8, 7, bitAt(format, 6));
  setFn(8, 8, bitAt(format, 7));
  setFn(7, 8, bitAt(format, 8));
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, bitAt(format, i));
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bitAt(format, i));
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bitAt(format, i));
  setFn(8, size - 8, true); // dark module
  // Version information (versions >= 7 only).
  if (version >= 7) {
    const versionBits = qrVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = bitAt(versionBits, i);
      setFn(size - 11 + (i % 3), Math.floor(i / 3), bit);
      setFn(Math.floor(i / 3), size - 11 + (i % 3), bit);
    }
  }
  // Data placement with mask 0 applied to data modules.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x]) continue;
        let dark = bitIndex < finalBits.length && finalBits[bitIndex] === 1;
        bitIndex++;
        if ((x + y) % 2 === 0) dark = !dark; // mask 0
        modules[y][x] = dark;
      }
    }
  }
  return modules;
}

/**
 * Internal codeword view for tests: the version chosen for `text`,
 * its data codewords and the per-block data/ECC split. Underscore-
 * prefixed — not part of the page-facing API.
 */
export function _qrCodewords(text: string): {
  version: number;
  ecPerBlock: number;
  dataCodewords: number[];
  blocks: { data: number[]; ecc: number[] }[];
} | null {
  const built = qrBuildData(text);
  if (!built) return null;
  return {
    version: built.version,
    ecPerBlock: built.ecPerBlock,
    dataCodewords: built.dataCodewords,
    blocks: built.blocksData.map((data, i) => ({
      data,
      ecc: built.blocksEc[i],
    })),
  };
}

// Reed-Solomon internals, exported for the parity checks in tests.
export {
  QR_GF_EXP as _qrGfExp,
  qrGfMul as _qrGfMul,
  qrRsDivisor as _qrRsDivisor,
  qrRsRemainder as _qrRsRemainder,
};
