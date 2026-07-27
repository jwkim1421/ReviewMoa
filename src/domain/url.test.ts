import { describe, expect, it } from "vitest";
import { ProductUrlError, cacheKey, resolveProductInput } from "./url";

describe("resolveProductInput", () => {
  it.each([
    ["https://smartstore.naver.com/shop/products/12345?utm_source=test", "naver", "12345"],
    ["www.coupang.com/vp/products/6094873732", "coupang", "6094873732"],
    ["상품입니다 https://www.kurly.com/goods/5061036 확인해 주세요", "kurly", "5061036"],
    ["https://ohou.se/productions/99123", "ohouse", "99123"],
    ["https://www.11st.co.kr/products/3430364683", "11st", "3430364683"],
    ["https://www.ssg.com/item/itemView.ssg?itemId=1000051461034", "ssg", "1000051461034"],
    ["https://item.gmarket.co.kr/Item?goodscode=123456", "gmarket", "123456"],
  ])("resolves %s", (input, source, productId) => {
    const product = resolveProductInput(input);
    expect(product.source).toBe(source);
    expect(product.productId).toBe(productId);
    expect(cacheKey(product)).toBe(`${source}:${productId}:all`.toLowerCase());
  });

  it("marks an unknown shop experimental", () => {
    expect(resolveProductInput("https://shop.example.com/item/abc").experimental).toBe(true);
  });

  it("rejects non-url text", () => {
    expect(() => resolveProductInput("상품 번호 12345")).toThrow(ProductUrlError);
  });
});
