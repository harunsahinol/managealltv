/**
 * Background jobs on pg-boss (queue tables live in the "pgboss" schema of the same database, next to
 * Prisma's "public" schema; Prisma migrations never touch it).
 *
 * Usage (e.g. the media processing module):
 *
 *   registerJob<{ mediaId: string }>({
 *     name: JOB_NAMES.mediaProcess,
 *     handler: async ({ mediaId }) => processMedia(mediaId),
 *     queue: { retryLimit: 1, expireInSeconds: 2 * 60 * 60 },
 *   });
 *   await sendJob(JOB_NAMES.mediaProcess, { mediaId });
 *
 * registerJob() may be called before or after startJobs(); index.ts starts the queue once at boot.
 * Each registered queue runs at most `concurrency` jobs at a time in this process (default 1, which
 * is what "Processing (one job at a time)" in docs/API.md needs).
 */
import { type Job, PgBoss, type Queue, type SendOptions } from "pg-boss";
import { env } from "./env";
import { logger } from "./logger";

export const JOB_NAMES = {
  /** Converts an uploaded original into the delivered file + thumbnail (media module). */
  mediaProcess: "media.process",
} as const;

export const PGBOSS_SCHEMA = "pgboss";

export interface JobDefinition<T extends object> {
  /** Queue name: letters, digits, "_", "-", "." or "/". */
  name: string;
  /** Throwing fails the attempt; pg-boss retries it according to `queue.retryLimit`. */
  handler: (data: T, job: Job<T>) => Promise<void>;
  /** Queue settings (retries, expiry, retention); applied when the queue is first created. */
  queue?: Omit<Queue, "name">;
  /** Parallel jobs of this queue inside this process. Default 1. */
  concurrency?: number;
  /** How often an idle worker polls for new jobs. Default 2 s. */
  pollingIntervalSeconds?: number;
}

interface Registration {
  name: string;
  start: (boss: PgBoss) => Promise<void>;
}

const registrations = new Map<string, Registration>();
let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

async function startWorker<T extends object>(instance: PgBoss, definition: JobDefinition<T>): Promise<void> {
  await instance.createQueue(definition.name, definition.queue ?? {});
  await instance.work<T>(
    definition.name,
    {
      batchSize: 1,
      localConcurrency: definition.concurrency ?? 1,
      pollingIntervalSeconds: definition.pollingIntervalSeconds ?? 2,
    },
    async (jobs) => {
      for (const job of jobs) {
        const startedAt = Date.now();
        try {
          await definition.handler(job.data, job);
          logger.info("Job completed", { queue: definition.name, jobId: job.id, ms: Date.now() - startedAt });
        } catch (error) {
          logger.error("Job failed", { queue: definition.name, jobId: job.id, retryCount: job.retryCount, error });
          throw error;
        }
      }
    },
  );
}

/** Registers a queue + worker. Re-registering a name replaces the handler for the next start. */
export function registerJob<T extends object>(definition: JobDefinition<T>): void {
  const registration: Registration = { name: definition.name, start: (instance) => startWorker(instance, definition) };
  registrations.set(definition.name, registration);
  // Registered after boot: start the worker right away.
  if (boss !== null) {
    registration.start(boss).catch((error: unknown) => logger.error("Could not start job worker", { queue: definition.name, error }));
  }
}

/** Starts pg-boss (installs/migrates its schema on first run) and every registered worker. */
export async function startJobs(): Promise<PgBoss> {
  if (boss !== null) return boss;
  if (starting !== null) return starting;
  starting = (async () => {
    const instance = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: PGBOSS_SCHEMA,
      application_name: "managealltv-jobs",
      max: 4,
    });
    instance.on("error", (error) => logger.error("pg-boss error", { error }));
    instance.on("warning", (warning) => logger.warn("pg-boss warning", { warning }));
    await instance.start();
    for (const registration of registrations.values()) await registration.start(instance);
    boss = instance;
    logger.info("Job queue started", { queues: [...registrations.keys()] });
    return instance;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** Waits up to `timeoutMs` for running jobs, then closes the pool. */
export async function stopJobs(timeoutMs = 10_000): Promise<void> {
  const instance = boss;
  boss = null;
  if (instance === null) return;
  await instance.stop({ graceful: true, timeout: timeoutMs });
  logger.info("Job queue stopped");
}

/** Queues a job; returns its id (null when a singleton/throttle option suppressed it). */
export async function sendJob<T extends object>(name: string, data: T, options: SendOptions = {}): Promise<string | null> {
  if (boss === null) throw new Error(`Job queue is not running; cannot send ${name}`);
  return boss.send(name, data, options);
}

/** The running pg-boss instance, or null before startJobs()/after stopJobs(). */
export function jobQueue(): PgBoss | null {
  return boss;
}
