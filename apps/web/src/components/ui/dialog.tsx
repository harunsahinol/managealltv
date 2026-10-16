import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { cx } from "./cx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Blocks Esc / backdrop / close button, e.g. while a request runs. */
  dismissible?: boolean;
}

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-5xl" } as const;

/**
 * Modal built on the native <dialog>: showModal() gives focus trapping, Esc and an inert page for
 * free. Content renders only while open so forms start fresh each time.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", dismissible = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (open && !element.open) {
      element.showModal();
      // showModal() focuses the first focusable element, which is the header's close button. Start in
      // the first form field instead; React's autoFocus already ran while the dialog was still closed.
      const field = element.querySelector<HTMLElement>(
        "[data-dialog-body] input:not([type=hidden]):not([disabled]):not([readonly]), [data-dialog-body] select:not([disabled]), [data-dialog-body] textarea:not([disabled])",
      );
      field?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description !== undefined ? descriptionId : undefined}
      onCancel={(event) => {
        // React state stays the source of truth: Esc asks the owner to close instead of closing itself.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current && dismissible) onClose();
      }}
      className={cx(
        "m-auto w-[calc(100%-2rem)] rounded-panel border border-line bg-surface p-0 text-ink shadow-pop",
        "max-h-[calc(100dvh-2rem)]",
        SIZES[size],
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description !== undefined && (
                <div id={descriptionId} className="mt-1 text-sm text-ink-2">
                  {description}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={!dismissible}
              aria-label="Kapat"
              className="-m-1 rounded-control p-1 text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-40"
            >
              <X size={18} aria-hidden />
            </button>
          </header>
          <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {children}
          </div>
          {footer !== undefined && (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
