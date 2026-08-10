import type { BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorApi } from "../collector/src/api";
import { processClaimedJob } from "../collector/src/daemon";
import type { CollectorReview } from "../collector/src/types";
import worker from "../worker/src/index";
import type { AppEnv } from "../worker/src/types";
import fixture from "./fixtures/naver-collector-job.json";
import { SqliteD1Fixture } from "./support/sqlite-d1";

const API_BASE = "https://fixture-api.test";
const COLLECTOR_ID = "fixture-mac";
const COLLECTOR_TOKEN = "fixture-collector-token";
const MIGRATIONS = [
  new URL("../worker/migrations/0001_initial.sql", import.meta.url).pathname,
  new URL("../worker/migrations/0002_ai_daily_usage.sql", import.meta.url).pathname,
  new URL("../worker/migrations/0003_collector_queue.sql", import.meta.url).pathname,
  new URL("../worker/migrations/0004_mobile_handoff.sql", import.meta.url).pathname,
  new URL("../worker/migrations/0005_rate_events.sql", import.meta.url).pathname,
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fixture collector lifecycle", () => {
  it("runs queued → claim → upload → complete → public report as one job", async () => {
    const database = new SqliteD1Fixture(MIGRATIONS);
    const env = {
      ALLOWED_ORIGIN: "https://reviewmoa.kro.kr",
      COLLECTOR_TOKEN,
      DB: database.db,
    } as AppEnv;

    try {
      const createResponse = await worker.fetch(
        new Request(`${API_BASE}/v1/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product: fixture.product }),
        }),
        env,
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as {
        id: string;
        status: string;
        operatorToken: string;
      };
      expect(created.status).toBe("queued");
      expect(created.operatorToken).toMatch(/^[a-f0-9]{64}$/);

      vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return worker.fetch(request, env);
      }));
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const api = new CollectorApi({
        apiBase: API_BASE,
        token: COLLECTOR_TOKEN,
        collectorId: COLLECTOR_ID,
      });
      const job = await api.claim();
      expect(job).toMatchObject({
        id: created.id,
        status: "collecting",
        claimedBy: COLLECTOR_ID,
        attemptCount: 1,
        product: fixture.product,
      });

      await processClaimedJob(
        api,
        {} as BrowserContext,
        job!,
        { heartbeatIntervalMs: 60_000, navigationTimeoutMs: 60_000 },
        async () => ({
          kind: "completed",
          reviews: fixture.reviews as CollectorReview[],
        }),
      );

      const storedJob = database.database.prepare(
        `SELECT status, claimed_by, attempt_count, progress_json, finished_at
         FROM jobs
         WHERE id = ?`,
      ).get(created.id) as Record<string, unknown>;
      expect(storedJob).toMatchObject({
        status: "completed",
        claimed_by: COLLECTOR_ID,
        attempt_count: 1,
      });
      expect(JSON.parse(String(storedJob.progress_json))).toEqual({
        stage: "completing",
        accepted: fixture.reviews.length,
      });
      expect(storedJob.finished_at).toEqual(expect.any(String));

      const storedReviewCount = database.database.prepare(
        "SELECT COUNT(*) AS count FROM reviews WHERE job_id = ?",
      ).get(created.id) as { count: number };
      expect(storedReviewCount.count).toBe(fixture.reviews.length);

      const jobResponse = await worker.fetch(
        new Request(`${API_BASE}/v1/jobs/${created.id}`),
        env,
      );
      expect(jobResponse.status).toBe(200);
      const snapshot = await jobResponse.json() as {
        id: string;
        status: string;
        product: typeof fixture.product;
        report: {
          id: string;
          collectionVerified: boolean;
          anomalyCounts: { sponsored: number; uncertain: number };
          ratings: Array<{
            rating: number;
            checked: number;
            included: number;
            excluded: number;
          }>;
        };
      };
      expect(snapshot).toMatchObject({
        id: created.id,
        status: "completed",
        product: fixture.product,
        report: {
          id: created.id,
          collectionVerified: true,
          anomalyCounts: { sponsored: 1, uncertain: 1 },
        },
      });
      expect(snapshot.report.ratings.find(({ rating }) => rating === 5)).toMatchObject({
        checked: 2,
        included: 1,
        excluded: 1,
      });
    } finally {
      database.close();
    }
  });

  it("hands a CAPTCHA job to iPhone Safari and completes it with mobile reviews", async () => {
    const database = new SqliteD1Fixture(MIGRATIONS);
    const env = {
      ALLOWED_ORIGIN: "https://reviewmoa.kro.kr",
      COLLECTOR_TOKEN,
      DB: database.db,
    } as AppEnv;

    try {
      const createResponse = await worker.fetch(
        new Request(`${API_BASE}/v1/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product: fixture.product }),
        }),
        env,
      );
      const created = await createResponse.json() as {
        id: string;
        operatorToken: string;
      };

      const claimResponse = await worker.fetch(
        new Request(`${API_BASE}/v1/collector/claim`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${COLLECTOR_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ collectorId: COLLECTOR_ID }),
        }),
        env,
      );
      expect(claimResponse.status).toBe(200);

      const interruptResponse = await worker.fetch(
        new Request(`${API_BASE}/v1/collector/jobs/${created.id}/interrupt`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${COLLECTOR_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            collectorId: COLLECTOR_ID,
            reason: "captcha",
          }),
        }),
        env,
      );
      expect(interruptResponse.status).toBe(200);

      const rejected = await worker.fetch(
        new Request(`${API_BASE}/v1/jobs/${created.id}/mobile-complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operatorToken: "0".repeat(64),
            reviews: fixture.reviews.slice(0, 2),
          }),
        }),
        env,
      );
      expect(rejected.status).toBe(409);

      const mobileResponse = await worker.fetch(
        new Request(`${API_BASE}/v1/jobs/${created.id}/mobile-complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operatorToken: created.operatorToken,
            reviews: fixture.reviews.slice(0, 2),
            collectorDiagnostics: {
              sourceDistribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 },
            },
          }),
        }),
        env,
      );
      expect(mobileResponse.status).toBe(200);
      await expect(mobileResponse.json()).resolves.toMatchObject({
        id: created.id,
        status: "completed",
        report: {
          confidenceReasons: expect.arrayContaining([
            "iPhone Safari에서 사용자가 보안 확인 후 수집한 공개 리뷰를 반영",
          ]),
          ratings: expect.arrayContaining([
            expect.objectContaining({ rating: 5, sourceCount: 1 }),
            expect.objectContaining({ rating: 4, sourceCount: 1 }),
          ]),
        },
      });

      const storedJob = database.database.prepare(
        `SELECT status, claimed_by, handoff_source, interruption_reason,
                operator_token_hash
         FROM jobs
         WHERE id = ?`,
      ).get(created.id) as Record<string, unknown>;
      expect(storedJob).toMatchObject({
        status: "completed",
        claimed_by: "mobile-safari",
        handoff_source: "ios-safari",
        interruption_reason: null,
        operator_token_hash: null,
      });
    } finally {
      database.close();
    }
  });
});
