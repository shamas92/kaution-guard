import Link from "next/link";
import {
  LandingDemo,
  LandingFeedback,
  LandingFinalCta,
  LandingHero,
  LandingStickyBar,
} from "./landing-client";

const LP_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "KautionGuard",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Web browser",
  description:
    "Rental contract checker and deposit-evidence workspace for tenants.",
};

/**
 * The Pattern device (V6): the sample lease's repair clause, echoed at
 * fading strengths. Echoes are decoration only — the marked instance
 * below is the real line, and it is never inside the aria-hidden
 * wrappers. The clause is quoted verbatim from the sample lease,
 * the same sentence the contract checker flags.
 */
function ClauseEcho({ className }: { className: string }) {
  return (
    <p className={`kg-pat-line ${className}`}>
      „Der Mieter traegt die Kosten kleiner Instandhaltungen bis zu{" "}
      <span className="kg-pat-amt">150 EUR</span> je Einzelfall.“
    </p>
  );
}

function ClauseMarked() {
  return (
    <p className="kg-pat-line kg-pat-marked">
      „Der Mieter traegt die Kosten kleiner Instandhaltungen bis zu{" "}
      <span className="kg-pat-amt">150 EUR</span> je Einzelfall.“
    </p>
  );
}

/**
 * Start page (landing): the value proposition, one worked proof, how
 * it works, what the app does on its own, and the fastest way in — a
 * made-up sample lease. The workflows themselves live on their own
 * pages; the sample buttons in the demo hand the chosen file to the
 * right page (see lib/handoff) instead of loading it here.
 *
 * This file is a server component: it renders the static sections and
 * the structured data. Everything interactive (hero + A/B variant,
 * demo panel, feedback widget, sticky mobile bar) lives in the
 * landing-client.tsx island, so interactive re-renders stay confined
 * to that island.
 */
