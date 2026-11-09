import { useState, type ReactNode } from "react";
import type { AlertStatus, Chain, Level, VerdictKind } from "@baitnet/shared";
import { CHAIN_LABEL, short } from "../lib/format";
import { useI18n } from "../i18n";

export function Badge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

export const VERDICT_TONE: Record<VerdictKind, string> = { block: "danger", warn: "warn", allow: "ok" };
export function VerdictBadge({ kind }: { kind: VerdictKind }) {
  const { t } = useI18n();
  return (
    <Badge tone={VERDICT_TONE[kind]}>
      <Dot />
      {t(`verdict.${kind}`)}
    </Badge>
  );
}
export function LevelBadge({ level }: { level: Level }) {
  const { t } = useI18n();
  return (
    <Badge tone={level === "L1" ? "danger" : level === "L2" ? "warn" : "muted"} title={t(`level.help.${level}`)}>
      {level}
    </Badge>
  );
}
export function StatusBadge({ status }: { status: AlertStatus }) {
  const { t } = useI18n();
  return <Badge tone={status === "Active" ? "danger-soft" : status === "Disputed" ? "warn" : "muted"}>{t(`alertStatus.${status}`)}</Badge>;
}
export const ChainTag = ({ chain }: { chain: Chain }) => <span className={`chain chain-${chain}`}>{CHAIN_LABEL[chain] ?? chain}</span>;

export const Dot = () => <span className="dot" aria-hidden />;

export function Mono({ value, head = 8, tail = 6, full = false }: { value: string; head?: number; tail?: number; full?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };
  return (
    <span className="mono-wrap">
      <code className={full ? "mono break" : "mono"} title={value}>
        {full ? value : short(value, head, tail)}
      </code>
      <button type="button" className="icon-btn" onClick={copy} aria-label={t("common.copy")} title={t("common.copy")}>
        {copied ? "✓" : <CopyIcon />}
      </button>
    </span>
  );
}

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
    <rect x="5" y="5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export function PageHead({ step, title, lead, children }: { step: string; title: string; lead: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{step}</div>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
      </div>
      {children && <div className="page-head-aside">{children}</div>}
    </header>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Segmented<T extends string>({
  value, options, onChange, label,
}: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
