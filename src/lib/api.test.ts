import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductIdentity } from "../domain/types";
import { createJob, getJob } from "./api";

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

  it("returns a useful message for an expired or unknown job", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "JOB_NOT_FOUND" }, { status: 404 })
    ));

    await expect(getJob("missing")).rejects.toThrow("저장된 작업을 찾지 못했습니다");
  });
});
