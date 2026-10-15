import { env } from "./env";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[env.LOG_LEVEL]) return;
  const line: Record<string, unknown> = { time: new Date().toISOString(), level, msg: message };
  if (meta) {
    for (const [key, value] of Object.entries(meta)) line[key] = serializeError(value);
  }
  const text = JSON.stringify(line, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  if (level === "error" || level === "warn") process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

/** Minimal structured (JSON lines) logger; LOG_LEVEL controls verbosity. */
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
