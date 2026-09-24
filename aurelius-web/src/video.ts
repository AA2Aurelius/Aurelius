// Attaches an HLS playlist to a <video>. Safari (including every iPhone
// browser) plays HLS natively; everything else goes through hls.js, loaded
// only then (the light build: no subtitles, alternate audio or DRM, which
// these videos don't use). Returns a function that detaches and cleans up.
export function attachHls(
  video: HTMLVideoElement,
  src: string,
  opts: { startSeconds?: number; onFatal?: (message: string) => void } = {}
): () => void {
  const start = opts.startSeconds ?? 0;

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    const onMeta = () => {
      if (start > 0) video.currentTime = start;
    };
    const onError = () => opts.onFatal?.('The video could not be loaded.');
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    video.addEventListener('error', onError);
    video.src = src;
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    };
  }

  let destroyed = false;
  let destroy = () => {};
  import('hls.js/light').then(({ default: Hls }) => {
    if (destroyed) return;
    if (!Hls.isSupported()) {
      opts.onFatal?.('This browser cannot play the video. Please try a recent version of Safari, Chrome, Edge or Firefox.');
      return;
    }
    const hls = new Hls({
      // Paced playlists are "live" (EVENT) playlists that grow as the server
      // releases chunks. Start where we ask (the beginning, or where the
      // patient left off), never at the live edge, and never speed up to
      // catch up with it. (hls.js's default liveMaxLatencyDurationCount,
      // Infinity, already means it never jumps forward.)
      startPosition: start,
      maxLiveSyncPlaybackRate: 1,
      lowLatencyMode: false,
      backBufferLength: 60,
    });
    let networkRetries = 0;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries++ < 5) {
        setTimeout(() => hls.startLoad(), 2000);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        opts.onFatal?.('The video could not be loaded. Please check your connection and reload the page.');
      }
    });
    hls.on(Hls.Events.FRAG_LOADED, () => (networkRetries = 0));
    hls.loadSource(src);
    hls.attachMedia(video);
    destroy = () => hls.destroy();
  }).catch((err) => {
    console.error('video player failed to start', err);
    opts.onFatal?.('The video player could not load. Please check your connection and reload the page.');
  });

  return () => {
    destroyed = true;
    destroy();
  };
}
