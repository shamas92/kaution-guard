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
