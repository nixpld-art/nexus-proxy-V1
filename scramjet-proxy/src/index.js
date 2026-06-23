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
const VERSION = pkg.version;

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
    const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("0.0.0.0");
    const protocol = isLocal ? "http" : "https";
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
function p(url){ return PB + encodeURIComponent(url); }
function abs(url){ try{ return new URL(url,document.baseURI).href; }catch(e){ return url; } }
function needsProxy(url){
  if(!url||typeof url!=='string') return false;
  if(url.indexOf('data:')===0||url.indexOf('javascript:')===0) return false;
  var full = abs(url);
  if(full.indexOf(PB)===0) return false;
  try{
    var u=new URL(full);
    if(u.origin===location.origin) return false;
    if(u.protocol!=='http:'&&u.protocol!=='https:') return false;
  }catch(e){ return false; }
  return true;
}

// ── fetch() interceptor (preserves method/body/headers) ──
var nativeFetch = window.fetch;
window.fetch = function(input, init){
  var req = (input instanceof Request) ? input : new Request(input, init);
  if(!req.url||!needsProxy(req.url)) return nativeFetch.call(window, req);
  var newReq = new Request(p(req.url), req);
  return nativeFetch.call(window, newReq);
};

// ── XMLHttpRequest interceptor ──
var XHR = window.XMLHttpRequest;
var _open = XHR.prototype.open;
XHR.prototype.open = function(method, url){
  if(needsProxy(url)) url = p(url);
  return _open.call(this, method, url);
};

// ── Link click interceptor ──
document.addEventListener('click', function(e){
  var a = e.target.closest('a');
  if(a && a.href && needsProxy(a.href) && !a.hasAttribute('download') && !e.ctrlKey&&!e.metaKey){
    e.preventDefault();
    location.href = p(a.href);
  }
}, true);

// ── window.location setter interception ──
(function(){
  var _loc = window.location;
  try {
    var _locProto = Object.getPrototypeOf ? Object.getPrototypeOf(_loc) : Location.prototype;
    var _hrefDesc = Object.getOwnPropertyDescriptor(_locProto, 'href');
    if (_hrefDesc && _hrefDesc.set) {
      var _origSetHref = _hrefDesc.set;
      Object.defineProperty(window, 'location', {
        get: function() { return _loc; },
        set: function(url) {
          if (typeof url === 'string' && needsProxy(url)) { _origSetHref.call(_loc, p(url)); }
          else { _origSetHref.call(_loc, url); }
        },
        configurable: true
      });
    }
  } catch(e) {}
})();

// ── history.pushState/replaceState interceptor (for SPAs) ──
try {
  var _pushState = history.pushState;
  var _replaceState = history.replaceState;
  history.pushState = function(data, unused, url) {
    if (url && needsProxy(url)) url = p(url);
    return _pushState.call(this, data, unused, url);
  };
  history.replaceState = function(data, unused, url) {
    if (url && needsProxy(url)) url = p(url);
    return _replaceState.call(this, data, unused, url);
  };
} catch(e){}

// ── Form submit interceptor ──
try {
  var _formSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    var action = this.getAttribute('action') || this.action;
    if (action && needsProxy(action)) { this.action = p(action); }
    return _formSubmit.call(this);
  };
  document.addEventListener('submit', function(e){
    var form = e.target;
    if (form && form.action && needsProxy(form.action)) {
      e.preventDefault();
      var method = (form.method || 'GET').toUpperCase();
      var baseUrl = p(form.action);
      var fd = new FormData(form);
      if (method === 'GET') {
        var sep = baseUrl.indexOf('?') > -1 ? '&' : '?';
        for (var pair of fd.entries()) baseUrl += sep + encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
        sep = '&';
        location.href = baseUrl;
      } else {
        var params = new URLSearchParams();
        for (var pair of fd.entries()) params.append(pair[0], pair[1]);
        fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }).then(function(r){ location.href = baseUrl; });
      }
    }
  }, true);
} catch(e){}

// ── location.assign/location.replace interceptor ──
try {
  var _locAssign = location.assign;
  var _locReplace = location.replace;
  location.assign = function(url) {
    if (url && needsProxy(url)) { _locAssign.call(this, p(url)); }
    else { _locAssign.call(this, url); }
  };
  location.replace = function(url) {
    if (url && needsProxy(url)) { _locReplace.call(this, p(url)); }
    else { _locReplace.call(this, url); }
  };
} catch(e){}

// ── Tab title + favicon spoofing ──
try{
  var _path = location.pathname;
  var _isProxied = _path.indexOf('/api/proxy/')===0 || _path.indexOf('/scramjet/')===0;
  if(_isProxied){
    var _pLen = _path.indexOf('/api/proxy/')===0 ? '/api/proxy/'.length : '/scramjet/'.length;
    var _originUrl = decodeURIComponent(_path.substring(_pLen));
    var _originHost = new URL(_originUrl).hostname;
    var _pageTitle = document.title || _originHost;
    var _link = document.querySelector('link[rel="shortcut icon"],link[rel="icon"]');
    if(!_link){ _link=document.createElement('link'); _link.rel='shortcut icon'; document.head.appendChild(_link); }
    var _icons = document.querySelectorAll('link[rel*="icon"]');
    var _faviconUrl = '';
    for(var _i=0;_i<_icons.length;_i++){
      var _h = _icons[_i].href;
      if(_h && _h.indexOf('//')>0){ _faviconUrl=_h; break; }
    }
    if(!_faviconUrl || _faviconUrl.indexOf(PB)===0){
      _faviconUrl = PB + encodeURIComponent('https://www.google.com/s2/favicons?domain='+encodeURIComponent(_originHost)+'&sz=64');
    }
    _link.href = _faviconUrl;
    document.title = _pageTitle;
    setInterval(function(){ document.title=_pageTitle; _link.href=_faviconUrl; }, 1500);
  }
}catch(e){}

