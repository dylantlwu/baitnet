import type { ReactNode } from "react";
import type { ChannelKind } from "@baitnet/shared";
import { useI18n } from "../i18n";

const PATHS: Record<ChannelKind, ReactNode> = {
  web: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  telegram: <path d="M21 4.5 2.8 11.6c-.9.4-.9 1.6.1 1.9l4.6 1.4 1.7 5.4c.2.7 1.1.9 1.6.4l2.6-2.4 4.7 3.5c.6.5 1.5.1 1.7-.6L22.3 5.8c.2-.9-.6-1.6-1.3-1.3ZM9.4 14.6l8.6-6.9-6.8 8.1-.3 3-1.5-4.2Z" fill="currentColor" />,
  lark: <path d="M4 6.5c3.6.2 7 1.9 9.4 4.6l2.2-1.5c1.9-1.3 4.2-1.6 6.4-.9-1.4.6-2.6 1.6-3.4 2.9l-2.3 3.8c-1.3 2.1-3.8 3.1-6.2 2.5L3 16.3c2.2-.4 4-1.8 5-3.7C7.6 10.3 6.1 8.1 4 6.5Z" fill="currentColor" />,
};

export function ChannelIcon({ kind, withLabel = false }: { kind: ChannelKind; withLabel?: boolean }) {
  const { t } = useI18n();
  return (
    <span className={`channel ch-${kind}`} title={t(`channel.${kind}`)}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        {PATHS[kind]}
      </svg>
      {withLabel ? <span>{t(`channel.${kind}`)}</span> : <span className="sr-only">{t(`channel.${kind}`)}</span>}
    </span>
  );
}
