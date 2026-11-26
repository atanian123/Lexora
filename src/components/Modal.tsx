import { X } from "lucide-react";
import { type DialogHTMLAttributes, type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export function useModalDialog(onDismiss: () => void, dismissDisabled = false) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    return () => dialog.close();
  }, []);

  const events: DialogHTMLAttributes<HTMLDialogElement> = {
    closedby: dismissDisabled ? "none" : "closerequest",
    onKeyDown(event) {
      if (dismissDisabled && event.key === "Escape") event.preventDefault();
    },
    onCancel(event) {
      event.preventDefault();
      if (!dismissDisabled) onDismiss();
    },
    onClose(event) {
      const dialog = event.currentTarget;
      if (dialog.open || !dialog.isConnected) return;
      // A repeated platform close request can be uncancelable in some browsers.
      if (dismissDisabled) dialog.showModal();
      else onDismiss();
    }
  };

  return { ref, ...events };
}

export function Modal({ title, children, onClose, wide = false, closeDisabled = false }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const dialog = useModalDialog(onClose, closeDisabled);
  const titleId = useId();

  return (
    <dialog
      {...dialog}
      className={`app-task-dialog ${wide ? "app-task-dialog-wide" : ""}`}
      aria-labelledby={titleId}
    >
      <header className="app-task-dialog-header">
        <h2 id={titleId} className="app-heading min-w-0 text-lg font-bold">{title}</h2>
        <button className="app-button app-button-secondary app-icon-button" type="button" aria-label={t("common.close")} onClick={onClose} disabled={closeDisabled}>
          <X size={18} />
        </button>
      </header>
      <div className="p-4">{children}</div>
    </dialog>
  );
}
