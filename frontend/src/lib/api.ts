import { overlayUrlForMaskUrl } from "./samOverlay.ts";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export { API_BASE_URL };

export interface MetaStatus {
  spend_usd: { session: number; cumulative: number };
  limits_usd: { max_session: number; max_cumulative: number };
  offline_lock: boolean;
  disk_cache: boolean;
  // Reported by the backend (`chat_provider` on /api/meta); optional so
  // older or partial meta responses still type-check.
  chat_provider?: string;
  // The backend's own note on what the cost figures are
  // (`ledger_note` on /api/meta); optional for the same reason.
  ledger_note?: string;
  jurisdictions: string[];
  models: { chat_default: string; voice: string; sam31: string };
  review_note: string;
}

// Returned by decode/draft responses when the request used
// GLOBAL_AUTO and the backend identified the lease's jurisdiction
// and language from its own text. Absent on explicitly-coded
// requests and on older backends.
export interface DetectedLocale {
  detected_jurisdiction: string;
  detected_language: string;
  confidence: string;
}

export interface DecodeResponse {
  analysis: Record<string, unknown>;
  truncated_chars: number;
  total_chars: number;
  review_note: string;
  detected_locale?: DetectedLocale;
}

export interface DisputeInput {
  jurisdiction_code: string;
  facts: string;
  desired_outcome: string;
  user_language: string;
  model?: string;
}

export interface DisputeResponse {
  draft: Record<string, unknown>;
  review_note: string;
  detected_locale?: DetectedLocale;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") return body.detail;
    return JSON.stringify(body);
  } catch {
    return response.statusText || `Request failed (${response.status})`;
  }
}

