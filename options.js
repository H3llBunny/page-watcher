const DEFAULTS = {
  urlPatterns: ["<all_urls>"],
  selector: "#target",
  keywords: ["1","2","3"],
  intervalSec: 60,
  soundEnabled: true
};

async function load() {
  const data = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  document.getElementById("urlPatterns").value = (data.urlPatterns || DEFAULTS.urlPatterns).join("\n");
  document.getElementById("selector").value = data.selector || DEFAULTS.selector;
  document.getElementById("keywords").value = (data.keywords || DEFAULTS.keywords).join(",");
  document.getElementById("intervalSec").value = data.intervalSec || DEFAULTS.intervalSec;
  document.getElementById("soundEnabled").checked = data.soundEnabled ?? DEFAULTS.soundEnabled;
}

async function save() {
  const urlPatterns = document.getElementById("urlPatterns").value
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const selector = document.getElementById("selector").value.trim();
  const keywords = document.getElementById("keywords").value.split(",").map(s => s.trim()).filter(Boolean);
  const intervalSec = Math.max(5, Number(document.getElementById("intervalSec").value) || 30);
  const soundEnabled = document.getElementById("soundEnabled").checked;

  await chrome.storage.sync.set({ urlPatterns, selector, keywords, intervalSec, soundEnabled });
  document.getElementById("status").textContent = "Saved.";
  setTimeout(() => document.getElementById("status").textContent = "", 1500);
}

document.getElementById("save").addEventListener("click", save);
load();