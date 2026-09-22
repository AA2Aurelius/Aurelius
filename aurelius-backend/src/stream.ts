// HTTP Range support for video streaming (RFC 9110 §14). Safari/iOS will
// not play <video> without 206 Partial Content responses.

export type ByteRange = { offset: number; length: number };

// Returns the single range to serve, null to serve the whole file (no header,
// a malformed header, or a multi-range request -- all allowed to fall back to
// 200), or 'unsatisfiable' for a 416.
export function parseRange(header: string | null | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;

  if (startStr === '' && endStr === '') return null;

  if (startStr === '') {
    // Suffix range: the last N bytes.
    const n = Number(endStr);
    if (n === 0 || size === 0) return 'unsatisfiable';
    const offset = Math.max(0, size - n);
    return { offset, length: size - offset };
  }

  const start = Number(startStr);
  if (start >= size) return 'unsatisfiable';
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

const BASE_HEADERS = {
  'Accept-Ranges': 'bytes',
  // The link token is part of the URL -- keep responses out of shared caches.
  'Cache-Control': 'private, no-store',
};

export async function serveR2Object(bucket: R2Bucket, key: string, req: Request): Promise<Response | null> {
  const head = await bucket.head(key);
  if (!head) return null;

  const size = head.size;
  const contentType = head.httpMetadata?.contentType ?? 'video/mp4';
  const common = { ...BASE_HEADERS, 'Content-Type': contentType, ETag: head.httpEtag };
  const range = parseRange(req.headers.get('Range'), size);

  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${size}` } });
  }

  if (range === null) {
    const headers = { ...common, 'Content-Length': String(size) };
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const obj = await bucket.get(key);
    if (!obj) return null;
    return new Response(obj.body, { status: 200, headers });
  }

  const headers = {
    ...common,
    'Content-Length': String(range.length),
    'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
  };
  if (req.method === 'HEAD') return new Response(null, { status: 206, headers });
  const obj = await bucket.get(key, { range });
  if (!obj) return null;
  return new Response(obj.body, { status: 206, headers });
}
