async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

document.getElementById("start").addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  await chrome.runtime.sendMessage({ type: "START_SCAN", tabId });
  setStatus("Scanning started for this tab.");
});

document.getElementById("stop").addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  await chrome.runtime.sendMessage({ type: "STOP_SCAN", tabId });
  setStatus("Scanning stopped for this tab.");
});

document.getElementById("options").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

function setStatus(s) {
  document.getElementById("status").textContent = s;
}