// radio-barry/functions/api/stream.js
// Cloudflare Pages Function: /api/stream?url=<stream-url>
//
// Fixes:
// - Mixed content: play http streams on https site via this proxy
// - CORS for <audio>
// - Follow simple playlist responses (m3u/pls) if the given URL returns a playlist
// - Sniff first bytes and set a browser-friendly Content-Type (audio/mpeg, audio/aac, ...)
//   because some Shoutcast/Icecast servers send odd MIME types (e.g. audio/aacp, text/plain)
//   which makes Android/Chrome say: "bron niet ondersteund".

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,Content-Type,Accept,Origin",
    "Access-Control-Expose-Headers":
      "Content-Length,Content-Range,Accept-Ranges,Content-Type,icy-br,icy-metaint,icy-name,icy-description",
  };
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikePlaylistContentType(ct) {
  const c = (ct || "").toLowerCase();
  return (
    c.includes("mpegurl") ||
    c.includes("x-mpegurl") ||
    c.includes("vnd.apple.mpegurl") ||
    c.includes("scpls") ||
    c.includes("playlist") ||
    c.includes("audio/x-scpls")
  );
}

function parsePlaylistText(txt) {
  // m3u: lines with http(s) (ignore comments)
  // pls: File1=http://...
  const lines = (txt || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // PLS first
  for (const l of lines) {
    const m = l.match(/^File\d+=(.+)$/i);
    if (m && isHttpUrl(m[1].trim())) return m[1].trim();
  }

  // M3U / generic
  for (const l of lines) {
    if (l.startsWith("#")) continue;
    if (isHttpUrl(l)) return l;
  }
  return "";
}

function sniffMime(firstChunk) {
  if (!firstChunk || firstChunk.length < 4) return "";

  // Text markers (playlist etc.)
  const headAscii = (() => {
    try {
      const dec = new TextDecoder("utf-8", { fatal: false });
      return dec.decode(firstChunk.slice(0, 64));
    } catch {
      return "";
    }
  })();

  if (headAscii.startsWith("#EXTM3U")) return "application/vnd.apple.mpegurl";
  if (headAscii.startsWith("[playlist]")) return "audio/x-scpls";

  // Binary signatures
  // MP3: "ID3" or frame sync 0xFF Ex
  if (firstChunk[0] === 0x49 && firstChunk[1] === 0x44 && firstChunk[2] === 0x33) {
    return "audio/mpeg";
  }
  // AAC ADTS: 0xFF 0xF1 or 0xFF 0xF9
  if (firstChunk[0] === 0xff && (firstChunk[1] === 0xf1 || firstChunk[1] === 0xf9)) {
    return "audio/aac";
  }
  // MP3 frame sync (rough)
  if (firstChunk[0] === 0xff && (firstChunk[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  // OGG: "OggS"
  if (firstChunk[0] === 0x4f && firstChunk[1] === 0x67 && firstChunk[2] === 0x67 && firstChunk[3] === 0x53) {
    return "audio/ogg";
  }
  // FLAC: "fLaC"
  if (firstChunk[0] === 0x66 && firstChunk[1] === 0x4c && firstChunk[2] === 0x61 && firstChunk[3] === 0x43) {
    return "audio/flac";
  }

  return "";
}

function makeCorsResponse(body, status, headers) {
  const outH = new Headers(headers || {});
  const cors = corsHeaders();
  for (const k of Object.keys(cors)) outH.set(k, cors[k]);

  outH.set("Cache-Control", "no-store, no-transform");
  outH.set("Pragma", "no-cache");

  // Niet zelf "Connection" zetten (Workers/Pages strippen dit vaak anyway)
  outH.delete("connection");

  return new Response(body, { status, headers: outH });
}

async function fetchUpstream(request, urlStr) {
  const h = new Headers();
  const range = request.headers.get("Range");
  if (range) h.set("Range", range);

  h.set("Accept", "*/*");
  h.set("Accept-Encoding", "identity");
  h.set("User-Agent", "radio-barry-stream-proxy/2.0");

  // Belangrijk: geen ICY metadata forceren bij audio playback
  // h.set("Icy-MetaData","1");  <-- juist NIET

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), 20000);

  try {
    const resp = await fetch(urlStr, {
      method: request.method,
      headers: h,
      redirect: "follow",
      signal: ac.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

export async function onRequest({ request }) {
  const reqUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "Method not allowed");
  }

  const target = reqUrl.searchParams.get("url");
  if (!target) return text(400, "Missing ?url=");

  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return text(400, "Invalid url");
  }
  if (!["http:", "https:"].includes(upstream.protocol)) {
    return text(400, "Only http/https allowed");
  }

  // 1) Fetch initial URL
  let resp;
  try {
    resp = await fetchUpstream(request, upstream.toString());
  } catch (e) {
    return text(502, "Upstream fetch failed: " + String(e || ""));
  }

  // 2) If it looks like a playlist, read a small amount and follow the first stream URL
  const ct0 = resp.headers.get("content-type") || "";
  const maybePlaylist =
    looksLikePlaylistContentType(ct0) ||
    upstream.pathname.toLowerCase().endsWith(".m3u") ||
    upstream.pathname.toLowerCase().endsWith(".m3u8") ||
    upstream.pathname.toLowerCase().endsWith(".pls");

  if (maybePlaylist) {
    try {
      const txt = await resp.text();
      const nextUrl = parsePlaylistText(txt);
      if (nextUrl) {
        resp = await fetchUpstream(request, nextUrl);
      }
    } catch {
      // if playlist handling fails, continue with original resp
    }
  }

  // HEAD: return headers only
  if (request.method === "HEAD") {
    const h = new Headers(resp.headers);
    // CORS + cache headers
    return makeCorsResponse(null, resp.status, h);
  }

  // 3) Sniff first bytes to pick a browser-friendly Content-Type
  // We read one chunk, then re-stream it together with the remaining body.
  if (!resp.body) {
    return makeCorsResponse(null, resp.status, resp.headers);
  }

  const reader = resp.body.getReader();
  const first = await reader.read(); // {value, done}

  const firstChunk = first && first.value ? first.value : new Uint8Array();
  const sniffed = sniffMime(firstChunk);

  const newBody = new ReadableStream({
    start(controller) {
      if (firstChunk && firstChunk.length) controller.enqueue(firstChunk);

      function pump() {
        reader.read().then(({ value, done }) => {
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
          pump();
        }).catch(err => controller.error(err));
      }

      pump();
    },
    cancel() {
      try { reader.cancel(); } catch {}
    },
  });

  const outH = new Headers(resp.headers);

  // Als upstream rare mime stuurt of niks, override met sniffed audio type
  const upstreamCt = (outH.get("content-type") || "").toLowerCase();
  const upstreamLooksBad =
    !upstreamCt ||
    upstreamLooksBadMime(upstreamCt);

  if (sniffed) {
    // Als upstream content-type duidelijk fout is (text/plain, audio/aacp, etc.), force sniffed.
    if (
      upstreamLooksBad ||
      upstreamCt.includes("audio/aacp") ||
      upstreamCt.includes("text/plain") ||
      upstreamCt.includes("application/octet-stream")
    ) {
      outH.set("content-type", sniffed);
    }
  }

  return makeCorsResponse(newBody, resp.status, outH);
}

function upstreamLooksBadMime(ctLower) {
  // Browsers haken vaak af bij deze types voor audio streams
  if (ctLower.includes("text/html")) return true;
  if (ctLower.includes("text/plain")) return true;
  if (ctLower.includes("application/json")) return true;
  if (ctLower.includes("application/octet-stream")) return true;
  return false;
}
