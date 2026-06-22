importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
let scramjet;
try {
    scramjet = new ScramjetServiceWorker();
} catch (e) {
    scramjet = null;
}

const STRIP_HEADERS = [
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "content-security-policy-report-only",
];

function stripHeaders(response) {
    const headers = new Headers(response.headers);
    STRIP_HEADERS.forEach((h) => headers.delete(h));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function isScramjetErrorPage(text) {
    return text.includes("<title>Scramjet</title>") || text.includes("errorTrace") || text.includes("Scramjet | Error");
}

const directHosts = [
    "ytimg.com", "googlevideo.com", "ggpht.com", "youtube.com",
    "cdn.jsdelivr.net", "cdnjs.cloudflare.com",
    "g.glance-cdn.com", "html5.gamedistribution.com",
    "static.cloudflareinsights.com", "imasdk.googleapis.com",
    "s0.2mdn.net", "pagead2.googlesyndication.com",
    "ajax.googleapis.com", "www.gstatic.com",
    "s3.amazonaws.com", "h5.ant.games",
    "googleapis.com", "googleusercontent.com",
];

const localPrefixes = [
    "/scram/", "/baremux/", "/libcurl/", "/epoxy/",
    "/epoxy-wrapper.mjs", "/api/", "/games/", "/apps/",
    "/firebase-sdk/", "/music/",
];

async function handleRequest(event) {
    const url = new URL(event.request.url);
    const destination = event.request.destination;

    try {
        if (directHosts.some(h => url.hostname === h || url.hostname.endsWith("." + h))) {
            return fetch(event.request);
        }

        if (url.origin === location.origin &&
            localPrefixes.some(p => url.pathname.startsWith(p))) {
            return fetch(event.request);
        }

        if (url.pathname.startsWith("/scramjet/")) {
            const encodedUrl = url.pathname.slice("/scramjet/".length);
            let origUrl;
            try {
                origUrl = decodeURIComponent(encodedUrl);
            } catch {
                return fetch(event.request);
            }

            const proxyFallback = () => fetch("/api/proxy/" + encodeURIComponent(origUrl));

            if (destination === "document" || destination === "iframe") {
                if (!scramjet) return proxyFallback();
                try {
                    await scramjet.loadConfig();
                } catch { /* config may already be loaded */ }
                let canRoute = false;
                try {
                    canRoute = scramjet.route(event);
                } catch { /* route check failed */ }
                if (canRoute) {
                    try {
                        const response = await scramjet.fetch(event);
                        const ct = response.headers.get("content-type") || "";
                        if (!ct || ct.includes("text/html") || ct.includes("application/json")) {
                            const text = await response.text();
                            if (isScramjetErrorPage(text)) {
                                return proxyFallback();
                            }
                            if (ct.includes("text/html")) {
                                if (event.request.url.includes("youtube.com")) {
                                    const patched = text.replace(
                                        '</head>',
                                        '<script>let i=setInterval(function(){var b=document.querySelector(\'[aria-label="Accept all"], [aria-label="Accept all"]\');if(b){b.click();clearInterval(i)}},200);setTimeout(function(){clearInterval(i)},8000);<\/script></head>'
                                    );
                                    return stripHeaders(new Response(patched, {
                                        status: response.status,
                                        statusText: response.statusText,
                                        headers: response.headers,
                                    }));
                                }
                                return stripHeaders(new Response(text, {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: response.headers,
                                }));
                            }
                        }
                        if (!response.ok) return proxyFallback();
                        return stripHeaders(response);
                    } catch (e) {
                        return proxyFallback();
                    }
                }
            }

            return proxyFallback();
        }

        const response = await fetch(event.request);
        return stripHeaders(response);
    } catch (e) {
        return fetch(event.request);
    }
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        await self.clients.claim();
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
    })());
});

self.addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event));
});
