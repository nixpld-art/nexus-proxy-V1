import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
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
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const BUILD_SEED = Date.now().toString(36).toUpperCase();
const VERSION = `${pkg.version}-b${BUILD_SEED}`;

/* ── AI backends ── */
const AI_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

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
    for (const msg of chatMessages.slice(-6)) prompt += (msg.role === "user" ? "User: " : "Assistant: ") + msg.content + "\n";
    prompt += "Assistant: ";
    for (const model of HF_MODELS) {
        try {
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 20000);
            const res = await fetch("https://api-inference.huggingface.co/models/" + model, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 512, temperature: 0.7, return_full_text: false } }),
                signal: ac.signal,
            });
            if (!res.ok) { if (res.status === 503) continue; continue; }
            const data = await res.json();
            const text = Array.isArray(data) ? data[0]?.generated_text || "" : data.generated_text || "";
            if (text.trim()) return text.trim();
        } catch { continue; }
    }
    return null;
}

async function askGemini(messages) {
    if (!GEMINI_KEY) return null;
    try {
        const systemMsg = messages.find(m => m.role === "system")?.content || "";
        const chatMessages = messages.filter(m => m.role !== "system");
        const contents = [];
        for (const m of chatMessages) contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
        const body = { contents };
        if (systemMsg) body.system_instruction = { parts: [{ text: systemMsg }] };
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 20000);
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_KEY, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ac.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch { return null; }
}

/* ── Proxy utilities ── */
function sanitizeUrl(raw) {
    let url = raw.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return null;
        return parsed.href;
    } catch { return null; }
}

async function proxyFetch(url, overrideAccept) {
    const sanitized = sanitizeUrl(url);
    if (!sanitized) throw new Error("Invalid URL: " + url);
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
    if (overrideAccept) headers["Accept"] = overrideAccept;
    const res = await fetch(sanitized, { headers, redirect: "follow" });
    return res;
}

function proxyBaseFromReq(req) {
    const host = req.headers.host || (req.hostname || "localhost") + ":" + (req.socket?.localPort || 8080);
    const protocol = req.protocol || (req.socket?.encrypted ? "https" : "http");
    return protocol + "://" + host + "/api/proxy/";
}

/* ═══════════════════════════════════════════════════════════════
   CLIENT-SIDE RUNTIME PROXY SCRIPT
   Injected into every proxied HTML page. Intercepts fetch(),
   XMLHttpRequest, history, and link clicks at runtime.
   ═══════════════════════════════════════════════════════════════ */
