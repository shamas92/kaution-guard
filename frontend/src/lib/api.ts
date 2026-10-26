const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export { API_BASE_URL };

export interface MetaStatus {
  spend_usd: { session: number; cumulative: number };
  limits_usd: { max_session: number; max_cumulative: number };
  offline_lock: boolean;
  disk_cache: boolean;
  jurisdictions: string[];
  models: { chat_default: string; voice: string; sam31: string };
  review_note: string;
}

export interface DecodeResponse {
  analysis: Record<string, unknown>;
  truncated_chars: number;
  total_chars: number;
  review_note: string;
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

export interface WalkthroughRegion {
  frame: string;
  second: number;
  mask_path: string;
  polygon: number[][] | null;
  usage: Record<string, unknown> | null;
  cached: boolean;
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
  iou: number;
  day1_area_px: number;
  moveout_area_px: number;
  area_growth_ratio: number;
}

export interface VerifyResponse {
  mask: VerifyMask;
  comparison: VerifyComparison;
  review_note: string;
}

export async function verifyMoveout(
  file: File,
  priorPolygon: unknown,
  textPrompt: string,
): Promise<VerifyResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("prior_polygon", JSON.stringify(priorPolygon));
  form.append("text_prompt", textPrompt);
  const response = await fetch(`${API_BASE_URL}/api/verify-moveout`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}