// ── window.open interceptor ──
var _open2 = window.open;
window.open = function(url){
  if(url && needsProxy(url)) return _open2.call(window, p(url));
  return _open2.apply(window, arguments);
};

// ── postMessage interceptor (for YouTube iframe embeds) ──
var _pm = window.postMessage;
window.postMessage = function(msg, target){
  if(target && target!=='*' && target!=='/' && needsProxy(target)) target = '*';
  return _pm.call(this, msg, target);
};

// ── MutationObserver: proxy src/href set dynamically ──
var observer = new MutationObserver(function(muts){
  for(var i=0;i<muts.length;i++){
    var m=muts[i];
    if(m.type!=='attributes') continue;
    var el=m.target, attr=m.attributeName;
    if(attr==='src'||attr==='href'||attr==='action'||attr==='data'){
      var val=el.getAttribute(attr);
      if(val && needsProxy(val)) el.setAttribute(attr, p(val));
    }
  }
});
observer.observe(document.documentElement, {attributes:true,subtree:true,attributeFilter:['src','href','action','data']});

// ── Auto-proxy existing elements with external URLs ──
document.addEventListener('DOMContentLoaded', function(){
  var els = document.querySelectorAll('[src],[href],[action],[data]');
  for(var i=0;i<els.length;i++){
    ['src','href','action','data'].forEach(function(attr){
      var val = els[i].getAttribute(attr);
      if(val && needsProxy(val)) els[i].setAttribute(attr, p(val));
    });
  }
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

    html = html.replace(
        /(<(?:a|img|script|link|iframe|source|video|audio|form)\s[^>]*?)(href|src|action)=("|')(\/\/[^"']+)("|')/gi,
        (match, before, attr, q, url, q2) => before + attr + "=" + q + proxyUrl("https:" + url) + q2
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
    trustProxy: true,
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
            const cssProxyUrl = (url) => {
                try { return proxyBase + encodeURIComponent(new URL(url, targetUrl).href); } catch { return url; }
            };
            css = css.replace(/url\(("|')((?:[^"']+))("|')\)/gi, (m, q1, url, q2) => {
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                return "url(" + q1 + cssProxyUrl(url) + q2 + ")";
            });
            css = css.replace(/url\(([^"'(][^"'\s)]*)\)/gi, (m, url) => {
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                return "url(" + cssProxyUrl(url) + ")";
            });
            css = css.replace(/@import\s+(?:url\(["']?([^"')]+)["']?\)|["']([^"']+)["'])/g, (m, url1, url2) => {
                const url = url1 || url2;
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                return '@import "' + cssProxyUrl(url) + '"';
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

/* ── Scramjet URL fallback (for when SW misses a /scramjet/ request) ── */
fastify.get("/scramjet/*", async (req, reply) => {
    try {
        const encoded = req.params["*"];
        if (!encoded) return reply.code(400).send({ error: "Missing URL" });
        const rawUrl = decodeURIComponent(encoded);
        const targetUrl = sanitizeUrl(rawUrl);
        if (!targetUrl) return reply.code(400).send({ error: "Invalid URL" });
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
            const cssProxyUrl = (url) => {
                try { return proxyBase + encodeURIComponent(new URL(url, targetUrl).href); } catch { return url; }
            };
            css = css.replace(/url\(("|')((?:[^"']+))("|')\)/gi, (m, q1, url, q2) => {
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                return "url(" + q1 + cssProxyUrl(url) + q2 + ")";
            });
            css = css.replace(/url\(([^"'(][^"'\s)]*)\)/gi, (m, url) => {
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                return "url(" + cssProxyUrl(url) + ")";
            });
            css = css.replace(/@import\s+(?:url\(["']?([^"')]+)["']?\)|["']([^"']+)["'])/g, (m, url1, url2) => {
                const url = url1 || url2;
                if (url.startsWith("data:") || url.startsWith("#")) return m;
                return '@import "' + cssProxyUrl(url) + '"';
            });
            return reply.code(status).type(contentType).send(css);
        }

        if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
            let js = await res.text();
            js = rewriteJs(js, targetUrl, proxyBase);
            return reply.code(status).type(contentType).send(js);
        }

        const buffer = await res.arrayBuffer();
        const passHeaders = {};
        const passThrough = ["content-type", "content-length", "cache-control", "etag", "last-modified", "accept-ranges", "content-range"];
        for (const h of passThrough) {
            const v = res.headers.get(h);
            if (v) passHeaders[h] = v;
        }
        return reply.code(status).headers(passHeaders).send(Buffer.from(buffer));
    } catch (err) {
        return reply.code(502).send({ error: "Scramjet fallback failed: " + err.message });
    }
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
