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

document.querySelector("#resume").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state = await chrome.runtime.sendMessage({ type: "REVIEWMOA_GET_STATE" });
  if (!tab?.id || !state?.activeJob) return;
  await chrome.tabs.sendMessage(tab.id, { type: "REVIEWMOA_PROBE_AND_COLLECT", job: state.activeJob });
  window.close();
});
