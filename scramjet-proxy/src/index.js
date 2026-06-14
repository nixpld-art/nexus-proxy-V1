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

fastify.post("/api/ai/chat", async (req, reply) => {
    try {
        const body = req.body;

        // Option 1: OpenAI API key (set via OPENAI_API_KEY env var)
        if (AI_KEY) {
            const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + AI_KEY };
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST", headers, body: JSON.stringify(body)
            });
            if (!res.ok) return reply.code(res.status).send({ error: await res.text() });
            return reply.send(await res.json());
        }

        // Option 2: Ollama (local, free, no API key)
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

        // No AI backend configured
        return reply.code(503).send({
            error: "No AI backend configured. Install Ollama (ollama.com) for free local AI, or set the OPENAI_API_KEY environment variable on the server."
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

	// Check AI backend availability
	if (AI_KEY) {
		console.log("AI: OpenAI (OPENAI_API_KEY set)");
	} else if (await checkOllama()) {
		console.log("AI: Ollama (local)");
	} else {
		console.log("AI: No backend configured. Install Ollama (ollama.com) or set OPENAI_API_KEY.");
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
