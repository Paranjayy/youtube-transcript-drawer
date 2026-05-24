// YouTube Auto-Transcript Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "copy-transcript",
    title: "Copy Video Transcript",
    contexts: ["page"],
    documentUrlPatterns: ["https://*.youtube.com/watch*"]
  });

  chrome.contextMenus.create({
    id: "summarize-video",
    title: "Summarize Video with AI",
    contexts: ["page"],
    documentUrlPatterns: ["https://*.youtube.com/watch*"]
  });

  chrome.contextMenus.create({
    id: "extract-playlist",
    title: "Extract Playlist Transcripts",
    contexts: ["page"],
    documentUrlPatterns: ["https://*.youtube.com/watch*", "https://*.youtube.com/playlist*"]
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && tab.url && (tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/playlist'))) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "toggle-panel" });
    } catch (err) {
      console.error("Failed to send toggle-panel message to content script: ", err);
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  try {
    if (info.menuItemId === "copy-transcript") {
      await chrome.tabs.sendMessage(tab.id, { action: "context-copy" });
    } else if (info.menuItemId === "summarize-video") {
      await chrome.tabs.sendMessage(tab.id, { action: "context-summarize" });
    } else if (info.menuItemId === "extract-playlist") {
      await chrome.tabs.sendMessage(tab.id, { action: "context-playlist" });
    }
  } catch (err) {
    console.error("Failed to send context menu command to content script: ", err);
  }
});
