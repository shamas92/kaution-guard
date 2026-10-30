"use client";

import { useEffect, useRef, useState } from "react";
import {
  API_BASE_URL,
  decodeContract,
  draftDispute,
  type DecodeResponse,
  type DisputeResponse,
} from "../../lib/api";
import { takeDemoHandoff } from "../../lib/handoff";
import {
  NOT_PROVIDED,
  asRecord,
  list,
  num,
  text,
} from "../../lib/uiHelpers";
import { useKautionGuard } from "../KautionGuardProvider";

/**
 * Step 1 — check a contract for unfair clauses, then turn a finding
 * into a letter to the landlord. A sample lease handed over from the
 * Start page is reconstructed here on mount; checking never starts
 * on its own.
 */
export default function ContractPage() {
  const { jurisdiction, language } = useKautionGuard();
  const [file, setFile] = useState<File | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decodeResult, setDecodeResult] = useState<DecodeResponse | null>(null);
  const [facts, setFacts] = useState("");
  const [outcome, setOutcome] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<DisputeResponse | null>(null);
  const [demoPdfLoading, setDemoPdfLoading] = useState(false);
  const [demoPdfError, setDemoPdfError] = useState<string | null>(null);
  const contractFileRef = useRef<HTMLInputElement | null>(null);
  const [copiedPane, setCopiedPane] = useState<"local" | "tenant" | null>(null);

  // One-time sample handoff from the Start page: reconstruct the File
  // the user picked there. The intent is consumed before the fetch, so
  // a refresh never reloads it.
  const handoffStarted = useRef(false);
  useEffect(() => {
    if (handoffStarted.current) return;
    handoffStarted.current = true;
    const intent = takeDemoHandoff("contract");
    if (!intent) return;
    let cancelled = false;
    setDemoPdfLoading(true);
    setDemoPdfError(null);
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}${intent.assetUrl}`);
        if (!response.ok) {
          throw new Error(`Sample contract fetch failed (${response.status})`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        const next = new File([blob], intent.fileName, {
          type: blob.type || "application/pdf",
        });
        setFile(next);
        const input = contractFileRef.current;
        if (input) {
          const transfer = new DataTransfer();
          transfer.items.add(next);
          input.files = transfer.files;
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setDemoPdfError(
            e instanceof Error ? e.message : "Sample contract load failed",
          );
        }
      } finally {
        if (!cancelled) setDemoPdfLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const analysis = asRecord(decodeResult?.analysis);
  const resultObj = asRecord(analysis.result);
  const verification = asRecord(analysis.verification);
  const issues = list(analysis.possible_issues).map((item) => {
    const entry = asRecord(item);
    return {
      clause: text(entry.clause) ?? NOT_PROVIDED,
      explanation: text(entry.why_risky) ?? NOT_PROVIDED,
      severity: text(entry.severity) ?? NOT_PROVIDED,
      citation: text(entry.citation) ?? NOT_PROVIDED,
      flaggedAmount: num(entry.flagged_amount),
      verified: entry.verified_quote === true,
      evidenceQuote: text(entry.evidence_quote),
      verificationNote: text(entry.verification_note),
    };
  });
  const findingStrings = [...list(analysis.findings), ...list(resultObj.findings)]
    .filter((f) => typeof f === "string")
    .map((f) => ({
      clause: "(finding)",
      explanation: f as string,
      severity: NOT_PROVIDED,
      citation: NOT_PROVIDED,
      flaggedAmount: null as number | null,
      verified: false,
      evidenceQuote: null as string | null,
      verificationNote: "Not checked against the lease text.",
    }));
  const issueCount = num(analysis.issue_count);
  const highSeverityCount = num(analysis.high_severity_count);
  const totalFlaggedAmount = num(analysis.total_flagged_amount);
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

  function onLoadIntoDrafter(issue: (typeof allIssues)[number]) {
    const lines = [`Clause: ${issue.clause}`];
    if (issue.evidenceQuote) {
      lines.push(`Verbatim quote: "${issue.evidenceQuote}"`);
    }
    lines.push(`Why risky: ${issue.explanation}`);
    if (issue.citation !== NOT_PROVIDED) {
      lines.push(`Citation: ${issue.citation}`);
    }
    if (issue.flaggedAmount !== null) {
      lines.push(`Flagged amount: ${issue.flaggedAmount}`);
    }
    lines.push(
      issue.verified
        ? "Evidence status: Verified verbatim excerpt from the uploaded lease."
        : `Evidence status: ${issue.verificationNote ?? "Not verified against the lease text."}`,
    );
    const block = lines.join("\n");
    setFacts((prev) =>
      prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${block}` : block,
    );
    document.getElementById("facts")?.focus();
  }

  async function onCopyDraft(pane: "local" | "tenant", value: string | null) {
    // Never copy the fallback placeholder: it is not draft text.
    if (!value || value === NOT_PROVIDED) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedPane(pane);
    } catch {
      setCopiedPane(null);
    }
  }

  const draft = asRecord(draftResult?.draft);
  const draftLocal = text(draft.draft_local);
  const draftTenant = text(draft.draft_tenant);

  return (
    <>
      <a href="#results" className="kg-skip">
        Skip to results
      </a>
      <div className="kg-tab1-grid">
        <section
          className={`kg-panel kg-t1-contract${decoding ? " kg-panel--checking" : ""}`}
          aria-labelledby="contract-heading"
        >
          <p className="kg-overline" aria-hidden="true">01 · Check your contract</p>
          <h2 id="contract-heading" className="kg-section-title">
            Check your contract for unfair clauses
          </h2>
          <div
            className={`kg-dropzone${file ? " kg-dropzone--has-file" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              setFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <label htmlFor="contract-file" className="kg-label">
              Rental contract (PDF)
            </label>
            <input
              id="contract-file"
              ref={contractFileRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              aria-describedby="contract-help"
            />
            <p id="contract-help" className="kg-sub">
              Text is extracted locally in the backend; only the text is sent for
              analysis.
            </p>
            {demoPdfLoading && (
              <p className="kg-sub">Loading sample contract…</p>
            )}
            {file && (
              <p className="kg-dropzone-filename">
                {file.name}{" "}
                <span className="kg-dropzone-size">
                  ({(file.size / 1024).toFixed(1)} KB)
                </span>
              </p>
            )}
          </div>
          {demoPdfError && (
            <p role="alert" className="kg-alert kg-alert--error">
              {demoPdfError}
            </p>
          )}
          <button
            type="button"
            className="kg-btn kg-btn--primary kg-btn--block"
            disabled={!file || decoding}
            onClick={onDecode}
          >
            {decoding ? "Analysing…" : "Decode Contract"}
          </button>
          {decodeError && (
            <p role="alert" className="kg-alert kg-alert--error">
              {decodeError}
            </p>
          )}
        </section>

        <section
          id="results"
          className="kg-panel kg-t1-results"
          aria-labelledby="results-heading"
          aria-live="polite"
        >
          <p className="kg-overline" aria-hidden="true">01 · What we found</p>
          <h2 id="results-heading" className="kg-section-title">
            What we found
          </h2>
          {!decodeResult && (
            <p className="kg-empty">
              <span className="kg-empty-icon" aria-hidden="true">📜</span>
              Your results will appear here after you check a contract.
            </p>
          )}
          {decodeResult && (
            <div>
              <p className="kg-sub">
                Summary: {text(analysis.summary) ?? NOT_PROVIDED}
              </p>
              <p className="kg-sub">
                Deposit terms: {text(analysis.deposit_terms) ?? NOT_PROVIDED}
              </p>
              <div className="kg-summary-strip">
                <span className="kg-summary-item">
                  <strong>Overall risk</strong>{" "}
                  {text(analysis.risk_score) ?? NOT_PROVIDED}
                </span>
                <span className="kg-summary-item">
                  <strong>Estimated savings</strong>{" "}
                  {text(analysis.estimated_savings) ?? NOT_PROVIDED}
                </span>
                <span className="kg-summary-item">
                  <strong>Problems found</strong> {issueCount ?? NOT_PROVIDED}
                  {" — serious: "}
                  {highSeverityCount ?? NOT_PROVIDED}
                  {" — money involved: "}
                  {totalFlaggedAmount ?? NOT_PROVIDED}
                </span>
              </div>
              {typeof verification.verified_quotes === "number" &&
                typeof verification.checked_issues === "number" &&
                verification.checked_issues > 0 && (
                  <p className="kg-sub">
                    Quotes checked word-for-word against your contract:{" "}
                    {verification.verified_quotes} of{" "}
                    {verification.checked_issues}.
                  </p>
                )}
              {allIssues.length === 0 && (
                <p className="kg-sub">
                  No problem clauses were found in this check.
                </p>
              )}
              {allIssues.map((issue, i) => (
                <article
                  key={i}
                  className={`kg-issue kg-finding-card${issue.severity.toLowerCase().includes("high") ? " kg-finding-card--high" : issue.severity.toLowerCase().includes("medium") ? " kg-finding-card--medium" : issue.severity.toLowerCase().includes("low") ? " kg-finding-card--low" : ""}`}
                  aria-label={`Issue ${i + 1}`}
                >
                  <p>
                    <strong>Part of your contract:</strong> {issue.clause}
                  </p>
                  <p>
                    <strong>How serious:</strong> {issue.severity}
                  </p>
                  <p>
                    <strong>Explanation:</strong> {issue.explanation}
                  </p>
                  <p>
                    <strong>Law it may break:</strong> {issue.citation}
                  </p>
                  {issue.flaggedAmount !== null && (
                    <p>
                      <strong>Money involved:</strong> {issue.flaggedAmount}
                    </p>
                  )}
                  {issue.evidenceQuote ? (
                    issue.verified ? (
                      <blockquote className="kg-finding-quote">
                        {issue.evidenceQuote}
                        <footer className="kg-sub">
                          Verified verbatim excerpt from the uploaded lease.
                        </footer>
                      </blockquote>
                    ) : (
                      <p role="alert" className="kg-alert kg-alert--error">
                        Unverified excerpt — could not be matched to the
                        uploaded lease text
                        {issue.verificationNote
                          ? ` (${issue.verificationNote})`
                          : ""}
                        . Treat it as model output, not document evidence:{" "}
                        {issue.evidenceQuote}
                      </p>
                    )
                  ) : (
                    issue.verificationNote && (
                      <p className="kg-sub">
                        Evidence status: {issue.verificationNote}
                      </p>
                    )
                  )}
                  <div className="kg-finding-actions">
                    <button
                      type="button"
                      className="kg-btn kg-btn--sm"
                      onClick={() => onLoadIntoDrafter(issue)}
                    >
                      Load into Dispute Drafter
                    </button>
                  </div>
                </article>
              ))}
              <p className="kg-note">{decodeResult.review_note}</p>
              <details className="kg-tech-details">
                <summary>Technical details</summary>
                <p className="kg-sub">
                  Analysed characters: {decodeResult.truncated_chars} of{" "}
                  {decodeResult.total_chars}
                </p>
                <p className="kg-sub">
                  How sure the checker is:{" "}
                  {text(analysis.confidence) ?? NOT_PROVIDED}
                </p>
              </details>
            </div>
          )}
        </section>

        <section className="kg-panel kg-t1-dispute" aria-labelledby="dispute-heading">
          <p className="kg-overline" aria-hidden="true">01 · Letter to your landlord</p>
          <h2 id="dispute-heading" className="kg-section-title">
            A letter to your landlord, in two languages
          </h2>
          <label htmlFor="facts" className="kg-label">
            What happened (facts for the letter)
          </label>
          <textarea
            id="facts"
            className="kg-control kg-control--tall"
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
            placeholder="e.g. Deposit of €900 retained without an itemised statement…"
          />
          <label htmlFor="outcome" className="kg-label">
            Desired outcome (optional)
          </label>
          <input
            id="outcome"
            type="text"
            className="kg-control"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="e.g. Full deposit return within 14 days"
          />
          <button
            type="button"
            className="kg-btn kg-btn--primary"
            disabled={drafting || !facts.trim()}
            onClick={onDraft}
          >
            {drafting ? "Writing…" : "Write my letter"}
          </button>
          {draftError && (
            <p role="alert" className="kg-alert kg-alert--error">
              {draftError}
            </p>
          )}
          {draftResult && (
            <div aria-live="polite">
              <div className="kg-doc-grid">
                <div className="kg-doc-pane">
                  <div className="kg-doc-pane-header">
                    <h3 className="kg-doc-pane-title">
                      Letter in your landlord&apos;s language
                    </h3>
                    <button
                      type="button"
                      className="kg-btn kg-btn--sm kg-btn--ghost"
                      onClick={() => onCopyDraft("local", draftLocal)}
                      disabled={!draftLocal}
                    >
                      {copiedPane === "local" ? "Copied" : "Copy to Clipboard"}
                    </button>
                  </div>
                  <div className="kg-doc-body">{draftLocal ?? NOT_PROVIDED}</div>
                </div>
                <div className="kg-doc-pane">
                  <div className="kg-doc-pane-header">
                    <h3 className="kg-doc-pane-title">Letter in your language</h3>
                    <button
                      type="button"
                      className="kg-btn kg-btn--sm kg-btn--ghost"
                      onClick={() => onCopyDraft("tenant", draftTenant)}
                      disabled={!draftTenant}
                    >
                      {copiedPane === "tenant" ? "Copied" : "Copy to Clipboard"}
                    </button>
                  </div>
                  <div className="kg-doc-body">{draftTenant ?? NOT_PROVIDED}</div>
                </div>
              </div>
              {text(draft.caveats) && (
                <p className="kg-note">Caveats: {text(draft.caveats)}</p>
              )}
              <p className="kg-note">{draftResult.review_note}</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
