import { Check, Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createId } from "../lib/ids";

export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
}

interface ConfirmRequest extends ConfirmOptions {
  id: string;
  resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("Confirmation dialog is not available.");
  }

  return confirm;
}

export function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  function requestConfirmation(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmRequest({
        id: createId("confirm"),
        ...options,
        resolve
      });
    });
  }

  function finishConfirmation(confirmed: boolean) {
    const request = confirmRequest;
    if (!request) {
      return;
    }

    setConfirmRequest(null);
    request.resolve(confirmed);
  }

  return (
    <ConfirmContext.Provider value={requestConfirmation}>
      {children}
      <ConfirmDialog
        request={confirmRequest}
        onCancel={() => finishConfirmation(false)}
        onConfirm={() => finishConfirmation(true)}
      />
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: ConfirmRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) {
      return;
    }

    const timeoutId = window.setTimeout(() => confirmButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel, request]);

  if (!request) {
    return null;
  }

  const titleId = `${request.id}-title`;
  const bodyId = `${request.id}-body`;
  const isDanger = request.variant === "danger";

  return (
    <div className="confirm-overlay" role="presentation">
      <div
        className={`confirm-dialog ${isDanger ? "confirm-dialog-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <div className="confirm-dialog-mark" aria-hidden="true">
          {isDanger ? <Trash2 size={20} /> : <Check size={20} />}
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="app-heading text-lg font-bold">{request.title}</h2>
          {request.message ? (
            <div id={bodyId} className="confirm-dialog-body app-muted mt-2 text-sm">
              {request.message}
            </div>
          ) : null}
        </div>
        <div className="confirm-dialog-actions">
          <button className="app-button app-button-ghost" type="button" onClick={onCancel}>
            {request.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            className={`app-button ${isDanger ? "app-button-danger" : "app-button-primary"}`}
            type="button"
            onClick={onConfirm}
            ref={confirmButtonRef}
          >
            {request.confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
