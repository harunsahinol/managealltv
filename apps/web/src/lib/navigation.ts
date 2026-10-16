/**
 * Where to go after signing in. Only same-origin paths are accepted so a crafted
 * /login?next=https://evil.example link cannot bounce people off-site.
 */
export function safeNextPath(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/login") || value.startsWith("/invite/")) return "/";
  return value;
}

/** /login?next=… for the current location; plain /login for the home page. */
export function loginPathFor(pathname: string, search: string): string {
  const next = `${pathname}${search}`;
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
