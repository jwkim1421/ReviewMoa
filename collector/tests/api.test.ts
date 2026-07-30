import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorApi, CollectorApiError } from "../src/api";
import type { CollectorReview } from "../src/types";

const CONFIG = {
  apiBase: "https://api.example",
  token: "collector-secret",
  collectorId: "home-mac-01",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collector API client", () => {
  it("returns null for an empty queue and sends the token only as authorization", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer collector-secret",
      });
      expect(init?.body).not.toContain("collector-secret");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CollectorApi(CONFIG).claim()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uploads reviews in batches of 100", async () => {
    const batchSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { reviews: unknown[] };
      batchSizes.push(body.reviews.length);
      return Response.json({ accepted: body.reviews.length });
    }));
    const reviews = Array.from({ length: 205 }, (_, index): CollectorReview => ({
      id: `review-${index}`,
      rating: 5,
      content: "만족합니다.",
      classification: "included",
    }));

    await expect(new CollectorApi(CONFIG).uploadReviews("job-1", reviews)).resolves.toBe(205);
    expect(batchSizes).toEqual([100, 100, 5]);
  });

  it("returns a typed error without exposing the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "LEASE_NOT_OWNED" }, { status: 409 })
    ));

    const error = await new CollectorApi(CONFIG).heartbeat("job-1", { stage: "opening" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollectorApiError);
    expect(error).toMatchObject({ status: 409, code: "LEASE_NOT_OWNED" });
    expect(String(error)).not.toContain(CONFIG.token);
  });
});