export default function StartPage() {
  return (
    <div className="kg-lp">
      <p className="kg-lp-bar">
        New — autonomous checks: your lease&apos;s country &amp; language,
        defects in a photo, and silent videos are all detected
        automatically. <a href="#how">See how it works ↓</a>
      </p>

      <LandingHero />

      <section aria-labelledby="proof-heading">
        <h2 id="proof-heading" className="kg-section-title">
          A real clause, checked the way yours will be
        </h2>
        <div className="kg-pat-field">
          <div className="kg-pat-head">
            <div className="kg-pat-lines">
              <div aria-hidden="true">
                <ClauseEcho className="kg-pat-line--f5" />
                <ClauseEcho className="kg-pat-line--f3 kg-pat-line--o1" />
                <ClauseEcho className="kg-pat-line--f1" />
              </div>
              <ClauseMarked />
              <div aria-hidden="true">
                <ClauseEcho className="kg-pat-line--f2 kg-pat-line--o2" />
                <ClauseEcho className="kg-pat-line--f4" />
              </div>
            </div>
            <aside className="kg-pat-note kg-pat-note--end">
            <span className="kg-pat-note-stamp">This one was checked</span>
            <h3 className="kg-pat-note-title">
              Same sentence. This time, somebody read it.
            </h3>
            <p>
              <span className="kg-pat-ok">✓ Quote check</span> — matched
              word for word against the sample lease.
            </p>
            <p>
              <b>Law check</b> — potential issue: repair clauses are only
              effective with two limits (BGH VIII ZR 91/88, in the
              app&apos;s law registry): roughly €75–100 per case and a
              yearly ceiling. This clause sets €150 per case and no
              yearly ceiling.
            </p>
            <p>
              <b>Deposit check · § 551 BGB</b> — sample lease:{" "}
              <b>€650</b> monthly cold rent, <b>€1,950</b> deposit. That
              is exactly three months&apos; cold rent — the most § 551
              allows — so in this example the deposit itself is not the
              problem.
            </p>
            <p>Example — not a real result.</p>
            </aside>
          </div>
        </div>
        <p className="kg-sub">
          <Link href="/contract">
            Check your contract — break the pattern in yours →
          </Link>
        </p>
      </section>

      <section id="how" aria-labelledby="how-heading">
        <h2 id="how-heading" className="kg-section-title">
          Three steps, start to finish
        </h2>
        <div className="kg-page-cards">
          <Link href="/contract" className="kg-page-card">
            <span className="kg-page-card-step">1 · Check your contract</span>
            <span className="kg-page-card-text">
              Upload your lease and see the unfair clauses — each one shown
              with the exact words from your contract, then turned into a
              letter to your landlord.
            </span>
          </Link>
          <Link href="/evidence" className="kg-page-card">
            <span className="kg-page-card-step">2 · Photograph the damage</span>
            <span className="kg-page-card-text">
              Highlight damage in a photo or a walkthrough video, and keep a
              sealed record of what your home looked like on move-in day.
            </span>
          </Link>
          <Link href="/move-out" className="kg-page-card">
            <span className="kg-page-card-step">3 · Compare when you move out</span>
            <span className="kg-page-card-text">
              Compare a photo from today with the move-in record and see what
              changed. Today&apos;s photo is outlined by a live check; the
              overlap is then calculated by the app.
            </span>
          </Link>
        </div>
      </section>

      <section id="features" aria-labelledby="features-heading">
        <h2 id="features-heading" className="kg-section-title">
          What KautionGuard does on its own
        </h2>
        <div className="kg-lp-grid">
          <article className="kg-lp-feature">
            <h3>Finds your law automatically</h3>
            <p>
              Leave the place on &lsquo;Detect automatically&rsquo;: the
              app reads your lease&apos;s language and country and checks
              it against that law.
            </p>
          </article>
          <article className="kg-lp-feature">
            <h3>Finds damage without a prompt</h3>
            <p>
              Send a photo with no description and the app discovers the
              defect itself, then outlines it with SAM 3.1.
            </p>
          </article>
          <article className="kg-lp-feature">
            <h3>Works with silent videos</h3>
            <p>
              No narration on your walkthrough? The app scans the frames
              on its own and marks what it finds.
            </p>
          </article>
          <article className="kg-lp-feature">
            <h3>Never invents a quote</h3>
            <p>
              Every clause it flags is checked word for word against your
              lease, and every law against its registry, before you see
              it.
            </p>
          </article>
          <article className="kg-lp-feature">
            <h3>Seals the record</h3>
            <p>
              Your handover report is sealed with a SHA-256 hash; change
              anything and the seal stops matching.
            </p>
          </article>
          <article className="kg-lp-feature">
            <h3>Caps what a check can cost</h3>
            <p>
              Costs are tracked in the app&apos;s own ledger and
              hard-capped: $5.00 per visit, $135.00 in total.
            </p>
          </article>
        </div>
      </section>

      <LandingDemo />

      <section aria-labelledby="cost-heading">
        <h2 id="cost-heading" className="kg-section-title">
          What it takes, what it costs, where it stops
        </h2>
        <div className="kg-lp-cols">
          <div>
            <h3>What you need</h3>
            <p>
              A lease PDF — or use a demo lease below. Apartment photos
              for the evidence steps.
            </p>
          </div>
          <div>
            <h3>What it costs</h3>
            <p>
              Trying the demos costs $0.00. Live checks are capped by
              the app: $5.00 per visit, $135.00 in total.
            </p>
          </div>
          <div>
            <h3>The limits</h3>
            <p>
              Information, not legal advice. Nothing is sent to your
              landlord — the app only drafts text for you to review.
            </p>
          </div>
        </div>
      </section>

      <section id="faq" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="kg-section-title">
          Questions, answered straight
        </h2>
        <details className="kg-lp-faq-item">
          <summary>Is this legal advice?</summary>
          <p>
            No. KautionGuard gives you information and drafts for you to
            review; its findings are preliminary. For a dispute that
            matters, have a qualified professional review everything —
            every result in the app says the same.
          </p>
        </details>
        <details className="kg-lp-faq-item">
          <summary>What does it cost?</summary>
          <p>
            Trying the demos is free. Live checks are metered by the app
            and hard-capped at $5.00 per visit and $135.00 in total; the
            header meter shows the app&apos;s own ledger, which is not
            your provider account balance.
          </p>
        </details>
        <details className="kg-lp-faq-item">
          <summary>What happens to my lease and photos?</summary>
          <p>
            Files go to the app&apos;s backend, which stores them so
            results can be shown to you. Contract text is extracted on
            the backend and only the text is sent to the checking
            service; photos are sent to Meta&apos;s SAM 3.1 service to
            be outlined. The app does not control how long providers
            keep what they receive.
          </p>
        </details>
        <details className="kg-lp-faq-item">
          <summary>Which places does it cover?</summary>
          <p>
            Germany, the UK, New York, France and Japan — or &lsquo;Detect
            automatically&rsquo; and the app works it out from your
            lease.
          </p>
        </details>
        <details className="kg-lp-faq-item">
          <summary>My walkthrough video has no sound. Does it still work?</summary>
          <p>
            Yes. Silent videos are scanned frame by frame and the
            defects found are marked &lsquo;Silent Video Vision
            Auto-Scan&rsquo;.
          </p>
        </details>
      </section>

      <section className="kg-lp-final" aria-labelledby="final-heading">
        <h2 id="final-heading" className="kg-section-title">
          Your deposit is worth ten minutes.
        </h2>
        <div className="kg-lp-cta-row">
          <LandingFinalCta />
          <a href="#demo" className="kg-btn kg-btn--ghost kg-btn--lg">
            or run the demo first ↓
          </a>
        </div>
      </section>

      <LandingFeedback />

      <LandingStickyBar />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(LP_JSON_LD) }}
      />
    </div>
  );
}
