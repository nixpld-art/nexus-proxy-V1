"use strict";

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

function swReadyWithTimeout(ms) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; resolve(null); }
        }, ms);
        navigator.serviceWorker.ready.then((reg) => {
            if (!done) { done = true; clearTimeout(timer); resolve(reg); }
        }, () => {
            if (!done) { done = true; clearTimeout(timer); resolve(null); }
        });
    });
}

function ensureProtocol(url) {
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) {
        url = "https://" + url;
    }
    return url;
}

function isValidUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch { return false; }
}

const serverProxyEngine = {
    name: "Server Proxy",
    id: "server",
    _proxyBase: "/api/proxy/",
    async init() {},
    createFrame() {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:none;display:block";
        iframe.setAttribute("allow", "autoplay; fullscreen; clipboard-read; clipboard-write");
        const _this = this;
        return {
            frame: iframe,
            go: (u) => { _this.navigate({ frame: iframe }, u); },
            back() { try { iframe.contentWindow?.history.back(); } catch {} },
            forward() { try { iframe.contentWindow?.history.forward(); } catch {} },
            reload() { try { iframe.contentWindow?.location.reload(); } catch {} },
        };
    },
    encodeUrl(url) {
        url = ensureProtocol(url);
        return this._proxyBase + encodeURIComponent(url);
    },
    decodeUrl(url) {
        try {
            const prefix = this._proxyBase;
            if (url.startsWith(prefix)) return decodeURIComponent(url.slice(prefix.length));
            return url;
        } catch { return url; }
    },
    navigate(frame, url) {
        url = ensureProtocol(url);
        if (!isValidUrl(url)) { console.warn("Invalid URL:", url); return; }
        frame.frame.src = this._proxyBase + encodeURIComponent(url);
    },
    supportsPost: true,
    proxyPost(url, body) {
        return fetch(this._proxyBase + encodeURIComponent(url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    },
};

const directFallbackEngine = {
    name: "Direct",
    id: "direct",
    async init() {},
    createFrame() {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:none;display:block";
        iframe.setAttribute("allow", "autoplay; fullscreen; clipboard-read; clipboard-write");
        const _this = this;
        return {
            frame: iframe,
            go: (u) => { _this.navigate({ frame: iframe }, u); },
            back() { try { iframe.contentWindow?.history.back(); } catch {} },
            forward() { try { iframe.contentWindow?.history.forward(); } catch {} },
            reload() { try { iframe.contentWindow?.location.reload(); } catch {} },
        };
    },
    encodeUrl(url) { return ensureProtocol(url); },
    decodeUrl(url) { return url; },
    navigate(frame, url) { frame.frame.src = ensureProtocol(url); },
};

async function setupBareMuxTransport() {
    const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
    const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

    try {
        const current = await connection.getTransport();
        if (current === "/epoxy-wrapper.mjs") return true;
    } catch { /* no transport yet */ }

    try {
        await connection.setTransport("/epoxy-wrapper.mjs", [{ wisp: wispUrl }]);
        const verify = await connection.getTransport();
        return verify === "/epoxy-wrapper.mjs";
    } catch (e) {
        console.warn("Epoxy transport failed:", e);
    }

    try {
        await connection.setTransport("/libcurl/index.mjs", [{ wisp: wispUrl }]);
        const verify = await connection.getTransport();
        return verify === "/libcurl/index.mjs";
    } catch (e) {
        console.warn("Libcurl transport also failed:", e);
    }

    return false;
}

async function forceSWUpdate() {
    try {
        const prev = await navigator.serviceWorker.getRegistration("/");
        if (prev) await prev.unregister();
    } catch { /* ignore */ }
    try {
        await navigator.serviceWorker.register("./sw.js", { scope: "/", updateViaCache: "none" });
    } catch (e) {
        console.warn("SW register failed", e);
        return false;
    }
    const reg = await swReadyWithTimeout(10000);
    return !!reg;
}

const ProxyEngines = {
    scramjet: {
        name: "Scramjet",
        id: "scramjet",
        _transportReady: false,
        async init() {
            if (!window.scramjet) {
                const { ScramjetController } = $scramjetLoadController();
                window.scramjet = new ScramjetController({
                    files: {
                        wasm: "/scram/scramjet.wasm.wasm",
                        all: "/scram/scramjet.all.js",
                        sync: "/scram/scramjet.sync.js",
                    },
                });
                await window.scramjet.init();
            }

            const swOk = await forceSWUpdate();
            if (!swOk) {
                throw new Error("SW registration failed");
            }

            const transportOk = await setupBareMuxTransport();
            if (!transportOk) {
                throw new Error("No BareMux transport available");
            }
        },
        createFrame() { return window.scramjet.createFrame(); },
        encodeUrl(url) { return window.scramjet.encodeUrl(url); },
        decodeUrl(url) { return window.scramjet.decodeUrl(url); },
        navigate(frame, url) { frame.go(url); },
    },
};
