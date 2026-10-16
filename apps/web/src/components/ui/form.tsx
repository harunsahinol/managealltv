import { type ComponentProps, type InputHTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "./cx";

export interface FieldProps {
  label: ReactNode;
  /** Render prop receives the generated ids so the control can wire aria attributes. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  className?: string;
  optional?: boolean;
}

/** Label + control + hint/error, with the ids and aria-describedby wired up. */
export function Field({ label, children, hint, error, className, optional = false }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = error !== undefined && error !== null && error !== "";
  const describedBy = [hint !== undefined ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {optional && <span className="ml-1 font-normal text-ink-3">(isteğe bağlı)</span>}
      </label>
      {children({ id, describedBy, invalid })}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-ink-3">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} className="text-xs font-medium text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cx("control h-9", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <select className={cx("control h-9 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cx("control min-h-20", className)} {...rest} />;
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, ...rest }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cx("flex items-start gap-2.5", className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-(--accent)" {...rest} />
      <label htmlFor={id} className="text-base leading-5">
        {label}
        {description !== undefined && <span className="mt-0.5 block text-sm text-ink-3">{description}</span>}
      </label>
    </div>
  );
}

/** Inline error under a form (request failures, as opposed to field validation). */
export function FormError({ message }: { message: string | null | undefined }) {
  if (message === null || message === undefined || message === "") return null;
  return (
    <p role="alert" className="rounded-control border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
      {message}
    </p>
  );
}
