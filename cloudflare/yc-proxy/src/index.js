/**
 * Proxies sitly.ru / gipsplamya.ru to Yandex API Gateway.
 * Sets cache headers and uses the edge Cache API so HTML and hashed
 * Astro assets are cached correctly; API/admin stay uncached.
 */

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-proto",
  "x-real-ip",
]);

const STATIC_EXT =
  /\.(?:css|js|mjs|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|txt|xml|json|webmanifest)$/i;

function originFor(host, env) {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "sitly.ru" || h === "www.sitly.ru") return env.ORIGIN_SITLY;
  if (h === "gipsplamya.ru" || h === "www.gipsplamya.ru") return env.ORIGIN_GIPS;
  return null;
}

/** Canonical host is apex (no www) — matches SITE_URL / sitemap. */
function wwwToApexRedirect(url) {
  const host = url.hostname.toLowerCase();
  if (!host.startsWith("www.")) return null;
  const apex = host.slice(4);
  if (apex !== "sitly.ru" && apex !== "gipsplamya.ru") return null;
  const target = new URL(url.toString());
  target.hostname = apex;
  target.protocol = "https:";
  return Response.redirect(target.toString(), 301);
}

function isBypassPath(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  );
}

function isHtmlPath(pathname) {
  return (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith("/") ||
    (!STATIC_EXT.test(pathname) && !pathname.includes("."))
  );
}

/** Browser + CDN cache policy for a path. */
function cachePolicy(pathname) {
  if (isBypassPath(pathname)) {
    return {
      store: false,
      browser: "private, no-store",
      edge: null,
    };
  }
  if (pathname.startsWith("/_astro/")) {
    return {
      store: true,
      browser: "public, max-age=31536000, immutable",
      edge: "public, max-age=31536000",
    };
  }
  if (STATIC_EXT.test(pathname)) {
    return {
      store: true,
      browser: "public, max-age=86400",
      edge: "public, max-age=604800",
    };
  }
  if (isHtmlPath(pathname)) {
    // Short edge TTL: ContentSync fills copy from /api/content.
    return {
      store: true,
      browser: "public, max-age=0, must-revalidate",
      edge: "public, max-age=300",
    };
  }
  return {
    store: false,
    browser: "private, no-store",
    edge: null,
  };
}

function applyCacheHeaders(headers, policy) {
  headers.set("Cache-Control", policy.browser);
  if (policy.edge) {
    headers.set("CDN-Cache-Control", policy.edge);
  } else {
    headers.delete("CDN-Cache-Control");
  }
  // Origin/object storage sometimes sends weak/conflicting hints.
  headers.delete("Expires");
  headers.delete("Pragma");
}

async function proxyToOrigin(request, target) {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (HOP.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    cf: {
      // Subrequest cache between Worker and Yandex for cacheable GETs.
      cacheEverything: false,
    },
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return fetch(target, init);
}

function cacheKeyFor(request, url) {
  // Normalize: ignore fragment; keep query (rare for static).
  return new Request(url.toString(), {
    method: "GET",
    headers: request.headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const redirect = wwwToApexRedirect(url);
    if (redirect) return redirect;

    const originBase = originFor(url.hostname, env);
    if (!originBase) {
      return new Response("Unknown host", { status: 404 });
    }

    const target = new URL(url.pathname + url.search, originBase);
    const policy = cachePolicy(url.pathname);
    const method = request.method.toUpperCase();
    const canCache =
      policy.store && (method === "GET" || method === "HEAD");

    const cache = caches.default;
    const key = canCache ? cacheKeyFor(request, url) : null;

    if (canCache && method === "GET") {
      const hit = await cache.match(key);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set("X-Yc-Proxy-Cache", "HIT");
        return new Response(hit.body, {
          status: hit.status,
          statusText: hit.statusText,
          headers,
        });
      }
    }

    // Origin rejects HEAD (405); use GET for cacheable docs/assets.
    let upstreamReq = request;
    if (method === "HEAD" && canCache) {
      upstreamReq = new Request(request.url, {
        method: "GET",
        headers: request.headers,
        redirect: "manual",
      });
    }

    const upstream = await proxyToOrigin(upstreamReq, target);
    const headers = new Headers(upstream.headers);
    applyCacheHeaders(headers, policy);
    headers.set("X-Yc-Proxy-Cache", canCache ? "MISS" : "BYPASS");

    let body = upstream.body;
    if (method === "HEAD") {
      body = null;
    }

    const response = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    if (
      canCache &&
      method === "GET" &&
      upstream.status >= 200 &&
      upstream.status < 400 &&
      !headers.has("Set-Cookie")
    ) {
      ctx.waitUntil(cache.put(key, response.clone()));
    }

    return response;
  },
};
