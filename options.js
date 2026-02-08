const DEFAULTS = {
  keywords: ["1 - Critical", "2 - High"],
  intervalSec: 60,
  soundEnabled: true,
  desktopNotify: true
};

async function load() {
  const data = await chrome.storage.sync.get(["keywords", "intervalSec", "soundEnabled", "desktopNotify"]);

  document.getElementById("keywords").value =
    (data.keywords && data.keywords.length ? data.keywords : DEFAULTS.keywords).join(",");

  document.getElementById("intervalSec").value =
    Number.isFinite(data.intervalSec) ? data.intervalSec : DEFAULTS.intervalSec;

  document.getElementById("soundEnabled").checked =
    (typeof data.soundEnabled === "boolean") ? data.soundEnabled : DEFAULTS.soundEnabled;

  document.getElementById("desktopNotify").checked =
    (typeof data.desktopNotify === "boolean") ? data.desktopNotify : DEFAULTS.desktopNotify;
}

async function save() {
  const btn = document.getElementById("save");
  const toast = document.getElementById("toast");

  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "Saving…";

  const keywords = document.getElementById("keywords").value
    .split(",").map(s => s.trim()).filter(Boolean);
  const intervalRaw = Number(document.getElementById("intervalSec").value);
  const intervalSec = Math.max(60, Number.isFinite(intervalRaw) ? intervalRaw : 60);
  const soundEnabled = document.getElementById("soundEnabled").checked;
  const desktopNotify = document.getElementById("desktopNotify").checked;

  await chrome.storage.sync.set({ keywords, intervalSec, soundEnabled, desktopNotify });

  btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = oldLabel; btn.disabled = false; }, 900);

  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.textContent = "Saved ✓";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1300);
}

document.getElementById("save").addEventListener("click", save);
load();