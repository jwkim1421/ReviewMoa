const ALLOWED_HOSTS = [
  "smartstore.naver.com",
  "shopping.naver.com",
  "brand.naver.com",
  "coupang.com",
  "kurly.com",
  "ohou.se",
  "11st.co.kr",
  "ssg.com",
  "gmarket.co.kr",
];

const LOGIN_HOSTS = [
  "nid.naver.com",
  "login.coupang.com",
];

function safeHttpsHost(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

export function isAllowedProductUrl(value: string) {
  const host = safeHttpsHost(value);
  if (!host) return false;
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function isKnownLoginUrl(value: string) {
  const host = safeHttpsHost(value);
  return Boolean(host && LOGIN_HOSTS.includes(host));
}

export function isAllowedNavigationUrl(value: string) {
  return isAllowedProductUrl(value) || isKnownLoginUrl(value);
}
