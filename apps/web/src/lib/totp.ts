/** The base32 secret inside an otpauth:// URI, for people who type it into the app instead of scanning. */
export function totpSecretFromUri(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get("secret");
    return secret !== null && secret !== "" ? secret : null;
  } catch {
    return null;
  }
}

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP" so it can be read out and typed without losing place. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** A 6-digit authenticator code, tolerating spaces people paste in. */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}
