import { useState } from "react";

/** A small UI preference (grid/list) remembered per browser; storage failures fall back to the default. */
export function useLocalPreference<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Private mode or storage disabled: the choice just is not remembered.
    }
  };
  return [value, update] as const;
}
