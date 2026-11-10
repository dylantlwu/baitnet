import { useEffect, useState } from "react";
import { API, type AttestationResult } from "@baitnet/shared";
import type { ViewSnapshot } from "../data/parse";
import { Badge, Empty, Mono, PageHead } from "../components/ui";
import { fmtTime } from "../lib/format";
import { useI18n } from "../i18n";
import { translateTeeCheck } from "../i18n/vocab";

const defaultFetch: typeof fetch = (...x) => fetch(...x);

export async function loadAttestation(apiBase: string, fetchFn: typeof fetch = defaultFetch): Promise<AttestationResult | undefined> {
  const r = await fetchFn(apiBase + API.attestation, { credentials: "include", headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as AttestationResult;
  return j && Array.isArray(j.checks) ? j : undefined;
}

/** Fetch the attestation directly when the snapshot doesn't carry one yet (the server builds it lazily). */
export function useAttestation(fromSnapshot: AttestationResult | undefined, apiBase: string | null, fetchFn: typeof fetch = defaultFetch) {
  const [fetched, setFetched] = useState<AttestationResult | undefined>();
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => {
    if (fromSnapshot || apiBase === null) return;
    let alive = true;
    setState("loading");
    loadAttestation(apiBase, fetchFn)
      .then((j) => {
        if (!alive) return;
        setFetched(j);
        setState(j ? "idle" : "failed");
      })
      .catch(() => alive && setState("failed"));
    return () => {
      alive = false;
    };
  }, [fromSnapshot, apiBase, fetchFn]);
  return { attestation: fromSnapshot ?? fetched, loading: !fromSnapshot && state === "loading" };
}

export function TeePage({ snap, apiBase }: { snap: ViewSnapshot; apiBase: string | null }) {
  const { t } = useI18n();
  const { attestation: a, loading } = useAttestation(snap.attestation, apiBase);
  return (
    <>
      <PageHead
        step={t("tee.step")}
        title={t("tee.title")}
        lead={t("tee.lead")}
      />
      {!a ? (
        loading ? (
          <div className="loading">
            <span className="spinner" /> {t("tee.loading")}
          </div>
        ) : (
          <Empty>{t("tee.empty")}</Empty>
        )
      ) : (
        <AttestationPanel a={a} />
      )}
    </>
  );
}

/**
 * Zero-retention result: the TEE proof as one line ("TEE verified ✓ (23/23 checks passed)"); the full
 * verdict and every check (names in plain words) open on click.
 */
export function AttestationFold({ a }: { a: AttestationResult }) {
  const { t } = useI18n();
  const passed = a.checks.filter((c) => c.pass).length;
  return (
    <details className={`card tee-fold ${a.verified ? "ok" : "bad"}`}>
      <summary>
        <strong>{t(a.verified ? "tee.foldOk" : "tee.foldBad", { a: passed, b: a.checks.length })}</strong>
        <span className="muted small"> {t("tee.foldMore")}</span>
      </summary>
      <AttestationPanel a={a} />
    </details>
  );
}

/** Verdict + item-by-item checks for one attestation. Reused by the zero-retention upload result (D27). */
export function AttestationPanel({ a }: { a: AttestationResult }) {
  const { t, lang } = useI18n();
  const passed = a.checks.filter((c) => c.pass).length;
  return (
    <div className="tee-grid">
      <section className={`card verdict-card ${a.verified ? "ok" : "bad"}`} aria-label={t("tee.verdict")}>
        <div className="seal" aria-hidden>
          {a.verified ? "✓" : "✗"}
        </div>
        <div>
          <div className="verdict-title">{a.verified ? t("tee.verified") : t("tee.failed")}</div>
          <div className="muted small">
            {t("tee.passed", { a: passed, b: a.checks.length })} · {fmtTime(a.at)}
          </div>
          {a.recorded && (
            <Badge tone="warn" title={t("tee.recordedHint")}>
              {t("tee.recorded")}
            </Badge>
          )}
        </div>
        <dl className="kv">
          <dt>{t("tee.model")}</dt>
          <dd>
            <code className="mono break">{a.model}</code>
          </dd>
          <dt>{t("tee.nonce")}</dt>
          <dd>
            <Mono value={a.nonce} head={12} tail={8} />
          </dd>
          {a.signingAddress && (
            <>
              <dt>{t("tee.signingKey")}</dt>
              <dd>
                <Mono value={a.signingAddress} head={10} tail={6} />
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="card" aria-label={t("tee.checks")}>
        <h2>{t("tee.checks")}</h2>
        <ul className="checks">
          {a.checks.map((c, i) => (
            <li key={i} className={c.pass ? "pass" : "fail"}>
              <span className="check-icon" aria-label={c.pass ? t("tee.pass") : t("tee.fail")}>
                {c.pass ? "✓" : "✗"}
              </span>
              <div>
                <strong title={c.name}>{translateTeeCheck(c.name, lang)}</strong>
                <div className="muted small">{c.detail}</div>
              </div>
              <span className="check-res">{c.pass ? t("tee.pass") : t("tee.fail")}</span>
            </li>
          ))}
        </ul>
        <p className="note">
          {t("tee.limitation")}
        </p>
      </section>
    </div>
  );
}
