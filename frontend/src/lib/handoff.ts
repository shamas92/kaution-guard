/**
 * One-time demo sample handoff between the Start page and a workflow
 * page.
 *
 * A `File`/`Blob` cannot be stored in web storage, so the Start page
 * stores only an *intent*: the backend asset path of the sample the
 * user picked. The destination page reads the intent on mount,
 * fetches the asset from the backend, reconstructs the `File` itself,
 * and acknowledges the intent once the file is set. sessionStorage
 * keeps the intent tab-scoped and short-lived; it is never a record
 * of anything.
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

/**
 * Fired on `window` after a handoff intent has been stored, so a
 * destination page that is ALREADY mounted (e.g. the user clicks a
 * demo preset while sitting on /contract) can consume the new intent
 * immediately instead of waiting for a remount.
 */
export const DEMO_HANDOFF_EVENT = "kautionguard:demo-handoff";

/** Announce a freshly stored handoff intent to any mounted page. */
export function notifyDemoHandoff(): void {
  try {
    window.dispatchEvent(new Event(DEMO_HANDOFF_EVENT));
  } catch {
    /* non-browser environment — the mount-time consume still applies */
  }
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
 * Read the intent for `kind` WITHOUT consuming it. Returns null for
 * missing, mismatched or stale intents; unusable entries (malformed,
 * invalid, or stale for this kind) are removed so they cannot wedge
 * later handoffs, while a valid intent for the OTHER kind is left
 * untouched.
 *
 * Consumption is a separate step (see clearDemoHandoff): the caller
 * acknowledges the intent only after it has successfully used it.
 * Removing the intent up front — the previous design — lost samples
 * whenever a page transition unmounted the consuming page mid-fetch
 * (e.g. the shell navigates while a twin instance of the destination
 * page is still mounted during the transition): that instance took
 * the intent, its cleanup cancelled the fetch, and the destination
 * found nothing. With peek + acknowledge, the cancelled instance
 * leaves the intent stored and the surviving instance completes it.
 */
export function peekDemoHandoff(kind: DemoHandoffKind): DemoHandoff | null {
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
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    try {
      store.removeItem(DEMO_HANDOFF_STORAGE_KEY);
    } catch {
      /* storage hygiene only */
    }
    return null;
  }
  const intent = parsed as Record<string, unknown>;
  if (intent.version !== 1 || intent.kind !== kind) return null;
  const removeAndNull = (): null => {
    try {
      store.removeItem(DEMO_HANDOFF_STORAGE_KEY);
    } catch {
      /* storage hygiene only */
    }
    return null;
  };
  if (
    typeof intent.presetId !== "string" ||
    typeof intent.assetUrl !== "string" ||
    typeof intent.fileName !== "string" ||
    intent.fileName === "" ||
    typeof intent.createdAt !== "number" ||
    !Number.isFinite(intent.createdAt)
  ) {
    return removeAndNull();
  }
  // Only site-relative backend paths may be fetched — never an absolute
  // or protocol-relative URL planted in storage.
  if (!intent.assetUrl.startsWith("/") || intent.assetUrl.startsWith("//")) {
    return removeAndNull();
  }
  if (Date.now() - intent.createdAt > MAX_INTENT_AGE_MS) {
    return removeAndNull();
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

/**
 * In-memory delivery slot for the reconstructed sample `File` itself.
 *
 * sessionStorage can only carry the intent, and delivering via the
 * intent alone races with page transitions: whichever page instance
 * fetches first applies the file to its own state, and if a route
 * transition then replaces that instance, the file dies with it while
 * the intent is already acknowledged. Module state survives every
 * in-app navigation, so the shell (and any instance that fetched via
 * the intent) stashes the `File` here; a mounting destination page
 * applies it from the slot regardless of which instance fetched it.
 * The stored intent remains the fallback for a full page reload,
 * where the slot is empty and only one instance ever mounts.
 */
export interface DemoFileDelivery {
  handoff: DemoHandoff;
  file: File;
}

let pendingDelivery: DemoFileDelivery | null = null;

/** Stash a reconstructed sample file for the destination page. */
export function stashDemoFile(handoff: DemoHandoff, file: File): void {
  pendingDelivery = { handoff, file };
}

/** The stashed delivery for `kind`, or null when absent or stale. */
export function peekDemoFile(kind: DemoHandoffKind): DemoFileDelivery | null {
  if (!pendingDelivery || pendingDelivery.handoff.kind !== kind) {
    return null;
  }
  if (
    Date.now() - pendingDelivery.handoff.createdAt > MAX_INTENT_AGE_MS
  ) {
    pendingDelivery = null;
    return null;
  }
  return pendingDelivery;
}

/** Drop the stashed delivery (applied, or explicitly discarded). */
export function clearDemoFile(): void {
  pendingDelivery = null;
}

/**
 * Remove the stored intent. With a `createdAt`, the entry is removed
 * only if it is still that intent — a newer intent stored in the
 * meantime is never cleared by a slower consumer. Without one, the
 * entry is removed unconditionally (the user discarded the sample).
 *
 * Applying a delivery deliberately does NOT clear the intent or the
 * in-memory slot: route transitions can replace the applying page
 * instance after it applied, and the replacement must be able to
 * apply the same delivery again. Single-use is enforced per instance
 * by the pages' createdAt guards; entries age out via
 * MAX_INTENT_AGE_MS and are overwritten by the next preset click.
 */
export function clearDemoHandoff(createdAt?: number): void {
  const store = sessionStore();
  if (!store) return;
  try {
    if (createdAt === undefined) {
      store.removeItem(DEMO_HANDOFF_STORAGE_KEY);
      return;
    }
    const raw = store.getItem(DEMO_HANDOFF_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).createdAt === createdAt
    ) {
      store.removeItem(DEMO_HANDOFF_STORAGE_KEY);
    }
  } catch {
    /* a failed clear only risks a duplicate delivery */
  }
}
