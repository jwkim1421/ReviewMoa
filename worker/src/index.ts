import { createReport, enhanceVerdictWithAi } from "./analyze";
import type {
  AppEnv,
  Classification,
  CollectorJobRow,
  StoredReview,
} from "./types";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const DEFAULT_COLLECTOR_LEASE_MS = 120_000;
const DEFAULT_COLLECTOR_MAX_ATTEMPTS = 3;
const MAX_REVIEW_BATCH_SIZE = 100;
const MAX_REVIEWS_PER_JOB = 3_000;
const MOBILE_TOKEN_TTL_DAYS = 7;
const CLASSIFICATIONS = new Set<Classification>([
  "included",
  "sponsored",
  "duplicate",
  "rating_mismatch",
  "uncertain",
]);
const INTERRUPTION_REASONS = new Set([
  "login_required",
  "captcha",
  "access_blocked",
  "operator_required",
]);
const FAILURE_CODES = new Set([
  "review_area_not_found",
  "product_unavailable",
  "unsupported_redirect",
  "browser_timeout",
  "access_blocked",
  "site_error",
  "collection_failed",
  "adapter_not_implemented",
]);

interface CollectorReviewInput {
  id: string;
  rating: number;
  content: string;
  createdAt?: string;
  option?: string;
  classification: Classification;
}

function json(data: unknown, status = 200, origin = "*") {
  const body = status === 204 ? null : JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      Vary: "Origin",
    },
  });
}

function addDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function createOperatorToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

async function hashOperatorToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function validOperatorToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function allowedOrigin(request: Request, env: AppEnv) {
  const origin = request.headers.get("Origin") ?? "";
  if (/^(chrome|safari-web)-extension:\/\//.test(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN;
}

async function readBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function collectorAuthorized(request: Request, env: AppEnv) {
  const token = env.COLLECTOR_TOKEN?.trim();
  return Boolean(token && request.headers.get("Authorization") === `Bearer ${token}`);
}

function collectorLeaseMs(env: AppEnv) {
  const configured = Number(env.COLLECTOR_LEASE_MS);
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, 30_000), 15 * 60_000)
    : DEFAULT_COLLECTOR_LEASE_MS;
}

function collectorMaxAttempts(env: AppEnv) {
  const configured = Number(env.COLLECTOR_MAX_ATTEMPTS);
  return Number.isInteger(configured)
    ? Math.min(Math.max(configured, 1), 10)
    : DEFAULT_COLLECTOR_MAX_ATTEMPTS;
}

function validCollectorId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function validOptionalText(value: unknown, maxLength: number) {
  return value === undefined ||
    (typeof value === "string" && value.length <= maxLength);
}

function validateReview(value: unknown): value is CollectorReviewInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  return typeof review.id === "string" &&
    review.id.trim().length > 0 &&
    review.id.length <= 200 &&
    Number.isInteger(review.rating) &&
    Number(review.rating) >= 1 &&
    Number(review.rating) <= 5 &&
    typeof review.content === "string" &&
    review.content.trim().length > 0 &&
    review.content.length <= 6_000 &&
    validOptionalText(review.createdAt, 64) &&
    (
      review.createdAt === undefined ||
      Number.isFinite(Date.parse(review.createdAt as string))
    ) &&
    validOptionalText(review.option, 500) &&
    typeof review.classification === "string" &&
    CLASSIFICATIONS.has(review.classification as Classification);
}

async function renewOwnedCollectingJob(
  env: AppEnv,
  jobId: string,
  collectorId: string,
) {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + collectorLeaseMs(env)).toISOString();
  return env.DB.prepare(
    `UPDATE jobs
     SET heartbeat_at = ?,
         lease_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'collecting'
       AND claimed_by = ?
       AND lease_expires_at >= ?
     RETURNING id, cache_key, product_json, status`,
  ).bind(now, leaseExpiresAt, now, jobId, collectorId, now).first<{
    id: string;
    cache_key: string;
    product_json: string;
    status: string;
  }>();
}

function serializeCollectorJob(row: CollectorJobRow) {
  return {
    id: row.id,
    cacheKey: row.cache_key,
    product: JSON.parse(row.product_json) as Record<string, unknown>,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    claimedBy: row.claimed_by,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    attemptCount: row.attempt_count,
    progress: row.progress_json
      ? JSON.parse(row.progress_json) as Record<string, unknown>
      : undefined,
  };
}

