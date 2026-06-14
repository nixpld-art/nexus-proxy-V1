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
	if (url.hostname === "www.youtube.com" || url.hostname === "i.ytimg.com") {
		return fetch(event.request);
	}
	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		const response = await scramjet.fetch(event);
		return stripHeaders(response);
	}
	const response = await fetch(event.request);
	return stripHeaders(response);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
