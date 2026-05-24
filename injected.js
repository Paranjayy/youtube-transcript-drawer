(function() {
  function getQueryParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
  }

  function postPlayerResponse() {
    const currentVideoId = getQueryParam('v');
    if (!currentVideoId) return false;

    const response = window.ytInitialPlayerResponse;
    if (response) {
      const responseVideoId = response.videoDetails ? response.videoDetails.videoId : null;
      if (responseVideoId === currentVideoId) {
        window.postMessage({
          type: "YOUTUBE_PLAYER_RESPONSE",
          videoId: currentVideoId,
          playerResponse: response
        }, "*");
        return true;
      }
    }
    return false;
  }

  // Send player response immediately on load
  postPlayerResponse();

  // Listen for YouTube's SPA navigation finish event
  document.addEventListener('yt-navigate-finish', () => {
    let attempts = 0;
    const interval = setInterval(() => {
      const success = postPlayerResponse();
      attempts++;
      if (success || attempts > 20) {
        clearInterval(interval);
      }
    }, 200);
  });

  // Listen for handshake requests from content.js (Isolated world)
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data && event.data.type === 'REQUEST_YOUTUBE_PLAYER_RESPONSE') {
      postPlayerResponse();
    }
  });
})();
