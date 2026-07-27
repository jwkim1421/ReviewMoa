import { createReport, enhanceVerdictWithAi } from "./analyze";
import type { Env, StoredReview } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
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

function allowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get("Origin") ?? "";
  if (/^chrome-extension:\/\//.test(origin)) return origin;
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

async function cleanup(env: Env) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews WHERE raw_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE report_expires_at < ?").bind(now),
  ]);
}

async function handle(request: Request, env: Env) {
  const url = new URL(request.url);
  const origin = allowedOrigin(request, env);
  if (request.method === "OPTIONS") return json(null, 204, origin);
  if (url.pathname === "/health") return json({ ok: true, service: "reviewmoa-api" }, 200, origin);

  await cleanup(env);

  if (request.method === "POST" && url.pathname === "/v1/products/resolve") {
    const body = await readBody<{ product: Record<string, unknown> }>(request);
    return json({ product: body.product }, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/jobs/probe") {
    const body = await readBody<{ product: { source: string; productId: string; experimental?: boolean } }>(request);
    const key = `${body.product.source}:${body.product.productId}:all`.toLowerCase();
    const cached = await env.DB.prepare(
      "SELECT report_json FROM reports WHERE cache_key = ? AND report_expires_at > ?",
    ).bind(key, new Date().toISOString()).first<{ report_json: string }>();
    let cachedReport: Record<string, unknown> | undefined;
    if (cached) {
      cachedReport = JSON.parse(cached.report_json) as Record<string, unknown>;
      const rawExpired = typeof cachedReport.rawExpiresAt === "string" &&
        cachedReport.rawExpiresAt < new Date().toISOString();
      if (rawExpired && Array.isArray(cachedReport.ratings)) {
        cachedReport = {
          ...cachedReport,
          ratings: cachedReport.ratings.map((rating) => ({
            ...(rating as Record<string, unknown>),
            reviews: [],
          })),
          limitations: [
            ...((cachedReport.limitations as string[] | undefined) ?? []),
            "원문 보존 기간 7일이 지나 대표 리뷰 원문이 만료되었습니다. 다시 불러오면 최신 원문을 확인할 수 있습니다.",
          ],
        };
      }
    }
    return json({
      capability: {
        status: body.product.experimental ? "partial" : "verified",
        hasReviewArea: true,
        supportsNewestSort: true,
        supportsRatingFilter: !body.product.experimental,
        requiresLogin: false,
        message: "확장 프로그램에서 실제 리뷰 영역을 다시 확인합니다.",
      },
      report: cachedReport ? { ...cachedReport, cached: true } : undefined,
    }, 200, origin);
  }

  if (request.method === "POST" && url.pathname === "/v1/jobs") {
    const body = await readBody<{ product: Record<string, unknown> & { source: string; productId: string } }>(request);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const key = `${body.product.source}:${body.product.productId}:all`.toLowerCase();
    await env.DB.prepare(
      "INSERT INTO jobs(id, cache_key, product_json, status, created_at, updated_at) VALUES(?, ?, ?, 'probing', ?, ?)",
    ).bind(id, key, JSON.stringify(body.product), now, now).run();
    return json({ id, status: "probing" }, 201, origin);
  }

  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/([^/]+))?$/);
  if (!jobMatch) return json({ error: "NOT_FOUND" }, 404, origin);
  const [, jobId, action] = jobMatch;
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<{
    id: string; cache_key: string; product_json: string; status: string;
  }>();
  if (!job) return json({ error: "JOB_NOT_FOUND" }, 404, origin);

  if (request.method === "GET" && !action) {
    const report = await env.DB.prepare("SELECT report_json FROM reports WHERE job_id = ?")
      .bind(jobId).first<{ report_json: string }>();
    return json({ ...job, product: JSON.parse(job.product_json), report: report ? JSON.parse(report.report_json) : undefined }, 200, origin);
  }

  if (request.method === "DELETE" && !action) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reviews WHERE job_id = ?").bind(jobId),
      env.DB.prepare("DELETE FROM reports WHERE job_id = ?").bind(jobId),
      env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(jobId),
    ]);
    return json({ deleted: true }, 200, origin);
  }

  if (request.method === "POST" && action === "reviews") {
    const body = await readBody<{ reviews: Array<{
      id: string; rating: number; content: string; createdAt?: string; option?: string; classification: string;
    }> }>(request);
    const expiry = addDays(7);
    const statements = body.reviews.slice(0, 500).map((review) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO reviews(job_id, review_id, rating, content, created_at, option_name, classification, raw_expires_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(jobId, review.id, review.rating, review.content.slice(0, 6000), review.createdAt ?? null, review.option ?? null, review.classification, expiry),
    );
    if (statements.length) await env.DB.batch(statements);
    await env.DB.prepare("UPDATE jobs SET status = 'collecting', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), jobId).run();
    return json({ accepted: statements.length }, 200, origin);
  }

  if (request.method === "POST" && (action === "complete" || action === "demo-complete")) {
    const rows = (await env.DB.prepare(
      "SELECT review_id, rating, content, created_at, option_name, classification FROM reviews WHERE job_id = ? ORDER BY created_at DESC",
    ).bind(jobId).all<StoredReview>()).results ?? [];
    let report = createReport(jobId, JSON.parse(job.product_json), rows);
    report = await enhanceVerdictWithAi(report, rows, env.OPENAI_API_KEY, env.AI_MODEL);
    const reportJson = JSON.stringify(report);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO reports(cache_key, job_id, report_json, collected_at, raw_expires_at, report_expires_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      ).bind(job.cache_key, jobId, reportJson, report.collectedAt, report.rawExpiresAt, report.reportExpiresAt),
      env.DB.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?")
        .bind(rows.length ? "completed" : "partial", new Date().toISOString(), jobId),
    ]);
    return json(report, 200, origin);
  }

  if (request.method === "POST" && action === "resume") {
    await env.DB.prepare("UPDATE jobs SET status = 'probing', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), jobId).run();
    return json({ id: jobId, status: "probing" }, 200, origin);
  }

  if (request.method === "POST" && action === "refresh") {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO jobs(id, cache_key, product_json, status, created_at, updated_at) VALUES(?, ?, ?, 'probing', ?, ?)",
    ).bind(id, job.cache_key, job.product_json, now, now).run();
    return json({ id, status: "probing", previousJobId: jobId }, 201, origin);
  }

  return json({ error: "NOT_FOUND" }, 404, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      return json({ error: message }, message === "INVALID_JSON" ? 400 : 500, allowedOrigin(request, env));
    }
  },
};
