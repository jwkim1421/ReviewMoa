export const SITE_CONFIGS = [
  {
    source: "naver",
    hosts: ["smartstore.naver.com", "shopping.naver.com", "brand.naver.com"],
    productId: [/\/products\/(\d+)/, /[?&]id=(\d+)/],
    reviewWords: ["리뷰", "구매평"],
  },
  {
    source: "coupang",
    hosts: ["coupang.com"],
    productId: [/\/products\/(\d+)/],
    reviewWords: ["상품평", "리뷰"],
  },
  {
    source: "kurly",
    hosts: ["kurly.com"],
    productId: [/\/goods\/(\d+)/],
    reviewWords: ["후기", "리뷰"],
  },
  {
    source: "ohouse",
    hosts: ["ohou.se"],
    productId: [/\/productions\/(\d+)/],
    reviewWords: ["리뷰", "후기"],
  },
  {
    source: "11st",
    hosts: ["11st.co.kr"],
    productId: [/\/products\/(\d+)/, /[?&]prdNo=(\d+)/],
    reviewWords: ["상품리뷰", "리뷰"],
  },
  {
    source: "ssg",
    hosts: ["ssg.com"],
    productId: [/[?&]itemId=([A-Za-z0-9]+)/],
    reviewWords: ["리뷰", "상품평"],
  },
  {
    source: "gmarket",
    hosts: ["gmarket.co.kr"],
    productId: [/[?&]goodscode=(\d+)/i],
    reviewWords: ["상품평", "리뷰"],
  },
];

export function getSiteConfig(url = location.href) {
  const parsed = new URL(url);
  return SITE_CONFIGS.find((item) =>
    item.hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)),
  );
}