function clientScript(proxyBase, targetOrigin) {
    return `
<script>
(function(){
var PB = ${JSON.stringify(proxyBase)};
var TO = ${JSON.stringify(targetOrigin)};
var pbLen = PB.length;
function p(url){ return PB + encodeURIComponent(url); }
function isProxied(url){ return typeof url==='string' && url.substring(0,pbLen)===PB; }
function abs(url){ try{ return new URL(url,document.baseURI).href; }catch(e){ return url; } }
function needsProxy(url){
  if(!url||typeof url!=='string') return false;
  if(url.substring(0,5)==='data:'||url.substring(0,11)==='javascript:') return false;
  var full = abs(url);
  if(full.substring(0,pbLen)===PB) return false;
  try{
    var u=new URL(full);
    if(u.origin===location.origin) return false;
    if(u.protocol!=='http:'&&u.protocol!=='https:') return false;
  }catch(e){ return false; }
  return true;
}

// Intercept fetch()
var nativeFetch = window.fetch;
window.fetch = function(input, init){
  var req = (input instanceof Request) ? input : new Request(input, init);
  var url = req.url;
  if(needsProxy(url)){
    var newUrl = p(url);
    return nativeFetch.call(window, newUrl, init);
  }
  return nativeFetch.call(window, req);
};

// Intercept XMLHttpRequest
var XHR = window.XMLHttpRequest;
var OrigOpen = XHR.prototype.open;
XHR.prototype.open = function(method, url){
  this._proxyUrl = url;
  if(needsProxy(url)) arguments[1] = p(url);
  return OrigOpen.apply(this, arguments);
};

// Intercept link clicks (catch dynamically added links)
document.addEventListener('click', function(e){
  var a = e.target.closest('a');
  if(a && a.href && needsProxy(a.href) && !a.hasAttribute('download') && !e.ctrlKey&&!e.metaKey){
    e.preventDefault();
    location.href = p(a.href);
  }
}, true);

// ── Tab title + favicon spoofing ──
try{
  var prefix = '/api/proxy/';
  var pathPart = location.pathname;
  if(pathPart.indexOf(prefix)===0){
    var originUrl = decodeURIComponent(pathPart.substring(prefix.length));
    var originHost = new URL(originUrl).hostname;
    var pageTitle = document.title || originHost;
    var faviconUrl = 'https://www.google.com/s2/favicons?domain='+encodeURIComponent(originHost)+'&sz=64';
    var link = document.querySelector('link[rel="shortcut icon"],link[rel="icon"]');
    if(!link){ link=document.createElement('link'); link.rel='shortcut icon'; document.head.appendChild(link); }
    // Use actual site favicon if available in page
    var icons = document.querySelectorAll('link[rel*="icon"]');
    for(var i=0;i<icons.length;i++){
      var h = icons[i].href;
      if(h && h.indexOf('//')>0 && h.indexOf(TO)<0){ faviconUrl=h; break; }
    }
    link.href = faviconUrl;
    document.title = pageTitle;
    // Keep spoofed (SPAs override title/favicon)
    setInterval(function(){ document.title=pageTitle; link.href=faviconUrl; }, 1500);
  }
}catch(e){};

// Intercept history.pushState/replaceState for SPA routing
var origPushState = history.pushState;
var origReplaceState = history.replaceState;
history.pushState = function(){ return origPushState.apply(this,arguments); };
history.replaceState = function(){ return origReplaceState.apply(this,arguments); };

// Intercept window.open
var origOpen = window.open;
window.open = function(url){
  if(url && needsProxy(url)) arguments[0] = p(url);
  return origOpen.apply(window, arguments);
};

// Intercept postMessage target origin for YouTube iframe embeds
var origPM = window.postMessage;
window.postMessage = function(message, targetOrigin){
  if(targetOrigin && targetOrigin!=='*' && targetOrigin!=='/' && needsProxy(targetOrigin)){
    arguments[1] = '*';
  }
  return origPM.apply(this, arguments);
};

// Rewrite element src/href set dynamically via JS
var observer = new MutationObserver(function(mutations){
  mutations.forEach(function(m){
    if(m.type!=='attributes') return;
    var el = m.target;
    if(!el) return;
    var attr = m.attributeName;
    if(attr==='src'||attr==='href'||attr==='action'||attr==='data'){
      var val = el.getAttribute(attr);
      if(val && needsProxy(val)) el.setAttribute(attr, p(val));
    }
  });
});
observer.observe(document.documentElement, {attributes:true, subtree:true, attributeFilter:['src','href','action','data']});

// Auto-proxy any existing elements with external URLs
document.addEventListener('DOMContentLoaded', function(){
  document.querySelectorAll('[src],[href],[action],[data]').forEach(function(el){
    ['src','href','action','data'].forEach(function(attr){
      var val = el.getAttribute(attr);
      if(val && needsProxy(val)) el.setAttribute(attr, p(val));
    });
  });
});
})();
<\/script>`;
}

/* ═══════════════════════════════════════════════════════════════
   HTML REWRITER — injects client script + rewrites static URLs
   ═══════════════════════════════════════════════════════════════ */
