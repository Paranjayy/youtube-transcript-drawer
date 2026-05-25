(function() {
// YouTube Auto-Transcript Content Script

let lastVideoId = null;
let transcriptData = null;
let currentLanguageCode = null;
let captionTracks = [];
let segments = [];
let activeSegmentIndex = -1;
let autoScrollEnabled = true;
let videoElement = null;
let isCollapsed = localStorage.getItem('yt-transcript-collapsed') === 'true';
let nativeScrapeInterval = null;
let nativeObserver = null;
let loadingTimeout = null;

// Deep querySelector helper to traverse shadow roots recursively
function querySelectorDeep(selector, root = document) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  
  let found = null;
  const traverse = (node) => {
    if (found) return;
    if (node.shadowRoot) {
      found = node.shadowRoot.querySelector(selector);
      if (found) return;
      Array.from(node.shadowRoot.querySelectorAll('*')).forEach(traverse);
    }
  };
  
  if (root.shadowRoot) {
    found = root.shadowRoot.querySelector(selector);
    if (found) return found;
    Array.from(root.shadowRoot.querySelectorAll('*')).forEach(traverse);
  }
  
  Array.from(root.querySelectorAll('*')).forEach(traverse);
  return found;
}

// Deep querySelectorAll helper to traverse shadow roots recursively
function querySelectorAllDeep(selector, root = document) {
  let elements = Array.from(root.querySelectorAll(selector));
  
  const traverse = (node) => {
    if (node.shadowRoot) {
      elements = elements.concat(Array.from(node.shadowRoot.querySelectorAll(selector)));
      Array.from(node.shadowRoot.querySelectorAll('*')).forEach(traverse);
    }
  };
  
  if (root.shadowRoot) {
    elements = elements.concat(Array.from(root.shadowRoot.querySelectorAll(selector)));
    Array.from(root.shadowRoot.querySelectorAll('*')).forEach(traverse);
  }
  
  Array.from(root.querySelectorAll('*')).forEach(traverse);
  return elements;
}

// Helper to wait for DOM elements to render
function waitForElement(selector, callback, maxAttempts = 30) {
  let attempts = 0;
  const interval = setInterval(() => {
    const el = document.querySelector(selector);
    if (el) {
      clearInterval(interval);
      callback(el);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
    }
    attempts++;
  }, 250);
}

// Extract video IDs and titles from the playlist panel/page
function getAllPlaylistVideos() {
  let videos = [];
  const sidebarItems = document.querySelectorAll('ytd-playlist-panel-video-renderer');
  sidebarItems.forEach(item => {
    const linkEl = item.querySelector('a');
    const titleEl = item.querySelector('#video-title');
    if (linkEl && titleEl) {
      const href = linkEl.getAttribute('href');
      const title = titleEl.textContent ? titleEl.textContent.trim() : 'Untitled Video';
      if (href && href.includes('v=')) {
        const urlParams = new URLSearchParams(href.split('?')[1]);
        const videoId = urlParams.get('v');
        if (videoId) {
          videos.push({ videoId, title });
        }
      }
    }
  });

  if (videos.length === 0) {
    const pageItems = document.querySelectorAll('ytd-playlist-video-renderer');
    pageItems.forEach(item => {
      const linkEl = item.querySelector('a#video-title') || item.querySelector('a');
      if (linkEl) {
        const href = linkEl.getAttribute('href');
        const title = linkEl.textContent ? linkEl.textContent.trim() : 'Untitled Video';
        if (href && href.includes('v=')) {
          const urlParams = new URLSearchParams(href.split('?')[1]);
          const videoId = urlParams.get('v');
          if (videoId) {
            videos.push({ videoId, title });
          }
        }
      }
    });
  }
  
  const seen = new Set();
  return videos.filter(v => {
    if (seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });
}

// Fetch player response for arbitrary video via background script to bypass CORS
async function getPlayerResponse(videoId) {
  return new Promise((resolve, reject) => {
    console.log(`[YT Extension] Sending FETCH_PLAYER_RESPONSE for videoId: ${videoId}`);
    const timeout = setTimeout(() => {
      console.warn(`[YT Extension] FETCH_PLAYER_RESPONSE timed out for videoId: ${videoId}`);
      reject(new Error("Request for FETCH_PLAYER_RESPONSE timed out after 15 seconds"));
    }, 15000);

    const api = typeof browser !== 'undefined' ? browser : chrome;
    api.runtime.sendMessage({ action: "FETCH_PLAYER_RESPONSE", videoId }, (response) => {
      clearTimeout(timeout);
      console.log(`[YT Extension] Received FETCH_PLAYER_RESPONSE response for videoId: ${videoId}`, response);
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else if (response && response.data) {
        resolve(response.data);
      } else {
        reject(new Error("No response data received"));
      }
    });
  });
}

// Fetch transcript JSON via background script to bypass CORS
async function fetchTranscriptJson(url) {
  return new Promise((resolve, reject) => {
    console.log(`[YT Extension] Sending FETCH_TRANSCRIPT_JSON for url: ${url}`);
    const timeout = setTimeout(() => {
      console.warn(`[YT Extension] FETCH_TRANSCRIPT_JSON timed out for url: ${url}`);
      reject(new Error("Request for FETCH_TRANSCRIPT_JSON timed out after 15 seconds"));
    }, 15000);

    const api = typeof browser !== 'undefined' ? browser : chrome;
    api.runtime.sendMessage({ action: "FETCH_TRANSCRIPT_JSON", url }, (response) => {
      clearTimeout(timeout);
      console.log(`[YT Extension] Received FETCH_TRANSCRIPT_JSON response for url: ${url}`, response);
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else if (response && response.data) {
        resolve(response.data);
      } else {
        reject(new Error("No response data received"));
      }
    });
  });
}

// Fetch and parse plain text transcript for batch zipping
async function fetchTranscriptText(baseUrl) {
  let resolvedUrl = baseUrl;
  if (resolvedUrl.startsWith('//')) {
    resolvedUrl = 'https:' + resolvedUrl;
  } else if (resolvedUrl.startsWith('/')) {
    resolvedUrl = 'https://www.youtube.com' + resolvedUrl;
  }
  const url = resolvedUrl + '&fmt=json3';
  const data = await fetchTranscriptJson(url);
  const textSegments = [];
  if (data && data.events) {
    for (const event of data.events) {
      if (!event.segs) continue;
      const text = event.segs.map(seg => seg.utf8).join('').replace(/\s+/g, ' ').trim();
      if (text) {
        textSegments.push(`[${formatTime((event.tStartMs || 0) / 1000)}] ${text}`);
      }
    }
  }
  return textSegments.join('\n');
}


// Show progress UI in cues container during playlist extraction
function showPlaylistProgress(completed, total) {
  const container = document.querySelector('.yt-transcript-ext-cues-container');
  if (!container) return;
  
  const percentage = Math.round((completed / total) * 100);
  container.innerHTML = `
    <div class="yt-transcript-ext-message" style="padding: 60px 20px;">
      <div class="yt-transcript-ext-spinner" style="margin-bottom: 12px;"></div>
      <div style="font-weight: bold; margin-bottom: 8px;">Extracting Playlist Transcripts</div>
      <div style="font-size: 13px; color: #aaa; margin-bottom: 12px;">Processed ${completed} of ${total} videos (${percentage}%)</div>
      <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
        <div style="width: ${percentage}%; height: 100%; background: linear-gradient(90deg, #00f2fe 0%, #06b6d4 100%); transition: width 0.2s ease;"></div>
      </div>
    </div>
  `;
}

// Extract transcripts for a list of videos, zip them, and download
async function extractPlaylistTranscripts(videos) {
  const zip = new JSZip();
  let completed = 0;
  const consolidated = [];
  
  showPlaylistProgress(0, videos.length);
  
  const BATCH_SIZE = 3;
  for (let i = 0; i < videos.length; i += BATCH_SIZE) {
    const batch = videos.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (video) => {
      try {
        const playerResponse = await getPlayerResponse(video.videoId);
        const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (tracks.length > 0) {
          const defaultTrack = tracks.find(t => t.languageCode === 'en') || tracks[0];
          const transcriptText = await fetchTranscriptText(defaultTrack.baseUrl);
          
          const safeTitle = video.title.replace(/[/\\?%*:|"<>. ]/g, '_');
          zip.file(`${safeTitle}.txt`, `Title: ${video.title}\nURL: https://youtube.com/watch?v=${video.videoId}\n\n${transcriptText}`);
          
          consolidated.push(`========================================\nTitle: ${video.title}\nURL: https://youtube.com/watch?v=${video.videoId}\n========================================\n\n${transcriptText}\n\n`);
        } else {
          zip.file(`NO_CAPTIONS_${video.videoId}.txt`, `No captions available for video: ${video.title}\nURL: https://youtube.com/watch?v=${video.videoId}`);
        }
      } catch (err) {
        console.error(`Failed to extract transcript for ${video.videoId}:`, err);
        zip.file(`FAILED_${video.videoId}.txt`, `Failed to extract transcript for video: ${video.title}\nURL: https://youtube.com/watch?v=${video.videoId}\nError: ${err.message}`);
      } finally {
        completed++;
        showPlaylistProgress(completed, videos.length);
      }
    }));
  }
  
  zip.file("consolidated_transcript.txt", consolidated.join('\n'));
  
  try {
    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playlist_transcripts_${new URLSearchParams(window.location.search).get('list') || 'export'}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Playlist ZIP downloaded!");
  } catch (err) {
    console.error("Failed to generate zip: ", err);
    showToast("Failed to generate ZIP archive.");
  }
  
  renderTranscript();
}

// Format seconds into H:MM:SS or M:SS
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mStr = String(m).padStart(2, '0');
  const sStr = String(s).padStart(2, '0');
  if (h > 0) {
    return `${h}:${mStr}:${sStr}`;
  }
  return `${m}:${sStr}`;
}

// Ensure the extension panel exists at the top of YouTube's secondary column or playlist section
function ensurePanelInjected() {
  const isPlaylistPage = window.location.pathname === '/playlist';
  let parent = null;
  let insertBeforeNode = null;

  if (isPlaylistPage) {
    // Inject at the top of the playlist video list (right column) to prevent layout squishing
    parent = document.querySelector('ytd-playlist-video-list-renderer') || 
             document.querySelector('ytd-section-list-renderer') ||
             document.querySelector('ytd-playlist-header-renderer');
    insertBeforeNode = parent ? parent.firstChild : null;
  } else {
    // Watch page
    parent = document.querySelector('#secondary');
    insertBeforeNode = parent ? parent.firstChild : null;
    
    if (!parent) {
      // Fallback for theater mode or narrow screens: under watch metadata
      parent = document.querySelector('#secondary-inner') || 
               document.querySelector('ytd-watch-metadata') ||
               document.querySelector('#columns');
      insertBeforeNode = parent ? parent.firstChild : null;
    }
  }
  
  if (!parent) return null;

  let panel = document.getElementById('yt-transcript-ext-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'yt-transcript-ext-panel';
    parent.insertBefore(panel, insertBeforeNode);
  } else if (panel.parentNode !== parent) {
    // Move the panel if it's currently attached to the wrong parent (e.g. from dynamic navigation)
    parent.insertBefore(panel, insertBeforeNode);
  }
  return panel;
}

// Show/hide panel based on current pathname
function checkPageAndTogglePanel() {
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v');
  const playlistId = urlParams.get('list');
  const isPlaylistPage = window.location.pathname === '/playlist' && playlistId;
  const panel = document.getElementById('yt-transcript-ext-panel');
  
  if (!videoId && !isPlaylistPage) {
    if (panel) {
      panel.style.display = 'none';
    }
    return false;
  }
  
  if (panel) {
    panel.style.display = 'flex';
  }
  return true;
}

// Show loading state
function showLoading() {
  const panel = ensurePanelInjected();
  if (!panel) return;
  
  panel.innerHTML = `
    <div class="yt-transcript-ext-message">
      <div class="yt-transcript-ext-spinner"></div>
      <div>Loading transcript...</div>
    </div>
  `;

  // Fallback to native after a timeout (Safari CSP workaround)
  if (loadingTimeout) clearTimeout(loadingTimeout);
  loadingTimeout = setTimeout(() => {
    if (!transcriptData && segments.length === 0) {
      console.log("[YT Extension] Handshake timed out. Falling back to native transcript drawer.");
      showError("Could not retrieve transcript data automatically.");
    }
  }, 4000);
}

// Open YouTube's native transcript panel programmatically
function openNativeTranscript() {
  let btn = querySelectorDeep('ytd-video-description-transcripts-section-renderer button') ||
            querySelectorDeep('ytd-video-description-transcripts-section-renderer ytd-button-renderer button') ||
            Array.from(querySelectorAllDeep('button')).find(el => el.textContent && el.textContent.includes('Show transcript'));
            
  if (btn) {
    btn.click();
    showToast("Opened native transcript!");
    return true;
  }
  
  const expandBtn = querySelectorDeep('#expand') || 
                    querySelectorDeep('ytd-description-renderer') ||
                    querySelectorDeep('ytd-watch-metadata #description') ||
                    querySelectorDeep('tp-yt-paper-button#more') || 
                    querySelectorDeep('.ytd-video-secondary-info-renderer #more');
                    
  if (expandBtn) {
    expandBtn.click();
    showToast("Expanding description...");
    
    let attempts = 0;
    const retryInterval = setInterval(() => {
      attempts++;
      const btnRetry = querySelectorDeep('ytd-video-description-transcripts-section-renderer button') ||
                       querySelectorDeep('ytd-video-description-transcripts-section-renderer ytd-button-renderer button') ||
                       Array.from(querySelectorAllDeep('button')).find(el => el.textContent && el.textContent.includes('Show transcript'));
      if (btnRetry) {
        clearInterval(retryInterval);
        btnRetry.click();
        showToast("Opened native transcript!");
      } else if (attempts > 15) {
        clearInterval(retryInterval);
        showToast("Native transcript button not found.");
      }
    }, 200);
    return true;
  }
  
  showToast("Native transcript not available for this video.");
  return false;
}

// Convert timestamp string (M:SS or H:MM:SS) to milliseconds
function parseTimestampToMs(timeStr) {
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  
  let seconds = 0;
  if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return seconds * 1000;
}

// Parse native YouTube transcript segment elements
function scrapeNativeTranscriptNodes(segmentNodes) {
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
  segments = [];
  segmentNodes.forEach(segment => {
    // Find timestamp using robust fallback selectors
    const timestampEl = querySelectorDeep('.segment-timestamp', segment) || 
                        querySelectorDeep('[class*="timestamp"]', segment) ||
                        Array.from(segment.querySelectorAll('*'))
                          .concat(segment.shadowRoot ? Array.from(segment.shadowRoot.querySelectorAll('*')) : [])
                          .find(el => /^\d+:\d+/.test(el.textContent.trim()));
    const timeStr = timestampEl ? timestampEl.textContent.trim() : "";
    
    // Find text using robust fallback selectors
    const textEl = querySelectorDeep('.segment-text', segment) || 
                   querySelectorDeep('[class*="text"]', segment);
    
    let text = "";
    if (textEl) {
      text = textEl.textContent.trim();
    } else {
      const lightText = segment.textContent.trim();
      const shadowText = segment.shadowRoot ? segment.shadowRoot.textContent.trim() : "";
      const fullText = (lightText + " " + shadowText).trim();
      text = fullText.replace(timeStr, "").trim().replace(/\s+/g, ' ');
    }
    
    if (timeStr && text) {
      const startMs = parseTimestampToMs(timeStr);
      segments.push({
        startMs,
        text,
        timeStr
      });
    }
  });

  if (segments.length > 0) {
    // Successfully scraped! Hide the native panel cleanly
    document.body.classList.add('yt-transcript-scraped-active');
    
    // Inject a fake option if captionTracks is empty to support the dropdown
    if (captionTracks.length === 0) {
      captionTracks = [{
        languageCode: 'en',
        name: { simpleText: 'Native Scraped' },
        baseUrl: ''
      }];
      currentLanguageCode = 'en';
    }
    
    renderTranscript();
    showToast("Loaded transcript from YouTube player!");
    
    // Monitor for changes (e.g. language selection)
    setupNativeObserver();
  } else {
    showError("Could not retrieve transcript data. Try another language or refresh.");
  }
}

// Poll DOM for native transcript segment elements
function startNativeScraping() {
  if (nativeScrapeInterval) clearInterval(nativeScrapeInterval);
  
  // Show progress feedback
  const fallbackStatus = querySelectorDeep('.yt-transcript-ext-fallback-status');
  if (fallbackStatus) {
    fallbackStatus.textContent = "Attempting native transcript extraction...";
  }

  let attempts = 0;
  nativeScrapeInterval = setInterval(() => {
    attempts++;
    const segmentNodes = querySelectorAllDeep('ytd-transcript-segment-renderer');
    
    if (segmentNodes.length > 0) {
      clearInterval(nativeScrapeInterval);
      nativeScrapeInterval = null;
      scrapeNativeTranscriptNodes(segmentNodes);
    } else if (attempts > 30) {
      clearInterval(nativeScrapeInterval);
      nativeScrapeInterval = null;
      // Do not loop infinitely if native is truly missing
      const statusEl = querySelectorDeep('.yt-transcript-ext-fallback-status');
      if (statusEl) {
        statusEl.textContent = "Extraction failed. No native transcript available.";
      }
    }
  }, 400);
}

// Monitor native container mutations to resync when language changes
function setupNativeObserver() {
  if (nativeObserver) nativeObserver.disconnect();
  
  const container = querySelectorDeep('ytd-transcript-renderer #segments-container') || 
                    querySelectorDeep('ytd-transcript-renderer');
  if (!container) return;
  
  nativeObserver = new MutationObserver(() => {
    const nodes = querySelectorAllDeep('ytd-transcript-segment-renderer');
    if (nodes.length > 0) {
      segments = [];
      nodes.forEach(segment => {
        const timestampEl = querySelectorDeep('.segment-timestamp', segment) || 
                            querySelectorDeep('[class*="timestamp"]', segment) ||
                            Array.from(segment.querySelectorAll('*'))
                              .concat(segment.shadowRoot ? Array.from(segment.shadowRoot.querySelectorAll('*')) : [])
                              .find(el => /^\d+:\d+/.test(el.textContent.trim()));
        const timeStr = timestampEl ? timestampEl.textContent.trim() : "";
        
        const textEl = querySelectorDeep('.segment-text', segment) || 
                       querySelectorDeep('[class*="text"]', segment);
        
        let text = "";
        if (textEl) {
          text = textEl.textContent.trim();
        } else {
          const lightText = segment.textContent.trim();
          const shadowText = segment.shadowRoot ? segment.shadowRoot.textContent.trim() : "";
          const fullText = (lightText + " " + shadowText).trim();
          text = fullText.replace(timeStr, "").trim().replace(/\s+/g, ' ');
        }
        
        if (timeStr && text) {
          const startMs = parseTimestampToMs(timeStr);
          segments.push({ startMs, text, timeStr });
        }
      });
      renderTranscript();
    }
  });
  
  nativeObserver.observe(container, { childList: true, subtree: true });
}

// Show error state
function showError(message) {
  const panel = ensurePanelInjected();
  if (!panel) return;
  
  panel.innerHTML = `
    <div class="yt-transcript-ext-message">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="rgba(255, 255, 255, 0.4)">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
      </svg>
      <div>${message}</div>
      <div class="yt-transcript-ext-fallback-status" style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-top: 4px;">Automatically falling back to native transcript...</div>
      <button class="yt-transcript-ext-action-btn" id="yt-transcript-ext-error-native-btn" style="margin-top: 12px; background: #06b6d4; color: #0d0d0d; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; transition: all 0.15s ease;">Try Native Transcript</button>
    </div>
  `;

  const errorNativeBtn = panel.querySelector('#yt-transcript-ext-error-native-btn');
  if (errorNativeBtn) {
    errorNativeBtn.onclick = () => {
      openNativeTranscript();
      startNativeScraping();
    };
  }

  // Automatically attempt native fallback and scrape
  const success = openNativeTranscript();
  if (success) {
    startNativeScraping();
  }
}

// Setup timeupdate listener on YouTube video element
function setupVideoListeners() {
  if (videoElement) {
    videoElement.removeEventListener('timeupdate', onTimeUpdate);
  }
  
  videoElement = document.querySelector('video');
  if (videoElement) {
    videoElement.addEventListener('timeupdate', onTimeUpdate);
  }
}

// Track active segment based on current video time
function onTimeUpdate() {
  if (!videoElement || segments.length === 0) return;
  const currentTimeMs = videoElement.currentTime * 1000;
  
  let activeIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (currentTimeMs >= segments[i].startMs) {
      activeIndex = i;
    } else {
      break;
    }
  }
  
  if (activeIndex !== activeSegmentIndex) {
    activeSegmentIndex = activeIndex;
    updateActiveHighlight();
  }
}

