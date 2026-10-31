/**
 * One-time demo sample handoff between the Start page and a workflow
 * page.
 *
 * A `File`/`Blob` cannot be stored in web storage, so the Start page
 * stores only an *intent*: the backend asset path of the sample the
 * user picked. The destination page reads (and consumes) the intent on
 * mount, fetches the asset from the backend and reconstructs the
 * `File` itself. sessionStorage keeps the intent tab-scoped and
 * short-lived; it is never a record of anything.
 */

export const DEMO_HANDOFF_STORAGE_KEY = "kautionguard.handoff.v1";

/** Intents older than this are treated as abandoned and rejected. */
const MAX_INTENT_AGE_MS = 10 * 60 * 1000;

export type DemoHandoffKind = "contract" | "video";

export interface DemoHandoff {
  version: 1;
  kind: DemoHandoffKind;
  presetId: string;
  assetUrl: string;
  fileName: string;
  createdAt: number;
  /** Optional preset display data, carried so the destination page can
   * describe the sample before any analysis runs. Absent when the
   * stored intent predates these fields or they were malformed. */
  presetTitle?: string;
  presetDescription?: string;
  demoIssues?: string[];
}

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    return null;
  }
  return null;
}

/** Store a one-time intent. Returns false when storage is unavailable. */
export function writeDemoHandoff(handoff: DemoHandoff): boolean {
  const store = sessionStore();
  if (!store) return false;
  try {
    store.setItem(DEMO_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and consume the intent for `kind`. The stored key is removed
 * before any fetch begins, so an intent can never be consumed twice.
 * Returns null for missing, malformed, mismatched or stale intents.
 */
export function takeDemoHandoff(kind: DemoHandoffKind): DemoHandoff | null {
  const store = sessionStore();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(DEMO_HANDOFF_STORAGE_KEY);
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
  if (typeof parsed !== "object" || parsed === null) return null;
  const intent = parsed as Record<string, unknown>;
  if (intent.version !== 1 || intent.kind !== kind) return null;
  if (
    typeof intent.presetId !== "string" ||
    typeof intent.assetUrl !== "string" ||
    typeof intent.fileName !== "string" ||
    intent.fileName === "" ||
    typeof intent.createdAt !== "number" ||
    !Number.isFinite(intent.createdAt)
  ) {
    return null;
  }
  // Only site-relative backend paths may be fetched — never an absolute
  // or protocol-relative URL planted in storage.
  if (!intent.assetUrl.startsWith("/") || intent.assetUrl.startsWith("//")) {
    return null;
  }
  if (Date.now() - intent.createdAt > MAX_INTENT_AGE_MS) return null;
  try {
    store.removeItem(DEMO_HANDOFF_STORAGE_KEY);
  } catch {
    /* the intent was validated; a failed removal must not lose it */
  }
  const handoff: DemoHandoff = {
    version: 1,
    kind,
    presetId: intent.presetId,
    assetUrl: intent.assetUrl,
    fileName: intent.fileName,
    createdAt: intent.createdAt,
  };
  // Optional preset display fields pass through only when well-typed;
  // anything else is dropped rather than failing the whole intent.
  if (typeof intent.presetTitle === "string") {
    handoff.presetTitle = intent.presetTitle;
  }
  if (typeof intent.presetDescription === "string") {
    handoff.presetDescription = intent.presetDescription;
  }
  if (
    Array.isArray(intent.demoIssues) &&
    intent.demoIssues.every((issue) => typeof issue === "string")
  ) {
    handoff.demoIssues = intent.demoIssues;
  }
  return handoff;
}
