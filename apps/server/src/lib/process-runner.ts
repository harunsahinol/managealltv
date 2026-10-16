import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Keep only the end of stderr: ffmpeg prints its real error last, after pages of stream info. */
const STDERR_TAIL_BYTES = 8 * 1024;

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

export interface RunOptions {
  /** Kills the process (SIGKILL) when aborted, e.g. pg-boss job expiry or shutdown. */
  signal?: AbortSignal;
  /** Called for every stdout line instead of buffering stdout (for long listings). */
  onLine?: (line: string) => void;
}

export interface RunResult {
  stdout: string;
  stderrTail: string;
}

/**
 * Runs an executable with an argument vector (never through a shell, so file names cannot inject
 * anything) and resolves when it exits with code 0. stdout is buffered unless `onLine` is given.
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted"));
      return;
    }
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
      killSignal: "SIGKILL",
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    if (options.onLine) {
      const onLine = options.onLine;
      createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", onLine);
    } else {
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_TAIL_BYTES * 2) stderr = stderr.slice(-STDERR_TAIL_BYTES);
    });

    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code, killedBy) => {
      if (settled) return;
      settled = true;
      const stderrTail = stderr.slice(-STDERR_TAIL_BYTES).trim();
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrTail });
        return;
      }
      const reason = killedBy ? `killed by ${killedBy}` : `exit code ${code}`;
      reject(new ProcessError(`${command} failed (${reason})`, code, stderrTail));
    });
  });
}
