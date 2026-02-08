// --- Debug (turn on/off logs)
const DEBUG = false;
const log  = (...a) => { if (DEBUG) console.log("[PW]", ...a); };
const warn = (...a) => { if (DEBUG) console.warn("[PW]", ...a); };
const err  = (...a) => { if (DEBUG) console.error("[PW]", ...a); };

const DEFAULTS = {
  baseUrl: "https://supportmsgc.service-now.com",
  selector: "8adc7cf893ec02507dfd31218bba103e",
  keywords: ["1 - Critical", "2 - High"],
  intervalSec: 60,                          
  soundEnabled: true,
  desktopNotify: true,
  keepAwake: true,
  activeTabId: null,
  runCount: 0
};

const ALARM_NAME = "page-watcher";

// ---------- storage & badges ----------
async function getConfig() {
  const data = await chrome.storage.sync.get([
    "keywords",
    "intervalSec",
    "soundEnabled",
    "desktopNotify",
    "keepAwake",
    "activeTabId",
    "runCount",
    "lastNotifiedMap"
  ]);
  return {
    ...DEFAULTS,
    ...data,
    lastNotifiedMap: data.lastNotifiedMap || {}
  };
}
async function setConfig(partial) {
  return chrome.storage.sync.set(partial);
}
async function setBadge(tabId, text = "", color = "#34A853") {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ tabId, text });
    log("badge", { tabId, text });
  } catch (e) { err("badge fail", e); }
}
async function setScanBadge(tabId, state) {
  const color = state === "ON" ? "#34A853" : state === "OFF" ? "#777777" : "#4285F4";
  await setBadge(tabId, state, color);
}

// ---------- keep-awake helpers ----------
async function keepAwakeOn() {
  try { await chrome.power.requestKeepAwake('display'); log('keepAwake: ON (display)'); }
  catch (e) { warn('keepAwakeOn failed', e); }
}
async function keepAwakeOff() {
  try { await chrome.power.releaseKeepAwake(); log('keepAwake: OFF'); }
  catch (e) { /* ignore */ }
}

// per-run de-dupe: record a notification for this tab/run
async function markNotified(tabId, runIndex) {
  const key = String(tabId);
  const cfg = await getConfig();
  const map = cfg.lastNotifiedMap || {};
  map[key] = runIndex;
  await setConfig({ lastNotifiedMap: map });
}
// per-run de-dupe: check if we already notified this run
async function canNotify(tabId, runIndex) {
  const key = String(tabId);
  const { lastNotifiedMap = {} } = await getConfig();
  return lastNotifiedMap[key] !== runIndex;
}

// ---------- install ----------
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get([
    "keywords",
    "intervalSec",
    "soundEnabled",
    "desktopNotify",
    "keepAwake",
    "activeTabId",
    "runCount",
    "lastNotifiedMap"
  ]);
  await chrome.storage.sync.set({ ...DEFAULTS, ...existing });

  // Baseline: show OFF on current active tab
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t?.id) await setScanBadge(t.id, "OFF");
  } catch {}
});

// ---------- popup messages (automation only: start/stop) ----------
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    log("msg", msg);
    if (msg?.type === "START_SCAN") {
      await startScanning(msg.tabId);
      respond?.({ ok: true });
    } else if (msg?.type === "STOP_SCAN") {
      await stopScanning();
      respond?.({ ok: true });
    }
  })();
  return true;
});

// ---------- start / stop ----------
async function startScanning(tabId) {
  const cfg = await getConfig();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  log("start", { tabId, url: tab?.url });

  if (!tab?.url || !tab.url.startsWith(cfg.baseUrl)) {
    warn("out of scope", { baseUrl: cfg.baseUrl, url: tab?.url });
    return;
  }

  await setConfig({ activeTabId: tabId, runCount: 0 });

  // Alarm every minute (minimum MV3 granularity)
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(cfg.intervalSec, 60) / 60
  });

  await setScanBadge(tabId, "ON");

  if (cfg.keepAwake) await keepAwakeOn();
}

