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

// Handle delegated fetches for content script to bypass Safari CORS/CSP constraints
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "FETCH_PLAYER_RESPONSE") {
    fetch(`https://www.youtube.com/watch?v=${message.videoId}`)
      .then(res => {
        if (!res.ok) throw new Error("Failed to load page source");
        return res.text();
      })
      .then(html => {
        const regex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+meta|<\/script|\n)/;
        const match = html.match(regex);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            sendResponse({ data });
          } catch (e) {
            sendResponse({ error: "Failed to parse player response: " + e.message });
          }
        } else {
          sendResponse({ error: "ytInitialPlayerResponse not found in source" });
        }
      })
      .catch(err => {
        sendResponse({ error: err.message });
      });
    return true; // Keep message channel open
  }

  if (message.action === "FETCH_TRANSCRIPT_JSON") {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error("Fetch failed");
        return res.json();
      })
      .then(data => {
        sendResponse({ data });
      })
      .catch(err => {
        sendResponse({ error: err.message });
      });
    return true; // Keep message channel open
  }
});