function rewriteProxiedHtml(html, targetUrl, proxyBase) {
    const proxyUrl = (u) => {
        try { return proxyBase + encodeURIComponent(new URL(u, targetUrl).href); } catch { return u; }
    };

    html = html.replace(
        /(<(?:a|img|script|link|iframe|source|video|audio|form)\s[^>]*?)(href|src|action)=("|')((?![a-zA-Z]*:|\/\/|#|data:|javascript:|mailto:|tel:|blob:)[^"']+)("|')/gi,
        (match, before, attr, q, url, q2) => before + attr + "=" + q + proxyUrl(url) + q2
    );

    html = html.replace(/url\(("|')((?:[^"']+))("|')\)/gi, (m, q1, url, q2) => {
        if (url.startsWith("data:") || url.startsWith("#")) return m;
        return "url(" + q1 + proxyUrl(url) + q2 + ")";
    });

    const baseHref = targetUrl.replace(/[^/]*$/, "");
    const targetOrigin = new URL(targetUrl).origin;

    html = html.replace("</head>",
        '<base href="' + baseHref + '">' +
        clientScript(proxyBase, targetOrigin) +
        "</head>"
    );

    return html;
}

/* ═══════════════════════════════════════════════════════════════
   JS REWRITER — rewrites URL strings inside JavaScript to use proxy
   ═══════════════════════════════════════════════════════════════ */
function rewriteJs(js, targetUrl, proxyBase) {
    const targetOrigin = (() => { try { return new URL(targetUrl).origin; } catch { return ""; } })();
    if (!targetOrigin) return js;
    // Rewrite http/https string literals containing the target domain
    const escaped = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(['\"])(" + escaped + "[^'\"]*)(['\"])", "gi");
    js = js.replace(re, (m, q1, url, q2) => {
        try {
            const u = new URL(url);
            if (u.origin === targetOrigin) return q1 + proxyBase + encodeURIComponent(url) + q2;
        } catch {}
        return m;
    });
    return js;
}

/* ═══════════════════════════════════════════════════════════════
   BINARY/STREAM PROXY ROUTE for POST/PUT methods (body passthrough)
   ═══════════════════════════════════════════════════════════════ */
async function proxyRequest(req, reply, targetUrl, method) {
    const sanitized = sanitizeUrl(targetUrl);
    if (!sanitized) return reply.code(400).send({ error: "Invalid URL" });
    try {
        const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
        const body = req.body ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : undefined;
        const res = await fetch(sanitized, { method, headers, body, redirect: "follow" });
        const contentType = res.headers.get("content-type") || "";
        const status = res.status;
        if (contentType.includes("text/html") || contentType.includes("application/json")) {
            return reply.code(status).type(contentType).send(await res.text());
        }
        const buffer = await res.arrayBuffer();
        return reply.code(status).type(contentType).send(Buffer.from(buffer));
    } catch (err) {
        return reply.code(502).send({ error: "Proxy request failed: " + err.message });
    }
}

/* ── Wisp ── */
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
    allow_udp_streams: false,
    hostname_blacklist: [/example\.com/],
    dns_servers: ["1.1.1.3", "1.0.0.3", "8.8.8.8", "8.8.4.4"],
});

const fastify = Fastify({
    serverFactory: (handler) => {
        return createServer()
            .on("request", (req, res) => { handler(req, res); })
            .on("upgrade", (req, socket, head) => {
                if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
                else socket.end();
            });
    },
});

