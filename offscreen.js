// Offscreen context for audio playback (MV3-friendly).
let audio;
function ensureAudio() {
  if (!audio) {
    audio = new Audio(chrome.runtime.getURL("ding.mp3"));
  }
  return audio;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PLAY_SOUND") {
    const a = ensureAudio();
    a.currentTime = 0;
    a.play().catch(() => {/* ignore autoplay issues */});
  }
});