function reportForResponse(
  reportJson: string,
  rawExpiresAt?: string | null,
  cached = false,
) {
  const report = JSON.parse(reportJson) as Record<string, unknown>;
  if (report.collectionVerified !== true) return undefined;
  const rawExpiry = rawExpiresAt ??
    (typeof report.rawExpiresAt === "string" ? report.rawExpiresAt : null);
  const rawExpired = Boolean(rawExpiry && rawExpiry < new Date().toISOString());
  if (!rawExpired || !Array.isArray(report.ratings)) {
    return { ...report, cached };
  }
  return {
    ...report,
    cached,
    ratings: report.ratings.map((rating) => ({
      ...(rating as Record<string, unknown>),
      reviews: [],
    })),
    limitations: [
      ...((report.limitations as string[] | undefined) ?? []),
      "원문 보존 기간 7일이 지나 대표 리뷰 원문이 만료되었습니다. 다시 불러오면 최신 원문을 확인할 수 있습니다.",
    ],
  };
}

async function cleanup(env: AppEnv) {
  const now = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const staleMobileAnalysis = new Date(Date.now() - 2 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews WHERE raw_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE report_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM ai_daily_usage WHERE day < ?").bind(sevenDaysAgo),
    env.DB.prepare(
      `UPDATE jobs
       SET status = 'waiting_for_operator',
           claimed_by = NULL,
           progress_json = ?,
           updated_at = ?
       WHERE status = 'analyzing'
         AND claimed_by = 'mobile-safari'
         AND updated_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM reports WHERE reports.job_id = jobs.id
         )`,
    ).bind(
      JSON.stringify({
        stage: "waiting_for_operator",
        message: "아이폰 전송이 중단되어 다시 시도할 수 있어요.",
      }),
      now,
      staleMobileAnalysis,
    ),
  ]);
}

async function reserveAiRequest(env: AppEnv) {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const limit = Math.max(1, Number(env.AI_DAILY_LIMIT) || 40);
  const reservation = await env.DB.prepare(
    `INSERT INTO ai_daily_usage(day, request_count, updated_at)
     VALUES(?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET
       request_count = request_count + 1,
       updated_at = excluded.updated_at
     WHERE request_count < ?
     RETURNING request_count`,
  ).bind(day, now, limit).first<{ request_count: number }>();
  return Boolean(reservation);
}

async function buildReport(
  env: AppEnv,
  jobId: string,
  productJson: string,
  rows: StoredReview[],
  options?: {
    summaryOnly?: boolean;
    mobileSafari?: boolean;
    skipAi?: boolean;
  },
) {
  let report = createReport(jobId, JSON.parse(productJson), rows);
  if (options?.summaryOnly) {
    report.limitations.push(
      "전체 리뷰 목록을 자동으로 열지 못해 상품 페이지에 공개된 대표 리뷰만 반영했습니다.",
    );
  }
  if (options?.mobileSafari) {
    report.confidenceReasons.push(
      "iPhone Safari에서 사용자가 보안 확인 후 수집한 공개 리뷰를 반영",
    );
    report.limitations.push(
      "iPhone에서 안정적으로 전송하기 위해 규칙 기반으로 즉시 분석했습니다.",
    );
  }

  const provider = env.OPENROUTER_API_KEY ? "openrouter" : "openai";
  const apiKey = env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY;
  if (!options?.skipAi && apiKey && rows.length && await reserveAiRequest(env)) {
    report = await enhanceVerdictWithAi(report, rows, {
      provider,
      apiKey,
      model: provider === "openrouter"
        ? env.OPENROUTER_MODEL ?? "openrouter/free"
        : env.AI_MODEL ?? "gpt-5-mini",
    });
  } else if (!options?.skipAi && apiKey && rows.length) {
    report.limitations.push("오늘의 무료 AI 분석 한도에 도달해 규칙 기반 결과를 표시합니다.");
  }
  return report;
}

