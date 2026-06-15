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

/* Server-side proxy engine — works without service workers (school Chromebook fix) */
const serverProxyEngine = {
    name: "Server Proxy",
    id: "server",
    _proxyBase: "/api/proxy/",
    async init() {},
    createFrame() {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:none;display:block";
        return { frame: iframe, go: (u) => { iframe.src = this._proxyBase + encodeURIComponent(u); } };
    },
    encodeUrl(url) { return this._proxyBase + encodeURIComponent(url); },
    decodeUrl(url) {
        try {
            const prefix = this._proxyBase;
            if (url.startsWith(prefix)) return decodeURIComponent(url.slice(prefix.length));
            return url;
        } catch { return url; }
    },
    navigate(frame, url) { frame.frame.src = this._proxyBase + encodeURIComponent(url); },
};

/* Ultimate fallback: raw iframe, no proxy rewriting */
const directFallbackEngine = {
    name: "Direct",
    id: "direct",
    async init() {},
    createFrame() {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:none;display:block";
        return { frame: iframe, go: (u) => { iframe.src = u; } };
    },
    encodeUrl(url) { return url; },
    decodeUrl(url) { return url; },
    navigate(frame, url) { frame.frame.src = url; },
};

const ProxyEngines = {
    scramjet: {
        name: "Scramjet",
        id: "scramjet",
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
            try {
                const prev = await navigator.serviceWorker.getRegistration("/");
                if (prev && prev.active && prev.active.scriptURL !== location.origin + "/sw.js")
                    await prev.unregister();
            } catch (e) {}
            try { await navigator.serviceWorker.register("./sw.js", { scope: "/" }); } catch (e) { console.warn("SW register failed", e); }
            const reg = await swReadyWithTimeout(10000);
            if (!reg) { console.warn("Scramjet SW not ready after timeout, continuing without SW"); }
            try {
                const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
                const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
                if ((await connection.getTransport()) !== "/libcurl/index.mjs")
                    await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
            } catch (e) { console.warn("BareMux transport setup failed", e); }
        },
        createFrame() { return window.scramjet.createFrame(); },
        encodeUrl(url) { return window.scramjet.encodeUrl(url); },
        decodeUrl(url) { return window.scramjet.decodeUrl(url); },
        navigate(frame, url) { frame.go(url); },
    },
};