// Highlight and center the current playing segment
function updateActiveHighlight() {
  const container = document.querySelector('.yt-transcript-ext-cues-container');
  if (!container) return;
  
  const oldActive = container.querySelector('.yt-transcript-ext-active');
  if (oldActive) {
    oldActive.classList.remove('yt-transcript-ext-active');
  }
  
  if (activeSegmentIndex >= 0) {
    const activeRow = container.querySelector(`[data-index="${activeSegmentIndex}"]`);
    if (activeRow) {
      activeRow.classList.add('yt-transcript-ext-active');
      if (autoScrollEnabled) {
        const top = activeRow.offsetTop - (container.clientHeight / 2) + (activeRow.clientHeight / 2);
        container.scrollTo({
          top: top,
          behavior: 'smooth'
        });
      }
    }
  }
}

// Helper to update the panel collapse class and chevron rotation
function updateCollapseState() {
  const panel = document.getElementById('yt-transcript-ext-panel');
  if (!panel) return;
  
  panel.classList.toggle('yt-transcript-ext-collapsed', isCollapsed);
  
  const chevron = panel.querySelector('.yt-transcript-ext-chevron');
  if (chevron) {
    chevron.style.transform = isCollapsed ? 'rotate(-180deg)' : 'rotate(0deg)';
  }
}

