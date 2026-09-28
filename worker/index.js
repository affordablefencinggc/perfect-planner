const securityHeaders = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function secureResponse(response, pathname, { fallback = false } = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  if (pathname === "/generated/current-generation.json" || pathname === "/index.html" || fallback) {
    headers.set("Cache-Control", "no-store, max-age=0");
  } else if (/^\/generated\/generations\/[a-f0-9]{64}\//.test(pathname) || /^\/assets\/.*-[a-zA-Z0-9_-]{8,}\./.test(pathname)) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "no-cache");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return secureResponse(response, requestUrl.pathname);
    }

    const indexUrl = new URL(requestUrl);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return secureResponse(
      await env.ASSETS.fetch(new Request(indexUrl, request)),
      "/index.html",
      { fallback: true },
    );
  },
};
