import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, Invite, Role, User } from "@baitnet/shared";
import { useAuth } from "../auth/context";
import { loginUrlFor } from "../auth/api";
import { ChannelIcon } from "../components/Channel";
import { QrCode } from "../components/QrCode";
import { Badge, Empty, PageHead } from "../components/ui";
import { useI18n } from "../i18n";
import { fmtTime } from "../lib/format";
import { href } from "../lib/router";

export function TeamPage() {
  const { t } = useI18n();
  const { state, admin } = useAuth();
  const head = <PageHead step={t("team.step")} title={t("team.title")} lead={t("team.lead")} />;
  if (!state) return <>{head}<div className="loading"><span className="spinner" /> {t("common.loading")}</div></>;
  if (state.kind === "disabled") return <>{head}<Empty>{t("team.authOff")}</Empty></>;
  if (state.kind === "anonymous")
    return (
      <>
        {head}
        <Empty>
          {t("team.needLogin")} <a href={href("login")}>{t("auth.login")}</a>
        </Empty>
      </>
    );
  if (state.me.role !== "reviewer" || !admin) return <>{head}<Empty>{t("team.reviewerOnly")}</Empty></>;
  return (
    <>
      {head}
      <TeamAdmin />
    </>
  );
}

function useList<T>(load: (() => Promise<T[]>) | undefined) {
  const [data, setData] = useState<T[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!load) return;
    load().then(
      (d) => {
        setData(d);
        setErr(null);
      },
      (e: Error) => setErr(e.message),
    );
  }, [load]);
  useEffect(reload, [reload]);
  return { data, err, reload };
}