// Render a simplified playlist panel on playlist pages
function renderPlaylistPagePanel() {
  const panel = ensurePanelInjected();
  if (!panel) return;

  const playlistVideos = getAllPlaylistVideos();

  panel.innerHTML = `
    <div class="yt-transcript-ext-header">
      <div class="yt-transcript-ext-title-wrapper" style="cursor: pointer; select: none;">
        <svg class="yt-transcript-ext-logo" viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: #06b6d4; filter: drop-shadow(0 0 6px rgba(6, 182, 212, 0.6));">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
          <path d="M7 9h10v2H7zm0-3h10v2H7zm0 6h7v2H7z"/>
        </svg>
        <div class="yt-transcript-ext-title" style="font-size: 15.5px; font-weight: 700; background: linear-gradient(90deg, #00f2fe 0%, #4facfe 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: 0.3px;">Playlist Extractor</div>
      </div>
      <div class="yt-transcript-ext-controls">
        <button class="yt-transcript-ext-btn yt-transcript-ext-toggle-btn" title="Toggle Collapse">
          <svg class="yt-transcript-ext-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.3s ease;">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="yt-transcript-ext-cues-container" style="padding: 12px 0;">
      <div class="yt-transcript-ext-message" style="padding: 20px 10px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px;">
        <div style="font-weight: bold; font-size: 14px; color: var(--yt-ext-text, #fff); margin-bottom: 6px;">Playlist Detected</div>
        <div style="font-size: 12.5px; color: var(--yt-ext-cue-text, #aaa); margin-bottom: 16px;">Found ${playlistVideos.length} videos in this playlist. You can extract and download all transcripts as a consolidated ZIP file.</div>
        
        <button class="yt-transcript-ext-action-btn yt-transcript-ext-playlist-btn" style="background: linear-gradient(90deg, #00f2fe 0%, #06b6d4 100%); color: #0d0d0d; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 13px; padding: 10px 16px; display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.25); transition: all 0.2s ease;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9H5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V11c0-1.1-.9-2-2-2zM5 11h14v10H5V11zm10-8H9v2h6V3zm4 3H5v2h14V6z"/>
          </svg>
          <span>Extract Playlist ZIP</span>
        </button>
      </div>
    </div>
  `;

  // Connect toggle collapse
  const titleWrapper = panel.querySelector('.yt-transcript-ext-title-wrapper');
  if (titleWrapper) {
    titleWrapper.onclick = () => {
      isCollapsed = !isCollapsed;
      localStorage.setItem('yt-transcript-collapsed', isCollapsed);
      updateCollapseState();
    };
  }

  const toggleBtn = panel.querySelector('.yt-transcript-ext-toggle-btn');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      isCollapsed = !isCollapsed;
      localStorage.setItem('yt-transcript-collapsed', isCollapsed);
      updateCollapseState();
    };
  }

  // Connect playlist extraction button
  const playlistBtn = panel.querySelector('.yt-transcript-ext-playlist-btn');
  if (playlistBtn) {
    playlistBtn.onclick = (e) => {
      e.stopPropagation();
      extractPlaylistTranscripts(playlistVideos);
    };
  }

  updateCollapseState();
}

