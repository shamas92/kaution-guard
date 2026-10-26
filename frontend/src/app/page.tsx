"use client";

import { useEffect, useState } from "react";
import {
  API_BASE_URL,
  decodeContract,
  draftDispute,
  getMeta,
  processWalkthrough,
  verifyMoveout,
  type DecodeResponse,
  type DisputeResponse,
  type MetaStatus,
  type VerifyResponse,
  type WalkthroughResponse,
} from "../lib/api";

const FALLBACK_JURISDICTIONS = ["GLOBAL_AUTO", "DE", "UK", "US_NY", "FR", "JP"];
const LANGUAGES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "ja", label: "日本語" },
];
const NOT_PROVIDED = "Not provided by backend";

const theme = {
  page: {
    backgroundColor: "#10141a",
    color: "#e9e7e1",
    minHeight: "100vh",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    lineHeight: 1.5,
  } as const,
  wrap: { maxWidth: "880px", margin: "0 auto", padding: "32px 20px 64px" } as const,
  panel: {
    backgroundColor: "#1b222c",
    border: "1px solid #2e3947",
    borderRadius: "10px",
    padding: "20px",
    marginTop: "20px",
  } as const,
  heading: { margin: "0 0 4px", fontSize: "28px" } as const,
  sub: { margin: "0 0 8px", color: "#c6cdd6" } as const,
  sectionTitle: { margin: "0 0 12px", fontSize: "19px" } as const,
  label: { display: "block", fontWeight: 600, margin: "12px 0 4px" } as const,
  control: {
    backgroundColor: "#10141a",
    color: "#e9e7e1",
    border: "1px solid #4a5665",
    borderRadius: "6px",
    padding: "8px 10px",
    width: "100%",
    fontSize: "15px",
  } as const,
  row: { display: "flex", gap: "12px", flexWrap: "wrap" } as const,
  half: { flex: "1 1 220px" } as const,
  button: {
    backgroundColor: "#d9a441",
    color: "#191407",
    border: "none",
    borderRadius: "6px",
    padding: "10px 18px",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    marginTop: "14px",
  } as const,
  buttonDisabled: { opacity: 0.55, cursor: "not-allowed" } as const,
  error: {
    backgroundColor: "#3a1d1d",
    border: "1px solid #8a3b3b",
    borderRadius: "6px",
    padding: "10px 12px",
    marginTop: "12px",
  } as const,
  note: {
    backgroundColor: "#232d1a",
    border: "1px solid #5a7038",
    borderRadius: "6px",
    padding: "10px 12px",
    marginTop: "12px",
    color: "#d7dfc4",
  } as const,
  bar: { backgroundColor: "#0b0e12", borderRadius: "4px", height: "10px" } as const,
  barFill: { backgroundColor: "#d9a441", borderRadius: "4px", height: "10px" } as const,
  mono: {
    fontFamily: "ui-monospace, Consolas, monospace",
    fontSize: "13px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as const,
  issue: {
    borderTop: "1px solid #2e3947",
    padding: "12px 0",
  } as const,
  badge: {
    display: "inline-block",
    border: "1px solid #4a5665",
    borderRadius: "20px",
    padding: "2px 10px",
    fontSize: "13px",
    marginRight: "8px",
  } as const,
  skip: {
    position: "absolute",
    left: "-9999px",
  } as const,
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function ratio(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, used / max));
}

function toFileUrl(fsPath: string): string | null {
  const normalised = fsPath.replace(/\\/g, "/");
  const idx = normalised.toLowerCase().indexOf("/storage/");
  if (idx === -1) return null;
  return `${API_BASE_URL}/files${normalised.slice(idx + "/storage".length)}`;
}

interface DemoPreset {
  preset_id: string;
  jurisdiction_code: string;
  title: string;
  description: string;
  contract_pdf_url: string;
  walkthrough_video_url: string | null;
  walkthrough_video_available: boolean;
  demo_issues: string[];
  review_note: string;
}

const DEMO_CHOICES = [
  { id: "DE", label: "Germany" },
  { id: "UK", label: "United Kingdom" },
  { id: "FR", label: "France" },
];

