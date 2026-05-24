// YouTube Auto-Transcript Background Service Worker

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && tab.url && tab.url.includes('youtube.com/watch')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "toggle-panel" });
    } catch (err) {
      console.error("Failed to send toggle-panel message to content script: ", err);
    }
  }
});
