import type { ReactNode } from "react";
import { errorMessage } from "../../lib/api/errors";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { FormError } from "./form";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  pending?: boolean;
  /** Failure of the confirmed action, shown inside the dialog (e.g. 409 media_in_use). */
  error?: unknown;
}

/** Confirmation for disruptive or destructive actions; the button names the action, never "Tamam". */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  tone = "danger",
  pending = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissible={!pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} pending={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base text-ink-2">
        {children}
        {error !== undefined && error !== null && <FormError message={errorMessage(error)} />}
      </div>
    </Dialog>
  );
}
