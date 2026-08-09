import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductIdentity } from "../domain/types";

vi.stubEnv("VITE_API_BASE", "https://reviewmoa-api.test");
const { createJob, getAdminDiagnostics, getJob, refreshJob } = await import("./api");

const PRODUCT: ProductIdentity = {
  source: "naver",
  sourceLabel: "네이버",
  originalUrl: "https://smartstore.naver.com/store/products/123",
  canonicalUrl: "https://smartstore.naver.com/store/products/123",
  productId: "123",
  experimental: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queued job API client", () => {
  it("creates a queued job with the resolved product", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ product: PRODUCT });
      return Response.json({ id: "job-1", status: "queued" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createJob(PRODUCT)).resolves.toEqual({
      id: "job-1",
      status: "queued",
    });
  });

  it("requests an iPhone-owned job when the Safari extension is ready", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        product: PRODUCT,
        collector: "ios-safari",
      });
      return Response.json({ id: "job-mobile", status: "collecting" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createJob(PRODUCT, { collector: "ios-safari" })).resolves.toMatchObject({
      id: "job-mobile",
      status: "collecting",
    });
  });

  it("polls job state without forcing a CORS JSON preflight header", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty("Content-Type");
      return Response.json({
        id: "job-1",
        status: "collecting",
        product: PRODUCT,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJob("job-1")).resolves.toMatchObject({
      id: "job-1",
      status: "collecting",
    });
  });

  it("refreshes an existing job with the iPhone collector", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ collector: "ios-safari" });
      return Response.json({ id: "job-refresh", status: "collecting" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshJob("job-1", { collector: "ios-safari" })).resolves.toMatchObject({
      id: "job-refresh",
      status: "collecting",
    });
  });

  it("returns a useful message for an expired or unknown job", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "JOB_NOT_FOUND" }, { status: 404 })
    ));

    await expect(getJob("missing")).rejects.toThrow("저장된 작업을 찾지 못했습니다");
  });

  it("hides internal D1 details behind a retryable user message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "TEMPORARY_DATABASE_ERROR" }, { status: 500 })
    ));

    await expect(refreshJob("job-1", { collector: "ios-safari" })).rejects.toThrow(
      "저장소 응답이 잠시 지연되고 있습니다",
    );
  });

  it("sends the admin token only in the authorization header", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://reviewmoa-api.test/v1/admin/diagnostics?limit=25");
      expect(init?.headers).toEqual({ Authorization: "Bearer admin-secret" });
      expect(String(input)).not.toContain("admin-secret");
      return Response.json({
        generatedAt: "2026-08-09T00:00:00.000Z",
        limit: 25,
        summary: {
          total: 0,
          successful: 0,
          failed: 0,
          waiting: 0,
          active: 0,
          successRate: null,
          bySource: {},
          byExtensionVersion: {},
          byErrorCode: {},
        },
        jobs: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminDiagnostics("admin-secret", 25)).resolves.toMatchObject({
      limit: 25,
      jobs: [],
    });
  });

  it("shows a useful message when admin authentication fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "UNAUTHORIZED" }, { status: 401 })
    ));

    await expect(getAdminDiagnostics("wrong-token")).rejects.toThrow(
      "운영자 인증 정보가 올바르지 않습니다",
    );
  });
});
