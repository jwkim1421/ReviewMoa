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
// 서버가 받아들이는 쇼핑몰 소스 화이트리스트. 목록에 없는 소스는 거부해 임의
// 호스트로 향하는 작업 생성(SSRF 성격)과 미지원 사이트의 무한 대기를 막는다.
const ALLOWED_SOURCES = new Set([
  "naver",
  "coupang",
  "kurly",
  "ohouse",
  "11st",
  "ssg",
  "gmarket",
]);
// 공개 작업 생성 요청 제한. IP는 시간당, 전체는 일일 상한으로 남용과 비용을 막는다.
const RATE_LIMIT_PER_IP_HOURLY = 30;
const RATE_LIMIT_GLOBAL_DAILY = 300;

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

function isTransientD1Error(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /D1_ERROR|storage operation exceeded timeout|object to be reset/i.test(message);
}

async function runIdempotentInsert(
  db: D1Database,
  sql: string,
  bindings: unknown[],
) {
  try {
    await db.prepare(sql).bind(...bindings).run();
  } catch (error) {
    if (!isTransientD1Error(error)) throw error;
    await db.prepare(sql).bind(...bindings).run();
  }
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

function adminAuthorized(request: Request, env: AppEnv) {
  const token = env.ADMIN_TOKEN?.trim();
  return Boolean(token && request.headers.get("Authorization") === `Bearer ${token}`);
}

function parseRecord(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function safeText(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function safeCount(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function safeBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function publicJobProgress(value: string | null) {
  const progress = parseRecord(value);
  if (!progress) return undefined;
  return {
    stage: safeText(progress.stage, 80),
    source: safeText(progress.source, 80),
    rating: safeCount(progress.rating),
    checked: safeCount(progress.checked),
    accepted: safeCount(progress.accepted),
    message: safeText(progress.message, 300),
  };
}

function safeNumberMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, count]) => Number.isInteger(count) && Number(count) >= 0)
    .slice(0, 10);
  return entries.length ? Object.fromEntries(entries.map(([key, count]) => [key, Number(count)])) : undefined;
}

function safeDiagnosticProgress(value: string | null) {
  const progress = parseRecord(value);
  if (!progress) return undefined;
  const diagnostics = progress.collectorDiagnostics &&
      typeof progress.collectorDiagnostics === "object" &&
      !Array.isArray(progress.collectorDiagnostics)
    ? progress.collectorDiagnostics as Record<string, unknown>
    : undefined;
  const validation = diagnostics?.validation &&
      typeof diagnostics.validation === "object" &&
      !Array.isArray(diagnostics.validation)
    ? diagnostics.validation as Record<string, unknown>
    : undefined;
  const sourceTotal = diagnostics?.sourceTotal &&
      typeof diagnostics.sourceTotal === "object" &&
      !Array.isArray(diagnostics.sourceTotal)
    ? diagnostics.sourceTotal as Record<string, unknown>
    : undefined;

  return {
    stage: safeText(progress.stage, 80),
    source: safeText(progress.source, 80),
    rating: safeCount(progress.rating),
    checked: safeCount(progress.checked),
    accepted: safeCount(progress.accepted),
    extensionVersion: safeText(progress.extensionVersion, 40),
    diagnostics: diagnostics
      ? {
          adapter: safeText(diagnostics.adapter, 80),
          pageKind: safeText(diagnostics.pageKind, 80),
          mobile: safeBoolean(diagnostics.mobile),
          failure: safeText(diagnostics.failure, 160),
          collectionStrategy: safeText(diagnostics.collectionStrategy, 80),
          ready: safeBoolean(diagnostics.ready),
          summaryDetected: safeBoolean(diagnostics.summaryDetected),
          attemptCount: Array.isArray(diagnostics.attempts) ? diagnostics.attempts.length : undefined,
          sourceDistribution: safeNumberMap(diagnostics.sourceDistribution),
          ratingDistribution: safeNumberMap(diagnostics.ratingDistribution),
          collectionTargets: safeNumberMap(diagnostics.collectionTargets),
          validation: validation
            ? { ok: safeBoolean(validation.ok), reason: safeText(validation.reason, 160) }
            : undefined,
          sourceTotal: sourceTotal
            ? {
                ok: safeBoolean(sourceTotal.ok),
                reason: safeText(sourceTotal.reason, 160),
                displayedReviewTotal: safeCount(sourceTotal.displayedReviewTotal),
                sourceReviewCount: safeCount(sourceTotal.sourceReviewCount),
              }
            : undefined,
        }
      : undefined,
  };
}

