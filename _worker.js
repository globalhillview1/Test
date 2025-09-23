// Cloudflare Pages single-file worker that proxies to your existing
// Google Apps Script Web App without changing your GAS code.

const TARGET = 'https://script.google.com/macros/s/AKfycbw8ta_GdLedTCp1L-I6QKVcJzbJTgy6-3GfBtHMhrCS0ESlXRi5jHVs0v_AFeM6ZICN/exec';

// Utility: clone headers except a few hop-by-hop ones
function cloneHeaders(src) {
  const h = new Headers();
  for (const [k, v] of src.entries()) {
    if (/^host$|^cf-|^x-forwarded-|^content-length$/i.test(k)) continue;
    h.set(k, v);
  }
  return h;
}

// Rewrite Set-Cookie domain/path to this origin (so auth/session sticks)
function rewriteSetCookie(headers, thisHost) {
  const out = new Headers(headers);
  const cookies = headers.getAll ? headers.getAll('set-cookie') : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  if (cookies.length) {
    out.delete('set-cookie');
    for (let c of cookies) {
      // Drop explicit Domain so it defaults to current host
      c = c.replace(/;\s*Domain=[^;]+/i, '');
      // Ensure Path is root
      if (!/;\s*Path=/i.test(c)) c += '; Path=/';
      out.append('set-cookie', c);
    }
  }
  return out;
}

// Rewrite Location headers that point to script.google.com back to our domain
function rewriteLocation(headers, reqUrl) {
  const out = new Headers(headers);
  const loc = headers.get('location');
  if (loc) {
    try {
      const u = new URL(loc, TARGET);
      const targetHost = new URL(TARGET).host;
      if (u.host === targetHost) {
        // Keep path/query of the redirect but on our host
        const newLoc = new URL(reqUrl);
        newLoc.pathname = u.pathname.replace(/.*\/exec/, '') || '/';
        newLoc.search = u.search;
        out.set('location', newLoc.toString());
      }
    } catch (_) {}
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    const baseTarget = new URL(TARGET);

    // GAS webapps usually ignore extra path, but we forward it just in case.
    const upstream = new URL(TARGET);
    upstream.search = reqUrl.search; // preserve ?query
    // Append any extra path after the worker's root
    const extraPath = reqUrl.pathname === '/' ? '' : reqUrl.pathname;
    upstream.pathname = baseTarget.pathname + extraPath;

    // Build upstream request
    const headers = cloneHeaders(request.headers);
    headers.set('origin', upstream.origin);
    headers.set('referer', upstream.origin + '/');

    const init = {
      method: request.method,
      headers,
      redirect: 'manual'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    // Proxy
    const res = await fetch(upstream.toString(), init);

    // Clone body & headers to modify
    const body = res.body;
    let headersOut = new Headers(res.headers);

    // Normalize security headers that can break proxied apps
    headersOut.delete('content-encoding'); // let CF handle
    // Keep CSP/XFO as-is; Apps Script sets them appropriately.

    // Fix cookies & redirects for our domain
    headersOut = rewriteSetCookie(headersOut, reqUrl.host);
    headersOut = rewriteLocation(headersOut, reqUrl.toString());

    // Optional: CORS open (usually not needed since same-origin through proxy)
    headersOut.set('access-control-allow-origin', reqUrl.origin);
    headersOut.set('access-control-allow-credentials', 'true');

    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: headersOut
    });
  }
};