function animateProgress(setter: (v: number) => void, ms = 1200): Promise<void> {
  return new Promise((resolve) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setter(100);
      resolve();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setter(Math.round(t * 100));
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function overlapVerdict(iou: number, growth: number): string {
  if (!Number.isFinite(iou) || !Number.isFinite(growth)) {
    return "Comparison values unavailable.";
  }
  if (iou >= 0.8 && Math.abs(growth) < 0.2) {
    return "Masks overlap closely — little visible change between the two masks.";
  }
  if (iou < 0.3 || growth > 1) {
    return "Substantial visible change versus the move-in mask.";
  }
  return "Partial overlap — visual review needed.";
}

export default function Home() {
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [jurisdiction, setJurisdiction] = useState("GLOBAL_AUTO");
  const [language, setLanguage] = useState("de");
  const [file, setFile] = useState<File | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decodeResult, setDecodeResult] = useState<DecodeResponse | null>(null);
  const [facts, setFacts] = useState("");
  const [outcome, setOutcome] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<DisputeResponse | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [samPrompt, setSamPrompt] = useState("visible damage or stain");
  const [maxFrames, setMaxFrames] = useState(5);
  const [working, setWorking] = useState(false);
  const [workStatus, setWorkStatus] = useState<string | null>(null);
  const [walkError, setWalkError] = useState<string | null>(null);
  const [walkResult, setWalkResult] = useState<WalkthroughResponse | null>(null);
  const [selectedDefect, setSelectedDefect] = useState(0);
  const [moveoutFile, setMoveoutFile] = useState<File | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoProgress, setDemoProgress] = useState(0);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<DemoPreset | null>(null);

  useEffect(() => {
    getMeta().then(setMeta).catch((e: unknown) => {
      setMetaError(e instanceof Error ? e.message : "Budget status unavailable");
    });
  }, []);

  const jurisdictions =
    meta && meta.jurisdictions.length > 0 ? meta.jurisdictions : FALLBACK_JURISDICTIONS;
  const analysis = asRecord(decodeResult?.analysis);
  const resultObj = asRecord(analysis.result);
  const issues = list(analysis.possible_issues).map((item) => {
    const entry = asRecord(item);
    return {
      clause: text(entry.clause) ?? NOT_PROVIDED,
      explanation: text(entry.why_risky) ?? NOT_PROVIDED,
      severity: text(entry.severity) ?? NOT_PROVIDED,
    };
  });
  const findingStrings = [...list(analysis.findings), ...list(resultObj.findings)]
    .filter((f) => typeof f === "string")
    .map((f) => ({
      clause: "(finding)",
      explanation: f as string,
      severity: NOT_PROVIDED,
    }));
  const allIssues = [...issues, ...findingStrings];

  async function onDecode() {
    if (!file) return;
    setDecoding(true);
    setDecodeError(null);
    try {
      const result = await decodeContract(file, jurisdiction);
      setDecodeResult(result);
    } catch (e: unknown) {
      setDecodeError(e instanceof Error ? e.message : "Contract analysis failed");
    } finally {
      setDecoding(false);
    }
  }

  async function onDraft() {
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await draftDispute({
        jurisdiction_code: jurisdiction,
        facts,
        desired_outcome: outcome,
        user_language: language,
      });
      setDraftResult(result);
    } catch (e: unknown) {
      setDraftError(e instanceof Error ? e.message : "Draft request failed");
    } finally {
      setDrafting(false);
    }
  }

  async function onWalkthrough() {
    if (!video) return;
    setWorking(true);
    setWalkError(null);
    setWalkResult(null);
    setWorkStatus("Uploading video and processing frames, transcript and masks…");
    try {
      const result = await processWalkthrough(video, {
        jurisdictionCode: jurisdiction,
        userLanguage: language,
        textPrompt: samPrompt,
        maxFrames: Number.isFinite(maxFrames) && maxFrames > 0 ? Math.floor(maxFrames) : 5,
      });
      setWalkResult(result);
      setSelectedDefect(0);
      setWorkStatus(null);
    } catch (e: unknown) {
      setWalkError(e instanceof Error ? e.message : "Walkthrough processing failed");
      setWorkStatus(null);
    } finally {
      setWorking(false);
    }
  }

  async function onLoadDemo(presetId: string) {
    setDemoLoading(true);
    setDemoError(null);
    setDemoProgress(0);
    try {
      const fetchPreset = (async (): Promise<DemoPreset> => {
        const response = await fetch(`${API_BASE_URL}/api/load-demo-preset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset_id: presetId }),
        });
        if (!response.ok) {
          let message = `Demo load failed (${response.status})`;
          try {
            const body = await response.json();
            if (typeof body?.detail === "string") message = body.detail;
          } catch {
            /* keep default message */
          }
          throw new Error(message);
        }
        return response.json();
      })();
      const [, preset] = await Promise.all([
        animateProgress(setDemoProgress),
        fetchPreset,
      ]);
      setDemoResult(preset);
      setJurisdiction(preset.jurisdiction_code);
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : "Demo load failed");
    } finally {
      setDemoLoading(false);
    }
  }

  async function onVerify() {
    if (!moveoutFile || !walkResult) return;
    const priorPolygon = walkResult.regions[selectedDefect]?.polygon;
    if (!priorPolygon) {
      setVerifyError("The selected defect has no polygon to compare against.");
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await verifyMoveout(moveoutFile, priorPolygon, samPrompt);
      setVerifyResult(result);
    } catch (e: unknown) {
      setVerifyError(e instanceof Error ? e.message : "Move-out verification failed");
    } finally {
      setVerifying(false);
    }
  }

  const draft = asRecord(draftResult?.draft);
  const session = meta?.spend_usd.session ?? 0;
  const cumulative = meta?.spend_usd.cumulative ?? 0;
  const maxSession = meta?.limits_usd.max_session ?? 0;
  const maxCumulative = meta?.limits_usd.max_cumulative ?? 0;

  return (
    <main style={theme.page}>
      <a href="#results" style={theme.skip}>
        Skip to results
      </a>
      <div style={theme.wrap}>
        <h1 style={theme.heading}>KautionGuard</h1>
        <p style={theme.sub}>
          Tenant document review and apartment evidence workspace. Findings are
          preliminary — have a qualified professional review them.
        </p>

        <section style={theme.panel} aria-labelledby="budget-heading">
          <h2 id="budget-heading" style={theme.sectionTitle}>
            Budget status
          </h2>
          {metaError && (
            <p role="alert" style={theme.error}>
              Budget panel unavailable: {metaError}. Is the backend running on
              port 8000?
            </p>
          )}
          {meta && (
            <div>
              <p style={theme.sub}>
                Session spend ${session.toFixed(2)} of ${maxSession.toFixed(2)}
              </p>
              <div
                style={theme.bar}
                role="progressbar"
                aria-valuenow={Math.round(ratio(session, maxSession) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Session spend"
              >
                <div
                  style={{ ...theme.barFill, width: `${ratio(session, maxSession) * 100}%` }}
                />
              </div>
              <p style={{ ...theme.sub, marginTop: "12px" }}>
                Cumulative spend ${cumulative.toFixed(2)} of $
                {maxCumulative.toFixed(2)}
              </p>
              <div
                style={theme.bar}
                role="progressbar"
                aria-valuenow={Math.round(ratio(cumulative, maxCumulative) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Cumulative spend"
              >
                <div
                  style={{
                    ...theme.barFill,
                    width: `${ratio(cumulative, maxCumulative) * 100}%`,
                  }}
                />
              </div>
              <p style={{ ...theme.sub, marginTop: "12px" }}>
                <span style={theme.badge}>
                  Offline lock: {meta.offline_lock ? "on" : "off"}
                </span>
                <span style={theme.badge}>
                  Disk cache: {meta.disk_cache ? "on" : "off"}
                </span>
              </p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="demo-heading">
          <h2 id="demo-heading" style={theme.sectionTitle}>
            Try a demo
          </h2>
          <p style={theme.sub}>
            Load local synthetic demo assets (fictional leases). Loading a
            demo makes no API calls — analyse or dispute only if you choose to
            below.
          </p>
          <div style={theme.row}>
            {DEMO_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                style={{
                  ...theme.button,
                  ...(demoLoading ? theme.buttonDisabled : {}),
                  marginTop: "6px",
                }}
                disabled={demoLoading}
                onClick={() => onLoadDemo(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          {demoLoading && (
            <div
              style={{ ...theme.bar, marginTop: "12px" }}
              role="progressbar"
              aria-valuenow={demoProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Loading demo"
            >
              <div style={{ ...theme.barFill, width: `${demoProgress}%` }} />
            </div>
          )}
          {demoError && (
            <p role="alert" style={theme.error}>
              {demoError}
            </p>
          )}
          {demoResult && (
            <div aria-live="polite">
              <h3>{demoResult.title}</h3>
              <p style={theme.sub}>{demoResult.description}</p>
              <ul>
                {demoResult.demo_issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
              <p>
                <a
                  href={`${API_BASE_URL}${demoResult.contract_pdf_url}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open sample contract (PDF)
                </a>
              </p>
              {!demoResult.walkthrough_video_available && (
                <p style={theme.sub}>
                  No sample walkthrough video on this host (FFmpeg is not
                  available); video processing stays disabled for the demo.
                </p>
              )}
              <p style={theme.note}>{demoResult.review_note}</p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="contract-heading">
          <h2 id="contract-heading" style={theme.sectionTitle}>
            Contract review
          </h2>
          <div style={theme.row}>
            <div style={theme.half}>
              <label htmlFor="jurisdiction" style={theme.label}>
                Jurisdiction
              </label>
              <select
                id="jurisdiction"
                style={theme.control}
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
              >
                {jurisdictions.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div style={theme.half}>
              <label htmlFor="tenant-language" style={theme.label}>
                Tenant language
              </label>
              <select
                id="tenant-language"
                style={theme.control}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label htmlFor="contract-file" style={theme.label}>
            Rental contract (PDF)
          </label>
          <input
            id="contract-file"
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-describedby="contract-help"
          />
          <p id="contract-help" style={theme.sub}>
            Text is extracted locally in the backend; only the text is sent for
            analysis.
          </p>
          <button
            type="button"
            style={{ ...theme.button, ...(!file || decoding ? theme.buttonDisabled : {}) }}
            disabled={!file || decoding}
            onClick={onDecode}
          >
            {decoding ? "Analysing…" : "Analyse contract"}
          </button>
          {decodeError && (
            <p role="alert" style={theme.error}>
              {decodeError}
            </p>
          )}
        </section>

        <section id="results" style={theme.panel} aria-labelledby="results-heading" aria-live="polite">
          <h2 id="results-heading" style={theme.sectionTitle}>
            Results
          </h2>
          {!decodeResult && <p style={theme.sub}>No analysis yet — upload a contract above.</p>}
          {decodeResult && (
            <div>
              <p style={theme.sub}>
                Risk score: {text(analysis.risk_score) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Estimated savings: {text(analysis.estimated_savings) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Confidence: {text(analysis.confidence) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Summary: {text(analysis.summary) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Deposit terms: {text(analysis.deposit_terms) ?? NOT_PROVIDED}
              </p>
              <p style={theme.sub}>
                Analysed characters: {decodeResult.truncated_chars} of{" "}
                {decodeResult.total_chars}
              </p>
              {allIssues.length === 0 && (
                <p style={theme.sub}>
                  Cited clauses: {NOT_PROVIDED} — the backend returned no
                  clause list for this analysis.
                </p>
              )}
              {allIssues.map((issue, i) => (
                <article key={i} style={theme.issue} aria-label={`Issue ${i + 1}`}>
                  <p>
                    <strong>Clause:</strong> {issue.clause}
                  </p>
                  <p>
                    <strong>Severity:</strong> {issue.severity}
                  </p>
                  <p>
                    <strong>Explanation:</strong> {issue.explanation}
                  </p>
                </article>
              ))}
              <p style={theme.note}>{decodeResult.review_note}</p>
              <details>
                <summary>Full backend response</summary>
                <pre style={theme.mono}>{JSON.stringify(analysis, null, 2)}</pre>
              </details>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="dispute-heading">
          <h2 id="dispute-heading" style={theme.sectionTitle}>
            Bilingual dispute notice
          </h2>
          <label htmlFor="facts" style={theme.label}>
            What happened (facts for the letter)
          </label>
          <textarea
            id="facts"
            style={{ ...theme.control, minHeight: "90px" }}
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
            placeholder="e.g. Deposit of €900 retained without an itemised statement…"
          />
          <label htmlFor="outcome" style={theme.label}>
            Desired outcome (optional)
          </label>
          <input
            id="outcome"
            type="text"
            style={theme.control}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="e.g. Full deposit return within 14 days"
          />
          <button
            type="button"
            style={{ ...theme.button, ...(drafting || !facts.trim() ? theme.buttonDisabled : {}) }}
            disabled={drafting || !facts.trim()}
            onClick={onDraft}
          >
            {drafting ? "Drafting…" : "Request bilingual notice"}
          </button>
          {draftError && (
            <p role="alert" style={theme.error}>
              {draftError}
            </p>
          )}
          {draftResult && (
            <div aria-live="polite">
              <h3>Draft (record language)</h3>
              <p>{text(draft.draft_local) ?? NOT_PROVIDED}</p>
              <h3>Draft (tenant language)</h3>
              <p>{text(draft.draft_tenant) ?? NOT_PROVIDED}</p>
              {text(draft.caveats) && (
                <p style={theme.note}>Caveats: {text(draft.caveats)}</p>
              )}
              <p style={theme.note}>{draftResult.review_note}</p>
              <details>
                <summary>Full backend response</summary>
                <pre style={theme.mono}>{JSON.stringify(draft, null, 2)}</pre>
              </details>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="walkthrough-heading">
          <h2 id="walkthrough-heading" style={theme.sectionTitle}>
            Walkthrough video
          </h2>
          <label htmlFor="walkthrough-file" style={theme.label}>
            Walkthrough video
          </label>
          <input
            id="walkthrough-file"
            type="file"
            accept="video/*"
            onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
          />
          <div style={theme.row}>
            <div style={theme.half}>
              <label htmlFor="sam-prompt" style={theme.label}>
                SAM text prompt
              </label>
              <input
                id="sam-prompt"
                type="text"
                style={theme.control}
                value={samPrompt}
                onChange={(e) => setSamPrompt(e.target.value)}
              />
            </div>
            <div style={theme.half}>
              <label htmlFor="max-frames" style={theme.label}>
                Max frames
              </label>
              <input
                id="max-frames"
                type="number"
                min={1}
                style={theme.control}
                value={maxFrames}
                onChange={(e) => setMaxFrames(Number(e.target.value))}
              />
            </div>
          </div>
          <button
            type="button"
            style={{ ...theme.button, ...(!video || working ? theme.buttonDisabled : {}) }}
            disabled={!video || working}
            onClick={onWalkthrough}
          >
            {working ? "Processing…" : "Process walkthrough"}
          </button>
          {workStatus && (
            <p role="status" style={theme.sub}>
              {workStatus}
            </p>
          )}
          {walkError && (
            <p role="alert" style={theme.error}>
              {walkError}
            </p>
          )}
          {walkResult && (
            <div aria-live="polite">
              <h3>Transcript</h3>
              {walkResult.transcript.length === 0 && (
                <p style={theme.sub}>No transcript segments returned.</p>
              )}
              {walkResult.transcript.map((seg, i) => (
                <p key={i} style={theme.sub}>
                  {seg.start}s – {seg.end ?? "?"}s: {seg.text}
                </p>
              ))}
              <h3>Segmented regions</h3>
              {walkResult.regions.map((region, i) => (
                <article key={i} style={theme.issue} aria-label={`Region ${i + 1}`}>
                  <p>
                    <strong>Frame:</strong> {region.frame} (t={region.second}s)
                  </p>
                  <p style={theme.sub}>
                    SAM prompt: {samPrompt} ·{" "}
                    {region.cached ? "served from cache" : "freshly segmented"} ·{" "}
                    {region.polygon ? `${region.polygon.length} polygon points` : "no polygon"}
                  </p>
                </article>
              ))}
              <h3>Defects</h3>
              {walkResult.defects.map((defect, i) => {
                const maskUrl = toFileUrl(defect.image_path);
                return (
                  <article key={i} style={theme.issue} aria-label={`Defect ${i + 1}`}>
                    <p>
                      <strong>Timestamp:</strong> {defect.timestamp}
                    </p>
                    <p>
                      <strong>Description:</strong> {defect.description_local}
                    </p>
                    <p>
                      <strong>Translation:</strong> {defect.description_tenant}
                    </p>
                    <p style={theme.sub}>
                      SAM confidence: {String(defect.sam_confidence)} · Mask area:{" "}
                      {String(defect.area_percent)} % of frame
                    </p>
                    {maskUrl ? (
                      <img
                        src={maskUrl}
                        alt={`Annotated mask for defect ${i + 1}`}
                        style={{ maxWidth: "100%", borderRadius: "6px" }}
                      />
                    ) : (
                      <p style={theme.sub}>
                        Annotated frame not servable: {defect.image_path}
                      </p>
                    )}
                  </article>
                );
              })}
              <p style={theme.sub}>
                Evidence SHA-256:{" "}
                <span style={theme.mono}>{walkResult.evidence_sha256}</span>
              </p>
              <p>
                <a
                  href={`${API_BASE_URL}${walkResult.pdf_url}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open handover PDF
                </a>
              </p>
              <p style={theme.note}>{walkResult.review_note}</p>
            </div>
          )}
        </section>

        <section style={theme.panel} aria-labelledby="moveout-heading">
          <h2 id="moveout-heading" style={theme.sectionTitle}>
            Move-out verification
          </h2>
          {!walkResult && (
            <p style={theme.sub}>
              Process a walkthrough first, then compare a move-out photo
              against one of its defects.
            </p>
          )}
          {walkResult && (
            <div>
              <label htmlFor="defect-select" style={theme.label}>
                Defect to compare
              </label>
              <select
                id="defect-select"
                style={theme.control}
                value={selectedDefect}
                onChange={(e) => {
                  setSelectedDefect(Number(e.target.value));
                  setVerifyResult(null);
                }}
              >
                {walkResult.defects.map((defect, i) => (
                  <option key={i} value={i}>
                    Defect {i + 1} — {defect.timestamp}
                  </option>
                ))}
              </select>
              <label htmlFor="moveout-file" style={theme.label}>
                Move-out image
              </label>
              <input
                id="moveout-file"
                type="file"
                accept="image/*"
                onChange={(e) => setMoveoutFile(e.target.files?.[0] ?? null)}
              />
              <button
                type="button"
                style={{
                  ...theme.button,
                  ...(!moveoutFile || verifying ? theme.buttonDisabled : {}),
                }}
                disabled={!moveoutFile || verifying}
                onClick={onVerify}
              >
                {verifying ? "Comparing…" : "Verify move-out"}
              </button>
              {verifyError && (
                <p role="alert" style={theme.error}>
                  {verifyError}
                </p>
              )}
              {verifyResult && (
                <div aria-live="polite">
                  <h3>Comparison</h3>
                  <p>
                    IoU: {verifyResult.comparison.iou} · Move-in area:{" "}
                    {verifyResult.comparison.day1_area_px} px · Move-out area:{" "}
                    {verifyResult.comparison.moveout_area_px} px · Area growth:{" "}
                    {verifyResult.comparison.area_growth_ratio}
                  </p>
                  <p style={theme.note}>
                    {overlapVerdict(
                      verifyResult.comparison.iou,
                      verifyResult.comparison.area_growth_ratio,
                    )}{" "}
                    This describes mask overlap only — have a qualified
                    professional review it before use.
                  </p>
                  <p style={theme.note}>{verifyResult.review_note}</p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