// Render the fully loaded transcript panel
function renderTranscript() {
  const panel = ensurePanelInjected();
  if (!panel) return;

  panel.innerHTML = `
    <div class="yt-transcript-ext-header">
      <div class="yt-transcript-ext-title-wrapper" style="cursor: pointer; select-none;">
        <svg class="yt-transcript-ext-logo" viewBox="0 0 24 24">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
          <path d="M7 9h10v2H7zm0-3h10v2H7zm0 6h7v2H7z"/>
        </svg>
        <div class="yt-transcript-ext-title">YouTube Summary</div>
      </div>
      <div class="yt-transcript-ext-controls">
        <select class="yt-transcript-ext-select"></select>
        <button class="yt-transcript-ext-btn yt-transcript-ext-ai-toggle-btn" title="AI Summary Options">
          <svg class="lucide lucide-bot" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 8V4H8"></path>
            <rect width="16" height="12" x="4" y="8" rx="2"></rect>
            <path d="M2 14h2"></path>
            <path d="M20 14h2"></path>
            <path d="M15 13v2"></path>
            <path d="M9 13v2"></path>
          </svg>
        </button>
        <button class="yt-transcript-ext-btn yt-transcript-ext-native-btn" title="Open Native Transcript">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 16H5V5h7v14zm7 0h-5V5h5v14z"/>
          </svg>
        </button>
        <button class="yt-transcript-ext-btn yt-transcript-ext-copy-btn" title="Copy Transcript">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
        </button>
        <button class="yt-transcript-ext-btn yt-transcript-ext-download-btn" title="Download Transcript (TXT)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
        <button class="yt-transcript-ext-btn yt-transcript-ext-scroll-btn" title="Toggle Auto-Scroll">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
          </svg>
        </button>
        <button class="yt-transcript-ext-btn yt-transcript-ext-toggle-btn" title="Toggle Collapse">
          <svg class="yt-transcript-ext-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="yt-transcript-ext-ai-dropdown" style="display: none;">
      <div class="yt-transcript-ext-ai-title">Summarize Video (Open New Tab)</div>
      <div class="yt-transcript-ext-ai-grid">
        <button class="yt-transcript-ext-ai-option" data-model="chatgpt" title="Copy prompt & open ChatGPT">
          <span class="yt-transcript-ext-ai-icon-wrapper chatgpt">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.73 10.37a4.99 4.99 0 0 0-.8-3.37 5.16 5.16 0 0 0-2.88-2.22 5.09 5.09 0 0 0-4.47.45 5.06 5.06 0 0 0-3.37-.8 5.16 5.16 0 0 0-2.22 2.88 5.09 5.09 0 0 0 .45 4.47 5.06 5.06 0 0 0-.8 3.37 5.16 5.16 0 0 0 2.88 2.22 5.09 5.09 0 0 0 4.47-.45 5.06 5.06 0 0 0 3.37.8 5.16 5.16 0 0 0 2.22-2.88 5.09 5.09 0 0 0-.45-4.47zm-8.73 7.82a3.3 3.3 0 0 1-1.46-.34l.05-.03 3.86-2.23a.85.85 0 0 0 .43-.75v-5.46l1.63.94a.06.06 0 0 1 .03.05v4.45a3.35 3.35 0 0 1-4.54 3.37zm-4.75-2.74a3.3 3.3 0 0 1-.34-1.46l.03.02 3.86 2.23c.23.13.5.13.73 0l4.73-2.73V15.4a.06.06 0 0 1-.03.05l-3.85 2.22a3.35 3.35 0 0 1-5.13-2.29zm-1.12-5.46a3.3 3.3 0 0 1 1.12-1.12l-.02.04-1.02 5.92a.85.85 0 0 0 0 .87l4.73 2.73-1.63.94a.06.06 0 0 1-.05 0l-3.85-2.22a3.35 3.35 0 0 1 .72-6.16zm5.13-5.13a3.3 3.3 0 0 1 1.46.34l-.05.03-3.86 2.23a.85.85 0 0 0-.43.75v5.46l-1.63-.94a.06.06 0 0 1-.03-.05V4.5a3.35 3.35 0 0 1 4.54-3.37zm4.75 2.74a3.3 3.3 0 0 1 .34 1.46l-.03-.02-3.86-2.23a.85.85 0 0 0-.73 0L8.25 8.21V6.32a.06.06 0 0 1 .03-.05l3.85-2.22a3.35 3.35 0 0 1 5.13 2.29zm1.12 5.46a3.3 3.3 0 0 1-1.12 1.12l.02-.04 1.02-5.92c.1.25.1.53 0 .78l-4.73-2.73 1.63-.94a.06.06 0 0 1 .05 0l3.85 2.22a3.35 3.35 0 0 1-.72 6.16zM10.15 13.5l1.85-1.07 1.85 1.07v2.14l-1.85 1.07-1.85-1.07V13.5z"/>
            </svg>
          </span>
          <span>ChatGPT</span>
        </button>
        <button class="yt-transcript-ext-ai-option" data-model="claude" title="Copy prompt & open Claude">
          <span class="yt-transcript-ext-ai-icon-wrapper claude">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a2 2 0 0 1 2 2c0 2.2 1.8 4 4 4a2 2 0 1 1 0 4c-2.2 0-4 1.8-4 4a2 2 0 1 1-4 0c0-2.2-1.8-4-4-4a2 2 0 1 1 0-4c2.2 0 4-1.8 4-4a2 2 0 0 1 2-2z"/>
            </svg>
          </span>
          <span>Claude</span>
        </button>
        <button class="yt-transcript-ext-ai-option" data-model="gemini" title="Copy prompt & open Gemini">
          <span class="yt-transcript-ext-ai-icon-wrapper gemini">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2c-.3 0-.6.2-.8.5l-2.2 6.6-6.6 2.2a1 1 0 0 0 0 1.9l6.6 2.2 2.2 6.6a1 1 0 0 0 1.9 0l2.2-6.6 6.6-2.2a1 1 0 0 0 0-1.9l-6.6-2.2-2.2-6.6c-.2-.3-.5-.5-.9-.5z"/>
            </svg>
          </span>
          <span>Gemini</span>
        </button>
        <button class="yt-transcript-ext-ai-option" data-model="aistudio" title="Copy prompt & open Google AI Studio">
          <span class="yt-transcript-ext-ai-icon-wrapper aistudio">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4zM12 8a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>
            </svg>
          </span>
          <span>AI Studio</span>
        </button>
        <button class="yt-transcript-ext-ai-option" data-model="mistral" title="Copy prompt & open Mistral">
          <span class="yt-transcript-ext-ai-icon-wrapper mistral">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 4h3l5 7 5-7h3v16h-3V9l-5 7-5-7v11H4V4z"/>
            </svg>
          </span>
          <span>Mistral</span>
        </button>
      </div>
    </div>
    
    <div class="yt-transcript-ext-search-container">
      <svg class="yt-transcript-ext-search-icon" viewBox="0 0 24 24">
        <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
      </svg>
      <input class="yt-transcript-ext-input" type="text" placeholder="Search transcript...">
    </div>
    <div class="yt-transcript-ext-cues-container"></div>
  `;

  // Populate language dropdown
  const select = panel.querySelector('.yt-transcript-ext-select');
  captionTracks.forEach((track) => {
    let trackName = "Unknown Language";
    if (track.name) {
      if (typeof track.name === 'string') {
        trackName = track.name;
      } else if (track.name.simpleText) {
        trackName = track.name.simpleText;
      } else if (Array.isArray(track.name.runs)) {
        trackName = track.name.runs.map(r => r.text).join('');
      }
    }
    if (track.kind === 'asr') {
      trackName += ' (auto-generated)';
    }

    const option = document.createElement('option');
    option.value = track.languageCode;
    option.textContent = trackName;
    if (track.languageCode === currentLanguageCode) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  select.onchange = (e) => {
    const track = captionTracks.find(t => t.languageCode === e.target.value);
    if (track) {
      loadTranscriptForTrack(track);
    }
  };

  // Click handler on Title Wrapper to toggle collapse
  const titleWrapper = panel.querySelector('.yt-transcript-ext-title-wrapper');
  if (titleWrapper) {
    titleWrapper.onclick = () => {
      isCollapsed = !isCollapsed;
      localStorage.setItem('yt-transcript-collapsed', isCollapsed);
      updateCollapseState();
    };
  }

  // Click handler on Chevron to toggle collapse
  const toggleBtn = panel.querySelector('.yt-transcript-ext-toggle-btn');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      isCollapsed = !isCollapsed;
      localStorage.setItem('yt-transcript-collapsed', isCollapsed);
      updateCollapseState();
    };
  }

  // AI Toggle Button functionality
  const aiToggleBtn = panel.querySelector('.yt-transcript-ext-ai-toggle-btn');
  const aiDropdown = panel.querySelector('.yt-transcript-ext-ai-dropdown');
  
  if (aiToggleBtn && aiDropdown) {
    aiToggleBtn.onclick = (e) => {
      e.stopPropagation(); // Avoid triggering collapse on header click if it bubbles
      if (isCollapsed) {
        isCollapsed = false;
        localStorage.setItem('yt-transcript-collapsed', isCollapsed);
        updateCollapseState();
      }
      
      const isVisible = aiDropdown.style.display !== 'none';
      aiDropdown.style.display = isVisible ? 'none' : 'block';
      aiToggleBtn.classList.toggle('yt-transcript-ext-icon-btn-active', !isVisible);
    };
  }

  // AI model option buttons
  const aiOptions = panel.querySelectorAll('.yt-transcript-ext-ai-option');
  aiOptions.forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const model = btn.getAttribute('data-model');
      const title = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(" - YouTube", "") || "this video";
      const videoUrl = window.location.href;
      const text = segments.map(s => s.text).join(' ');
      const promptText = `Summarize the following transcript of the YouTube video titled "${title}" (${videoUrl}) in 5 clear and concise bullet points. Include key takeaways and actionable insights:\n\n${text}`;
      
      let url = "";
      let name = "";
      switch (model) {
        case 'chatgpt':
          url = 'https://chatgpt.com/';
          name = 'ChatGPT';
          break;
        case 'claude':
          url = 'https://claude.ai/';
          name = 'Claude';
          break;
        case 'gemini':
          url = 'https://gemini.google.com/';
          name = 'Gemini';
          break;
        case 'aistudio':
          url = 'https://aistudio.google.com/';
          name = 'Google AI Studio';
          break;
        case 'mistral':
          url = 'https://chat.mistral.ai/';
          name = 'Mistral';
          break;
      }
      
      try {
        await navigator.clipboard.writeText(promptText);
        showToast(`Prompt copied! Opening ${name}...`);
        window.open(url, '_blank');
      } catch (err) {
        console.error("AI copy failed: ", err);
        showToast("Failed to copy transcript prompt.");
      }
    };
  });

  // Native UI Fallback button functionality
  const nativeBtn = panel.querySelector('.yt-transcript-ext-native-btn');
  nativeBtn.onclick = (e) => {
    e.stopPropagation();
    openNativeTranscript();
  };

  // Copy transcript button functionality
  const copyBtn = panel.querySelector('.yt-transcript-ext-copy-btn');
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    const text = segments.map(s => `[${s.timeStr}] ${s.text}`).join('\n');
    const title = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(" - YouTube", "") || "YouTube Video";
    const videoUrl = window.location.href;
    const formattedText = `Title: ${title}\nURL: ${videoUrl}\n\n${text}`;
    try {
      await navigator.clipboard.writeText(formattedText);
      showToast("Transcript copied with Title & URL!");
    } catch (err) {
      console.error("Clipboard copy failed: ", err);
      showToast("Failed to copy transcript.");
    }
  };

  // Download transcript button functionality
  const downloadBtn = panel.querySelector('.yt-transcript-ext-download-btn');
  if (downloadBtn) {
    downloadBtn.onclick = (e) => {
      e.stopPropagation();
      const text = segments.map(s => `[${s.timeStr}] ${s.text}`).join('\n');
      const title = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(" - YouTube", "") || "YouTube Video";
      const videoUrl = window.location.href;
      const fileContent = `Title: ${title}\nURL: ${videoUrl}\n\n${text}`;
      
      const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeTitle = title.replace(/[/\\?%*:|"<>. ]/g, '_');
      a.download = `${safeTitle}_transcript.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("Transcript downloaded!");
    };
  }

  // Auto-scroll toggle
  const scrollBtn = panel.querySelector('.yt-transcript-ext-scroll-btn');
  scrollBtn.classList.toggle('yt-transcript-ext-icon-btn-active', autoScrollEnabled);
  scrollBtn.onclick = (e) => {
    e.stopPropagation();
    autoScrollEnabled = !autoScrollEnabled;
    scrollBtn.classList.toggle('yt-transcript-ext-icon-btn-active', autoScrollEnabled);
    if (autoScrollEnabled) {
      updateActiveHighlight();
    }
  };

  // Search input filter with text highlighting
  const searchInput = panel.querySelector('.yt-transcript-ext-input');
  searchInput.oninput = (e) => {
    const query = e.target.value.toLowerCase().trim();
    const rows = panel.querySelectorAll('.yt-transcript-ext-cue-row');
    rows.forEach((row) => {
      const textEl = row.querySelector('.yt-transcript-ext-cue-text');
      if (!textEl.hasAttribute('data-original-text')) {
        textEl.setAttribute('data-original-text', textEl.textContent);
      }
      const originalText = textEl.getAttribute('data-original-text');
      const originalTextLower = originalText.toLowerCase();
      
      if (query === '') {
        row.style.display = 'flex';
        textEl.textContent = originalText;
      } else if (originalTextLower.includes(query)) {
        row.style.display = 'flex';
        const regex = new RegExp(`(${query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
        const highlighted = originalText.replace(regex, '<mark class="yt-transcript-ext-search-highlight" style="background: rgba(6, 182, 212, 0.3); color: inherit; padding: 1px 3px; border-radius: 3px; border-bottom: 2px solid #06b6d4;">$1</mark>');
        textEl.innerHTML = highlighted;
      } else {
        row.style.display = 'none';
      }
    });
  };

  // Add Playlist Extractor Button if active playlist detected
  const urlParams = new URLSearchParams(window.location.search);
  const playlistId = urlParams.get('list');
  const playlistVideos = getAllPlaylistVideos();
  
  if (playlistId && playlistVideos.length > 0) {
    const playlistContainer = document.createElement('div');
    playlistContainer.className = 'yt-transcript-ext-playlist-container';
    playlistContainer.style.cssText = "margin-top: 10px; margin-bottom: 6px; display: flex; justify-content: center;";
    
    playlistContainer.innerHTML = `
      <button class="yt-transcript-ext-playlist-btn" style="width: 100%; padding: 8px 12px; background: linear-gradient(90deg, #00f2fe 0%, #06b6d4 100%); color: #0d0d0d; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 12.5px; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.25); transition: all 0.2s ease;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 9H5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V11c0-1.1-.9-2-2-2zM5 11h14v10H5V11zm10-8H9v2h6V3zm4 3H5v2h14V6z"/>
        </svg>
        <span>Extract Playlist Transcripts (${playlistVideos.length})</span>
      </button>
    `;
    
    const button = playlistContainer.querySelector('.yt-transcript-ext-playlist-btn');
    button.onmouseenter = () => {
      button.style.transform = 'translateY(-1px)';
      button.style.boxShadow = '0 6px 16px rgba(6, 182, 212, 0.4)';
    };
    button.onmouseleave = () => {
      button.style.transform = 'translateY(0)';
      button.style.boxShadow = '0 4px 12px rgba(6, 182, 212, 0.25)';
    };
    button.onclick = (e) => {
      e.stopPropagation();
      extractPlaylistTranscripts(playlistVideos);
    };
    
    const searchContainer = panel.querySelector('.yt-transcript-ext-search-container');
    if (searchContainer) {
      searchContainer.parentNode.insertBefore(playlistContainer, searchContainer.nextSibling);
    }
  }

  // Populate segments/cues list
  const container = panel.querySelector('.yt-transcript-ext-cues-container');
  segments.forEach((seg, idx) => {
    const row = document.createElement('div');
    row.className = 'yt-transcript-ext-cue-row';
    row.setAttribute('data-index', idx);

    row.innerHTML = `
      <span class="yt-transcript-ext-cue-timestamp">${seg.timeStr}</span>
      <span class="yt-transcript-ext-cue-text">${seg.text}</span>
    `;

    // Click segment timestamp to seek video
    row.querySelector('.yt-transcript-ext-cue-timestamp').onclick = (e) => {
      e.stopPropagation(); // Avoid double click trigger on row
      if (videoElement) {
        videoElement.currentTime = seg.startMs / 1000;
        videoElement.play();
      }
    };

    // Clicking anywhere on the segment row highlights and seeks
    row.onclick = () => {
      if (videoElement) {
        videoElement.currentTime = seg.startMs / 1000;
        videoElement.play();
      }
    };

    container.appendChild(row);
  });

  // Apply initial collapse state style
  updateCollapseState();

  // Setup progress syncing listeners
  setupVideoListeners();
  updateActiveHighlight();
}

// Fetch the transcript for a selected track
async function loadTranscriptForTrack(track) {
  showLoading();
  try {
    let baseUrl = track.baseUrl;
    if (baseUrl.startsWith('//')) {
      baseUrl = 'https:' + baseUrl;
    } else if (baseUrl.startsWith('/')) {
      baseUrl = 'https://www.youtube.com' + baseUrl;
    }
    const url = baseUrl + '&fmt=json3';
    const data = await fetchTranscriptJson(url);

    segments = [];
    if (data && data.events) {
      for (const event of data.events) {
        if (!event.segs) continue;
        const text = event.segs.map(seg => seg.utf8).join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const startMs = event.tStartMs || 0;
        segments.push({
          startMs,
          text,
          timeStr: formatTime(startMs / 1000)
        });
      }
    }

    currentLanguageCode = track.languageCode;
    renderTranscript();
  } catch (e) {
    console.error("[YT Extension] loadTranscriptForTrack error stack:", e.stack || e);
    showError("Could not retrieve transcript data. Try another language or refresh.");
  }
}

// Toast notification injector
function showToast(message) {
  let toast = document.querySelector('.yt-transcript-ext-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'yt-transcript-ext-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('yt-transcript-ext-toast-show');
  
  setTimeout(() => {
    toast.classList.remove('yt-transcript-ext-toast-show');
  }, 2000);
}

// Handle data passed from page context
async function handlePlayerResponse(videoId, playerResponse) {
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
  if (!videoId) return;

  const isWatch = checkPageAndTogglePanel();
  if (!isWatch) return;

  if (lastVideoId === videoId && transcriptData) {
    ensurePanelInjected();
    setupVideoListeners();
    return;
  }

  lastVideoId = videoId;
  transcriptData = playerResponse;
  activeSegmentIndex = -1;

  try {
    captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks || [];
  } catch (e) {
    captionTracks = [];
  }

  if (captionTracks.length === 0) {
    showError("No captions/transcripts available for this video.");
    return;
  }

  // Attempt to select English default, otherwise use first available
  const englishTrack = captionTracks.find(t => t.languageCode === 'en');
  const defaultTrack = englishTrack || captionTracks[0];

  await loadTranscriptForTrack(defaultTrack);
}

// Listen for messages from injected.js
window.addEventListener('message', (event) => {
  if (event.source === window && event.data && event.data.type === 'YOUTUBE_PLAYER_RESPONSE') {
    const { videoId, playerResponse } = event.data;
    handlePlayerResponse(videoId, playerResponse);
  }
});

// Setup on navigation completion
document.addEventListener('yt-navigate-finish', () => {
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
  // Clear any active native scraping resources
  if (nativeScrapeInterval) {
    clearInterval(nativeScrapeInterval);
    nativeScrapeInterval = null;
  }
  if (nativeObserver) {
    nativeObserver.disconnect();
    nativeObserver = null;
  }
  document.body.classList.remove('yt-transcript-scraped-active');

  const hasPanel = checkPageAndTogglePanel();
  if (hasPanel) {
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');
    const isPlaylistPage = window.location.pathname === '/playlist';
    
    if (isPlaylistPage) {
      waitForElement('ytd-playlist-header-renderer, #columns', () => {
        renderPlaylistPagePanel();
      }, 40);
    } else if (videoId && videoId !== lastVideoId) {
      lastVideoId = null;
      transcriptData = null;
      segments = [];
      activeSegmentIndex = -1;
      
      waitForElement('#secondary', () => {
        showLoading();
      });
    }
  }
});

// Listen for panel toggling and context menu actions from background
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (!message) return;
  
  if (message.action === "toggle-panel") {
    const panel = ensurePanelInjected() || document.getElementById('yt-transcript-ext-panel');
    if (panel) {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'flex' : 'none';
      if (isHidden && window.location.pathname === '/playlist') {
        renderPlaylistPagePanel();
      }
      showToast(isHidden ? "Transcript panel opened" : "Transcript panel closed");
    }
  } else if (message.action === "context-copy") {
    if (segments.length > 0) {
      const text = segments.map(s => `[${s.timeStr}] ${s.text}`).join('\n');
      const title = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(" - YouTube", "") || "YouTube Video";
      const videoUrl = window.location.href;
      const formattedText = `Title: ${title}\nURL: ${videoUrl}\n\n${text}`;
      try {
        await navigator.clipboard.writeText(formattedText);
        showToast("Transcript copied!");
      } catch (err) {
        console.error("Context copy failed: ", err);
        showToast("Failed to copy transcript.");
      }
    } else {
      showToast("No transcript available to copy.");
    }
  } else if (message.action === "context-summarize") {
    if (segments.length > 0) {
      const title = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(" - YouTube", "") || "this video";
      const videoUrl = window.location.href;
      const text = segments.map(s => s.text).join(' ');
      const promptText = `Summarize the following transcript of the YouTube video titled "${title}" (${videoUrl}) in 5 clear and concise bullet points. Include key takeaways and actionable insights:\n\n${text}`;
      try {
        await navigator.clipboard.writeText(promptText);
        showToast("Prompt copied! Opening ChatGPT...");
        window.open('https://chatgpt.com/', '_blank');
      } catch (err) {
        console.error("Context AI copy failed: ", err);
        showToast("Failed to copy prompt.");
      }
    } else {
      showToast("No transcript available to summarize.");
    }
  } else if (message.action === "context-playlist") {
    const playlistVideos = getAllPlaylistVideos();
    if (playlistVideos.length > 0) {
      extractPlaylistTranscripts(playlistVideos);
    } else {
      showToast("No playlist detected on this page.");
    }
  }
});

// Run initial injection and checks
waitForElement('#secondary, ytd-playlist-header-renderer, #columns', () => {
  const hasPanel = checkPageAndTogglePanel();
  if (hasPanel) {
    if (window.location.pathname === '/playlist') {
      renderPlaylistPagePanel();
    } else {
      // Request player response immediately to handshake with injected.js
      window.postMessage({ type: "REQUEST_YOUTUBE_PLAYER_RESPONSE" }, "*");
    }
  }
});
})();
