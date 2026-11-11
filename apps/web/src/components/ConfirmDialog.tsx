import { useEffect, useRef, type ReactNode } from "react";

/** Small modal confirm (role=alertdialog). Esc / backdrop cancel; focus starts on Cancel (the safe choice). */
export function ConfirmDialog({
  open, title, body, confirmLabel, cancelLabel, onConfirm, onCancel, children, confirmDisabled,
}: {
  open: boolean; title: string; body?: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void;
  /** Extra content between the body and the buttons (e.g. D33 warning checkboxes). */
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog card" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dlg-title">{title}</h2>
        {body && <p className="muted">{body}</p>}
        {children}
        <div className="row gap dialog-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn primary" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