function adminStatusGroup(status: string): "successful" | "failed" | "waiting" | "active" {
  if (["completed", "partial"].includes(status)) return "successful";
  if (["failed", "cancelled"].includes(status)) return "failed";
  if (["waiting_for_login", "waiting_for_user", "waiting_for_operator"].includes(status)) {
    return "waiting";
  }
  return "active";
}

interface AdminJobRow {
  id: string;
  product_json: string;
  status: string;
  error_code: string | null;
  progress_json: string | null;
  interruption_reason: string | null;
  claimed_by: string | null;
  handoff_source: string | null;
  attempt_count: number | null;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

function serializeAdminJob(row: AdminJobRow) {
  const product = parseRecord(row.product_json);
  const progress = safeDiagnosticProgress(row.progress_json);
  return {
    id: row.id,
    product: {
      source: safeText(product?.source, 40) ?? "unknown",
      sourceLabel: safeText(product?.sourceLabel, 40),
      productId: safeText(product?.productId, 120) ?? "unknown",
    },
    status: row.status,
    statusGroup: adminStatusGroup(row.status),
    errorCode: row.error_code,
    interruptionReason: row.interruption_reason,
    collector: row.claimed_by,
    handoffSource: row.handoff_source,
    attemptCount: row.attempt_count ?? 0,
    retryable: [
      "partial",
      "failed",
      "cancelled",
      "waiting_for_login",
      "waiting_for_user",
      "waiting_for_operator",
    ].includes(row.status),
    requestedAt: row.requested_at ?? row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    progress,
  };
}

function summarizeAdminJobs(jobs: ReturnType<typeof serializeAdminJob>[]) {
  const status = { successful: 0, failed: 0, waiting: 0, active: 0 };
  const bySource: Record<string, { total: number; successful: number; failed: number }> = {};
  const byExtensionVersion: Record<string, { total: number; successful: number; failed: number }> = {};
  const byErrorCode: Record<string, number> = {};

  for (const job of jobs) {
    status[job.statusGroup] += 1;
    const source = job.product.source;
    bySource[source] ??= { total: 0, successful: 0, failed: 0 };
    bySource[source].total += 1;
    if (job.statusGroup === "successful") bySource[source].successful += 1;
    if (job.statusGroup === "failed") bySource[source].failed += 1;

    const version = job.progress?.extensionVersion;
    if (version) {
      byExtensionVersion[version] ??= { total: 0, successful: 0, failed: 0 };
      byExtensionVersion[version].total += 1;
      if (job.statusGroup === "successful") byExtensionVersion[version].successful += 1;
      if (job.statusGroup === "failed") byExtensionVersion[version].failed += 1;
    }
    if (job.errorCode) byErrorCode[job.errorCode] = (byErrorCode[job.errorCode] ?? 0) + 1;
  }

  const terminal = status.successful + status.failed;
  return {
    total: jobs.length,
    ...status,
    successRate: terminal ? Math.round(status.successful / terminal * 100) : null,
    bySource,
    byExtensionVersion,
    byErrorCode,
  };
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

function validSource(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_SOURCES.has(value);
}

function validProductId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    !/\s/.test(value);
}

function clientIpBucket(request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return hashOperatorToken(ip).then((hash) => `ip:${hash.slice(0, 32)}`);
}

// rate_events에 원자적으로 1을 더하되 한도 미만일 때만 성공한다. reserveAiRequest와
// 같은 SQLite UPSERT + 조건부 UPDATE + RETURNING 패턴을 사용한다.
async function reserveRateSlot(
  env: AppEnv,
  bucket: string,
  windowStart: string,
  limit: number,
) {
  const now = new Date().toISOString();
  const reservation = await env.DB.prepare(
    `INSERT INTO rate_events(bucket, window_start, count, updated_at)
     VALUES(?, ?, 1, ?)
     ON CONFLICT(bucket, window_start) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at
     WHERE count < ?
     RETURNING count`,
  ).bind(bucket, windowStart, now, limit).first<{ count: number }>();
  return Boolean(reservation);
}

// 공개 작업 생성에 IP 시간당 + 전체 일일 제한을 적용한다. 둘 중 하나라도 초과하면
// false를 돌려주고 호출부에서 429로 응답한다.
async function withinJobRateLimit(request: Request, env: AppEnv) {
  const now = new Date().toISOString();
  const hourWindow = now.slice(0, 13);
  const dayWindow = now.slice(0, 10);
  const ipBucket = await clientIpBucket(request);
  const globalOk = await reserveRateSlot(env, "jobs:global", dayWindow, RATE_LIMIT_GLOBAL_DAILY);
  if (!globalOk) return false;
  return reserveRateSlot(env, `jobs:${ipBucket}`, hourWindow, RATE_LIMIT_PER_IP_HOURLY);
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

// 저장용 보고서에서 대표 리뷰 원문을 제거한다. 원문은 reviews 테이블(7일 만료)에만
// 남기고 report_json에는 review_id 참조와 별점·분류만 저장해, 30일 보관되는 보고서
// JSON에 원문이 남지 않도록 한다(보존 정책 버그 수정).
function stripRawFromReport<T extends { ratings?: unknown }>(report: T): T {
  if (!Array.isArray(report.ratings)) return report;
  return {
    ...report,
    ratings: report.ratings.map((rating) => {
      const record = rating as Record<string, unknown>;
      return {
        ...record,
        reviews: Array.isArray(record.reviews)
          ? record.reviews.map((review) => {
              const item = review as Record<string, unknown>;
              return {
                id: item.id,
                rating: item.rating,
                classification: item.classification,
              };
            })
          : record.reviews,
      };
    }),
  };
}

// 저장된 보고서를 응답용으로 복원한다. 원문 보존 기간이 남아 있으면 reviews
// 테이블에서 대표 리뷰 원문을 채우고, 만료됐으면 원문을 비운 채 안내를 덧붙인다.
// probe, 캐시 응답, GET 작업 조회가 모두 이 함수를 거쳐 만료 원문이 노출되지 않게 한다.
async function hydrateStoredReport(
  env: AppEnv,
  jobId: string,
  reportJson: string,
  rawExpiresAt?: string | null,
  cached = false,
) {
  const report = JSON.parse(reportJson) as Record<string, unknown>;
  if (report.collectionVerified !== true) return undefined;
  const rawExpiry = rawExpiresAt ??
    (typeof report.rawExpiresAt === "string" ? report.rawExpiresAt : null);
  const rawExpired = Boolean(rawExpiry && rawExpiry < new Date().toISOString());
  if (!Array.isArray(report.ratings)) {
    return { ...report, cached };
  }
  if (rawExpired) {
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

  const ids = report.ratings.flatMap((rating) => {
    const reviews = (rating as Record<string, unknown>).reviews;
    return Array.isArray(reviews)
      ? reviews
          .map((review) => (review as Record<string, unknown>).id)
          .filter((id): id is string => typeof id === "string")
      : [];
  });
  const contentById = new Map<string, {
    content: string;
    created_at: string | null;
    option_name: string | null;
  }>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = (await env.DB.prepare(
      `SELECT review_id, content, created_at, option_name
       FROM reviews
       WHERE job_id = ? AND review_id IN (${placeholders})`,
    ).bind(jobId, ...ids).all<{
      review_id: string;
      content: string;
      created_at: string | null;
      option_name: string | null;
    }>()).results ?? [];
    for (const row of rows) {
      contentById.set(row.review_id, {
        content: row.content,
        created_at: row.created_at,
        option_name: row.option_name,
      });
    }
  }

  return {
    ...report,
    cached,
    ratings: report.ratings.map((rating) => {
      const record = rating as Record<string, unknown>;
      const reviews = Array.isArray(record.reviews)
        ? record.reviews
            .map((review) => {
              const item = review as Record<string, unknown>;
              const found = typeof item.id === "string" ? contentById.get(item.id) : undefined;
              if (!found) return undefined;
              return {
                ...item,
                content: found.content,
                createdAt: found.created_at ?? undefined,
                option: found.option_name ?? undefined,
              };
            })
            .filter((review) => review !== undefined)
        : record.reviews;
      return { ...record, reviews };
    }),
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
           interruption_reason = 'operator_required',
           progress_json = ?,
           updated_at = ?
       WHERE status IN ('collecting', 'analyzing')
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

// Cron Trigger로 실행하는 종합 만료 정리. 요청이 없어도 오래된 원문·보고서·작업·토큰을
// 지워, 원문 7일·보고서 30일 보존 정책을 요청 트래픽과 무관하게 강제한다.
async function scheduledCleanup(env: AppEnv) {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const staleMobileAnalysis = new Date(Date.now() - 2 * 60_000).toISOString();
  await env.DB.batch([
    // 7일 지난 원문, 30일 지난 보고서 실제 삭제
    env.DB.prepare("DELETE FROM reviews WHERE raw_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE report_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM ai_daily_usage WHERE day < ?").bind(day),
    env.DB.prepare("DELETE FROM rate_events WHERE window_start < ?").bind(twoDaysAgo),
    // 만료된 모바일 인계 토큰 무효화
    env.DB.prepare(
      `UPDATE jobs
       SET operator_token_hash = NULL,
           operator_token_expires_at = NULL,
           updated_at = ?
       WHERE operator_token_expires_at IS NOT NULL
         AND operator_token_expires_at < ?`,
    ).bind(now, now),
    // 종료된 지 30일 넘은 작업 삭제(관련 원문·보고서는 이미 만료 삭제됨)
    env.DB.prepare(
      `DELETE FROM jobs
       WHERE status IN ('completed', 'partial', 'failed', 'cancelled')
         AND COALESCE(finished_at, updated_at) < ?`,
    ).bind(thirtyDaysAgo),
    // 3일 넘게 수집기가 가져가지 않은 대기 작업 정리
    env.DB.prepare(
      `DELETE FROM jobs
       WHERE status IN ('queued', 'probing')
         AND COALESCE(requested_at, created_at) < ?`,
    ).bind(threeDaysAgo),
    // 리뷰·보고서가 사라진 고아 작업(비종료 상태 제외) 정리
    env.DB.prepare(
      `DELETE FROM jobs
       WHERE status IN ('completed', 'partial')
         AND NOT EXISTS (SELECT 1 FROM reports WHERE reports.job_id = jobs.id)
         AND COALESCE(finished_at, updated_at) < ?`,
    ).bind(threeDaysAgo),
    // 멈춘 모바일 수집 작업을 운영자 대기로 되돌림
    env.DB.prepare(
      `UPDATE jobs
       SET status = 'waiting_for_operator',
           claimed_by = NULL,
           interruption_reason = 'operator_required',
           updated_at = ?
       WHERE status IN ('collecting', 'analyzing')
         AND claimed_by = 'mobile-safari'
         AND updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM reports WHERE reports.job_id = jobs.id)`,
    ).bind(now, staleMobileAnalysis),
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
    collectorDiagnostics?: unknown;
  },
) {
  const sourceDistribution = readCollectorSourceDistribution(options?.collectorDiagnostics);
  let report = createReport(jobId, JSON.parse(productJson), rows, { sourceDistribution });
  if (options?.summaryOnly) {
    report.limitations.push(
      "전체 리뷰 목록을 자동으로 열지 못해 상품 페이지에 공개된 대표 리뷰만 반영했습니다.",
    );
  }
  if (options?.mobileSafari) {
    report.confidenceReasons.push(
      "iPhone Safari에서 사용자가 보안 확인 후 수집한 공개 리뷰를 반영",
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
  if (options?.mobileSafari && report.analysisProvider === "rules" && !report.limitations.some(
    (item) => item.includes("규칙 기반"),
  )) {
    report.limitations.push("AI 분석을 사용할 수 없어 규칙 기반 결과를 표시합니다.");
  }
  return report;
}

function readCollectorSourceDistribution(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as { sourceDistribution?: unknown }).sourceDistribution;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const distribution = {} as Partial<Record<1 | 2 | 3 | 4 | 5, number>>;
  for (const rating of [1, 2, 3, 4, 5] as const) {
    const count = (candidate as Record<string, unknown>)[String(rating)];
    if (!Number.isInteger(count) || Number(count) < 0) return undefined;
    distribution[rating] = Number(count);
  }
  return distribution;
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

  const adminPath = url.pathname.startsWith("/v1/admin/");
  if (adminPath && !adminAuthorized(request, env)) {
    return json({ error: "UNAUTHORIZED" }, 401, origin);
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/diagnostics") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;
    const result = await env.DB.prepare(
      `SELECT id, product_json, status, error_code, progress_json,
              interruption_reason, claimed_by, handoff_source, attempt_count,
              requested_at, started_at, finished_at, created_at, updated_at
       FROM jobs
       ORDER BY updated_at DESC
       LIMIT ?`,
    ).bind(limit).all<AdminJobRow>();
    const jobs = result.results.map(serializeAdminJob);
    return json({
      generatedAt: new Date().toISOString(),
      limit,
      summary: summarizeAdminJobs(jobs),
      jobs,
    }, 200, origin);
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
          JSON.stringify(stripRawFromReport(report)),
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
      `SELECT job_id, report_json, raw_expires_at
       FROM reports
       WHERE cache_key = ? AND report_expires_at > ?`,
    ).bind(key, new Date().toISOString()).first<{
      job_id: string;
      report_json: string;
      raw_expires_at: string;
    }>();
    const cachedReport = cached
      ? await hydrateStoredReport(env, cached.job_id, cached.report_json, cached.raw_expires_at, true)
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
      collector?: unknown;
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
    if (!validSource(body.product.source) || !validProductId(body.product.productId)) {
      return json({ error: "UNSUPPORTED_SOURCE" }, 400, origin);
    }
    if (body.collector !== undefined && body.collector !== "ios-safari") {
      return json({ error: "INVALID_COLLECTOR" }, 400, origin);
    }
    const mobileRequested = body.collector === "ios-safari";
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
      const report = await hydrateStoredReport(
        env,
        cached.job_id,
        cached.report_json,
        cached.raw_expires_at,
        true,
      );
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
      let status = active.status;
      if (
        mobileRequested &&
        ["queued", "waiting_for_operator", "waiting_for_login", "waiting_for_user"].includes(active.status)
      ) {
        const claimed = await env.DB.prepare(
          `UPDATE jobs
           SET status = 'collecting',
               claimed_by = 'mobile-safari',
               started_at = COALESCE(started_at, ?),
               heartbeat_at = ?,
               lease_expires_at = NULL,
               interruption_reason = NULL,
               progress_json = ?,
               handoff_source = 'ios-safari',
               operator_token_hash = ?,
               operator_token_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND status IN (
               'queued', 'waiting_for_operator', 'waiting_for_login', 'waiting_for_user'
             )
           RETURNING id`,
        ).bind(
          now,
          now,
          JSON.stringify({
            stage: "opening_product",
            message: "iPhone Safari에서 상품 페이지를 열고 있어요.",
            source: "ios-safari",
          }),
          operatorTokenHash,
          operatorTokenExpiresAt,
          now,
          active.id,
        ).first<{ id: string }>();
        if (claimed) status = "collecting";
      } else {
        await env.DB.prepare(
          `UPDATE jobs
           SET operator_token_hash = ?,
               operator_token_expires_at = ?,
               updated_at = ?
           WHERE id = ?`,
        ).bind(operatorTokenHash, operatorTokenExpiresAt, now, active.id).run();
      }
      return json({
        id: active.id,
        status,
        operatorToken,
        deduplicated: true,
      }, 200, origin);
    }

    if (!await withinJobRateLimit(request, env)) {
      return json({ error: "RATE_LIMITED" }, 429, origin);
    }

    const status = mobileRequested ? "collecting" : "queued";
    const progress = mobileRequested
      ? JSON.stringify({
          stage: "opening_product",
          message: "iPhone Safari에서 상품 페이지를 열고 있어요.",
          source: "ios-safari",
        })
      : null;
    await runIdempotentInsert(
      env.DB,
      `INSERT OR IGNORE INTO jobs(
         id, cache_key, product_json, status, requested_at, created_at, updated_at,
         operator_token_hash, operator_token_expires_at, claimed_by, started_at,
         heartbeat_at, progress_json, handoff_source
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        key,
        JSON.stringify(body.product),
        status,
        now,
        now,
        now,
        operatorTokenHash,
        operatorTokenExpiresAt,
        mobileRequested ? "mobile-safari" : null,
        mobileRequested ? now : null,
        mobileRequested ? now : null,
        progress,
        mobileRequested ? "ios-safari" : null,
      ],
    );
    return json({ id, status, operatorToken }, 201, origin);
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
    const report = storedReport
      ? await hydrateStoredReport(env, jobId, storedReport.report_json, storedReport.raw_expires_at)
      : undefined;
    return json({
      id: job.id,
      status: job.status,
      product: JSON.parse(job.product_json),
      capability: job.capability_json ? JSON.parse(job.capability_json) : undefined,
      progress: publicJobProgress(job.progress_json),
      interruptionReason: job.interruption_reason,
      errorCode: job.error_code,
      requestedAt: job.requested_at ?? job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      updatedAt: job.updated_at,
      report,
    }, 200, origin);
  }

  if (request.method === "POST" && action === "mobile-start") {
    const body = await readBody<{ operatorToken?: unknown }>(request);
    if (!validOperatorToken(body.operatorToken)) {
      return json({ error: "INVALID_OPERATOR_TOKEN" }, 401, origin);
    }
    const now = new Date().toISOString();
    const tokenHash = await hashOperatorToken(body.operatorToken);
    const claimed = await env.DB.prepare(
      `UPDATE jobs
       SET status = 'collecting',
           claimed_by = 'mobile-safari',
           started_at = COALESCE(started_at, ?),
           heartbeat_at = ?,
           lease_expires_at = NULL,
           interruption_reason = NULL,
           progress_json = ?,
           handoff_source = 'ios-safari',
           updated_at = ?
       WHERE id = ?
         AND (
           status = 'queued'
           OR (
             status = 'waiting_for_operator'
             AND interruption_reason IN (
               'captcha', 'login_required', 'access_blocked', 'operator_required'
             )
           )
           OR (status = 'collecting' AND claimed_by = 'mobile-safari')
         )
         AND operator_token_hash = ?
         AND operator_token_expires_at >= ?
       RETURNING id`,
    ).bind(
      now,
      now,
      JSON.stringify({
        stage: "opening_product",
        message: "iPhone Safari에서 상품 페이지를 열고 있어요.",
        source: "ios-safari",
      }),
      now,
      jobId,
      tokenHash,
      now,
    ).first<{ id: string }>();
    return claimed
      ? json({ id: jobId, status: "collecting" }, 200, origin)
      : json({ error: "MOBILE_HANDOFF_NOT_AVAILABLE" }, 409, origin);
  }

  if (request.method === "POST" && action === "mobile-interrupt") {
    const body = await readBody<{
      operatorToken?: unknown;
      reason?: unknown;
    }>(request);
    if (!validOperatorToken(body.operatorToken)) {
      return json({ error: "INVALID_OPERATOR_TOKEN" }, 401, origin);
    }
    if (
      typeof body.reason !== "string" ||
      !["captcha", "login_required", "access_blocked", "operator_required"].includes(body.reason)
    ) {
      return json({ error: "INVALID_INTERRUPTION_REASON" }, 400, origin);
    }
    const now = new Date().toISOString();
    const tokenHash = await hashOperatorToken(body.operatorToken);
    const interrupted = await env.DB.prepare(
      `UPDATE jobs
       SET status = 'waiting_for_operator',
           interruption_reason = ?,
           progress_json = ?,
           heartbeat_at = ?,
           updated_at = ?
       WHERE id = ?
         AND status = 'collecting'
         AND claimed_by = 'mobile-safari'
         AND operator_token_hash = ?
         AND operator_token_expires_at >= ?`,
    ).bind(
      body.reason,
      JSON.stringify({
        stage: "waiting_for_operator",
        message: "iPhone Safari에서 보안 확인을 완료해 주세요.",
        source: "ios-safari",
      }),
      now,
      now,
      jobId,
      tokenHash,
      now,
    ).run();
    return interrupted.meta.changes
      ? json({ id: jobId, status: "waiting_for_operator", reason: body.reason }, 200, origin)
      : json({ error: "MOBILE_HANDOFF_NOT_AVAILABLE" }, 409, origin);
  }

  if (request.method === "POST" && action === "mobile-fail") {
    const body = await readBody<{
      operatorToken?: unknown;
      reason?: unknown;
      message?: unknown;
      extensionVersion?: unknown;
      collectorDiagnostics?: unknown;
    }>(request);
    if (!validOperatorToken(body.operatorToken)) {
      return json({ error: "INVALID_OPERATOR_TOKEN" }, 401, origin);
    }
    if (
      typeof body.reason !== "string" ||
      !/^[a-z0-9_]{1,80}$/.test(body.reason) ||
      typeof body.message !== "string" ||
      !body.message.trim() ||
      body.message.length > 500
    ) {
      return json({ error: "INVALID_MOBILE_FAILURE" }, 400, origin);
    }
    if (
      body.extensionVersion !== undefined &&
      (typeof body.extensionVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(body.extensionVersion))
    ) {
      return json({ error: "INVALID_EXTENSION_VERSION" }, 400, origin);
    }
    if (
      body.collectorDiagnostics !== undefined &&
      (
        !body.collectorDiagnostics ||
        typeof body.collectorDiagnostics !== "object" ||
        Array.isArray(body.collectorDiagnostics) ||
        JSON.stringify(body.collectorDiagnostics).length > 4_000
      )
    ) {
      return json({ error: "INVALID_COLLECTOR_DIAGNOSTICS" }, 400, origin);
    }
    const now = new Date().toISOString();
    const tokenHash = await hashOperatorToken(body.operatorToken);
    const failed = await env.DB.prepare(
      `UPDATE jobs
       SET status = 'failed',
           error_code = ?,
           interruption_reason = NULL,
           progress_json = ?,
           heartbeat_at = ?,
           finished_at = ?,
           operator_token_hash = NULL,
           operator_token_expires_at = NULL,
           updated_at = ?
       WHERE id = ?
         AND status = 'collecting'
         AND claimed_by = 'mobile-safari'
         AND operator_token_hash = ?
         AND operator_token_expires_at >= ?`,
    ).bind(
      body.reason,
      JSON.stringify({
        stage: "failed",
        message: body.message.trim(),
        source: "ios-safari",
        extensionVersion: body.extensionVersion,
        collectorDiagnostics: body.collectorDiagnostics,
      }),
      now,
      now,
      now,
      jobId,
      tokenHash,
      now,
    ).run();
    return failed.meta.changes
      ? json({ id: jobId, status: "failed", errorCode: body.reason }, 200, origin)
      : json({ error: "MOBILE_HANDOFF_NOT_AVAILABLE" }, 409, origin);
  }

  if (request.method === "POST" && action === "mobile-heartbeat") {
    const body = await readBody<{
      operatorToken?: unknown;
      progress?: unknown;
    }>(request);
    if (!validOperatorToken(body.operatorToken)) {
      return json({ error: "INVALID_OPERATOR_TOKEN" }, 401, origin);
    }
    const now = new Date().toISOString();
    const tokenHash = await hashOperatorToken(body.operatorToken);
    const progress = body.progress && typeof body.progress === "object"
      ? JSON.stringify({ ...(body.progress as Record<string, unknown>), source: "ios-safari" })
      : JSON.stringify({ stage: "collecting", source: "ios-safari" });
    const heartbeat = await env.DB.prepare(
      `UPDATE jobs
       SET heartbeat_at = ?,
           progress_json = ?,
           updated_at = ?
       WHERE id = ?
         AND status = 'collecting'
         AND claimed_by = 'mobile-safari'
         AND operator_token_hash = ?
         AND operator_token_expires_at >= ?`,
    ).bind(now, progress, now, jobId, tokenHash, now).run();
    return heartbeat.meta.changes
      ? json({ id: jobId, status: "collecting" }, 200, origin)
      : json({ error: "MOBILE_HANDOFF_NOT_AVAILABLE" }, 409, origin);
  }

  if (request.method === "POST" && action === "mobile-complete") {
    const body = await readBody<{
      operatorToken?: unknown;
      product?: unknown;
      reviews?: unknown;
      confirmedEmpty?: unknown;
      partialReason?: unknown;
      extensionVersion?: unknown;
      collectorDiagnostics?: unknown;
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
    if (
      body.extensionVersion !== undefined &&
      (typeof body.extensionVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(body.extensionVersion))
    ) {
      return json({ error: "INVALID_EXTENSION_VERSION" }, 400, origin);
    }
    if (
      body.collectorDiagnostics !== undefined &&
      (
        !body.collectorDiagnostics ||
        typeof body.collectorDiagnostics !== "object" ||
        Array.isArray(body.collectorDiagnostics) ||
        JSON.stringify(body.collectorDiagnostics).length > 4_000
      )
    ) {
      return json({ error: "INVALID_COLLECTOR_DIAGNOSTICS" }, 400, origin);
    }
    if (
      body.product !== undefined &&
      (
        !body.product ||
        typeof body.product !== "object" ||
        typeof (body.product as { name?: unknown }).name !== "string" ||
        !(body.product as { name: string }).name.trim() ||
        (body.product as { name: string }).name.length > 300
      )
    ) {
      return json({ error: "INVALID_PRODUCT_METADATA" }, 400, origin);
    }

    const now = new Date().toISOString();
    const tokenHash = await hashOperatorToken(body.operatorToken);
    const diagnosticProgress = {
      extensionVersion: body.extensionVersion,
      collectorDiagnostics: body.collectorDiagnostics,
      source: "ios-safari",
    };
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
             AND interruption_reason IN (
               'captcha', 'login_required', 'access_blocked', 'operator_required'
             )
           )
           OR (status = 'collecting' AND claimed_by = 'mobile-safari')
           OR (status = 'analyzing' AND claimed_by = 'mobile-safari')
         )
         AND operator_token_hash = ?
         AND operator_token_expires_at >= ?
       RETURNING id, cache_key, product_json`,
    ).bind(
      now,
      now,
      JSON.stringify({ stage: "uploading", accepted: body.reviews.length, ...diagnosticProgress }),
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
      const product = JSON.parse(claimed.product_json) as Record<string, unknown>;
      if (body.product && typeof body.product === "object") {
        product.name = (body.product as { name: string }).name.trim();
      }
      const report = await buildReport(env, jobId, JSON.stringify(product), rows, {
        summaryOnly: body.partialReason === "summary_only",
        mobileSafari: true,
        collectorDiagnostics: body.collectorDiagnostics,
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
          JSON.stringify(stripRawFromReport(report)),
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
          JSON.stringify({ stage: "completing", accepted: rows.length, ...diagnosticProgress }),
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
    const body = request.headers.get("Content-Type")
      ? await readBody<{ collector?: unknown }>(request)
      : {};
    if (body.collector !== undefined && body.collector !== "ios-safari") {
      return json({ error: "INVALID_COLLECTOR" }, 400, origin);
    }
    const mobileRequested = body.collector === "ios-safari";
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const operatorToken = createOperatorToken();
    const operatorTokenHash = await hashOperatorToken(operatorToken);
    const status = mobileRequested ? "collecting" : "queued";
    const progress = mobileRequested
      ? JSON.stringify({
          stage: "opening_product",
          message: "iPhone Safari에서 상품 페이지를 열고 있어요.",
          source: "ios-safari",
        })
      : null;
    await runIdempotentInsert(
      env.DB,
      `INSERT OR IGNORE INTO jobs(
         id, cache_key, product_json, status, requested_at, created_at, updated_at,
         operator_token_hash, operator_token_expires_at, claimed_by, started_at,
         heartbeat_at, progress_json, handoff_source
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        job.cache_key,
        job.product_json,
        status,
        now,
        now,
        now,
        operatorTokenHash,
        addDays(MOBILE_TOKEN_TTL_DAYS),
        mobileRequested ? "mobile-safari" : null,
        mobileRequested ? now : null,
        mobileRequested ? now : null,
        progress,
        mobileRequested ? "ios-safari" : null,
      ],
    );
    return json({
      id,
      status,
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
      const publicMessage = isTransientD1Error(error) ? "TEMPORARY_DATABASE_ERROR" : message;
      return json({ error: publicMessage }, message === "INVALID_JSON" ? 400 : 500, allowedOrigin(request, env));
    }
  },
  async scheduled(_controller: ScheduledController, env: AppEnv): Promise<void> {
    await scheduledCleanup(env);
  },
} satisfies ExportedHandler<AppEnv>;