function TeamAdmin() {
  const { t, tl } = useI18n();
  const { admin } = useAuth();
  const users = useList<User>(admin ? admin.listUsers : undefined);
  const invites = useList<Invite>(admin ? admin.listInvites : undefined);
  const audit = useList<AuditEntry>(admin ? admin.listAudit : undefined);
  const refreshAll = () => {
    users.reload();
    invites.reload();
    audit.reload();
  };
  return (
    <div className="team-grid">
      <CreateInvite onCreated={refreshAll} />
      <section className="card" aria-label={t("team.members")}>
        <h2>{t("team.members")}</h2>
        {users.err && <p className="err small">{t("team.membersUnavailable", { msg: users.err })}</p>}
        {!users.data && !users.err ? (
          <div className="loading small"><span className="spinner" /> {t("common.loading")}</div>
        ) : users.data?.length === 0 ? (
          <p className="muted small">{t("team.noMembers")}</p>
        ) : (
          <ul className="member-list">
            {users.data?.map((u) => (
              <li key={u.id}>
                <span className="avatar sm">{u.name.slice(0, 1)}</span>
                <div className="grow">
                  <strong>{u.name}</strong> <Badge tone={u.role === "reviewer" ? "info" : "muted"}>{t(`role.${u.role}`)}</Badge>
                  <div className="row gap-s bindings">
                    {u.bindings.length === 0 ? (
                      <span className="muted small">{t("team.noBinding")}</span>
                    ) : (
                      u.bindings.map((b) => (
                        <span key={b.kind + b.externalId} className="binding">
                          <ChannelIcon kind={b.kind} withLabel />
                          {b.username && <span className="muted small">@{b.username}</span>}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <InviteList invites={invites.data} err={invites.err} onChange={refreshAll} />
      <section className="card" aria-label={t("team.audit")}>
        <h2>{t("team.audit")}</h2>
        {audit.err && <p className="err small">{t("common.loadFailed", { msg: audit.err })}</p>}
        {audit.data?.length === 0 && <p className="muted small">{t("team.noAudit")}</p>}
        <ol className="audit-list">
          {audit.data?.slice(0, 100).map((a, i) => (
            <li key={i}>
              <time className="muted small">{fmtTime(a.at)}</time>
              <span>
                <b>{users.data?.find((u) => u.id === a.expertId)?.name ?? a.expertId}</b> · {tl("audit", a.action)}
                {a.target && <span className="muted"> · {a.target}</span>}
                {a.detail && <span className="muted"> · {a.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function CreateInvite({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const { admin } = useAuth();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("expert");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<Invite | null>(null);
  const submit = async () => {
    if (!admin || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setCreated(await admin.createInvite(name.trim(), role));
      setName("");
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card invite-card" aria-label={t("team.newInvite")}>
      <h2>{t("team.newInvite")}</h2>
      <form
        className="invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t("team.name")}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("team.namePlaceholder")} />
        </label>
        <label className="field">
          <span>{t("team.role")}</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="expert">{t("role.expert")}</option>
            <option value="reviewer">{t("role.reviewer")}</option>
          </select>
        </label>
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
          {busy ? t("common.working") : t("team.generate")}
        </button>
      </form>
      {err && <p className="err small">{t("common.actionFailed", { msg: err })}</p>}
      {created && <InviteResult inv={created} />}
    </section>
  );
}

export function InviteResult({ inv }: { inv: Invite }) {
  const { t } = useI18n();
  const web = loginUrlFor(inv, typeof location !== "undefined" ? location.origin : "");
  return (
    <div className="invite-result">
      <p className="small">
        {t("team.createdFor", { name: inv.name, role: t(`role.${inv.role}`) })} <code className="mono code-once">{inv.code}</code>
      </p>
      <p className="warn-text small">{t("team.codeOnce")}</p>
      <div className="qr-grid">
        {inv.telegramStartUrl ? (
          <LinkQr title={t("team.qrTelegram")} hint={t("team.qrTelegramHint")} url={inv.telegramStartUrl} kind="telegram" />
        ) : (
          <div className="qr-box missing">
            <strong>{t("team.qrTelegram")}</strong>
            <p className="muted small">{t("team.noBot")}</p>
          </div>
        )}
        <LinkQr title={t("team.qrWeb")} hint={t("team.qrWebHint")} url={web} kind="web" />
      </div>
    </div>
  );
}

function LinkQr({ title, hint, url, kind }: { title: string; hint: string; url: string; kind: "telegram" | "web" }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="qr-box">
      <div className="row gap">
        <ChannelIcon kind={kind} />
        <strong>{title}</strong>
      </div>
      <QrCode text={url} label={title} />
      <code className="mono break small qr-url">{url}</code>
      <p className="muted small">{hint}</p>
      <div className="row gap">
        <button type="button" className="btn small" onClick={copy}>
          {copied ? `✓ ${t("team.copied")}` : t("team.copy")}
        </button>
        {canShare && (
          <button type="button" className="btn small" onClick={() => void navigator.share({ title, url }).catch(() => undefined)}>
            {t("team.share")}
          </button>
        )}
      </div>
    </div>
  );
}

function InviteList({ invites, err, onChange }: { invites: Invite[] | null; err: string | null; onChange: () => void }) {
  const { t } = useI18n();
  const { admin } = useAuth();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const revoke = async (code: string) => {
    setMsg(null);
    try {
      await admin?.revokeInvite(code);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setConfirm(null);
    }
  };
  return (
    <section className="card" aria-label={t("team.invites")}>
      <h2>{t("team.invites")}</h2>
      {(err || msg) && <p className="err small">{t("common.actionFailed", { msg: err ?? msg ?? "" })}</p>}
      {invites?.length === 0 && <p className="muted small">{t("team.noInvites")}</p>}
      <ul className="invite-list">
        {invites?.map((inv) => {
          const status = inv.revoked ? "revoked" : inv.usedAt ? "used" : "open";
          return (
            <li key={inv.code}>
              <div className="grow">
                <strong>{inv.name}</strong> <Badge tone="muted">{t(`role.${inv.role}`)}</Badge>
                <div className="muted small">
                  <code className="mono">{inv.code}</code> · {fmtTime(inv.createdAt)}
                </div>
              </div>
              <Badge tone={status === "open" ? "info" : status === "used" ? "ok" : "muted"}>{t(`invite.${status}`)}</Badge>
              {status === "open" &&
                (confirm === inv.code ? (
                  <span className="row gap">
                    <button type="button" className="btn small danger" onClick={() => void revoke(inv.code)}>
                      {t("team.revokeYes")}
                    </button>
                    <button type="button" className="btn small" onClick={() => setConfirm(null)}>
                      {t("common.cancel")}
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn small" onClick={() => setConfirm(inv.code)}>
                    {t("team.revoke")}
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
