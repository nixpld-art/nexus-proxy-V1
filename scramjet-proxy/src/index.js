import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { join, dirname } from "node:path";
const epoxyPath = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@mercuryworkshop/epoxy-transport/dist");
import ytSearch from "yt-search";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

const AI_KEY = process.env.OPENAI_API_KEY || "";

async function checkOllama() {
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 2000);
        const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: ac.signal });
        return res.ok;
    } catch { return false; }
}

const HF_MODELS = [
    "microsoft/Phi-3-mini-4k-instruct",
    "HuggingFaceH4/zephyr-7b-beta",
    "google/gemma-2-2b-it",
    "mistralai/Mistral-7B-Instruct-v0.3",
];

async function askHuggingFace(messages) {
    const systemMsg = messages.find(m => m.role === "system")?.content || "You are a helpful assistant.";
    const chatMessages = messages.filter(m => m.role !== "system");
    const lastUserMsg = chatMessages.filter(m => m.role === "user").pop()?.content || "";

    if (!lastUserMsg) return null;

    let prompt = systemMsg + "\n\n";
    for (const msg of chatMessages.slice(-6)) {
        prompt += (msg.role === "user" ? "User: " : "Assistant: ") + msg.content + "\n";
    }
    prompt += "Assistant: ";

    for (const model of HF_MODELS) {
        try {
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 15000);
            const res = await fetch("https://api-inference.huggingface.co/models/" + model, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    inputs: prompt,
                    parameters: { max_new_tokens: 512, temperature: 0.7, return_full_text: false }
                }),
                signal: ac.signal,
            });
            if (!res.ok) {
                if (res.status === 503) continue;
                continue;
            }
            const data = await res.json();
            const text = Array.isArray(data) ? data[0]?.generated_text || "" : data.generated_text || "";
            if (text.trim()) return text.trim();
        } catch {
            continue;
        }
    }
    return null;
}

async function proxyFetch(url) {
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        redirect: "follow",
    });
    return res;
}

function rewriteProxiedHtml(html, targetUrl, proxyBase) {
    const proxyUrl = (u) => {
        try { return proxyBase + encodeURIComponent(new URL(u, targetUrl).href); } catch { return u; }
    };

    html = html.replace(
        /(<(?:a|img|script|link|iframe|source|video|audio)\s[^>]*?)(href|src|action)=("|')((?![a-zA-Z]*:|\/\/|#|data:|javascript:|mailto:|tel:|blob:)[^"']+)("|')/gi,
        (match, before, attr, q, url, q2) => {
            return before + attr + "=" + q + proxyUrl(url) + q2;
        }
    );

    html = html.replace(
        /(<form\s[^>]*?)action=("|')((?![a-zA-Z]*:|\/\/|#|data:|javascript:)[^"']+)("|')/gi,
        (match, before, q, url, q2) => {
            return before + "action=" + q + proxyUrl(url) + q2;
        }
    );

    html = html.replace(/url\(("|')((?:[^"']+))("|')\)/gi, (m, q1, url, q2) => {
        if (url.startsWith("data:") || url.startsWith("#")) return m;
        return "url(" + q1 + proxyUrl(url) + q2 + ")";
    });

    html = html.replace("</head>",
        '<base href="' + targetUrl.replace(/[^/]*$/, "") + '">' +
        '<script>var pb="' + proxyBase + '";document.addEventListener("click",function(e){var a=e.target.closest("a");if(a&&a.href&&!a.href.startsWith(pb)&&!a.href.startsWith("#")&&!a.href.startsWith("javascript:")){e.preventDefault();location.href=pb+encodeURIComponent(a.href)}});<\/script>' +
        "</head>"
    );

    return html;
}

// Wisp Configuration: Refer to the documentation at https://www.npmjs.com/package/@mercuryworkshop/wisp-js

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3", "8.8.8.8", "8.8.4.4"],
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: epoxyPath,
	prefix: "/epoxy/",
	decorateReply: false,
});