async function handle(request: Request, env: AppEnv) {
  const url = new URL(request.url);
  const origin = allowedOrigin(request, env);
  if (request.method === "OPTIONS") return json(null, 204, origin);
  if (url.pathname === "/health") return json({ ok: true, service: "reviewmoa-api" }, 200, origin);

  const collectorPath = url.pathname.startsWith("/v1/collector/");
  if (collectorPath && !collectorAuthorized(request, env)) {
    return json({ error: "UNAUTHORIZED" }, 401, origin);
  }

  await cleanup(env);

  if (request.method === "POST" && url.pathname === "/v1/collector/claim") {
    const body = await readBody<{ collectorId?: unknown }>(request);
    if (!validCollectorId(body.collectorId)) {
      return json({ error: "INVALID_COLLECTOR_ID" }, 400, origin);
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + collectorLeaseMs(env)).toISOString();
    const job = await env.DB.prepare(
      `UPDATE jobs
       SET status = 'collecting',
           claimed_by = ?,
           started_at = COALESCE(started_at, ?),
           lease_expires_at = ?,
           heartbeat_at = ?,
           attempt_count = COALESCE(attempt_count, 0) + 1,
           updated_at = ?,
           interruption_reason = NULL
       WHERE id = (
         SELECT id
         FROM jobs
         WHERE (
           status = 'queued'
           OR (status = 'collecting' AND lease_expires_at < ?)
         )
         AND COALESCE(attempt_count, 0) < ?
         ORDER BY COALESCE(requested_at, created_at), created_at
         LIMIT 1
       )
       RETURNING id, cache_key, product_json, status, requested_at, started_at,
                 claimed_by, lease_expires_at, heartbeat_at, attempt_count,
                 progress_json`,
    ).bind(
      body.collectorId,
      now,
      leaseExpiresAt,
      now,
      now,
      now,
      collectorMaxAttempts(env),
    ).first<CollectorJobRow>();

    return job
      ? json({ job: serializeCollectorJob(job) }, 200, origin)
      : json(null, 204, origin);
  }

  const collectorJobMatch = url.pathname.match(/^\/v1\/collector\/jobs\/([^/]+)\/heartbeat$/);
  if (request.method === "POST" && collectorJobMatch) {
    const body = await readBody<{
      collectorId?: unknown;
      progress?: unknown;
    }>(request);
    if (!validCollectorId(body.collectorId)) {
      return json({ error: "INVALID_COLLECTOR_ID" }, 400, origin);
    }
    if (
      body.progress !== undefined &&
      (typeof body.progress !== "object" || body.progress === null || Array.isArray(body.progress))
    ) {
      return json({ error: "INVALID_PROGRESS" }, 400, origin);
    }

    const progressJson = body.progress === undefined ? null : JSON.stringify(body.progress);
    if (progressJson && progressJson.length > 20_000) {
      return json({ error: "PROGRESS_TOO_LARGE" }, 400, origin);
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + collectorLeaseMs(env)).toISOString();
    const result = await env.DB.prepare(
      `UPDATE jobs
       SET heartbeat_at = ?,
           lease_expires_at = ?,
           progress_json = COALESCE(?, progress_json),
           updated_at = ?
       WHERE id = ?
         AND status = 'collecting'
         AND claimed_by = ?`,
    ).bind(
      now,
      leaseExpiresAt,
      progressJson,
      now,
      collectorJobMatch[1],
      body.collectorId,
    ).run();

    if (!result.meta.changes) {
      return json({ error: "LEASE_NOT_OWNED" }, 409, origin);
    }
    return json({
      id: collectorJobMatch[1],
      status: "collecting",
      heartbeatAt: now,
      leaseExpiresAt,
    }, 200, origin);
  }

  const collectorActionMatch = url.pathname.match(
    /^\/v1\/collector\/jobs\/([^/]+)\/(reviews|interrupt|complete|fail)$/,
  );
  if (request.method === "POST" && collectorActionMatch) {
    const [, jobId, action] = collectorActionMatch;

    if (action === "reviews") {
      const body = await readBody<{
        collectorId?: unknown;
        reviews?: unknown;
      }>(request);
      if (!validCollectorId(body.collectorId)) {
        return json({ error: "INVALID_COLLECTOR_ID" }, 400, origin);
      }
      if (
        !Array.isArray(body.reviews) ||
        body.reviews.length === 0 ||
        body.reviews.length > MAX_REVIEW_BATCH_SIZE ||
        !body.reviews.every(validateReview)
      ) {
        return json({ error: "INVALID_REVIEWS" }, 400, origin);
      }
      const job = await renewOwnedCollectingJob(env, jobId, body.collectorId);
      if (!job) return json({ error: "LEASE_NOT_OWNED" }, 409, origin);

      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM reviews WHERE job_id = ?",
      ).bind(jobId).first<{ count: number }>();
      if ((count?.count ?? 0) + body.reviews.length > MAX_REVIEWS_PER_JOB) {
        return json({ error: "REVIEW_LIMIT_EXCEEDED" }, 409, origin);
      }

      const expiry = addDays(7);
      const statements = (body.reviews as CollectorReviewInput[]).map((review) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO reviews(
             job_id, review_id, rating, content, created_at, option_name,
             classification, raw_expires_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          jobId,
          review.id.trim(),
          review.rating,
          review.content.trim(),
          review.createdAt ?? null,
          review.option?.trim() || null,
          review.classification,
          expiry,
        )
      );
      await env.DB.batch(statements);
      await env.DB.prepare(
        "UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'collecting' AND claimed_by = ?",
      ).bind(new Date().toISOString(), jobId, body.collectorId).run();
      return json({ accepted: statements.length }, 200, origin);
    }

    if (action === "interrupt") {
      const body = await readBody<{
        collectorId?: unknown;
        reason?: unknown;
      }>(request);
      if (!validCollectorId(body.collectorId)) {
        return json({ error: "INVALID_COLLECTOR_ID" }, 400, origin);
      }
      if (typeof body.reason !== "string" || !INTERRUPTION_REASONS.has(body.reason)) {
        return json({ error: "INVALID_INTERRUPTION_REASON" }, 400, origin);
      }

      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        `UPDATE jobs
         SET status = 'waiting_for_operator',
             interruption_reason = ?,
             lease_expires_at = NULL,
             heartbeat_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'collecting'
           AND claimed_by = ?
           AND lease_expires_at >= ?`,
      ).bind(body.reason, now, now, jobId, body.collectorId, now).run();
      if (!result.meta.changes) {
        return json({ error: "LEASE_NOT_OWNED" }, 409, origin);
      }
      return json({
        id: jobId,
        status: "waiting_for_operator",
        reason: body.reason,
      }, 200, origin);
    }

    if (action === "fail") {
      const body = await readBody<{
        collectorId?: unknown;
        code?: unknown;
      }>(request);
      if (!validCollectorId(body.collectorId)) {
        return json({ error: "INVALID_COLLECTOR_ID" }, 400, origin);
      }
      if (typeof body.code !== "string" || !FAILURE_CODES.has(body.code)) {
        return json({ error: "INVALID_FAILURE_CODE" }, 400, origin);
      }

      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        `UPDATE jobs
         SET status = 'failed',
             error_code = ?,
             finished_at = ?,
             lease_expires_at = NULL,
             heartbeat_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'collecting'
           AND claimed_by = ?
           AND lease_expires_at >= ?`,
      ).bind(body.code, now, now, now, jobId, body.collectorId, now).run();
      if (!result.meta.changes) {
        return json({ error: "LEASE_NOT_OWNED" }, 409, origin);
      }
      return json({ id: jobId, status: "failed", errorCode: body.code }, 200, origin);
    }

    const body = await readBody<{ collectorId?: unknown }>(request);
    if (!validCollectorId(body.collectorId)) {
      return json({ error: "INVALID_COLLECTOR_ID" }, 400, origin);
    }

    const now = new Date().toISOString();
    const job = await env.DB.prepare(
      `UPDATE jobs
       SET status = 'analyzing',
           heartbeat_at = ?,
           updated_at = ?
       WHERE id = ?
         AND status = 'collecting'
         AND claimed_by = ?
         AND lease_expires_at >= ?
       RETURNING id, cache_key, product_json, status, progress_json`,
    ).bind(now, now, jobId, body.collectorId, now).first<{
      id: string;
      cache_key: string;
      product_json: string;
      status: string;
      progress_json: string | null;
    }>();

    if (!job) {
      const completed = await env.DB.prepare(
        `SELECT reports.report_json
         FROM jobs
         JOIN reports ON reports.job_id = jobs.id
         WHERE jobs.id = ?
           AND jobs.claimed_by = ?
           AND jobs.status IN ('completed', 'partial')`,
      ).bind(jobId, body.collectorId).first<{ report_json: string }>();
      return completed
        ? json(JSON.parse(completed.report_json), 200, origin)
        : json({ error: "LEASE_NOT_OWNED" }, 409, origin);
    }

    try {
      const rows = (await env.DB.prepare(
        `SELECT review_id, rating, content, created_at, option_name, classification
         FROM reviews
         WHERE job_id = ?
         ORDER BY created_at DESC`,
      ).bind(jobId).all<StoredReview>()).results ?? [];
      const progress = job.progress_json
        ? JSON.parse(job.progress_json) as { partialReason?: unknown }
        : undefined;
      const summaryOnly = progress?.partialReason === "summary_only";
      const report = await buildReport(env, jobId, job.product_json, rows, {
        summaryOnly,
      });

      const finalStatus = rows.length && !summaryOnly ? "completed" : "partial";
      const finishedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR REPLACE INTO reports(
             cache_key, job_id, report_json, collected_at, raw_expires_at,
             report_expires_at
           ) VALUES(?, ?, ?, ?, ?, ?)`,
        ).bind(
          job.cache_key,
          jobId,
          JSON.stringify(report),
          report.collectedAt,
          report.rawExpiresAt,
          report.reportExpiresAt,
        ),
        env.DB.prepare(
          `UPDATE jobs
           SET status = ?,
               finished_at = ?,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ?
             AND status = 'analyzing'
             AND claimed_by = ?`,
        ).bind(finalStatus, finishedAt, finishedAt, jobId, body.collectorId),
      ]);
      return json(report, 200, origin);
    } catch (error) {
      await env.DB.prepare(
        `UPDATE jobs
         SET status = 'collecting',
             updated_at = ?
         WHERE id = ?
           AND status = 'analyzing'
           AND claimed_by = ?`,
      ).bind(new Date().toISOString(), jobId, body.collectorId).run();
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/products/resolve") {
    const body = await readBody<{ product: Record<string, unknown> }>(request);
    return json({ product: body.product }, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/jobs/probe") {
    const body = await readBody<{ product: { source: string; productId: string; experimental?: boolean } }>(request);
    const key = `${body.product.source}:${body.product.productId}:all`.toLowerCase();
    const cached = await env.DB.prepare(
      `SELECT report_json, raw_expires_at
       FROM reports
       WHERE cache_key = ? AND report_expires_at > ?`,
    ).bind(key, new Date().toISOString()).first<{
      report_json: string;
      raw_expires_at: string;
    }>();
    const cachedReport = cached
      ? reportForResponse(cached.report_json, cached.raw_expires_at, true)
      : undefined;
    return json({
      capability: {
        status: "partial",
        hasReviewArea: false,
        supportsNewestSort: false,
        supportsRatingFilter: false,
        requiresLogin: false,
        message: "상품 URL을 확인했습니다. 확장 프로그램에서 실제 리뷰 영역과 필터를 검증합니다.",
      },
      report: cachedReport,
    }, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/jobs") {
    const body = await readBody<{
      product?: Record<string, unknown> & { source?: unknown; productId?: unknown };
    }>(request);
    if (
      !body.product ||
      typeof body.product.source !== "string" ||
      !body.product.source ||
      typeof body.product.productId !== "string" ||
      !body.product.productId
    ) {
      return json({ error: "INVALID_PRODUCT" }, 400, origin);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const operatorToken = createOperatorToken();
    const operatorTokenHash = await hashOperatorToken(operatorToken);
    const operatorTokenExpiresAt = addDays(MOBILE_TOKEN_TTL_DAYS);
    const key = `${body.product.source}:${body.product.productId}:all`.toLowerCase();
    const cached = await env.DB.prepare(
      `SELECT job_id, report_json, raw_expires_at
       FROM reports
       WHERE cache_key = ? AND report_expires_at > ?`,
    ).bind(key, now).first<{
      job_id: string;
      report_json: string;
      raw_expires_at: string;
    }>();
    if (cached) {
      const report = reportForResponse(cached.report_json, cached.raw_expires_at, true);
      if (report) {
        return json({
          id: cached.job_id,
          status: "completed",
          product: body.product,
          report,
          cached: true,
        }, 200, origin);
      }
    }

    const active = await env.DB.prepare(
      `SELECT id, status
       FROM jobs
       WHERE cache_key = ?
         AND status IN (
           'queued', 'probing', 'collecting', 'analyzing',
           'waiting_for_operator', 'waiting_for_login', 'waiting_for_user'
         )
       ORDER BY created_at DESC
       LIMIT 1`,
    ).bind(key).first<{ id: string; status: string }>();
    if (active) {
      await env.DB.prepare(
        `UPDATE jobs
         SET operator_token_hash = ?,
             operator_token_expires_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).bind(operatorTokenHash, operatorTokenExpiresAt, now, active.id).run();
      return json({
        id: active.id,
        status: active.status,
        operatorToken,
        deduplicated: true,
      }, 200, origin);
    }

    await env.DB.prepare(
      `INSERT INTO jobs(
         id, cache_key, product_json, status, requested_at, created_at, updated_at,
         operator_token_hash, operator_token_expires_at
       ) VALUES(?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      key,
      JSON.stringify(body.product),
      now,
      now,
      now,
      operatorTokenHash,
      operatorTokenExpiresAt,
    ).run();
    return json({ id, status: "queued", operatorToken }, 201, origin);
  }

  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/([^/]+))?$/);
  if (!jobMatch) return json({ error: "NOT_FOUND" }, 404, origin);
  const [, jobId, action] = jobMatch;
  if (request.method === "POST" && ["reviews", "complete"].includes(action ?? "")) {
    return json({ error: "NOT_FOUND" }, 404, origin);
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<{
    id: string;
    cache_key: string;
    product_json: string;
    status: string;
    capability_json: string | null;
    error_code: string | null;
    progress_json: string | null;
    interruption_reason: string | null;
    requested_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    operator_token_hash: string | null;
    operator_token_expires_at: string | null;
    created_at: string;
    updated_at: string;
  }>();
  if (!job) return json({ error: "JOB_NOT_FOUND" }, 404, origin);

  if (request.method === "GET" && !action) {
    const storedReport = await env.DB.prepare(
      "SELECT report_json, raw_expires_at FROM reports WHERE job_id = ?",
    ).bind(jobId).first<{ report_json: string; raw_expires_at: string }>();
    return json({
      id: job.id,
      status: job.status,
      product: JSON.parse(job.product_json),
      capability: job.capability_json ? JSON.parse(job.capability_json) : undefined,
      progress: job.progress_json ? JSON.parse(job.progress_json) : undefined,
      interruptionReason: job.interruption_reason,
      errorCode: job.error_code,
      requestedAt: job.requested_at ?? job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      updatedAt: job.updated_at,
      report: storedReport
        ? reportForResponse(storedReport.report_json, storedReport.raw_expires_at)
        : undefined,
    }, 200, origin);
  }

  if (request.method === "POST" && action === "mobile-complete") {
    const body = await readBody<{
      operatorToken?: unknown;
      reviews?: unknown;
      confirmedEmpty?: unknown;
      partialReason?: unknown;
    }>(request);
    if (!validOperatorToken(body.operatorToken)) {
      return json({ error: "INVALID_OPERATOR_TOKEN" }, 401, origin);
    }
    if (
      !Array.isArray(body.reviews) ||
      body.reviews.length > 500 ||
      (!body.reviews.length && body.confirmedEmpty !== true) ||
      !body.reviews.every(validateReview)
    ) {
      return json({ error: "INVALID_REVIEWS" }, 400, origin);
    }
    if (body.partialReason !== undefined && body.partialReason !== "summary_only") {
      return json({ error: "INVALID_PARTIAL_REASON" }, 400, origin);
    }

    const now = new Date().toISOString();
    const tokenHash = await hashOperatorToken(body.operatorToken);
    const claimed = await env.DB.prepare(
      `UPDATE jobs
       SET status = 'analyzing',
           claimed_by = 'mobile-safari',
           started_at = COALESCE(started_at, ?),
           heartbeat_at = ?,
           lease_expires_at = NULL,
           progress_json = ?,
           handoff_source = 'ios-safari',
           updated_at = ?
       WHERE id = ?
         AND (
           (
             status = 'waiting_for_operator'
             AND interruption_reason IN ('captcha', 'login_required', 'operator_required')
           )
           OR (status = 'analyzing' AND claimed_by = 'mobile-safari')
         )
         AND operator_token_hash = ?
         AND operator_token_expires_at >= ?
       RETURNING id, cache_key, product_json`,
    ).bind(
      now,
      now,
      JSON.stringify({ stage: "uploading", accepted: body.reviews.length, source: "ios-safari" }),
      now,
      jobId,
      tokenHash,
      now,
    ).first<{
      id: string;
      cache_key: string;
      product_json: string;
    }>();
    if (!claimed) {
      return json({ error: "MOBILE_HANDOFF_NOT_AVAILABLE" }, 409, origin);
    }

    try {
      const expiry = addDays(7);
      const reviews = body.reviews as CollectorReviewInput[];
      await env.DB.batch([
        env.DB.prepare("DELETE FROM reviews WHERE job_id = ?").bind(jobId),
        ...reviews.map((review) =>
          env.DB.prepare(
            `INSERT INTO reviews(
               job_id, review_id, rating, content, created_at, option_name,
               classification, raw_expires_at
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            jobId,
            review.id.trim(),
            review.rating,
            review.content.trim(),
            review.createdAt ?? null,
            review.option?.trim() || null,
            review.classification,
            expiry,
          )
        ),
      ]);
      const rows = (await env.DB.prepare(
        `SELECT review_id, rating, content, created_at, option_name, classification
         FROM reviews
         WHERE job_id = ?
         ORDER BY created_at DESC`,
      ).bind(jobId).all<StoredReview>()).results ?? [];
      const report = await buildReport(env, jobId, claimed.product_json, rows, {
        summaryOnly: body.partialReason === "summary_only",
        mobileSafari: true,
        skipAi: true,
      });
      const finalStatus = rows.length && body.partialReason !== "summary_only"
        ? "completed"
        : "partial";
      const finishedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR REPLACE INTO reports(
             cache_key, job_id, report_json, collected_at, raw_expires_at,
             report_expires_at
           ) VALUES(?, ?, ?, ?, ?, ?)`,
        ).bind(
          claimed.cache_key,
          jobId,
          JSON.stringify(report),
          report.collectedAt,
          report.rawExpiresAt,
          report.reportExpiresAt,
        ),
        env.DB.prepare(
          `UPDATE jobs
           SET status = ?,
               finished_at = ?,
               interruption_reason = NULL,
               progress_json = ?,
               operator_token_hash = NULL,
               operator_token_expires_at = NULL,
               updated_at = ?
           WHERE id = ?
             AND status = 'analyzing'
             AND claimed_by = 'mobile-safari'`,
        ).bind(
          finalStatus,
          finishedAt,
          JSON.stringify({ stage: "completing", accepted: rows.length, source: "ios-safari" }),
          finishedAt,
          jobId,
        ),
      ]);
      return json({ id: jobId, status: finalStatus, report }, 200, origin);
    } catch (error) {
      await env.DB.prepare(
        `UPDATE jobs
         SET status = 'waiting_for_operator',
             claimed_by = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'analyzing'
           AND claimed_by = 'mobile-safari'`,
      ).bind(new Date().toISOString(), jobId).run();
      throw error;
    }
  }

  if (request.method === "DELETE" && !action) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reviews WHERE job_id = ?").bind(jobId),
      env.DB.prepare("DELETE FROM reports WHERE job_id = ?").bind(jobId),
      env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId),
    ]);
    return json({ deleted: true }, 200, origin);
  }

  if (request.method === "POST" && action === "refresh") {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const operatorToken = createOperatorToken();
    const operatorTokenHash = await hashOperatorToken(operatorToken);
    await env.DB.prepare(
      `INSERT INTO jobs(
         id, cache_key, product_json, status, requested_at, created_at, updated_at,
         operator_token_hash, operator_token_expires_at
       ) VALUES(?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      job.cache_key,
      job.product_json,
      now,
      now,
      now,
      operatorTokenHash,
      addDays(MOBILE_TOKEN_TTL_DAYS),
    ).run();
    return json({
      id,
      status: "queued",
      operatorToken,
      previousJobId: jobId,
    }, 201, origin);
  }

  return json({ error: "NOT_FOUND" }, 404, origin);
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      return json({ error: message }, message === "INVALID_JSON" ? 400 : 500, allowedOrigin(request, env));
    }
  },
} satisfies ExportedHandler<AppEnv>;
