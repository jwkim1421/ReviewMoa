import { describe, expect, it } from "vitest";
import {
  isAllowedNavigationUrl,
  isAllowedProductUrl,
  isKnownLoginUrl,
} from "../src/url-safety";

describe("collector URL safety", () => {
  it("allows only HTTPS URLs on configured shopping hosts", () => {
    expect(isAllowedProductUrl("https://smartstore.naver.com/store/products/123")).toBe(true);
    expect(isAllowedProductUrl("https://m.coupang.com/vp/products/123")).toBe(true);
    expect(isAllowedProductUrl("https://shop.11st.co.kr/products/123")).toBe(true);
  });

  it("blocks deceptive hosts, credentials, ports, and local URLs", () => {
    expect(isAllowedProductUrl("https://smartstore.naver.com.evil.example/products/123")).toBe(false);
    expect(isAllowedProductUrl("https://user:pass@smartstore.naver.com/products/123")).toBe(false);
    expect(isAllowedProductUrl("https://smartstore.naver.com:8443/products/123")).toBe(false);
    expect(isAllowedProductUrl("http://smartstore.naver.com/products/123")).toBe(false);
    expect(isAllowedProductUrl("https://127.0.0.1/products/123")).toBe(false);
  });

  it("allows known login redirects without treating them as product pages", () => {
    expect(isKnownLoginUrl("https://nid.naver.com/nidlogin.login")).toBe(true);
    expect(isAllowedNavigationUrl("https://nid.naver.com/nidlogin.login")).toBe(true);
    expect(isAllowedProductUrl("https://nid.naver.com/nidlogin.login")).toBe(false);
    expect(isAllowedNavigationUrl("https://internal.example/login")).toBe(false);
  });
});
