// radio-barry/functions/api/icy.js
// Cloudflare Pages Function: /api/icy?url=<stream-url>
// Doel:
// - ICY headers + eerste metadata-block lezen (StreamTitle)
// - CORS openzetten
// - Niet te lang hangen: abort na korte tijd

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,Origin",
    "Access-Control-Expose-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
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

function parseStreamTitle(metaStr) {
  // Voorbeeld: StreamTitle='Artist - Title';StreamUrl='';
  const m = metaStr.match(/StreamTitle='([^']*)'/i);
  return m ? m[1].trim() : "";
}

export async function onRequest({ request }) {
  const reqUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
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

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort("timeout"), 8000);

  try {
    const h = new Headers();
    h.set("Accept", "*/*");
    h.set("Accept-Encoding", "identity");
    h.set("Icy-MetaData", "1");
    h.set("User-Agent", "radio-barry-icy/1.2");

    // Kleine range helpt soms om sneller headers + eerste bytes te krijgen
    h.set("Range", "bytes=0-");

    const resp = await fetch(upstream.toString(), {
      method: "GET",
      headers: h,
      redirect: "follow",
      signal: ac.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const ct = resp.headers.get("content-type") || "";
    const icyName = resp.headers.get("icy-name") || "";
    const icyBr = resp.headers.get("icy-br") || resp.headers.get("ice-audio-info") || "";
    const metaIntStr = resp.headers.get("icy-metaint") || "";
    const metaInt = metaIntStr ? Number(metaIntStr) : 0;

    let bitrate = 0;
    if (resp.headers.get("icy-br")) {
      const n = Number(resp.headers.get("icy-br"));
      bitrate = Number.isFinite(n) ? n : 0;
    }

    let title = "";

    // Alleen metadata lezen als we metaint hebben en een body
    if (metaInt > 0 && resp.body) {
      const reader = resp.body.getReader();

      // 1) skip audio bytes tot metaint
      let toSkip = metaInt;
      while (toSkip > 0) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (value.byteLength <= toSkip) toSkip -= value.byteLength;
        else {
          // We hebben meer dan genoeg gelezen, rest laten we vallen
          toSkip = 0;
        }
      }

      // 2) 1 byte length indicator (len * 16 bytes)
      const lenRes = await reader.read();
      if (lenRes && lenRes.value && lenRes.value.length) {
        const metaLen = lenRes.value[0] * 16;

        if (metaLen > 0) {
          let metaBytes = new Uint8Array(metaLen);
          let filled = 0;

          while (filled < metaLen) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            const take = Math.min(value.byteLength, metaLen - filled);
            metaBytes.set(value.slice(0, take), filled);
            filled += take;
          }

          const raw = new TextDecoder("utf-8", { fatal: false }).decode(metaBytes);
          title = parseStreamTitle(raw);
        }
      }

      try { reader.cancel(); } catch {}
    }

    return json({
      ok: true,
      url: upstream.toString(),
      contentType: ct,
      icyName,
      icyBr,
      icyMetaint: metaInt || 0,
      bitrate,
      title,
    });
  } catch (e) {
    return json({ ok: false, error: String(e || "") }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
