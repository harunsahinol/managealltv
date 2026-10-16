import type { LucideIcon } from "lucide-react";
import { cx } from "./cx";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Hide the text and keep it as the accessible name. */
  iconOnly?: boolean;
}

/** Small exclusive toggle (grid/list, media type filter). Uses radio semantics for screen readers. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-control border border-line-strong bg-surface p-0.5">
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.iconOnly ? option.label : undefined}
            title={option.iconOnly ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-sm font-medium transition-colors",
              active ? "bg-accent-soft text-accent" : "text-ink-2 hover:text-ink",
            )}
          >
            {Icon && <Icon size={14} aria-hidden />}
            {!option.iconOnly && option.label}
          </button>
        );
      })}
    </div>
  );
}
