const stateElement = document.querySelector("#state");

chrome.runtime.sendMessage({ type: "REVIEWMOA_GET_STATE" }).then((state) => {
  if (state?.activeJob) {
    stateElement.innerHTML = `<strong>${state.activeJob.status}</strong><br>${state.activeJob.url}`;
  } else if (state?.result) {
    stateElement.innerHTML = `<strong>${state.result.status}</strong><br>최근 수집 결과가 저장되어 있습니다.`;
  } else {
    stateElement.textContent = "진행 중인 작업이 없습니다.";
  }
});

document.querySelector("#collect").addEventListener("click", async () => {
  // 현재 보고 있는 상품 페이지 URL로 리뷰모아를 새 탭에서 열고, 그 URL을 자동으로
  // 채워 수집을 시작하게 한다. 실제 수집·복귀·보고서 표시는 기존 모바일 인계 흐름이
  // 이어서 처리한다.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  await chrome.tabs.create({
    url: `https://reviewmoa.kro.kr/?collect=${encodeURIComponent(tab.url)}`,
    active: true,
  });
  window.close();
});
