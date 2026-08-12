import type { ProductIdentity, SourceSite } from "./types";

interface SourceDefinition {
  source: SourceSite;
  label: string;
  hosts: RegExp[];
  idPatterns: RegExp[];
}

export const SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    source: "naver",
    label: "네이버",
    hosts: [/smartstore\.naver\.com$/, /shopping\.naver\.com$/, /brand\.naver\.com$/],
    idPatterns: [/\/products\/(\d+)/, /[?&]id=(\d+)/, /\/catalog\/(\d+)/],
  },
  {
    source: "coupang",
    label: "쿠팡",
    hosts: [/coupang\.com$/],
    idPatterns: [/\/products\/(\d+)/, /[?&]productId=(\d+)/],
  },
  {
    source: "kurly",
    label: "컬리",
    hosts: [/kurly\.com$/],
    idPatterns: [/\/goods\/(\d+)/],
  },
  {
    source: "ohouse",
    label: "오늘의집",
    hosts: [/ohou\.se$/],
    idPatterns: [/\/productions\/(\d+)/],
  },
  {
    source: "11st",
    label: "11번가",
    hosts: [/(^|\.)11st\.co\.kr$/],
    idPatterns: [/\/products\/(\d+)/, /[?&]prdNo=(\d+)/],
  },
  {
    source: "ssg",
    label: "SSG닷컴",
    hosts: [/(^|\.)ssg\.com$/],
    idPatterns: [/[?&]itemId=([A-Za-z0-9]+)/, /\/item\/([A-Za-z0-9]+)/],
  },
  {
    source: "gmarket",
    label: "G마켓",
    hosts: [/(^|\.)gmarket\.co\.kr$/],
    idPatterns: [/[?&]goodscode=(\d+)/i, /[?&]goodsCode=(\d+)/],
  },
];

const TRACKING_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "NaPm",
  "sourceType",
];

export class ProductUrlError extends Error {}

function extractUrl(input: string): string {
  const trimmed = input.trim();
  const explicit = trimmed.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  if (explicit) return explicit.replace(/[),.;]+$/, "");
  const domainLike = trimmed.match(/(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/[^\s]*)?/i)?.[0];
  if (domainLike) return `https://${domainLike}`;
  throw new ProductUrlError("상품 주소를 찾지 못했어요. URL 전체를 붙여넣어 주세요.");
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
}

function findSource(host: string): SourceDefinition | undefined {
  return SOURCE_DEFINITIONS.find((definition) =>
    definition.hosts.some((pattern) => pattern.test(host)),
  );
}

function fallbackId(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  const meaningful = path.split("/").filter(Boolean).pop();
  return meaningful || `${url.hostname}${url.pathname}`;
}

export function resolveProductInput(input: string): ProductIdentity {
  let url: URL;
  try {
    url = new URL(extractUrl(input));
  } catch (error) {
    if (error instanceof ProductUrlError) throw error;
    throw new ProductUrlError("올바른 상품 주소인지 확인해 주세요.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ProductUrlError("웹 상품 주소만 지원합니다.");
  }

  url.protocol = "https:";
  url.hostname = normalizeHost(url.hostname);
  url.hash = "";
  TRACKING_KEYS.forEach((key) => url.searchParams.delete(key));

  const definition = findSource(url.hostname);
  const productId =
    definition?.idPatterns
      .map((pattern) => url.href.match(pattern)?.[1])
      .find(Boolean) ?? fallbackId(url);

  return {
    source: definition?.source ?? "generic",
    sourceLabel: definition?.label ?? "기타 쇼핑몰",
    originalUrl: extractUrl(input),
    canonicalUrl: url.toString(),
    productId,
    experimental: !definition,
  };
}

// 네이버 플레이스(장소) 주소인지 판별한다. 장소 리뷰는 상품과 구조가 전혀 달라 아직
// 지원하지 않으므로, 서버로 보내 UNSUPPORTED_SOURCE로 막기 전에 안내로 대체한다.
export function isNaverPlaceUrl(input: string): boolean {
  try {
    const url = new URL(extractUrl(input));
    return /(^|\.)place\.naver\.com$/.test(normalizeHost(url.hostname));
  } catch {
    return false;
  }
}

export function cacheKey(product: ProductIdentity, optionId = "all"): string {
  return `${product.source}:${product.productId}:${optionId}`.toLowerCase();
}