export async function getMeta(): Promise<MetaStatus> {
  const response = await fetch(`${API_BASE_URL}/api/meta`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function decodeContract(
  file: File,
  jurisdictionCode: string,
): Promise<DecodeResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("jurisdiction_code", jurisdictionCode);
  const response = await fetch(`${API_BASE_URL}/api/decode-contract`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function draftDispute(input: DisputeInput): Promise<DisputeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/draft-dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export interface TranscriptSegment {
  start: number;
  end: number | null;
  text: string;
}

export interface WalkthroughRegionMask {
  object_id: string | null;
  box: { left: number; top: number; right: number; bottom: number } | null;
  mask_dims: { width: number; height: number } | null;
  mask_url: string | null;
}

export interface WalkthroughRegion {
  frame: string;
  second: number;
  mask_path: string;
  polygon: number[][] | null;
  usage: Record<string, unknown> | null;
  cached: boolean;
  // The backend merges the full SAM result into each region, so live
  // matches also carry these. They stay optional: mock and no-match
  // regions omit them.
  box?: { left: number; top: number; right: number; bottom: number } | null;
  object_id?: string | null;
  mask_dims?: { width: number; height: number } | null;
  // Actual dimensions of the processed frame file sent to SAM, plus one
  // entry per returned mask (several masks may share a frame). Absent on
  // older or mock rows, whose masks cannot be combined.
  frame_width?: number | null;
  frame_height?: number | null;
  masks?: WalkthroughRegionMask[] | null;
}

export interface WalkthroughDefect {
  timestamp: string;
  sam_confidence: unknown;
  area_percent: unknown;
  description_local: string;
  description_tenant: string;
  image_path: string;
}

export interface WalkthroughResponse {
  pdf_url: string;
  evidence_sha256: string;
  transcript: TranscriptSegment[];
  regions: WalkthroughRegion[];
  defects: WalkthroughDefect[];
  review_note: string;
  // How the defects were found: "voice_and_vision" when narration
  // was transcribed, "silent_vision_auto" when a silent video was
  // scanned frame by frame. Absent on older backends.
  detection_mode?: string;
}

export interface WalkthroughOptions {
  jurisdictionCode: string;
  userLanguage: string;
  textPrompt: string;
  maxFrames: number;
}

export async function processWalkthrough(
  file: File,
  opts: WalkthroughOptions,
): Promise<WalkthroughResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("jurisdiction_code", opts.jurisdictionCode);
  form.append("user_language", opts.userLanguage);
  form.append("text_prompt", opts.textPrompt);
  form.append("max_frames", String(opts.maxFrames));
  const response = await fetch(`${API_BASE_URL}/api/process-walkthrough`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export interface VerifyMask {
  mask_path: string;
  polygon: number[][] | null;
  usage: Record<string, unknown> | null;
  cached: boolean;
}

export interface VerifyComparison {
  match?: boolean;
  note?: string;
  iou: number;
  day1_area_px: number;
  moveout_area_px: number;
  area_growth_ratio: number;
  prior_kind?: string;
  current_kind?: string;
  frame_size?: { width: number; height: number } | null;
  compared_object_id?: string | null;
  // True when the backend resized the move-in mask to the move-out
  // dimensions before comparing. Absent on no-match results.
  dimension_normalized?: boolean | null;
}

export interface VerifyResponse {
  mask: VerifyMask;
  comparison: VerifyComparison;
  review_note: string;
}

export interface SegmentImageBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SegmentImageDiagnostic {
  severity: string;
  code: string;
  message: string;
  line: number | null;
}

export interface SegmentImageMaskEntry {
  object_id: string | null;
  box: SegmentImageBox | null;
  mask_dims: { width: number; height: number } | null;
  mask_encoding: string | null;
  mask_path: string | null;
}

export interface SegmentImagePrompt {
  mode: "concept" | "points";
  text: string;
}

export interface SegmentImagePoint {
  x: number;
  y: number;
  label?: "positive" | "negative";
}

export interface SegmentImageMask {
  match: boolean;
  polygon: number[][] | null;
  box: SegmentImageBox | null;
  object_id: string | null;
  mask_dims: { width: number; height: number } | null;
  mask_encoding: string | null;
  masks: SegmentImageMaskEntry[] | null;
  usage: Record<string, unknown> | null;
  cached: boolean;
  outcome?: string | null;
  diagnostics?: SegmentImageDiagnostic[] | null;
  prompt?: SegmentImagePrompt | null;
}

// One defect the backend discovered on its own in Auto-Detect Mode
// (empty text prompt): a SAM-ready concept prompt plus descriptions
// in the jurisdiction's language and the tenant's language.
export interface AutoDefectCandidate {
  prompt: string;
  description_local: string;
  description_tenant: string;
}

export interface SegmentImageResponse {
  job_id: string;
  mask: SegmentImageMask;
  mask_url: string | null;
  mask_urls: string[] | null;
  image_url: string | null;
  review_note: string;
  // Auto-Detect Mode only: the concept prompt the backend discovered
  // and segmented with, and the candidate descriptions. Null/absent
  // on prompted requests and older backends.
  auto_discovered_prompt?: string | null;
  auto_descriptions?: AutoDefectCandidate[];
  // Served `/files/...` URL of the backend's full-frame overlay PNG,
  // derived client-side from `mask_url` (see overlayUrlForMaskUrl), or
  // null when no mask file was served. The backend's absolute
  // `overlay_path` is intentionally not typed here and never surfaces.
  overlay_url: string | null;
}

export async function segmentImage(
  file: File,
  textPrompt: string,
  points?: SegmentImagePoint[],
): Promise<SegmentImageResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("text_prompt", textPrompt);
  // Point mode is mutually exclusive with the concept prompt: when spots
  // are given, the server builds the documented point grammar and ignores
  // the concept text.
  if (points && points.length > 0) {
    form.append("points", JSON.stringify(points));
  }
  const response = await fetch(`${API_BASE_URL}/api/segment-image`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  const data: Record<string, unknown> = await response.json();
  // The backend also reports an absolute `overlay_path` inside `mask`.
  // It is never served or rendered, so drop it here: only the safe
  // `/files/...` derivation below may reach the UI.
  const mask =
    data.mask !== null && typeof data.mask === "object"
      ? { ...(data.mask as Record<string, unknown>) }
      : data.mask;
  if (mask !== null && typeof mask === "object") {
    delete (mask as Record<string, unknown>).overlay_path;
  }
  // Fresh and cached backend responses carry the same served `mask_url`
  // shape, so both resolve to a usable overlay URL through the same
  // derivation. A server-sent absolute path never passes validation.
  const direct =
    typeof data.overlay_url === "string"
      ? overlayUrlForMaskUrl(data.overlay_url)
      : null;
  return {
    ...(data as unknown as Omit<SegmentImageResponse, "overlay_url">),
    mask: mask as SegmentImageResponse["mask"],
    overlay_url:
      direct ??
      overlayUrlForMaskUrl(
        typeof data.mask_url === "string" ? data.mask_url : null,
      ),
  };
}

export async function verifyMoveout(
  file: File,
  priorPolygon: unknown,
  textPrompt: string,
  priorMaskJson?: string,
): Promise<VerifyResponse> {
  const form = new FormData();
  form.append("file", file);
  // The raster prior and the legacy polygon are mutually exclusive: the
  // backend rejects both together, so the polygon field stays empty when
  // a saved reference is sent.
  form.append(
    "prior_polygon",
    priorMaskJson ? "" : JSON.stringify(priorPolygon),
  );
  if (priorMaskJson) form.append("prior_mask", priorMaskJson);
  form.append("text_prompt", textPrompt);
  const response = await fetch(`${API_BASE_URL}/api/verify-moveout`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}