async function stopScanning() {
  const cfg = await getConfig();
  await chrome.alarms.clear(ALARM_NAME);
  if (cfg.activeTabId != null) await setScanBadge(cfg.activeTabId, "OFF");
  await setConfig({ activeTabId: null, runCount: 0 });

  if (cfg.keepAwake) await keepAwakeOff();
}

// stop if the tracked tab closes
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cfg = await getConfig();
  if (cfg.activeTabId === tabId) await stopScanning();
});

// keep ON badge visible across reload/activation
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const { activeTabId } = await getConfig();
  if (tabId === activeTabId && (info.status === "loading" || info.status === "complete")) {
    await setScanBadge(tabId, "ON");
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { activeTabId } = await getConfig();
  if (tabId === activeTabId) await setScanBadge(tabId, "ON");
});

// ---------- alarms (every minute; no nextRunAt gate) ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const cfg = await getConfig();
  if (cfg.activeTabId == null) return;

  log("tick", { runCount: cfg.runCount, doRefresh: true });

  await scanOnce(cfg.activeTabId, { refresh: true, runIndex: cfg.runCount });

  // Let the alarm cadence drive timing; just bump runCount
  await setConfig({ runCount: cfg.runCount + 1 });
});

// React to Options changes while scanning
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;

  const cfg = await getConfig();
  if (!cfg.activeTabId) return;

  if (changes.intervalSec) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: Math.max(cfg.intervalSec, 60) / 60
    });
    log("intervalSec updated; alarm recreated", { intervalSec: cfg.intervalSec });
  }

  if (changes.keepAwake) {
    const next = changes.keepAwake.newValue ?? DEFAULTS.keepAwake;
    if (next) await keepAwakeOn(); else await keepAwakeOff();
  }
});

// ---------- scan cycle (one minute cadence, always refresh) ----------
async function scanOnce(tabId, { refresh, runIndex }) {
  const cfg = await getConfig();

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  log("scanOnce", { tabId, refresh, runIndex, url: tab?.url });

  if (!tab?.url || !tab.url.startsWith(cfg.baseUrl)) return;

  // HIT persists until next refresh: set ON at start of refreshed run
  if (refresh) {
    await setScanBadge(tabId, "ON");
    log("badge reset to ON at run start");
    log("reloading...");
    await chrome.tabs.reload(tabId, { bypassCache: true }).catch((e) => err("reload fail", e));
    await waitForTabComplete(tabId);
    log("top frame complete");
  }

  let showedHit = false; // prevents end-of-run ON from clearing a fresh HIT

  try {
    // 1) quick probe
    const quick = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: contentProbe,
      args: [cfg.selector, cfg.keywords]
    });
    let finalResult = quick.find(r => r?.result && r.result.matched)?.result;

    // 2) if no hit, observe post-reload for instant change (up to 15s)
    if (!finalResult) {
      const watchMs = 15000;
      log("observing", { watchMs, mode: "post-reload" });

      const observed = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: observeUntilMatch,
        args: [cfg.selector, cfg.keywords, watchMs]
      });
      finalResult = observed.find(r => r?.result && r.result.matched)?.result || null;
    }

    // one notification per run
    if (finalResult?.matched) {
      const ok = await canNotify(tabId, runIndex);
      if (ok) {
        log("HIT", finalResult.matchedText, "run", runIndex);
        await markNotified(tabId, runIndex);
        await notifyHit(tab, finalResult); // sets "HIT" and keeps it
        showedHit = true;
      } else {
        log("HIT suppressed (already notified this run)", finalResult.matchedText, "run", runIndex);
      }
    } else {
      log("no match");
    }
  } catch (e) {
    err("executeScript", e, chrome.runtime.lastError);
  }

  // Do NOT force ON if we just showed HIT
  try {
    const { activeTabId } = await getConfig();
    if (!showedHit && activeTabId === tabId) await setScanBadge(tabId, "ON");
  } catch {}
}

