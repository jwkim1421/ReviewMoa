import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { AppEnv } from "./types";

interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

function createDb(options?: {
  claimJob?: Record<string, unknown> | null;
  changes?: number | ((sql: string, bindings: unknown[]) => number);
  first?: (sql: string, bindings: unknown[]) => unknown;
  rows?: (sql: string, bindings: unknown[]) => unknown[];
  run?: (sql: string, bindings: unknown[], runCount: number) => unknown;
}) {
  const statements: RecordedStatement[] = [];
  let runCount = 0;
  const db = {
    prepare(sql: string) {
      const recorded = { sql, bindings: [] as unknown[] };
      statements.push(recorded);
      const statement = {
        bind(...bindings: unknown[]) {
          recorded.bindings = bindings;
          return statement;
        },
        async first() {
          const custom = options?.first?.(sql, recorded.bindings);
          if (custom !== undefined) return custom;
          return sql.includes("SET status = 'collecting'")
            ? options?.claimJob ?? null
            : null;
        },
        async run() {
          runCount += 1;
          const custom = options?.run?.(sql, recorded.bindings, runCount);
          if (custom !== undefined) return custom;
          const changes = typeof options?.changes === "function"
            ? options.changes(sql, recorded.bindings)
            : options?.changes ?? 1;
          return {
            success: true,
            meta: { changes },
          };
        },
        async all() {
          return {
            success: true,
            results: options?.rows?.(sql, recorded.bindings) ?? [],
          };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
  return { db: db as unknown as D1Database, statements };
}

function collectorEnv(db: D1Database, overrides?: Partial<AppEnv>) {
  return {
    ALLOWED_ORIGIN: "https://reviewmoa.kro.kr",
    COLLECTOR_TOKEN: "collector-secret",
    DB: db,
    ...overrides,
  } as AppEnv;
}

describe("Worker CORS", () => {
  it("returns a bodyless 204 preflight response for the production site", async () => {
    const request = new Request("https://reviewmoa-api.reviewmoa.workers.dev/v1/jobs/probe", {
      method: "OPTIONS",
      headers: {
        Origin: "https://reviewmoa.kro.kr",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    const response = await worker.fetch(
      request,
      { ALLOWED_ORIGIN: "https://reviewmoa.kro.kr" } as AppEnv,
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://reviewmoa.kro.kr");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("allows an iPhone Safari Web Extension origin", async () => {
    const response = await worker.fetch(
      new Request("https://reviewmoa-api.reviewmoa.workers.dev/health", {
        headers: {
          Origin: "safari-web-extension://kr.reviewmoa.safari.extension",
        },
      }),
      { ALLOWED_ORIGIN: "https://reviewmoa.kro.kr" } as AppEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "safari-web-extension://kr.reviewmoa.safari.extension",
    );
  });
});

describe("collector queue API", () => {
  it("rejects collector requests without touching D1 when the token is missing or invalid", async () => {
    const missing = await worker.fetch(
      new Request("https://api.example/v1/collector/claim", {
        method: "POST",
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      { ALLOWED_ORIGIN: "https://reviewmoa.kro.kr" } as AppEnv,
    );
    const wrong = await worker.fetch(
      new Request("https://api.example/v1/collector/claim", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      {
        ALLOWED_ORIGIN: "https://reviewmoa.kro.kr",
        COLLECTOR_TOKEN: "collector-secret",
      } as AppEnv,
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "UNAUTHORIZED" });
    await expect(wrong.json()).resolves.toEqual({ error: "UNAUTHORIZED" });
  });

  it("atomically claims the oldest queued or expired job", async () => {
    const { db, statements } = createDb({
      claimJob: {
        id: "job-1",
        cache_key: "naver:123:all",
        product_json: JSON.stringify({
          source: "naver",
          productId: "123",
          canonicalUrl: "https://smartstore.naver.com/example/products/123",
        }),
        status: "collecting",
        requested_at: "2026-07-28T00:00:00.000Z",
        started_at: "2026-07-28T00:00:01.000Z",
        claimed_by: "home-mac-01",
        lease_expires_at: "2026-07-28T00:02:01.000Z",
        heartbeat_at: "2026-07-28T00:00:01.000Z",
        attempt_count: 1,
        progress_json: null,
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/claim", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      job: {
        id: "job-1",
        status: "collecting",
        claimedBy: "home-mac-01",
        attemptCount: 1,
        product: { source: "naver", productId: "123" },
      },
    });
    const claim = statements.find((statement) =>
      statement.sql.includes("SET status = 'collecting'")
    );
    expect(claim?.sql).toContain("status = 'queued'");
    expect(claim?.sql).toContain("lease_expires_at < ?");
    expect(claim?.sql).toContain("RETURNING");
    expect(claim?.bindings[0]).toBe("home-mac-01");
    expect(claim?.bindings.at(-1)).toBe(3);
  });

  it("returns a bodyless 204 when there is no claimable job", async () => {
    const { db } = createDb({ claimJob: null });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/claim", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("extends only the lease owned by the heartbeat collector", async () => {
    const { db, statements } = createDb({ changes: 1 });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/heartbeat", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectorId: "home-mac-01",
          progress: { rating: 5, accepted: 42 },
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "job-1",
      status: "collecting",
    });
    const heartbeat = statements.find((statement) =>
      statement.sql.includes("SET heartbeat_at = ?")
    );
    expect(heartbeat?.sql).toContain("AND claimed_by = ?");
    expect(heartbeat?.bindings[2]).toBe(JSON.stringify({ rating: 5, accepted: 42 }));
    expect(heartbeat?.bindings.at(-2)).toBe("job-1");
    expect(heartbeat?.bindings.at(-1)).toBe("home-mac-01");
  });

  it("rejects a heartbeat when the collector does not own the lease", async () => {
    const { db } = createDb({ changes: 0 });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/heartbeat", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectorId: "other-mac" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "LEASE_NOT_OWNED" });
  });

  it("creates new public jobs in the queue with a requested timestamp", async () => {
    const { db, statements } = createDb();
    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: { source: "naver", productId: "123" },
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ status: "queued" });
    const insert = statements.find((statement) =>
      statement.sql.includes("INTO jobs")
    );
    expect(insert?.bindings[3]).toBe("queued");
    expect(insert?.sql).toContain("requested_at");
    expect(insert?.bindings).toHaveLength(14);
  });

  it("creates an iPhone-owned job that the central collector cannot claim", async () => {
    const { db, statements } = createDb();
    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: { source: "naver", productId: "123" },
          collector: "ios-safari",
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ status: "collecting" });
    const insert = statements.find((statement) =>
      statement.sql.includes("INTO jobs")
    );
    expect(insert?.bindings[3]).toBe("collecting");
    expect(insert?.bindings[9]).toBe("mobile-safari");
    expect(insert?.bindings[13]).toBe("ios-safari");
  });

  it("refreshes a completed job directly into iPhone collection", async () => {
    const existingJob = {
      id: "job-old",
      cache_key: "naver:123:all",
      product_json: JSON.stringify({
        source: "naver",
        productId: "123",
        canonicalUrl: "https://brand.naver.com/store/products/123",
      }),
      status: "completed",
      capability_json: null,
      error_code: null,
      progress_json: null,
      interruption_reason: null,
      requested_at: "2026-07-31T00:00:00.000Z",
      started_at: null,
      finished_at: "2026-07-31T00:01:00.000Z",
      operator_token_hash: null,
      operator_token_expires_at: null,
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:01:00.000Z",
    };
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SELECT * FROM jobs")) return existingJob;
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-old/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collector: "ios-safari" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      status: "collecting",
      previousJobId: "job-old",
    });
    const insert = statements.find((statement) =>
      statement.sql.includes("INTO jobs")
    );
    expect(insert?.bindings[3]).toBe("collecting");
    expect(insert?.bindings[9]).toBe("mobile-safari");
    expect(insert?.bindings[13]).toBe("ios-safari");
  });

  it("retries a timed-out refresh insert without creating a second job", async () => {
    const existingJob = {
      id: "job-old",
      cache_key: "naver:123:all",
      product_json: JSON.stringify({ source: "naver", productId: "123" }),
      status: "completed",
      capability_json: null,
      error_code: null,
      progress_json: null,
      interruption_reason: null,
      requested_at: "2026-07-31T00:00:00.000Z",
      started_at: null,
      finished_at: "2026-07-31T00:01:00.000Z",
      operator_token_hash: null,
      operator_token_expires_at: null,
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:01:00.000Z",
    };
    let insertAttempts = 0;
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SELECT * FROM jobs")) return existingJob;
      },
      run(sql) {
        if (!sql.includes("INSERT OR IGNORE INTO jobs")) return undefined;
        insertAttempts += 1;
        if (insertAttempts === 1) {
          throw new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset");
        }
        return { success: true, meta: { changes: 0 } };
      },
    });

    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-old/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collector: "ios-safari" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(201);
    expect(insertAttempts).toBe(2);
    expect(statements.filter((statement) =>
      statement.sql.includes("INSERT OR IGNORE INTO jobs")
    )).toHaveLength(2);
  });

  it("starts and interrupts a mobile Safari collection with its operator token", async () => {
    const operatorToken = "f".repeat(64);
    const job = {
      id: "job-1",
      cache_key: "naver:123:all",
      product_json: JSON.stringify({ source: "naver", productId: "123" }),
      status: "queued",
      capability_json: null,
      error_code: null,
      progress_json: null,
      interruption_reason: null,
      requested_at: "2026-07-31T00:00:00.000Z",
      started_at: null,
      finished_at: null,
      operator_token_hash: "unused-by-fake-db",
      operator_token_expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:00:00.000Z",
    };
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SELECT * FROM jobs")) return job;
        if (
          sql.includes("SET status = 'collecting'") &&
          sql.includes("handoff_source = 'ios-safari'")
        ) return { id: job.id };
      },
    });

    const started = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1/mobile-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorToken }),
      }),
      collectorEnv(db),
    );
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({ status: "collecting" });

    const interrupted = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1/mobile-interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorToken, reason: "captcha" }),
      }),
      collectorEnv(db),
    );
    expect(interrupted.status).toBe(200);
    await expect(interrupted.json()).resolves.toMatchObject({
      status: "waiting_for_operator",
      reason: "captcha",
    });
    expect(statements.some((statement) =>
      statement.sql.includes("claimed_by = 'mobile-safari'")
    )).toBe(true);

    const heartbeat = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1/mobile-heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorToken,
          progress: { stage: "collecting", accepted: 12 },
        }),
      }),
      collectorEnv(db),
    );
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({ status: "collecting" });
    const heartbeatUpdate = statements.find((statement) =>
      statement.sql.includes("SET heartbeat_at = ?") &&
      statement.sql.includes("operator_token_hash")
    );
    expect(heartbeatUpdate?.bindings[1]).toContain('"source":"ios-safari"');

    const failed = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1/mobile-fail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorToken,
          reason: "naver_collection_incomplete",
          message: "네이버 5점 리뷰 100개 중 12개만 확인되어 분석을 중단했습니다.",
          extensionVersion: "0.1.12",
          collectorDiagnostics: {
            sourceDistribution: { 5: 100, 4: 4, 3: 2, 2: 0, 1: 0 },
            scanned: 12,
          },
        }),
      }),
      collectorEnv(db),
    );
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toMatchObject({
      status: "failed",
      errorCode: "naver_collection_incomplete",
    });
    const failedUpdate = statements.find((statement) =>
      statement.sql.includes("SET status = 'failed'") &&
      statement.sql.includes("operator_token_hash = NULL")
    );
    expect(failedUpdate?.bindings[0]).toBe("naver_collection_incomplete");
    expect(JSON.parse(String(failedUpdate?.bindings[1]))).toMatchObject({
      stage: "failed",
      source: "ios-safari",
      extensionVersion: "0.1.12",
      collectorDiagnostics: { scanned: 12 },
    });
  });

  it("returns a valid cached report instead of creating another job", async () => {
    const cachedReport = {
      id: "cached-job",
      collectionVerified: true,
      rawExpiresAt: "2099-01-01T00:00:00.000Z",
      ratings: [],
      limitations: [],
    };
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("FROM reports") && sql.includes("job_id")) {
          return {
            job_id: "cached-job",
            report_json: JSON.stringify(cachedReport),
            raw_expires_at: "2099-01-01T00:00:00.000Z",
          };
        }
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: { source: "naver", productId: "123" },
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "cached-job",
      status: "completed",
      cached: true,
      report: { id: "cached-job", cached: true },
    });
    expect(statements.some((statement) =>
      statement.sql.includes("INTO jobs")
    )).toBe(false);
  });

  it("deduplicates an active job for the same product", async () => {
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("FROM jobs") && sql.includes("status IN")) {
          return { id: "active-job", status: "collecting" };
        }
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: { source: "naver", productId: "123" },
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "active-job",
      status: "collecting",
      deduplicated: true,
      operatorToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(statements.some((statement) =>
      statement.sql.includes("INTO jobs")
    )).toBe(false);
  });

  it("returns only user-facing job state without collector lease details", async () => {
    const { db } = createDb({
      first(sql) {
        if (sql.includes("SELECT * FROM jobs")) {
          return {
            id: "job-1",
            cache_key: "naver:123:all",
            product_json: JSON.stringify({
              source: "naver",
              sourceLabel: "네이버",
              productId: "123",
              canonicalUrl: "https://smartstore.naver.com/store/products/123",
            }),
            status: "collecting",
            capability_json: null,
            error_code: null,
            progress_json: JSON.stringify({ stage: "collecting", accepted: 20 }),
            interruption_reason: null,
            requested_at: "2026-07-28T00:00:00.000Z",
            started_at: "2026-07-28T00:00:01.000Z",
            finished_at: null,
            created_at: "2026-07-28T00:00:00.000Z",
            updated_at: "2026-07-28T00:00:02.000Z",
            claimed_by: "home-mac-01",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          };
        }
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1"),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      id: "job-1",
      status: "collecting",
      progress: { stage: "collecting", accepted: 20 },
      product: { source: "naver", productId: "123" },
    });
    expect(payload).not.toHaveProperty("claimed_by");
    expect(payload).not.toHaveProperty("claimedBy");
    expect(payload).not.toHaveProperty("lease_expires_at");
    expect(payload).not.toHaveProperty("leaseExpiresAt");
  });

  it("accepts valid review batches only from the collector that owns the lease", async () => {
    const { db, statements } = createDb({
      first(sql) {
        if (
          sql.includes("SET heartbeat_at = ?") &&
          sql.includes("RETURNING id, cache_key")
        ) {
          return {
            id: "job-1",
            cache_key: "naver:123:all",
            product_json: "{}",
            status: "collecting",
          };
        }
        if (sql.includes("COUNT(*) AS count")) return { count: 12 };
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/reviews", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectorId: "home-mac-01",
          reviews: [
            {
              id: "review-1",
              rating: 5,
              content: "배송이 빠르고 만족합니다.",
              createdAt: "2026-07-28T00:00:00.000Z",
              classification: "included",
            },
            {
              id: "review-2",
              rating: 2,
              content: "포장이 훼손되어 아쉽습니다.",
              option: "검정",
              classification: "uncertain",
            },
          ],
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: 2 });
    const inserts = statements.filter((statement) =>
      statement.sql.includes("INSERT OR REPLACE INTO reviews")
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].bindings.slice(0, 4)).toEqual([
      "job-1",
      "review-1",
      5,
      "배송이 빠르고 만족합니다.",
    ]);
  });

  it("rejects malformed review data before writing it", async () => {
    const { db, statements } = createDb();
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/reviews", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectorId: "home-mac-01",
          reviews: [{
            id: "bad-review",
            rating: 6,
            content: "잘못된 별점",
            classification: "included",
          }],
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_REVIEWS" });
    expect(statements.some((statement) =>
      statement.sql.includes("INSERT OR REPLACE INTO reviews")
    )).toBe(false);
  });

  it("moves an owned collecting job to waiting_for_operator on interruption", async () => {
    const { db, statements } = createDb({ changes: 1 });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/interrupt", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectorId: "home-mac-01",
          reason: "captcha",
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "job-1",
      status: "waiting_for_operator",
      reason: "captcha",
    });
    const interrupt = statements.find((statement) =>
      statement.sql.includes("status = 'waiting_for_operator'") &&
      statement.sql.includes("interruption_reason = ?")
    );
    expect(interrupt?.bindings[0]).toBe("captcha");
    expect(interrupt?.sql).toContain("AND claimed_by = ?");
  });

  it("records a safe failure code and finishes an owned job", async () => {
    const { db, statements } = createDb({ changes: 1 });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/fail", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          collectorId: "home-mac-01",
          code: "adapter_not_implemented",
        }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "job-1",
      status: "failed",
      errorCode: "adapter_not_implemented",
    });
    const failure = statements.find((statement) =>
      statement.sql.includes("status = 'failed'")
    );
    expect(failure?.bindings[0]).toBe("adapter_not_implemented");
    expect(failure?.sql).toContain("finished_at = ?");
  });

  it("completes an owned job once and stores its report", async () => {
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SET status = 'analyzing'")) {
          return {
            id: "job-1",
            cache_key: "naver:123:all",
            product_json: JSON.stringify({
              source: "naver",
              sourceLabel: "네이버",
              productId: "123",
              name: "테스트 상품",
            }),
            status: "analyzing",
          };
        }
      },
      rows(sql) {
        return sql.includes("FROM reviews")
          ? [{
              review_id: "review-1",
              rating: 5,
              content: "배송이 빠르고 만족합니다.",
              created_at: "2026-07-28T00:00:00.000Z",
              option_name: null,
              classification: "included",
            }]
          : [];
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/complete", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "job-1",
      collectionVerified: true,
      product: { name: "테스트 상품" },
    });
    expect(statements.some((statement) =>
      statement.sql.includes("INSERT OR REPLACE INTO reports")
    )).toBe(true);
    const finish = statements.find((statement) =>
      statement.sql.includes("AND status = 'analyzing'")
    );
    expect(finish?.bindings[0]).toBe("completed");
  });

  it("returns the stored report when complete is retried by the same collector", async () => {
    const storedReport = {
      id: "job-1",
      product: { name: "테스트 상품" },
      collectionVerified: true,
    };
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SET status = 'analyzing'")) return null;
        if (sql.includes("JOIN reports")) {
          return { report_json: JSON.stringify(storedReport) };
        }
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/complete", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(storedReport);
    expect(statements.some((statement) =>
      statement.sql.includes("INSERT OR REPLACE INTO reports")
    )).toBe(false);
  });

  it("marks a summary-only report partial and explains the limitation", async () => {
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SET status = 'analyzing'")) {
          return {
            id: "job-1",
            cache_key: "naver:123:all",
            product_json: JSON.stringify({ source: "naver", productId: "123" }),
            status: "analyzing",
            progress_json: JSON.stringify({
              stage: "completing",
              accepted: 1,
              partialReason: "summary_only",
            }),
          };
        }
      },
      rows(sql) {
        return sql.includes("FROM reviews")
          ? [{
              review_id: "review-1",
              rating: 5,
              content: "공개된 대표 리뷰입니다.",
              created_at: null,
              option_name: null,
              classification: "included",
            }]
          : [];
      },
    });
    const response = await worker.fetch(
      new Request("https://api.example/v1/collector/jobs/job-1/complete", {
        method: "POST",
        headers: {
          Authorization: "Bearer collector-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectorId: "home-mac-01" }),
      }),
      collectorEnv(db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sampleNotice: expect.stringContaining("정상 리뷰가 1개로 충분하지 않습니다."),
      limitations: expect.arrayContaining([
        "전체 리뷰 목록을 자동으로 열지 못해 상품 페이지에 공개된 대표 리뷰만 반영했습니다.",
      ]),
    });
    const finish = statements.find((statement) =>
      statement.sql.includes("AND status = 'analyzing'")
    );
    expect(finish?.bindings[0]).toBe("partial");
  });

  it("finishes an iPhone handoff with product metadata and safe rule fallback", async () => {
    const operatorToken = "a".repeat(64);
    const job = {
      id: "job-1",
      cache_key: "naver:123:all",
      product_json: JSON.stringify({ source: "naver", productId: "123" }),
      status: "waiting_for_operator",
      capability_json: null,
      error_code: null,
      progress_json: null,
      interruption_reason: "operator_required",
      requested_at: "2026-07-30T00:00:00.000Z",
      started_at: null,
      finished_at: null,
      operator_token_hash: "unused-by-fake-db",
      operator_token_expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
    };
    const { db, statements } = createDb({
      first(sql) {
        if (sql.includes("SELECT * FROM jobs")) return job;
        if (sql.includes("handoff_source = 'ios-safari'")) {
          return {
            id: job.id,
            cache_key: job.cache_key,
            product_json: job.product_json,
          };
        }
      },
      rows(sql) {
        return sql.includes("FROM reviews")
          ? [{
              review_id: "review-1",
              rating: 5,
              content: "배송이 빠르고 사용하기 편합니다.",
              created_at: "2026-07-30",
              option_name: null,
              classification: "included",
            }]
          : [];
      },
    });
    const aiFetch = vi.fn();
    vi.stubGlobal("fetch", aiFetch);

    try {
      const response = await worker.fetch(
        new Request("https://api.example/v1/jobs/job-1/mobile-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operatorToken,
            extensionVersion: "0.1.9",
            product: { name: "테스트 상품 이름" },
            collectorDiagnostics: {
              summaryDetected: true,
              attempts: [{ area: "sprvsub.topreviewmore", activated: true }],
              ready: true,
            },
            reviews: [{
              id: "review-1",
              rating: 5,
              content: "배송이 빠르고 사용하기 편합니다.",
              createdAt: "2026-07-30",
              classification: "included",
            }],
          }),
        }),
        collectorEnv(db, { OPENROUTER_API_KEY: "test-ai-key" }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "job-1",
        status: "completed",
        report: {
          product: { name: "테스트 상품 이름" },
          analysisProvider: "rules",
          limitations: expect.arrayContaining([
            "오늘의 무료 AI 분석 한도에 도달해 규칙 기반 결과를 표시합니다.",
          ]),
        },
      });
      expect(aiFetch).not.toHaveBeenCalled();
      const claim = statements.find((statement) =>
        statement.sql.includes("handoff_source = 'ios-safari'")
      );
      expect(claim?.sql).toContain(
        "OR (status = 'collecting' AND claimed_by = 'mobile-safari')",
      );
      const finish = statements.find((statement) =>
        statement.sql.includes("SET status = ?") &&
        statement.sql.includes("finished_at = ?")
      );
      expect(JSON.parse(String(finish?.bindings[2]))).toMatchObject({
        extensionVersion: "0.1.9",
        collectorDiagnostics: {
          summaryDetected: true,
          ready: true,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers a stale interrupted iPhone collection or analysis during cleanup", async () => {
    const { db, statements } = createDb();
    await worker.fetch(
      new Request("https://api.example/v1/jobs/missing"),
      collectorEnv(db),
    );

    const recovery = statements.find((statement) =>
      statement.sql.includes("updated_at < ?") &&
      statement.sql.includes("claimed_by = 'mobile-safari'")
    );
    expect(recovery?.sql).toContain("status = 'waiting_for_operator'");
    expect(recovery?.sql).toContain("status IN ('collecting', 'analyzing')");
    expect(recovery?.sql).toContain("NOT EXISTS");
    expect(recovery?.bindings[0]).toContain("다시 시도할 수 있어요");
  });

  it("does not expose the legacy public review upload and complete routes", async () => {
    const { db, statements } = createDb();
    const env = collectorEnv(db);
    const reviews = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1/reviews", {
        method: "POST",
        body: JSON.stringify({ reviews: [] }),
      }),
      env,
    );
    const complete = await worker.fetch(
      new Request("https://api.example/v1/jobs/job-1/complete", {
        method: "POST",
      }),
      env,
    );

    expect(reviews.status).toBe(404);
    expect(complete.status).toBe(404);
    expect(statements.some((statement) =>
      statement.sql.includes("SELECT * FROM jobs WHERE id = ?")
    )).toBe(false);
  });
});
