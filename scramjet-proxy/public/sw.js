importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

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

async function handleRequest(event) {
	const url = new URL(event.request.url);

	// Game CDNs and media — bypass proxy
	const directHosts = ["ytimg.com", "googlevideo.com", "ggpht.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "g.glance-cdn.com", "html5.gamedistribution.com", "static.cloudflareinsights.com", "imasdk.googleapis.com", "s0.2mdn.net", "pagead2.googlesyndication.com", "ajax.googleapis.com", "www.gstatic.com", "s3.amazonaws.com", "h5.ant.games"];
	if (directHosts.some(h => url.hostname === h || url.hostname.endsWith("." + h))) {
		return fetch(event.request);
	}

	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		const response = await scramjet.fetch(event);
		// For YouTube pages, inject consent-bypass script and US params
		const targetUrl = event.request.url;
		if (targetUrl.includes("youtube.com") && response.headers.get("content-type")?.includes("text/html")) {
			const text = await response.text();
			const patched = text
				.replace('</head>', '<script>let i=setInterval(function(){var b=document.querySelector(\'[aria-label="Accept all"], [aria-label="Accept all"]\');if(b){b.click();clearInterval(i)}},200);setTimeout(function(){clearInterval(i)},8000);<\/script></head>');
			return stripHeaders(new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers }));
		}
		return stripHeaders(response);
	}
	const response = await fetch(event.request);
	return stripHeaders(response);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