fastify.get("/api/proxy/*", async (req, reply) => {
    try {
        const encoded = req.params["*"];
        if (!encoded) return reply.code(400).send({ error: "Missing URL" });
        const targetUrl = decodeURIComponent(encoded);
        if (!/^https?:\/\//i.test(targetUrl)) return reply.code(400).send({ error: "Invalid URL" });

        const res = await proxyFetch(targetUrl);
        const contentType = res.headers.get("content-type") || "";
        const status = res.status;

        const host = req.headers.host || (req.hostname || "localhost") + ":" + (req.socket?.localPort || 8080);
        const protocol = req.protocol || (req.socket?.encrypted ? "https" : "http");
        const proxyBase = protocol + "://" + host + "/api/proxy/";

        if (contentType.includes("text/html")) {
            let html = await res.text();
            html = rewriteProxiedHtml(html, targetUrl, proxyBase);
            return reply.code(status).type(contentType).send(html);
        }

        if (contentType.includes("text/css")) {
            let css = await res.text();
            css = css.replace(/url\(("|')((?:[^"']+))("|')\)/gi, (m, q1, url, q2) => {
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                try { return "url(" + q1 + proxyBase + encodeURIComponent(new URL(url, targetUrl).href) + q2 + ")"; } catch { return m; }
            });
            return reply.code(status).type(contentType).send(css);
        }

        const buffer = await res.arrayBuffer();
        const passHeaders = {};
        const passThrough = ["content-type", "content-length", "cache-control", "etag", "last-modified"];
        for (const h of passThrough) {
            const v = res.headers.get(h);
            if (v) passHeaders[h] = v;
        }
        return reply.code(status).headers(passHeaders).send(Buffer.from(buffer));
    } catch (err) {
        return reply.code(502).send({ error: "Proxy fetch failed: " + err.message });
    }
});

fastify.post("/api/ai/chat", async (req, reply) => {
    try {
        const body = req.body;

        if (AI_KEY) {
            const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + AI_KEY };
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST", headers, body: JSON.stringify(body)
            });
            if (!res.ok) return reply.code(res.status).send({ error: await res.text() });
            return reply.send(await res.json());
        }

        const ollamaOk = await checkOllama();
        if (ollamaOk) {
            const res = await fetch("http://127.0.0.1:11434/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "llama3.2", messages: body.messages, stream: false })
            });
            if (!res.ok) return reply.code(res.status).send({ error: await res.text() });
            const data = await res.json();
            return reply.send({
                choices: [{ message: { role: "assistant", content: data.message?.content || "" } }]
            });
        }

        const hfReply = await askHuggingFace(body.messages || []);
        if (hfReply) {
            return reply.send({
                choices: [{ message: { role: "assistant", content: hfReply } }]
            });
        }

        return reply.code(503).send({
            error: "AI backend unavailable."
        });

    } catch (err) {
        return reply.code(500).send({ error: err.message });
    }
});

fastify.get("/api/music/search", async (req, reply) => {
    try {
        const q = req.query?.q;
        if (!q || q.trim().length === 0) {
            return reply.code(400).send({ error: "Query parameter 'q' is required" });
        }
        const results = await ytSearch(q.trim());
        const videos = (results.videos || []).slice(0, 12).map(v => ({
            id: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
            duration: v.timestamp || "0:00",
            author: v.author?.name || "Unknown",
            url: v.url,
            views: v.views
        }));
        return reply.send({ results: videos });
    } catch (err) {
        return reply.code(500).send({ error: err.message });
    }
});

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", async () => {
	const address = fastify.server.address();

	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);

	console.log("Server-side proxy fallback available at /api/proxy/");
	if (AI_KEY) {
		console.log("AI: OpenAI (OPENAI_API_KEY set)");
	} else if (await checkOllama()) {
		console.log("AI: Ollama (local)");
	} else {
		console.log("AI: Free Hugging Face inference (no setup needed)");
	}
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

fastify.listen({
	port: port,
	host: "0.0.0.0",
});
