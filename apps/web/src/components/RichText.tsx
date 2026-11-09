import type { AlertView } from "@baitnet/shared";
import { tokenize } from "../lib/tokens";
import { href } from "../lib/router";
import { CHAIN_LABEL } from "../lib/format";
import { useI18n } from "../i18n";

/** Chat text with payment addresses highlighted, URLs defanged and personal data redacted. */
export function RichText({ text, alerts }: { text: string; alerts: AlertView[] }) {
  const { t: tr } = useI18n();
  return (
    <>
      {tokenize(text).map((t, i) => {
        switch (t.kind) {
          case "text":
            return <span key={i}>{t.value}</span>;
          case "address": {
            const hit = alerts.find((a) => a.address.toLowerCase() === t.value.toLowerCase());
            const inner = (
              <>
                <span className="addr-chain">{CHAIN_LABEL[t.chain]}</span>
                <span className="addr-val">{t.value}</span>
              </>
            );
            return hit ? (
              <a key={i} className="addr-hl" href={href("alerts", hit.id)} title={tr("rich.onchainAlert", { id: hit.id })}>
                {inner}
              </a>
            ) : (
              <span key={i} className="addr-hl">
                {inner}
              </span>
            );
          }
          case "url":
            return (
              <span key={i} className="url-hl" title={tr("rich.phishing")}>
                {t.defanged}
              </span>
            );
          case "pii":
            return (
              <span key={i} className="pii" title={tr("rich.piiTitle")}>
                ▇▇▇ {tr(`rich.pii.${t.label}`)}
              </span>
            );
        }
      })}
    </>
  );
}
