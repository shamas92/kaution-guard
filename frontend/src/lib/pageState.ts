/**
 * Session persistence for workflow page state.
 *
 * WCAG 2.2 SC 3.3.7: never make the user re-enter information they
 * already gave. Each workflow page stores one versioned payload in
 * sessionStorage — drafts, selections and results that are pure
 * data — so navigating away and back no longer discards work.
 * Files cannot be stored in web storage; a page that restores a
 * result without its file says so next to the result.
 *
 * Same discipline as lib/handoff.ts and lib/walkthroughPriors.ts:
 * versioned keys, strict validation on load, try/catch everywhere,
 * and a hard size guard — a payload whose JSON exceeds the cap is
 * refused, and callers fall back to a smaller payload (prompts and
 * drafts without the bulky result objects).
 */

export const PAGE_STATE_VERSION = 1;

/** Refuse to store a payload whose JSON is longer than this. */
export const MAX_PAGE_STATE_CHARS = 1_500_000;

const PAGE_STATE_KEYS = {
  contract: "kautionguard.pagestate.contract.v1",
  evidence: "kautionguard.pagestate.evidence.v1",
  moveout: "kautionguard.pagestate.moveout.v1",
} as const;

export type PageStateKey = keyof typeof PAGE_STATE_KEYS;

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    return null;
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` serialises within the size guard. */
export function fitsPageState(value: unknown): boolean {
  try {
    const raw = JSON.stringify(value);
    return typeof raw === "string" && raw.length <= MAX_PAGE_STATE_CHARS;
  } catch {
    return false;
  }
}

/**
 * Store a page payload. Returns false when storage is unavailable,
 * the payload cannot be serialised, or it exceeds the size guard —
 * a failed save must never break the page itself.
 */
export function savePageState(page: PageStateKey, payload: unknown): boolean {
  const store = sessionStore();
  if (!store) return false;
  let raw: string;
  try {
    raw = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (typeof raw !== "string" || raw.length > MAX_PAGE_STATE_CHARS) {
    return false;
  }
  try {
    store.setItem(PAGE_STATE_KEYS[page], raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a page payload. Returns the parsed record only when it
 * parses, is a plain object and carries the current version;
 * anything else is treated as absent. Field-level validation is
 * the caller's job (each page knows its own shape).
 */
export function loadPageState(page: PageStateKey): Record<string, unknown> | null {
  const store = sessionStore();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(PAGE_STATE_KEYS[page]);
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
  if (!isRecord(parsed)) return null;
  if (parsed.version !== PAGE_STATE_VERSION) return null;
  return parsed;
}

/** Drop a page payload (not used by the pages today; kept for symmetry). */
export function clearPageState(page: PageStateKey): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(PAGE_STATE_KEYS[page]);
  } catch {
    /* nothing to clear if storage is blocked */
  }
}

/* ------------------------------------------------------------------ */
/* Case summary (shell dossier ribbon)                                 */
/* ------------------------------------------------------------------ */

/**
 * Cross-step progress snapshot for the shell's Case Dossier ribbon:
 * what each workflow step has produced so far, read from the same
 * persisted state the pages themselves save. Counts and figures are
 * copied verbatim from the saved payloads — nothing is recomputed
 * or inferred here.
 */
export interface CaseSummary {
  contract: { issueCount: number; highCount: number } | null;
  refCount: number;
  walkthroughSha: string | null;
  moveout: { iou: number; registered: boolean } | null;
}

/** The summary before anything has been saved (and during SSR). */
export const EMPTY_CASE_SUMMARY: CaseSummary = {
  contract: null,
  refCount: 0,
  walkthroughSha: null,
  moveout: null,
};

/** Move-in references live in localStorage under this key. */
const MOVEIN_REFS_KEY = "kautionguard.movein.references.v1";

function localStore(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return null;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readLocalJson(key: string): unknown {
  const store = localStore();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the case summary from persisted browser state. Pure,
 * synchronous and defensive: any missing, malformed or partial
 * payload degrades to nulls/0 for that step only, and during SSR
 * (no window) the empty summary is returned.
 */
export function readCaseSummary(): CaseSummary {
  if (typeof window === "undefined") return EMPTY_CASE_SUMMARY;

  // Step 1: the contract page saves its decode result; the backend
  // puts issue_count / high_severity_count on the result itself and
  // mirrors them inside `analysis` — read the top level first.
  let contract: CaseSummary["contract"] = null;
  const contractState = loadPageState("contract");
  if (contractState && isRecord(contractState.decodeResult)) {
    const result = contractState.decodeResult;
    const analysis = isRecord(result.analysis) ? result.analysis : null;
    const issueCount =
      finiteNumber(result.issue_count) ??
      (analysis ? finiteNumber(analysis.issue_count) : null);
    if (issueCount !== null) {
      const highCount =
        finiteNumber(result.high_severity_count) ??
        (analysis ? finiteNumber(analysis.high_severity_count) : null) ??
        0;
      contract = { issueCount, highCount };
    }
  }

  // Step 2a: saved move-in references (a JSON array in localStorage).
  const refs = readLocalJson(MOVEIN_REFS_KEY);
  const refCount = Array.isArray(refs) ? refs.length : 0;

  // Step 2b: the evidence page saves its walkthrough result, whose
  // evidence hash seals the handover pack.
  let walkthroughSha: string | null = null;
  const evidenceState = loadPageState("evidence");
  if (evidenceState && isRecord(evidenceState.walkResult)) {
    const sha = evidenceState.walkResult.evidence_sha256;
    if (typeof sha === "string" && sha.length > 0) walkthroughSha = sha;
  }

  // Step 3: the move-out page saves its verify result; the ribbon
  // shows the registered IoU when the comparison registered,
  // otherwise the raw IoU. A no-match comparison carries no IoU at
  // all, so the finite check leaves the step empty.
  let moveout: CaseSummary["moveout"] = null;
  const moveoutState = loadPageState("moveout");
  if (
    moveoutState &&
    isRecord(moveoutState.verifyResult) &&
    isRecord(moveoutState.verifyResult.comparison)
  ) {
    const comparison = moveoutState.verifyResult.comparison;
    const registered = comparison.registered === true;
    const registeredIou = finiteNumber(comparison.iou_registered);
    const iou =
      registered && registeredIou !== null
        ? registeredIou
        : finiteNumber(comparison.iou);
    if (iou !== null) moveout = { iou, registered };
  }

  return { contract, refCount, walkthroughSha, moveout };
}