// wait for top-level page "complete"
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

// ---------- notifications & sound ----------
async function notifyHit(tab, { matchedText }) {
  const cfg = await getConfig();
  const title = "Page Watcher";
  const message = matchedText || "Match found";

  if (cfg.desktopNotify) {
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "icon128.png",
        title,
        message,
        priority: 2
      });
    } catch (e) { warn("notify fail", e); }
  }

  if (cfg.soundEnabled) await playDing();

  await setBadge(tab.id, "HIT", "#EA4335");
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

// ---------- contentProbe (runs inside frames) ----------
// Quick, one-shot check. Returns the first keyword match if present now.
async function contentProbe(selectorOrId, rawKeywords, maxWaitMs = 8000) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const findContainer = (sel) => {
    if (!sel) return null;
    if (sel.startsWith("#")) { try { return document.querySelector(sel); } catch { return null; } }
    const byId = document.getElementById(sel);
    if (byId) return byId;
    try { return document.querySelector(sel); } catch { return null; }
  };
  const findContentBySysId = (sel) => {
    const sysId = sel?.startsWith("#") ? sel.slice(1) : sel;
    if (!sysId) return null;
    try { return document.querySelector(`.grid-widget-content[data-original-widget-sysid="${sysId}"]`); }
    catch { return null; }
  };

  // brief wait for container/content in this frame
  let container = null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    container = findContainer(selectorOrId) || findContentBySysId(selectorOrId);
    if (container) break;
    await sleep(200);
  }
  if (!container) return { matched: false, reason: "selector-not-found" };

  const keywords = rawKeywords;

  // check common descendants first
  const nodes = container.querySelectorAll("td.vt, td, div, span");
  for (const el of nodes) {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const k of keywords) {
      if (text.includes(k)) return { matched: true, matchedText: k };
    }
  }

  // fallback: whole subtree
  const allText = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
  for (const k of keywords) {
    if (allText.includes(k)) return { matched: true, matchedText: k };
  }

  return { matched: false };
}

// ---------- observeUntilMatch (runs inside frames) ----------
// Watches the widget subtree and resolves as soon as a keyword appears (or times out).
async function observeUntilMatch(selectorOrId, rawKeywords, timeoutMs = 15000) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const findContainer = (sel) => {
    if (!sel) return null;
    if (sel.startsWith("#")) { try { return document.querySelector(sel); } catch { return null; } }
    const byId = document.getElementById(sel);
    if (byId) return byId;
    try { return document.querySelector(sel); } catch { return null; }
  };
  const findContentBySysId = (sel) => {
    const sysId = sel?.startsWith("#") ? sel.slice(1) : sel;
    if (!sysId) return null;
    try { return document.querySelector(`.grid-widget-content[data-original-widget-sysid="${sysId}"]`); }
    catch { return null; }
  };

  // wait for container/content in this frame
  let container = null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    container = findContainer(selectorOrId) || findContentBySysId(selectorOrId);
    if (container) break;
    await sleep(200);
  }
  if (!container) return { matched: false, reason: "selector-not-found" };

  const keywords = rawKeywords;
  const hasHit = () => {
    const txt = (container.innerText || container.textContent || "").replace(/\s+/g, " ");
    return keywords.find(k => txt.includes(k)) || null;
  };

  // immediate check
  let first = hasHit();
  if (first) return { matched: true, matchedText: first };

  // observe changes and exit on first hit
  return await new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const hit = hasHit();
      if (hit) { obs.disconnect(); resolve({ matched: true, matchedText: hit }); }
    });
    obs.observe(container, { subtree: true, childList: true, characterData: true });

    // timeout guard
    setTimeout(() => { try { obs.disconnect(); } catch {} ; resolve({ matched: false }); }, timeoutMs);
  });
}