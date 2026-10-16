/** "482 913", "482-913" → "482913"; anything else non-digit is dropped too. */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/\D+/g, "").slice(0, 6);
}

/** "482913" → "482 913", the way the TV shows it. */
export function formatPairingCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