fastify.register(fastifyStatic, { root: publicPath, decorateReply: true });
fastify.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
fastify.register(fastifyStatic, { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
fastify.register(fastifyStatic, { root: baremuxPath, prefix: "/baremux/", decorateReply: false });
fastify.register(fastifyStatic, { root: epoxyPath, prefix: "/epoxy/", decorateReply: false });

/* ── Version ── */
fastify.get("/api/version", async (req, reply) => {
    return reply.send({ version: VERSION, build: BUILD_SEED, app: pkg.name });
});

/* ── Proxy endpoint (GET) ── */
fastify.get("/api/proxy/*", async (req, reply) => {
    try {
        const encoded = req.params["*"];
        if (!encoded) return reply.code(400).send({ error: "Missing URL" });

        const rawUrl = decodeURIComponent(encoded);
        const targetUrl = sanitizeUrl(rawUrl);
        if (!targetUrl) return reply.code(400).send({ error: "Invalid or malformed URL: " + rawUrl });

        const proxyBase = proxyBaseFromReq(req);
        const res = await proxyFetch(targetUrl);
        const contentType = res.headers.get("content-type") || "";
        const status = res.status;

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

        if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
            let js = await res.text();
            js = rewriteJs(js, targetUrl, proxyBase);
            return reply.code(status).type(contentType).send(js);
        }

        // Pass-through for media, fonts, etc.
        const buffer = await res.arrayBuffer();
        const passHeaders = {};
        const passThrough = ["content-type", "content-length", "cache-control", "etag", "last-modified", "accept-ranges", "content-range"];
        for (const h of passThrough) {
            const v = res.headers.get(h);
            if (v) passHeaders[h] = v;
        }
        return reply.code(status).headers(passHeaders).send(Buffer.from(buffer));
    } catch (err) {
        return reply.code(502).send({ error: "Proxy fetch failed: " + err.message });
    }
});

/* ── Proxy endpoint (POST/PUT — for API calls) ── */
fastify.post("/api/proxy/*", async (req, reply) => {
    try {
        const encoded = req.params["*"];
        if (!encoded) return reply.code(400).send({ error: "Missing URL" });
        const rawUrl = decodeURIComponent(encoded);
        const targetUrl = sanitizeUrl(rawUrl);
        if (!targetUrl) return reply.code(400).send({ error: "Invalid URL" });
        return await proxyRequest(req, reply, targetUrl, "POST");
    } catch (err) {
        return reply.code(502).send({ error: "Proxy POST failed: " + err.message });
    }
});

fastify.put("/api/proxy/*", async (req, reply) => {
    try {
        const encoded = req.params["*"];
        if (!encoded) return reply.code(400).send({ error: "Missing URL" });
        const rawUrl = decodeURIComponent(encoded);
        const targetUrl = sanitizeUrl(rawUrl);
        if (!targetUrl) return reply.code(400).send({ error: "Invalid URL" });
        return await proxyRequest(req, reply, targetUrl, "PUT");
    } catch (err) {
        return reply.code(502).send({ error: "Proxy PUT failed: " + err.message });
    }
});

/* ── AI Chat ── */
fastify.post("/api/ai/chat", async (req, reply) => {
    try {
        const body = req.body;
        const messages = body.messages || [];

        if (AI_KEY) {
            const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + AI_KEY };
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST", headers, body: JSON.stringify(body)
            });
            if (res.ok) return reply.send(await res.json());
        }

        const geminiReply = await askGemini(messages);
        if (geminiReply) return reply.send({ choices: [{ message: { role: "assistant", content: geminiReply } }] });

        const hfReply = await askHuggingFace(messages);
        if (hfReply) return reply.send({ choices: [{ message: { role: "assistant", content: hfReply } }] });

        return reply.code(503).send({ error: "AI backend unavailable. Set GEMINI_API_KEY or OPENAI_API_KEY in env." });
    } catch (err) {
        return reply.code(500).send({ error: err.message });
    }
});

/* ── Music Search ── */
fastify.get("/api/music/search", async (req, reply) => {
    try {
        const q = req.query?.q;
        if (!q || q.trim().length === 0) return reply.code(400).send({ error: "Query 'q' required" });
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
    } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.setNotFoundHandler((res, reply) => {
    return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", async () => {
    const address = fastify.server.address();
    console.log("Stratus Proxy v" + VERSION);
    console.log("Listening on:");
    console.log(`\thttp://localhost:${address.port}`);
    console.log(`\thttp://${hostname()}:${address.port}`);
    console.log("Server proxy at /api/proxy/ (GET, POST, PUT)");
    if (AI_KEY) console.log("AI: OpenAI");
    else if (GEMINI_KEY) console.log("AI: Google Gemini (free)");
    else console.log("AI: Hugging Face free inference (set GEMINI_API_KEY for better)");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
    console.log("Shutting down...");
    fastify.close();
    process.exit(0);
}

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;
fastify.listen({ port, host: "0.0.0.0" });
