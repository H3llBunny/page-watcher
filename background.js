const DEFAULTS = {
  baseUrl: "https://supportmsgc.service-now.com",
  selector: "8adc7cf893ec02507dfd31218bba103e",
  keywords: ["1 - Critical", "2 - High"],
  intervalSec: 60,
  soundEnabled: true,
  activeTabId: null
};

const ALARM_NAME = "page-watcher";

async function getConfig() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...data };
}
async function setConfig(partial) {
  return chrome.storage.sync.set(partial);
}
async function setBadge(tabId, text = "", color = "#34A853") {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {}
}

async function setScanBadge(tabId, state) {
  const color =
    state === "ON" ? "#34A853" : state === "OFF" ? "#777777" : "#4285F4";
  await setBadge(tabId, state, color);
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  await chrome.storage.sync.set({ ...DEFAULTS, ...existing });

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) await setScanBadge(activeTab.id, "OFF");
  } catch {}
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    if (msg?.type === "START_SCAN") {
      await startScanning(msg.tabId);
      respond?.({ ok: true });
    } else if (msg?.type === "STOP_SCAN") {
      await stopScanning();
      respond?.({ ok: true });
    } else if (msg?.type === "SCAN_NOW") {
      await scanOnce(msg.tabId, { refresh: false });
      respond?.({ ok: true });
    }
  })();
  return true;
});

async function startScanning(tabId) {
  const cfg = await getConfig();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !tab.url.startsWith(cfg.baseUrl)) return;

  await setConfig({ activeTabId: tabId, nextRunAt: Date.now() });
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(cfg.intervalSec, 60) / 60 });

  await setScanBadge(tabId, "ON");
}

async function stopScanning() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM_NAME);

  if (cfg.activeTabId != null) {
    await setScanBadge(cfg.activeTabId, "OFF");
  }
  await setConfig({ activeTabId: null, nextRunAt: 0 });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cfg = await getConfig();
  if (cfg.activeTabId === tabId) {
    await stopScanning();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const { activeTabId } = await getConfig();
  if (tabId === activeTabId && (info.status === "loading" || info.status === "complete")) {
    await setScanBadge(tabId, "ON");
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { activeTabId } = await getConfig();
  if (tabId === activeTabId) {
    await setScanBadge(tabId, "ON");
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const cfg = await getConfig();
  if (cfg.activeTabId == null) return;

  const now = Date.now();
  if (now < (cfg.nextRunAt || 0)) return;

  await scanOnce(cfg.activeTabId, { refresh: true });

  const next = now + Math.max(5, cfg.intervalSec) * 1000;
  await setConfig({ nextRunAt: next });
});

async function scanOnce(tabId, { refresh }) {
  const cfg = await getConfig();

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !tab.url.startsWith(cfg.baseUrl)) return;

  if (refresh) {
    await chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
    await waitForTabComplete(tabId);
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: contentProbe,
      args: [cfg.selector, cfg.keywords]
    });
    if (result?.matched) {
      await notifyHit(tab, result);
    }
  } catch {}

  try {
    const { activeTabId } = await getConfig();
    if (activeTabId === tabId) {
      await setScanBadge(tabId, "ON");
    }
  } catch {}
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (t) => {
      if (!t || t.status === "complete") return resolve();
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 20000);
    });
  });
}

async function notifyHit(tab, { foundIn, matchedText }) {
  const cfg = await getConfig();
  const message = `Match in ${foundIn}: "${(matchedText || "").slice(0, 120)}"`;

  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: "Page Watcher",
      message,
      priority: 2
    });
  } catch {}

  if (cfg.soundEnabled) await playDing();

  await setBadge(tab.id, "HIT", "#EA4335");
  setTimeout(() => setScanBadge(tab.id, "ON"), 4000);
}

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen?.hasDocument?.()) return;
  } catch {}
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Play notification sound"
    });
  } catch {}
}

async function playDing() {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "PLAY_SOUND" });
  } catch {}
}

async function contentProbe(selectorOrId, rawKeywords, maxWaitMs = 15000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const findContainer = (sel) => {
    if (!sel) return null;
    if (sel.startsWith("#")) {
      try { return document.querySelector(sel); } catch { return null; }
    }
    const byId = document.getElementById(sel);
    if (byId) return byId;
    try { return document.querySelector(sel); } catch { return null; }
  };

  let container = null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    container = findContainer(selectorOrId);
    if (container) break;
    await sleep(300);
  }
  if (!container) return { matched: false, reason: "selector-not-found", selectorOrId };

  const keywords = (rawKeywords && rawKeywords.length)
    ? rawKeywords
    : ["1 - Critical", "2 - High"];

  // Look for candidate cells inside the container only
  const cells = container.querySelectorAll("td.vt, td, div, span");
  for (const el of cells) {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const k of keywords) {
      if (text.includes(k)) {
        const id = container.id ? `#${container.id}` : selectorOrId;
        return { matched: true, foundIn: id, matchedText: k };
      }
    }
  }

  const textRaw = (container.innerText || container.textContent || "").trim();
  const whole = textRaw.replace(/\s+/g, " ");
  for (const k of keywords) {
    if (whole.includes(k)) {
      const id = container.id ? `#${container.id}` : selectorOrId;
      return { matched: true, foundIn: id, matchedText: k };
    }
  }

  return { matched: false };
}