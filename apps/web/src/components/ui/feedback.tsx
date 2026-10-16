import type { LucideIcon } from "lucide-react";
import { CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "../../lib/api/errors";
import { Button } from "./button";
import { cx } from "./cx";

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cx("animate-spin text-ink-3", className)} aria-hidden />;
}

export function LoadingState({ label = "Yükleniyor…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cx("flex items-center justify-center gap-2 py-16 text-sm text-ink-3", className)}>
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx("panel flex flex-col items-center gap-3 px-6 py-12 text-center", className)}>
      <TriangleAlert size={24} className="text-bad" aria-hidden />
      <p className="max-w-md text-base text-ink">{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Tekrar dene
        </Button>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cx("panel flex flex-col items-center gap-2 px-6 py-14 text-center", className)}>
      <div className="mb-1 grid size-11 place-items-center rounded-full bg-surface-3 text-ink-2">
        <Icon size={20} aria-hidden />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children !== undefined && <div className="max-w-md text-base text-ink-2">{children}</div>}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}

export type Tone = "neutral" | "info" | "ok" | "warn" | "bad";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-2",
  info: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const ALERT_TONES: Record<Exclude<Tone, "neutral">, { box: string; icon: LucideIcon }> = {
  info: { box: "border-accent/25 bg-accent-soft text-ink", icon: Info },
  ok: { box: "border-ok/25 bg-ok-soft text-ink", icon: CircleCheck },
  warn: { box: "border-warn/30 bg-warn-soft text-ink", icon: TriangleAlert },
  bad: { box: "border-bad/30 bg-bad-soft text-ink", icon: TriangleAlert },
};

const ALERT_ICON_COLORS: Record<Exclude<Tone, "neutral">, string> = {
  info: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = ALERT_TONES[tone];
  return (
    <div className={cx("flex gap-3 rounded-panel border px-4 py-3", box, className)}>
      <Icon size={18} className={cx("mt-0.5 shrink-0", ALERT_ICON_COLORS[tone])} aria-hidden />
      <div className="min-w-0 flex-1 text-base">
        {title !== undefined && <p className="font-semibold">{title}</p>}
        {children !== undefined && <div className={cx("text-ink-2", title !== undefined && "mt-0.5")}>{children}</div>}
      </div>
      {action !== undefined && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Thin determinate bar; `value` is 0..1. */
export function ProgressBar({ value, label, tone = "info" }: { value: number; label: string; tone?: "info" | "ok" | "bad" }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const fill = tone === "ok" ? "bg-ok" : tone === "bad" ? "bg-bad" : "bg-accent";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div className={cx("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * A background refresh failed but earlier data is still on screen (polling pages): say so instead of
 * replacing the page with an error.
 */
export function StaleDataNotice({ error, show, className }: { error: unknown; show: boolean; className?: string }) {
  if (!show) return null;
  return (
    <Alert tone="warn" title="Güncel bilgiler alınamadı" className={className}>
      {errorMessage(error)} Gösterilen bilgiler eski olabilir; sayfa kendini yenilemeyi sürdürüyor.
    </Alert>
  );
}
