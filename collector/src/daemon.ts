import type { BrowserContext } from "playwright-core";
import type { CollectorConfig } from "./config.js";
import { collectClaimedJob } from "./collect.js";
import type {
  CollectionOutcome,
  CollectorJob,
  CollectorProgress,
  CollectorReview,
  FailureCode,
  InterruptionReason,
} from "./types.js";

export interface CollectorApiClient {
  claim(): Promise<CollectorJob | null>;
  heartbeat(jobId: string, progress: CollectorProgress): Promise<unknown>;
  uploadReviews(jobId: string, reviews: CollectorReview[]): Promise<number>;
  interrupt(jobId: string, reason: InterruptionReason): Promise<unknown>;
  complete(jobId: string): Promise<unknown>;
  fail(jobId: string, code: FailureCode): Promise<unknown>;
}

type CollectFunction = (
  context: BrowserContext,
  job: CollectorJob,
  config: Pick<CollectorConfig, "navigationTimeoutMs">,
) => Promise<CollectionOutcome>;

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...data }));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function processClaimedJob(
  api: CollectorApiClient,
  context: BrowserContext,
  job: CollectorJob,
  config: Pick<CollectorConfig, "heartbeatIntervalMs" | "navigationTimeoutMs">,
  collect: CollectFunction = collectClaimedJob,
) {
  let progress: CollectorProgress = { stage: "opening" };
  let heartbeatFailure: unknown;
  const heartbeat = setInterval(() => {
    void api.heartbeat(job.id, progress).catch((error) => {
      heartbeatFailure = error;
    });
  }, config.heartbeatIntervalMs);

  try {
    await api.heartbeat(job.id, progress);
    const outcome = await collect(context, job, config);
    if (heartbeatFailure) throw heartbeatFailure;

    if (outcome.kind === "interrupted") {
      await api.interrupt(job.id, outcome.reason);
      log("job_interrupted", { jobId: job.id, reason: outcome.reason });
      return;
    }
    if (outcome.kind === "failed") {
      await api.fail(job.id, outcome.code);
      log("job_failed", { jobId: job.id, code: outcome.code });
      return;
    }

    progress = { stage: "uploading", accepted: 0 };
    const accepted = await api.uploadReviews(job.id, outcome.reviews);
    progress = {
      stage: "completing",
      accepted,
      partialReason: outcome.partialReason,
    };
    await api.heartbeat(job.id, progress);
    await api.complete(job.id);
    log("job_completed", { jobId: job.id, accepted });
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runCollector(
  api: CollectorApiClient,
  context: BrowserContext,
  config: Pick<
    CollectorConfig,
    "heartbeatIntervalMs" | "navigationTimeoutMs" | "pollIntervalMs" | "runOnce"
  >,
  signal: AbortSignal,
) {
  log("collector_started");
  while (!signal.aborted) {
    try {
      const job = await api.claim();
      if (job) {
        log("job_claimed", { jobId: job.id, attemptCount: job.attemptCount });
        await processClaimedJob(api, context, job, config);
      } else if (config.runOnce) {
        break;
      }
    } catch (error) {
      log("collector_error", { error: error instanceof Error ? error.message : "unknown" });
    }
    if (config.runOnce) break;
    await sleep(config.pollIntervalMs, signal);
  }
  log("collector_stopped");
}
