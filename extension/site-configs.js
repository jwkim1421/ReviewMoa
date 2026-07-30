(() => {
  const configs = [
    {
      source: "naver",
      hosts: ["smartstore.naver.com", "shopping.naver.com", "brand.naver.com"],
      itemSelectors: [
        "[data-review-id]",
        "[data-shp-contents-type='review']",
        "[class*='ReviewListItem']",
        "[class*='review_list'] > li",
        "[class*='purchase_review'] > li",
      ],
      reviewTabSelectors: ["a[href*='REVIEW']", "a[href*='review']", "[data-shp-area*='review']"],
      newestSelectors: ["[data-sort='recent']", "[data-sort='latest']"],
      nextSelectors: ["a[aria-label='다음']", "button[aria-label='다음']"],
    },
    {
      source: "coupang",
      hosts: ["coupang.com"],
      itemSelectors: [
        ".sdp-review__article__list__review",
        "[class*='review__article']",
        "[data-review-id]",
      ],
      reviewTabSelectors: ["a[href*='sdpReview']", "a[href*='review']", "#btfTab ul li:nth-child(2)"],
      newestSelectors: ["[data-ordering='DATE_DESC']", "[data-sort='latest']"],
      nextSelectors: [
        ".sdp-review__article__page__next",
        "button[aria-label='다음']",
        "a[aria-label='다음']",
      ],
    },
    {
      source: "kurly",
      hosts: ["kurly.com"],
      itemSelectors: [
        "[data-testid*='review-item']",
        "[class*='ReviewList'] > div",
        "[class*='review-list'] > li",
      ],
      reviewTabSelectors: ["a[href*='review']", "button[data-testid*='review']"],
      newestSelectors: ["[data-testid*='latest']", "[data-sort='latest']"],
      nextSelectors: ["button[aria-label='다음']", "a[aria-label='다음']"],
    },
    {
      source: "ohouse",
      hosts: ["ohou.se"],
      itemSelectors: [
        "[class*='production-review-item']",
        "[class*='ReviewItem']",
        "[data-review-id]",
      ],
      reviewTabSelectors: ["a[href*='review']", "button[class*='review']"],
      newestSelectors: ["[data-sort='latest']", "[value='latest']"],
      nextSelectors: ["button[aria-label='다음']", "a[aria-label='다음']"],
    },
    {
      source: "11st",
      hosts: ["11st.co.kr"],
      itemSelectors: [
        ".review_list > li",
        "[class*='review_list'] > li",
        "[class*='c_product_review']",
        "[data-review-id]",
      ],
      reviewTabSelectors: ["a[href*='review']", "a[href*='prdReview']"],
      newestSelectors: ["[data-sort='recent']", "[value='01']"],
      nextSelectors: [".pagination a.next", "a[aria-label='다음']", "button[aria-label='다음']"],
    },
    {
      source: "ssg",
      hosts: ["ssg.com"],
      itemSelectors: [
        ".rvw_item",
        "[class*='review_item']",
        "[class*='cdtl_cmt'] > li",
        "[data-review-id]",
      ],
      reviewTabSelectors: ["a[href*='review']", "a[href*='comment']"],
      newestSelectors: ["[data-sort='recent']", "[value='recent']"],
      nextSelectors: [".pagination a.next", "a[aria-label='다음']", "button[aria-label='다음']"],
    },
    {
      source: "gmarket",
      hosts: ["gmarket.co.kr"],
      itemSelectors: [
        ".review-item",
        "[class*='box__review'] > li",
        "[class*='review_list'] > li",
        "[data-review-id]",
      ],
      reviewTabSelectors: ["a[href*='review']", "a[href*='feedback']"],
      newestSelectors: ["[data-sort='latest']", "[value='latest']"],
      nextSelectors: [".pagination a.next", "a[aria-label='다음']", "button[aria-label='다음']"],
    },
  ];

  globalThis.REVIEWMOA_SITE_CONFIGS = configs;
  globalThis.REVIEWMOA_GET_SITE_CONFIG = (url = location.href) => {
    const parsed = new URL(url);
    return configs.find((config) =>
      config.hosts.some((host) =>
        parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      )
    );
  };
})();
