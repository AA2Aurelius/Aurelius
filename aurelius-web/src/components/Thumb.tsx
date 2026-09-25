import { useEffect, useState } from 'react';
import { attachHls } from '../video';

// Video thumbnails. The uploaded videos have no poster images, so a frame is
// captured in the browser: the playlist is loaded into a hidden, muted video
// a couple of seconds in, and that frame is drawn to a canvas. One capture
// runs at a time, and results are kept for the page's lifetime. Where a
// frame can't be captured (e.g. iPhones don't load video without a tap), the
// soft placeholder stays.

const cache = new Map<string, string | null>();
const waiting = new Map<string, Array<(url: string | null) => void>>();
let queue: Promise<void> = Promise.resolve();

function capture(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let done = false;
    let detach = () => {};
    const finish = (url: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      detach();
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), 15000);
    const grab = () => {
      if (video.readyState < 2 || video.currentTime < 1 || !video.videoWidth) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = Math.round((480 * video.videoHeight) / video.videoWidth);
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.75));
      } catch {
        finish(null);
      }
    };
    video.addEventListener('loadeddata', grab);
    video.addEventListener('seeked', grab);
    video.addEventListener('canplay', grab);
    detach = attachHls(video, src, { startSeconds: 2, onFatal: () => finish(null) });
  });
}

export function useThumbnail(src: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (src ? cache.get(src) ?? null : null));
  useEffect(() => {
    if (!src) return;
    if (cache.has(src)) {
      setUrl(cache.get(src)!);
      return;
    }
    let live = true;
    const deliver = (u: string | null) => live && setUrl(u);
    const list = waiting.get(src);
    if (list) list.push(deliver);
    else {
      waiting.set(src, [deliver]);
      queue = queue.then(async () => {
        const u = await capture(src);
        cache.set(src, u);
        waiting.get(src)?.forEach((f) => f(u));
        waiting.delete(src);
      });
    }
    return () => {
      live = false;
    };
  }, [src]);
  return url;
}

export function Thumb({ src, small, label, onClick }: { src: string | null; small?: boolean; label?: string; onClick?: () => void }) {
  const url = useThumbnail(src);
  const inner = (
    <>
      {url && <img src={url} alt="" />}
      <span className="thumb-play"><span aria-hidden="true">▶</span></span>
    </>
  );
  const cls = `thumb ${small ? 'small' : ''}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-label={label}>{inner}</button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
