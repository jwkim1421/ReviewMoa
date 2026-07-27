const ALLOWED_TYPES = new Set([
  "REVIEWMOA_PING",
  "REVIEWMOA_START",
  "REVIEWMOA_GET_STATE",
]);

window.addEventListener("message", async (event) => {
  if (event.source !== window || !ALLOWED_TYPES.has(event.data?.type)) return;
  try {
    const response = await chrome.runtime.sendMessage(event.data);
    window.postMessage(
      { type: `${event.data.type}_RESULT`, requestId: event.data.requestId, payload: response },
      window.location.origin,
    );
  } catch (error) {
    window.postMessage(
      { type: `${event.data.type}_RESULT`, requestId: event.data.requestId, error: error.message },
      window.location.origin,
    );
  }
});
