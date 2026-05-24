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

// Fetch player response for arbitrary video (background parsing)
async function getPlayerResponse(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  if (!response.ok) throw new Error("Failed to load page source");
  const html = await response.text();
  const regex = /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*(?:var\s+meta|<\/script|\n)/;
  const match = html.match(regex);
  if (match) {
    return JSON.parse(match[1]);
  }
  throw new Error("ytInitialPlayerResponse not found in source");
}

// Fetch and parse plain text transcript for batch zipping
async function fetchTranscriptText(baseUrl) {
  const url = baseUrl + '&fmt=json3';
  const response = await fetch(url);
  if (!response.ok) throw new Error("Fetch failed");
  const data = await response.json();
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

// Ensure the extension panel exists at the top of YouTube's secondary column
function ensurePanelInjected() {
  const secondary = document.querySelector('#secondary');
  if (!secondary) return null;

  let panel = document.getElementById('yt-transcript-ext-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'yt-transcript-ext-panel';
    secondary.insertBefore(panel, secondary.firstChild);
  }
  return panel;
}

// Show/hide panel based on current pathname
function checkPageAndTogglePanel() {
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v');
  const panel = document.getElementById('yt-transcript-ext-panel');
  
  if (!videoId) {
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
}

// Open YouTube's native transcript panel programmatically
function openNativeTranscript() {
  let btn = document.querySelector('ytd-video-description-transcripts-section-renderer button') ||
            Array.from(document.querySelectorAll('button')).find(el => el.textContent && el.textContent.includes('Show transcript'));
            
  if (btn) {
    btn.click();
    showToast("Opened native transcript!");
    return true;
  }
  
  const expandBtn = document.querySelector('#expand') || 
                    document.querySelector('tp-yt-paper-button#more') || 
                    document.querySelector('.ytd-video-secondary-info-renderer #more');
                    
  if (expandBtn) {
    expandBtn.click();
    showToast("Expanding description...");
    
    setTimeout(() => {
      const btnRetry = document.querySelector('ytd-video-description-transcripts-section-renderer button') ||
                       Array.from(document.querySelectorAll('button')).find(el => el.textContent && el.textContent.includes('Show transcript'));
      if (btnRetry) {
        btnRetry.click();
        showToast("Opened native transcript!");
      } else {
        showToast("Native transcript button not found.");
      }
    }, 400);
    return true;
  }
  
  showToast("Native transcript not available for this video.");
  return false;
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
      <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-top: 4px;">Automatically falling back to native transcript...</div>
      <button class="yt-transcript-ext-action-btn" id="yt-transcript-ext-error-native-btn" style="margin-top: 12px; background: #06b6d4; color: #0d0d0d; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; transition: all 0.15s ease;">Try Native Transcript</button>
    </div>
  `;

  const errorNativeBtn = panel.querySelector('#yt-transcript-ext-error-native-btn');
  if (errorNativeBtn) {
    errorNativeBtn.onclick = () => {
      openNativeTranscript();
    };
  }

  // Automatically attempt native fallback
  openNativeTranscript();
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
      const title = document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() || "this video";
      const text = segments.map(s => s.text).join(' ');
      const promptText = `Summarize the following transcript of the YouTube video titled "${title}" in 5 clear and concise bullet points. Include key takeaways and actionable insights:\n\n${text}`;
      
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
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    const text = segments.map(s => `[${s.timeStr}] ${s.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast("Transcript copied!");
    } catch (err) {
      console.error("Clipboard copy failed: ", err);
    }
  };

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

  // Search input filter
  const searchInput = panel.querySelector('.yt-transcript-ext-input');
  searchInput.oninput = (e) => {
    const query = e.target.value.toLowerCase().trim();
    const rows = panel.querySelectorAll('.yt-transcript-ext-cue-row');
    rows.forEach((row) => {
      const text = row.querySelector('.yt-transcript-ext-cue-text').textContent.toLowerCase();
      row.style.display = text.includes(query) ? 'flex' : 'none';
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
    const url = track.baseUrl + '&fmt=json3';
    const response = await fetch(url);
    if (!response.ok) throw new Error("Fetch failed");
    const data = await response.json();

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
    console.error(e);
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
  const isWatch = checkPageAndTogglePanel();
  if (isWatch) {
    // Check if video ID changed to clear panel details
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');
    if (videoId && videoId !== lastVideoId) {
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

// Listen for panel toggling from background service worker (icon click)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "toggle-panel") {
    const panel = document.getElementById('yt-transcript-ext-panel');
    if (panel) {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'flex' : 'none';
      showToast(isHidden ? "Transcript panel opened" : "Transcript panel closed");
    }
  }
});

// Run initial injection and checks
waitForElement('#secondary', () => {
  checkPageAndTogglePanel();
  // Request player response immediately to handshake with injected.js
  window.postMessage({ type: "REQUEST_YOUTUBE_PLAYER_RESPONSE" }, "*");
});
