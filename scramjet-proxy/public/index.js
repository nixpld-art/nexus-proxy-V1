"use strict";

/* Proxy engine init */
let activeProxy = null;
let proxyInitPromise = null;

async function initProxy() {
    let preferred = "server";
    try { preferred = localStorage.getItem("stratus-proxy") || "server"; } catch (e) {}
    const engineMap = { scramjet: ProxyEngines.scramjet, server: serverProxyEngine, direct: directFallbackEngine };
    const engineOrder = [engineMap[preferred], serverProxyEngine, directFallbackEngine];

    for (const engine of new Set(engineOrder)) {
        if (!engine) continue;
        try {
            await engine.init();
            activeProxy = engine;
            if (engine.id === "server") toast("Using server-side proxy (no service worker needed)");
            return engine;
        } catch (e) { console.warn("Proxy engine " + engine.id + " failed:", e); }
    }
    activeProxy = directFallbackEngine;
    return activeProxy;
}

/* Particle background */
const canvas = document.getElementById("bg-canvas");
const ctx = canvas.getContext("2d");
let particles = [];
let mouse = { x: -999, y: -999 };
let animId;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const COUNT = 80;
const CONNECT_DIST = 140;

function initParticles() {
    particles = [];
    for (let i = 0; i < COUNT; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.6,
            vy: (Math.random() - 0.5) * 0.6,
            r: Math.random() * 2 + 1,
        });
    }
}
initParticles();

canvas.addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener("mouseleave", () => { mouse.x = -999; mouse.y = -999; });

function drawParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const r = parseInt(accent.slice(1, 3), 16);
    const g = parseInt(accent.slice(3, 5), 16);
    const b = parseInt(accent.slice(5, 7), 16);

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 180) {
            p.x -= dx * 0.004;
            p.y -= dy * 0.004;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},0.4)`;
        ctx.fill();

        for (let j = i + 1; j < particles.length; j++) {
            const q = particles[j];
            const pdx = p.x - q.x;
            const pdy = p.y - q.y;
            const pd = Math.sqrt(pdx * pdx + pdy * pdy);
            if (pd < CONNECT_DIST) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(q.x, q.y);
                ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - pd / CONNECT_DIST) * 0.15})`;
                ctx.lineWidth = 0.6;
                ctx.stroke();
            }
        }
    }
    animId = requestAnimationFrame(drawParticles);
}
drawParticles();

/* Loading screen */
setTimeout(() => {
    document.getElementById("loading-screen").classList.add("hidden");
}, 800);

/* Init proxy engine immediately */
ensureProxy();

/* Proxy setup */
const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");

let connection = null;

async function ensureProxy() {
    if (activeProxy) return activeProxy;
    if (proxyInitPromise) return proxyInitPromise;
    try {
        proxyInitPromise = initProxy();
        const engine = await proxyInitPromise;
        connection = new BareMux.BareMuxConnection("/baremux/worker.js");
        return engine;
    } finally { proxyInitPromise = null; }
}

let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let frogTimeout = null;
let frogHideTimeout = null;
let urlPollInterval = null;

function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ── Version info ── */
(async function loadVersion() {
    try {
        const res = await fetch("/api/version");
        const data = await res.json();
        const badge = document.getElementById("versionBadge");
        if (badge) badge.textContent = "v" + data.version;
        const aboutV = document.getElementById("aboutVersion");
        if (aboutV) aboutV.textContent = data.version;
        const aboutB = document.getElementById("aboutBuild");
        if (aboutB) aboutB.textContent = data.build;
    } catch (e) {}
})();

/* Tab system */
async function createTab(url) {
    await ensureProxy();
    tabCounter++;
    const id = tabCounter;
    const frame = activeProxy.createFrame();
    const tabEl = document.createElement("button");
    tabEl.className = "frog-tab";
    tabEl.dataset.tabId = id;

    const title = document.createElement("span");
    title.className = "ft-title";
    title.textContent = url ? hostnameFromUrl(url) : "New Tab";
    const close = document.createElement("button");
    close.className = "ft-close";
    close.textContent = "×";

    tabEl.appendChild(title);
    tabEl.appendChild(close);
    document.getElementById("frog-tab-list").appendChild(tabEl);

    const tab = { id, frame, tabEl, titleEl: title, url: url || null };
    tabs.push(tab);
    switchTab(id);

    tabEl.addEventListener("click", (e) => {
        if (e.target !== close) switchTab(id);
    });
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id); });
    return id;
}

function hostnameFromUrl(url) {
    try { return new URL(url).hostname; } catch (e) { return url; }
}

function switchTab(id) {
    activeTabId = id;
    tabs.forEach((t) => t.tabEl.classList.toggle("active", t.id === id));
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const fc = document.getElementById("frame-container");
    fc.innerHTML = "";
    if (tab.frame && tab.frame.frame) {
        fc.appendChild(tab.frame.frame);
        fc.classList.toggle("has-frame", !!tab.url);
        if (tab.url) document.getElementById("frog-url").value = tab.url;
        startUrlPolling(tab);
    } else {
        fc.classList.remove("has-frame");
        stopUrlPolling();
        document.getElementById("frog-url").value = "";
    }
}

function closeTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.tabEl.remove();
    tabs = tabs.filter((t) => t.id !== id);
    if (activeTabId === id) {
        stopUrlPolling();
        if (tabs.length > 0) {
            switchTab(tabs[tabs.length - 1].id);
        } else {
            activeTabId = null;
            const fc = document.getElementById("frame-container");
            fc.innerHTML = "";
            fc.classList.remove("has-frame");
            document.getElementById("frog-url").value = "";
        }
    }
}

async function navigateTab(id, url) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    await ensureProxy();
    const fc = document.getElementById("frame-container");
    fc.innerHTML = "";
    fc.appendChild(tab.frame.frame);
    fc.classList.add("has-frame");
    tab.url = url;
    activeProxy.navigate(tab.frame, url);
    tab.titleEl.textContent = hostnameFromUrl(url);
    document.getElementById("frog-url").value = url;
    clearTimeout(tab._proxyCheck);
    tab._proxyCheck = setTimeout(() => {
        try {
            const doc = tab.frame.frame.contentDocument || tab.frame.frame.contentWindow?.document;
            if (doc && doc.body && doc.body.textContent && doc.body.textContent.length < 500 &&
                doc.body.textContent.includes("http")) {
                toast("Proxy blocked — your network may restrict proxies. Use Server mode in settings.");
            }
        } catch (e) {}
    }, 6000);
    autoCloakRedirect();
}

function navigateDirect(id, url) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const fc = document.getElementById("frame-container");
    fc.innerHTML = "";
    fc.appendChild(tab.frame.frame);
    fc.classList.add("has-frame");
    tab.url = url;
    tab.frame.frame.src = url;
    tab.titleEl.textContent = hostnameFromUrl(url);
    document.getElementById("frog-url").value = url;
    autoCloakRedirect();
}

/* URL polling */
function startUrlPolling(tab) {
    stopUrlPolling();
    updateFrogUrl(tab);
    urlPollInterval = setInterval(() => updateFrogUrl(tab), 800);
}

function stopUrlPolling() {
    if (urlPollInterval) { clearInterval(urlPollInterval); urlPollInterval = null; }
}

function updateFrogUrl(tab) {
    if (!tab || !tab.frame || !tab.frame.frame) return;
    try {
        const loc = tab.frame.frame.contentWindow.location.href;
        if (loc && loc !== "about:blank") {
            const decoded = activeProxy.decodeUrl(loc) || loc;
            document.getElementById("frog-url").value = decoded;
            tab.url = decoded;
            tab.titleEl.textContent = hostnameFromUrl(decoded);
        }
    } catch (e) {}
}

/* Frog bar */
const frogBar = document.getElementById("frog-bar");
let frogVisible = false;

function showFrogBar() {
    if (frogVisible) return;
    frogVisible = true;
    frogBar.classList.add("visible");
    const ft = document.getElementById("frog-toggle");
    if (ft) ft.classList.add("active");
    clearTimeout(frogHideTimeout);
}

function hideFrogBar(force) {
    if (!frogVisible && !force) return;
    clearTimeout(frogHideTimeout);
    if (document.activeElement && document.activeElement.id === "frog-url") return;
    frogVisible = false;
    frogBar.classList.remove("visible");
    const ft = document.getElementById("frog-toggle");
    if (ft) ft.classList.remove("active");
}

document.getElementById("frog-toggle")?.addEventListener("click", () => {
    if (frogVisible) { hideFrogBar(true); }
    else { showFrogBar(); }
});

document.getElementById("frog-url").addEventListener("focus", showFrogBar);
document.getElementById("frog-url").addEventListener("blur", () => {
    setTimeout(() => { if (!frogBar.matches(":hover")) hideFrogBar(); }, 120);
});

document.addEventListener("click", (e) => {
    const ft = document.getElementById("frog-toggle");
    if (frogVisible && !frogBar.contains(e.target) && e.target !== ft) {
        hideFrogBar(true);
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && frogVisible) {
        hideFrogBar(true);
        stopUrlPolling();
    }
});

/* Frog-bar drag */
let frogDrag = false, frogDragOffX = 0, frogDragOffY = 0;

(function initFrogPos() {
    try {
        const saved = localStorage.getItem("stratus-frog-pos");
        if (saved) {
            const pos = JSON.parse(saved);
            if (typeof pos.x === "number" && typeof pos.y === "number") {
                frogBar.style.left = pos.x + "px";
                frogBar.style.top = pos.y + "px";
                frogBar.classList.add("drag-mode");
            }
        }
    } catch (e) {}
})();

document.getElementById("frog-drag-handle").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = frogBar.getBoundingClientRect();
    frogDrag = true;
    frogDragOffX = e.clientX - rect.left;
    frogDragOffY = e.clientY - rect.top;
    frogBar.classList.add("drag-mode", "dragging");
    frogBar.style.left = rect.left + "px";
    frogBar.style.top = rect.top + "px";
});

document.addEventListener("mousemove", (e) => {
    if (!frogDrag) return;
    const x = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - frogDragOffX));
    const y = Math.max(0, e.clientY - frogDragOffY);
    frogBar.style.left = x + "px";
    frogBar.style.top = y + "px";
});

document.addEventListener("mouseup", () => {
    if (!frogDrag) return;
    frogDrag = false;
    frogBar.classList.remove("dragging");
    try {
        localStorage.setItem("stratus-frog-pos", JSON.stringify({
            x: parseFloat(frogBar.style.left),
            y: parseFloat(frogBar.style.top)
        }));
    } catch (e) {}
});

/* About:blank window tracking for re-cloaking */
const blankWindows = [];

function recloakBlanks() {
    const c = activeCloak && cloakMap[activeCloak] ? cloakMap[activeCloak] : defaultCloak;
    blankWindows.forEach((w) => {
        try {
            if (w && !w.closed) {
                w.document.title = c.title;
                const link = w.document.querySelector("link[rel='shortcut icon']");
                if (link) link.href = c.icon;
            }
        } catch (e) {}
    });
}

/* Frog controls */
document.getElementById("frog-back").addEventListener("click", () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) try { tab.frame.back(); } catch (e) {}
});

document.getElementById("frog-forward").addEventListener("click", () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) try { tab.frame.forward(); } catch (e) {}
});

document.getElementById("frog-refresh").addEventListener("click", () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) try { tab.frame.reload(); } catch (e) {}
});

document.getElementById("frog-home").addEventListener("click", () => {
    switchNav("home");
});

/* ── New Tab (fullscreen, not about:blank) ── */
document.getElementById("frog-popout").addEventListener("click", async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.url) { toast("Open a page first"); return; }
    await openFullscreenTab(tab.url);
});

document.getElementById("frog-newtab").addEventListener("click", async () => {
    await createTab();
    showFrogBar();
});

document.getElementById("frog-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("frog-url");
    const url = search(input.value, searchEngine.value);
    input.value = url;
    let id = activeTabId;
    if (!id || !tabs.find((t) => t.id === id)) {
        id = await createTab(url);
        await navigateTab(id, url);
    } else {
        await navigateTab(id, url);
    }
    showFrogBar();
});

/* Search form */
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = search(address.value, searchEngine.value);
    address.value = url;
    switchNav("proxy");
    let id = activeTabId;
    if (!id || !tabs.find((t) => t.id === id)) {
        id = await createTab(url);
        await navigateTab(id, url);
    } else {
        await navigateTab(id, url);
    }
    showFrogBar();
});

/* Nav */
document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => { switchNav(btn.dataset.view); });
});

let currentView = "home";

function switchNav(view) {
    currentView = view;
    document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const target = document.getElementById(view + "-view");
    if (target) target.classList.add("active");
    document.getElementById("navbar").style.display = view === "proxy" ? "none" : "flex";
    frogBar.classList.remove("visible");
    const ft = document.getElementById("frog-toggle");
    if (ft) ft.style.display = view === "proxy" ? "flex" : "none";
    if (view !== "proxy") { stopUrlPolling(); }
    if (view === "proxy" && tabs.length > 0) { showFrogBar(); }
}

switchNav("home");

/* App icons */
document.querySelectorAll(".app-icon").forEach((el) => {
    el.addEventListener("click", async (e) => {
        e.preventDefault();
        const url = el.dataset.url;
        switchNav("proxy");
        let id = activeTabId;
        if (!id || !tabs.find((t) => t.id === id)) {
            id = await createTab(url);
            await navigateTab(id, url);
        } else {
            await navigateTab(id, url);
        }
        showFrogBar();
    });
});

/* ── Fullscreen Tab — navigates directly to proxied URL, spoofs title/favicon ── */
async function openFullscreenTab(url) {
    await ensureProxy();
    const encodedUrl = location.origin + activeProxy.encodeUrl(url);

    const win = window.open(encodedUrl, "_blank");
    if (!win) { toast("Pop-up blocked"); return; }
    toast("Opened in new tab");
}

/* Settings */
const engineSelect = document.getElementById("engine-select");
searchEngine.value = engineSelect.value;
engineSelect.addEventListener("change", () => { searchEngine.value = engineSelect.value; });

const proxySelect = document.getElementById("proxy-select");
proxySelect.addEventListener("change", async () => {
    const val = proxySelect.value;
    try { localStorage.setItem("stratus-proxy", val); } catch (e) {}
    toast("Reloading proxy engine...");
    setTimeout(() => location.reload(), 500);
});

const cloakMap = {
    google: { title: "Google", icon: "https://www.google.com/favicon.ico" },
    classroom: { title: "Classroom", icon: "https://ssl.gstatic.com/classroom/favicon.png" },
    drive: { title: "Google Drive", icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" },
};
const defaultCloak = { title: "Stratus", icon: "icon.png" };

function applyCloak(val) {
    const c = val ? cloakMap[val] : defaultCloak;
    if (c) {
        document.title = c.title;
        const link = document.querySelector("link[rel='shortcut icon']");
        if (link) link.href = c.icon;
    }
}

let activeCloak = "";

async function autoCloakRedirect() {
    if (window.self !== window.top) return;
    if (!autocloakToggle || !autocloakToggle.checked || !activeCloak) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const cloak = cloakMap[activeCloak];
    if (!cloak) return;
    await ensureProxy();
    const win = window.open("about:blank", "_blank");
    if (!win) return;
    const frameUrl = tab?.url
        ? location.origin + activeProxy.encodeUrl(tab.url)
        : location.href;
    const musicState = JSON.stringify(getMusicState()).replace(/<\/script>/gi, '<\\/script>');
    const thumbSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%231a1a2e' rx='8'/%3E%3Ctext x='50' y='65' text-anchor='middle' font-size='35' fill='%23888'%3E%E2%99%AA%3C/text%3E%3C/svg%3E";
    win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
    win.document.write('<title>' + cloak.title + '</title>');
    win.document.write('<link id="cloakFavicon" rel="shortcut icon" href="' + cloak.icon + '">');
    win.document.write('<style>*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;overflow:hidden;background:#0a0a12;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px}#cloakFrame{width:100%;height:100%;border:none;display:block}#music-player{position:fixed;bottom:14px;right:14px;z-index:999999;background:rgba(10,10,18,0.85);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.06);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,0.6);overflow:hidden;width:320px;max-height:520px}#music-player.music-minimized{width:220px;border-radius:10px;cursor:pointer}#music-header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.04);gap:8px}.music-minimized #music-header{border-bottom:none}.music-compact{display:flex;align-items:center;gap:8px;flex:1;min-width:0}.music-compact img{width:30px;height:30px;border-radius:6px;object-fit:cover;flex-shrink:0;display:none}.music-compact img[src]:not([src=""]){display:block}.music-info{display:flex;flex-direction:column;min-width:0}#music-title{font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e0e0e0}#music-author{font-size:10px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.music-header-btns{display:flex;gap:4px;flex-shrink:0}.music-icon-btn{background:none;border:none;color:#888;cursor:pointer;padding:3px;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:background 0.15s,color 0.15s}.music-icon-btn:hover{background:rgba(255,255,255,0.06);color:#e0e0e0}#music-body{transition:max-height 0.3s ease,padding 0.3s ease;max-height:460px;overflow-y:auto;padding:0 10px 10px}.music-minimized #music-body{max-height:0;padding:0;overflow:hidden}#music-player-area{padding:10px 0}#music-progress{display:flex;align-items:center;gap:8px;margin-bottom:8px}#music-progress span{font-size:10px;color:#888;min-width:32px;text-align:center}#music-progress-bar{flex:1;height:4px;background:rgba(255,255,255,0.08);border-radius:4px;cursor:pointer;position:relative}#music-progress-fill{height:100%;width:0%;background:#00cc7a;border-radius:4px;transition:width 0.2s linear}#music-controls{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:8px}.music-ctrl-btn{background:none;border:none;color:#e0e0e0;cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background 0.15s,color 0.15s}.music-ctrl-btn:hover{background:rgba(255,255,255,0.08)}.music-ctrl-btn.active{color:#00cc7a}.music-play-btn{background:#00cc7a;color:#0a0a12;border-radius:50%;width:36px;height:36px;padding:0;display:flex;align-items:center;justify-content:center}.music-play-btn:hover{opacity:0.85}#music-volume-wrap{display:flex;align-items:center;gap:6px;margin-bottom:8px}#music-volume{flex:1;-webkit-appearance:none;appearance:none;height:3px;background:rgba(255,255,255,0.1);border-radius:3px;outline:none}#music-volume::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#00cc7a;cursor:pointer}#music-queue{border-top:1px solid rgba(255,255,255,0.04);padding-top:6px}.music-queue-header{display:flex;justify-content:space-between;font-size:11px;color:#888;margin-bottom:4px}#music-queue-list{max-height:160px;overflow-y:auto}.music-qitem{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;transition:background 0.12s}.music-qitem:hover{background:rgba(255,255,255,0.04)}.music-qitem.active{background:rgba(0,204,122,0.06)}.music-qitem img{width:24px;height:16px;border-radius:3px;object-fit:cover;flex-shrink:0}.q-title{flex:1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.q-remove{background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 2px;line-height:1}.q-remove:hover{color:#ff4444}.music-loading{display:flex;gap:4px;justify-content:center;padding:12px}.music-loading span{width:6px;height:6px;border-radius:50%;background:#00cc7a;animation:mb 1s infinite}.music-loading span:nth-child(2){animation-delay:0.15s}.music-loading span:nth-child(3){animation-delay:0.3s}@keyframes mb{0%,80%,100%{opacity:0.3}40%{opacity:1}}#music-search-area{padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04)}#music-search-area.music-hidden{display:none}.music-search-wrap input{width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:7px 10px;color:#e0e0e0;font-size:12px;outline:none;box-sizing:border-box}.music-search-wrap input:focus{border-color:rgba(0,204,122,0.4)}#music-results{max-height:200px;overflow-y:auto;margin-top:6px}.music-result-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;transition:background 0.12s}.music-result-item:hover{background:rgba(255,255,255,0.06)}.music-result-item img{width:36px;height:20px;border-radius:4px;object-fit:cover;flex-shrink:0}.r-title{flex:1;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r-meta{font-size:10px;color:#888;white-space:nowrap}</style></head><body>');
    win.document.write('<iframe id="cloakFrame" src="' + frameUrl + '" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>');
    win.document.write('<div id="music-player" class="music-minimized"><div id="music-header"><div id="music-now-playing" class="music-compact"><img id="music-thumb" src="" alt="" onerror="this.src=\'' + thumbSvg + '\'" /><div class="music-info"><span id="music-title">No track</span><span id="music-author"></span></div></div><div class="music-header-btns"><button id="music-search-toggle" class="music-icon-btn" title="Search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button><button id="music-toggle-btn" class="music-icon-btn" title="Minimize"><svg id="music-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button></div></div><div id="music-body"><div id="music-search-area" class="music-hidden"><div class="music-search-wrap"><input id="music-search-input" type="text" placeholder="Search songs..." /></div><div id="music-results"></div></div><div id="music-player-area"><div id="music-progress"><span id="music-current-time">0:00</span><div id="music-progress-bar"><div id="music-progress-fill"></div></div><span id="music-duration">0:00</span></div><div id="music-controls"><button id="music-shuffle-btn" class="music-ctrl-btn" title="Shuffle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg></button><button id="music-prev-btn" class="music-ctrl-btn" title="Previous"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="19 20 9 12 19 4 19 20"/><line y1="4" x2="4" y2="4" stroke="currentColor" stroke-width="2.5"/><line y1="20" x2="4" y2="20" stroke="currentColor" stroke-width="2.5"/></svg></button><button id="music-play-btn" class="music-ctrl-btn music-play-btn" title="Play"><svg id="music-play-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg></button><button id="music-next-btn" class="music-ctrl-btn" title="Next"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="4" x2="19" y2="20" stroke="currentColor" stroke-width="2.5"/></svg></button><button id="music-repeat-btn" class="music-ctrl-btn" title="Repeat"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></button></div><div id="music-volume-wrap"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg><input id="music-volume" type="range" min="0" max="100" value="80" /></div><div id="music-queue"><div class="music-queue-header"><span>Queue</span><span id="music-queue-count">0 songs</span></div><div id="music-queue-list"></div></div></div></div></div><div id="music-youtube-player" style="position:absolute;width:0;height:0;overflow:hidden"></div>');
    win.document.write('<script>window._musicState=' + musicState + ';<\/script>');
    win.document.write('<script src="/blank-player.js"><\/script>');
    win.document.write('<script>var icon="' + cloak.icon + '";var link=document.getElementById("cloakFavicon");function force(){link.href=icon;}document.getElementById("cloakFrame").onload=force;setInterval(force,500);<\/script>');
    win.document.write('</body></html>');
    win.document.close();
    blankWindows.push(win);
    window.location.replace("https://www.google.com");
}

document.querySelectorAll(".cloak-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
        document.querySelectorAll(".cloak-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeCloak = btn.dataset.cloak;
        try { localStorage.setItem("stratus-cloak", activeCloak); } catch (e) {}
        applyCloak(activeCloak);
        recloakBlanks();
        await autoCloakRedirect();
    });
});

(function loadSavedCloak() {
    try {
        const saved = localStorage.getItem("stratus-cloak");
        if (saved) {
            document.querySelectorAll(".cloak-btn").forEach((b) => b.classList.toggle("active", b.dataset.cloak === saved));
            activeCloak = saved;
            applyCloak(saved);
            recloakBlanks();
            return;
        }
    } catch (e) {}
    document.querySelector('[data-cloak=""]').classList.add("active");
})();

const autocloakToggle = document.getElementById("autocloak-toggle");
const autocloakLabel = document.getElementById("autocloak-label");

try {
    if (localStorage.getItem("stratus-autocloak") === "true") {
        autocloakToggle.checked = true;
        autocloakLabel.textContent = "On";
    }
} catch (e) {}

autocloakToggle.addEventListener("change", async () => {
    const on = autocloakToggle.checked;
    autocloakLabel.textContent = on ? "On" : "Off";
    try { localStorage.setItem("stratus-autocloak", on ? "true" : "false"); } catch (e) {}
    if (on && activeCloak) applyCloak(activeCloak);
    await autoCloakRedirect();
});

const themeSelect = document.getElementById("theme-select");
const savedTheme = (() => { try { return localStorage.getItem("stratus-theme"); } catch (e) { return null; } })() || "nexus";
document.documentElement.setAttribute("data-theme", savedTheme);
themeSelect.value = savedTheme;

const savedProxy = (() => { try { return localStorage.getItem("stratus-proxy"); } catch (e) { return null; } })() || "server";
proxySelect.value = ["scramjet", "server", "direct"].includes(savedProxy) ? savedProxy : "server";

themeSelect.addEventListener("change", () => {
    const val = themeSelect.value;
    document.documentElement.setAttribute("data-theme", val);
    try { localStorage.setItem("stratus-theme", val); } catch (e) {}
    toast("Theme: " + themeSelect.options[themeSelect.selectedIndex].text);
});

autoCloakRedirect();

/* ── Music Player (YouTube IFrame API) ── */
const musicQueue = [];
let musicIndex = -1;
let musicMinimized = true;
let musicHidden = false;
let shuffleOn = false;
let repeatOn = false;
let ytPlayer = null;
let ytReady = false;
let ytLoadAttempted = false;
let progressInterval = null;
const FALLBACK_THUMB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Ccircle cx='24' cy='24' r='22' fill='%23222'/%3E%3Cpath d='M18 14v20l16-10z' fill='%23888'/%3E%3C/svg%3E";
window.FALLBACK_THUMB = FALLBACK_THUMB;

const musicEl = document.getElementById("music-player");
const musicThumb = document.getElementById("music-thumb");
const musicTitle = document.getElementById("music-title");
const musicAuthor = document.getElementById("music-author");
const musicSearchInput = document.getElementById("music-search-input");
const musicResults = document.getElementById("music-results");
const musicSearchToggle = document.getElementById("music-search-toggle");
const musicSearchArea = document.getElementById("music-search-area");
const musicToggleBtn = document.getElementById("music-toggle-btn");
const musicToggleIcon = document.getElementById("music-toggle-icon");
const musicQueueList = document.getElementById("music-queue-list");
const musicQueueCount = document.getElementById("music-queue-count");
const frogMusicBtn = document.getElementById("frog-music-btn");
const playPauseBtn = document.getElementById("music-play-pause");
const prevBtn = document.getElementById("music-prev");
const nextBtn = document.getElementById("music-next");
const shuffleBtn = document.getElementById("music-shuffle");
const repeatBtn = document.getElementById("music-repeat");
const volumeBtn = document.getElementById("music-volume-btn");
const volumeSlider = document.getElementById("music-volume-slider");
const musicSeek = document.getElementById("music-seek");
const musicTimeCurrent = document.getElementById("music-time-current");
const musicTimeTotal = document.getElementById("music-time-total");

function formatTime(t) {
    if (!t || isNaN(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
}

function loadYouTubeAPI() {
    if (ytLoadAttempted) return;
    ytLoadAttempted = true;
    if (typeof YT !== "undefined" && YT.Player) { onYouTubeIframeAPIReady(); return; }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = function () {
        console.warn("YT API load failed, retrying...");
        setTimeout(loadYouTubeAPI, 3000);
    };
    const first = document.getElementsByTagName("script")[0];
    first.parentNode.insertBefore(tag, first);
}

function onYouTubeIframeAPIReady() {
    const container = document.getElementById("music-youtube-player");
    if (!container) return;
    ytPlayer = new YT.Player("music-youtube-player", {
        height: "0",
        width: "0",
        playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            iv_load_policy: 3,
        },
        events: {
            onReady: onPlayerReady,
            onStateChange: onPlayerStateChange,
            onError: onPlayerError,
        },
    });
}

function onPlayerReady() {
    ytReady = true;
    ytPlayer.setVolume(parseInt(volumeSlider.value));
    if (musicIndex >= 0 && musicIndex < musicQueue.length) {
        playCurrent();
    }
}

function onPlayerStateChange(e) {
    if (e.data === YT.PlayerState.PLAYING) {
        isPlaying = true;
        playPauseBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
        startProgressTimer();
    } else if (e.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
        playPauseBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        stopProgressTimer();
    } else if (e.data === YT.PlayerState.ENDED) {
        isPlaying = false;
        playPauseBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        stopProgressTimer();
        if (repeatOn) {
            ytPlayer.seekTo(0);
            ytPlayer.playVideo();
        } else if (musicIndex < musicQueue.length - 1) {
            musicIndex++;
            playCurrent();
        } else if (shuffleOn) {
            musicIndex = Math.floor(Math.random() * musicQueue.length);
            playCurrent();
        }
    }
}

function onPlayerError() {
    if (musicQueue.length > 1) { playNext(); }
}

/* Progress updates from YT API */
function updateProgressDisplay() {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    const current = ytPlayer.getCurrentTime();
    const dur = ytPlayer.getDuration();
    if (dur > 0) {
        musicSeek.value = Math.min(100, (current / dur) * 100);
    }
    musicTimeCurrent.textContent = formatTime(current);
    musicTimeTotal.textContent = formatTime(dur);
}

function startProgressTimer() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(updateProgressDisplay, 500);
}

function stopProgressTimer() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

let isPlaying = false;

function playSong(videoId, title, author, thumbnail, durationSec) {
    const existingIdx = musicQueue.findIndex(t => t.id === videoId);
    if (existingIdx >= 0) {
        musicIndex = existingIdx;
    } else {
        musicQueue.push({ id: videoId, title, author, thumbnail, durationSec });
        musicIndex = musicQueue.length - 1;
    }
    if (!ytReady) {
        loadYouTubeAPI();
        updateThumb(musicQueue[musicIndex]);
        updateQueueUI();
        if (musicMinimized) toggleMinimize();
        showPlayer();
        return;
    }
    playCurrent();
    updateQueueUI();
    if (musicMinimized) toggleMinimize();
    showPlayer();
}

function playCurrent() {
    if (musicIndex < 0 || musicIndex >= musicQueue.length) return;
    const track = musicQueue[musicIndex];
    updateThumb(track);
    updateQueueUI();
    if (ytReady && ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(track.id);
        ytPlayer.playVideo();
        isPlaying = true;
    }
}

function updateThumb(track) {
    const thumb = track.thumbnail || `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`;
    musicThumb.src = thumb;
    musicThumb.onerror = () => { musicThumb.src = window.FALLBACK_THUMB; };
    musicTitle.textContent = track.title;
    musicAuthor.textContent = track.author;
}

function playNext() {
    if (musicQueue.length === 0) return;
    if (shuffleOn) {
        let next;
        do { next = Math.floor(Math.random() * musicQueue.length); } while (next === musicIndex && musicQueue.length > 1);
        musicIndex = next;
    } else if (musicIndex < musicQueue.length - 1) {
        musicIndex++;
    } else if (repeatOn) {
        musicIndex = 0;
    } else { return; }
    playCurrent();
}

function playPrev() {
    if (musicQueue.length === 0) return;
    if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 3) {
        ytPlayer.seekTo(0);
        return;
    }
    if (musicIndex > 0) { musicIndex--; playCurrent(); }
    else if (repeatOn && musicQueue.length > 0) { musicIndex = musicQueue.length - 1; playCurrent(); }
}

function toggleMinimize() {
    musicMinimized = !musicMinimized;
    musicEl.classList.toggle("music-minimized", musicMinimized);
    musicToggleIcon.innerHTML = musicMinimized
        ? '<polyline points="18 15 12 9 6 15"/>'
        : '<polyline points="6 9 12 15 18 9"/>';
    musicToggleBtn.title = musicMinimized ? "Maximize" : "Minimize";
}

function toggleMusicVisibility() {
    musicHidden = !musicHidden;
    musicEl.classList.toggle("music-hidden", musicHidden);
    frogMusicBtn.classList.toggle("active", !musicHidden);
}

/* Search */
let searchTimeout = null;
musicSearchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = musicSearchInput.value.trim();
    if (q.length < 2) { musicResults.innerHTML = ""; return; }
    searchTimeout = setTimeout(() => doMusicSearch(q), 300);
});

async function doMusicSearch(q) {
    musicResults.innerHTML = '<div class="music-loading"><span></span><span></span><span></span></div>';
    try {
        const res = await fetch("/api/music/search?q=" + encodeURIComponent(q));
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        renderMusicResults(data.results || []);
    } catch (err) {
        musicResults.innerHTML = "<div style='padding:8px;color:var(--muted);font-size:12px'>Search failed</div>";
    }
}

function renderMusicResults(results) {
    if (results.length === 0) {
        musicResults.innerHTML = "<div style='padding:8px;color:var(--muted);font-size:12px'>No results found</div>";
        return;
    }
    musicResults.innerHTML = results.map(r => {
        const parts = (r.duration || "0:00").split(":").map(Number);
        const durSec = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2] : parts.length === 2 ? parts[0]*60 + parts[1] : parts[0] || 0;
        return '<div class="music-result-item" data-id="' + r.id + '" data-title="' + escapeHtml(r.title) + '" data-author="' + escapeHtml(r.author) + '" data-thumb="' + r.thumbnail + '" data-dur="' + durSec + '">' +
            '<img src="' + r.thumbnail + '" alt="" loading="lazy" onerror="this.src=window.FALLBACK_THUMB" />' +
            '<div class="r-info"><div class="r-title">' + escapeHtml(r.title) + '</div><div class="r-meta">' + r.author + ' · ' + r.duration + '</div></div>' +
            '<button class="r-play-btn" title="Play now">\u25b6</button>' +
            '<button class="r-add-btn" title="Add to queue">+</button></div>';
    }).join("");
    musicResults.querySelectorAll(".music-result-item").forEach(el => {
        const id = el.dataset.id, title = el.dataset.title, author = el.dataset.author, thumb = el.dataset.thumb, dur = parseInt(el.dataset.dur) || 0;
        el.querySelector(".r-play-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            playSong(id, title, author, thumb, dur);
            musicSearchInput.value = "";
            musicResults.innerHTML = "";
            musicSearchArea.classList.add("music-hidden");
        });
        el.querySelector(".r-add-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            queueSong(id, title, author, thumb, dur);
            toast("Added to queue");
        });
    });
}

function queueSong(videoId, title, author, thumbnail, durationSec) {
    if (musicQueue.findIndex(t => t.id === videoId) >= 0) return;
    musicQueue.push({ id: videoId, title, author, thumbnail, durationSec });
    if (musicIndex < 0) musicIndex = 0;
    updateQueueUI();
    showPlayer();
}

/* Queue UI */
function updateQueueUI() {
    musicQueueList.innerHTML = musicQueue.map((t, i) =>
        '<div class="music-qitem ' + (i === musicIndex ? "active" : "") + '" data-idx="' + i + '">' +
        '<img src="' + (t.thumbnail || "https://i.ytimg.com/vi/" + t.id + "/mqdefault.jpg") + '" alt="" onerror="this.src=window.FALLBACK_THUMB" />' +
        '<span class="q-title">' + escapeHtml(t.title) + '</span>' +
        '<button class="q-remove" data-idx="' + i + '">\u00d7</button></div>'
    ).join("");
    musicQueueCount.textContent = musicQueue.length + " song" + (musicQueue.length !== 1 ? "s" : "");
    musicQueueList.querySelectorAll(".music-qitem").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target.classList.contains("q-remove")) return;
            musicIndex = parseInt(el.dataset.idx);
            playCurrent();
            if (musicMinimized) toggleMinimize();
        });
    });
    musicQueueList.querySelectorAll(".q-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            musicQueue.splice(idx, 1);
            if (idx < musicIndex) musicIndex--;
            else if (idx === musicIndex) {
                if (musicQueue.length === 0) { musicIndex = -1; if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo(); }
                else { if (musicIndex >= musicQueue.length) musicIndex = musicQueue.length - 1; playCurrent(); }
            }
            updateQueueUI();
        });
    });
}

function showPlayer() {
    musicHidden = false;
    musicEl.classList.remove("music-hidden");
    frogMusicBtn.classList.add("active");
}

function getMusicState() {
    const currentTime = (ytPlayer && ytPlayer.getCurrentTime) ? ytPlayer.getCurrentTime() : 0;
    return {
        queue: musicQueue.map(function (t) { return { id: t.id, title: t.title, author: t.author, thumbnail: t.thumbnail }; }),
        index: musicIndex,
        shuffle: shuffleOn,
        repeat: repeatOn,
        minimized: musicMinimized,
        volume: parseInt(volumeSlider.value),
        currentTime: currentTime,
    };
}

/* Event listeners */
prevBtn.addEventListener("click", playPrev);
playPauseBtn.addEventListener("click", () => {
    if (!ytReady || musicIndex < 0) { if (musicQueue.length > 0) playCurrent(); return; }
    const state = ytPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
    } else {
        ytPlayer.playVideo();
    }
});
nextBtn.addEventListener("click", playNext);

shuffleBtn.addEventListener("click", () => {
    shuffleOn = !shuffleOn;
    shuffleBtn.classList.toggle("active", shuffleOn);
    toast(shuffleOn ? "Shuffle on" : "Shuffle off");
});
repeatBtn.addEventListener("click", () => {
    repeatOn = !repeatOn;
    repeatBtn.classList.toggle("active", repeatOn);
    toast(repeatOn ? "Repeat on" : "Repeat off");
});

musicSeek.addEventListener("input", () => {
    if (!ytReady || !ytPlayer || !ytPlayer.getDuration) return;
    const dur = ytPlayer.getDuration();
    if (dur <= 0) return;
    const seekTo = dur * (parseInt(musicSeek.value) / 100);
    ytPlayer.seekTo(seekTo);
});

volumeSlider.addEventListener("input", () => {
    const v = parseInt(volumeSlider.value) / 100;
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(parseInt(volumeSlider.value));
    volumeBtn.innerHTML = v === 0
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
        : v < 0.5
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
});

musicToggleBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMinimize(); });
document.getElementById("music-header").addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (musicMinimized) toggleMinimize();
});
musicSearchToggle.addEventListener("click", () => {
    musicSearchArea.classList.toggle("music-hidden");
    if (!musicSearchArea.classList.contains("music-hidden")) musicSearchInput.focus();
});

frogMusicBtn.addEventListener("click", toggleMusicVisibility);

document.getElementById("music-queue-toggle").addEventListener("click", () => {
    const q = document.getElementById("music-queue");
    q.style.display = q.style.display === "none" ? "" : "none";
});

/* Keyboard shortcuts */
document.addEventListener("keydown", (e) => {
    if (musicHidden) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT") return;
    if (e.key === "Escape" && !musicSearchArea.classList.contains("music-hidden")) {
        musicSearchArea.classList.add("music-hidden");
    }
    if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        playPauseBtn.click();
    }
});

/* Init music */
frogMusicBtn.classList.add("active");
volumeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
loadYouTubeAPI();

/* ── Games (unique icons per game name) ── */
function gameFallback(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const ah = Math.abs(hash);
    const hue = ((ah % 360) + 360) % 360;
    const h2 = (hue + 40) % 360;
    const h3 = (hue + 200) % 360;
    const letter = name.replace(/[^a-zA-Z0-9]/g, "").charAt(0).toUpperCase() || "G";
    const dark = "hsl(" + hue + ",40%,25%)";
    const mid = "hsl(" + hue + ",45%,38%)";
    const light = "hsl(" + h2 + ",50%,50%)";
    const accent2 = "hsl(" + h3 + ",35%,30%)";
    const pattern = "M0 " + (ah % 30 + 10) + "L" + (ah % 15 + 5) + " 0L" + (ah % 25 + 15) + " " + (ah % 35 + 10) + "L" + (ah % 10 + 5) + " " + (ah % 20 + 15) + "Z";
    return "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='gg' x1='0%' y1='0%' x2='100%' y2='100%'><stop offset='0%' stop-color='" + dark + "'/><stop offset='50%' stop-color='" + mid + "'/><stop offset='100%' stop-color='" + light + "'/></linearGradient><radialGradient id='ggr' cx='30%' cy='30%' r='70%'><stop offset='0%' stop-color='rgba(255,255,255,0.15)'/><stop offset='100%' stop-color='rgba(0,0,0,0.2)'/></radialGradient><filter id='gs'><feDropShadow dx='0' dy='2' stdDeviation='3' flood-opacity='0.35'/></filter></defs><rect width='100' height='100' rx='22' fill='url(#gg)'/><rect width='100' height='100' rx='22' fill='url(#ggr)'/><text x='50' y='67' text-anchor='middle' font-size='48' font-weight='800' font-family='-apple-system,BlinkMacSystemFont,sans-serif' fill='rgba(255,255,255,0.92)' filter='url(#gs)' letter-spacing='1'>" + letter + "</text></svg>";
}

async function loadGames() {
    try {
        const res = await fetch("/games/index.json");
        if (!res.ok) { document.getElementById("game-count").textContent = "0"; return; }
        const games = await res.json();

        // Track shared HTML files to detect duplicates
        const fileCount = {};
        games.forEach(g => { fileCount[g.file] = (fileCount[g.file] || 0) + 1; });

        const grid = document.getElementById("games-grid");
        grid.innerHTML = "";
        document.getElementById("game-count").textContent = games.length;

        games.forEach((game) => {
            const card = document.createElement("div");
            card.className = "game-card";
            const isShared = fileCount[game.file] > 1;
            // Use generated unique icon (per game name) for shared files, try PNG for unique ones
            const fallback = gameFallback(game.name);
            if (isShared) {
                card.innerHTML = '<img src="' + fallback + '" alt="' + game.name + '"><div class="game-name">' + game.name + '</div>';
            } else {
                const imgSrc = "games/" + game.file.replace(".html", ".png");
                card.innerHTML = '<img src="' + imgSrc + '" alt="' + game.name + '" onerror="this.src=\'' + fallback + '\'"><div class="game-name">' + game.name + '</div>';
            }
            card.addEventListener("click", async () => {
                switchNav("proxy");
                let id = activeTabId;
                if (!id || !tabs.find((t) => t.id === id)) {
                    id = await createTab("/games/" + game.file);
                }
                navigateDirect(id, location.origin + "/games/" + game.file);
                showFrogBar();
            });
            grid.appendChild(card);
        });
    } catch (e) { document.getElementById("game-count").textContent = "0"; }
}

loadGames();

/* ===== Home Shortcuts ===== */
let shortcuts = parseJson(storageGet("stratus-shortcuts"), []);
if (!Array.isArray(shortcuts)) shortcuts = [];

function saveShortcuts() {
    storageSet("stratus-shortcuts", JSON.stringify(shortcuts));
}

function renderShortcuts() {
    const grid = document.getElementById("shortcutsGrid");
    if (!grid) return;
    grid.innerHTML = "";
    shortcuts.forEach((s, i) => {
        const card = document.createElement("button");
        card.className = "shortcut-card";
        const letter = (s.name || "?").charAt(0).toUpperCase();
        card.innerHTML = '<span class="sc-icon">' + letter + '</span><span class="sc-name">' + escapeHtml(s.name) + '</span><span class="sc-remove" data-idx="' + i + '">x</span>';
        card.addEventListener("click", async (e) => {
            if (e.target.classList.contains("sc-remove")) {
                shortcuts.splice(parseInt(e.target.dataset.idx), 1);
                saveShortcuts();
                renderShortcuts();
                return;
            }
            const url = s.url.trim();
            if (!url) return;
            switchNav("proxy");
            let id = activeTabId;
            if (!id || !tabs.find((t) => t.id === id)) {
                id = await createTab(url);
                await navigateTab(id, url);
            } else {
                await navigateTab(id, url);
            }
            showFrogBar();
        });
        grid.appendChild(card);
    });
}

document.getElementById("addShortcutBtn")?.addEventListener("click", () => {
    document.getElementById("addShortcutModal").classList.remove("hidden");
});
document.getElementById("cancelShortcut")?.addEventListener("click", () => {
    document.getElementById("addShortcutModal").classList.add("hidden");
});
document.getElementById("confirmShortcut")?.addEventListener("click", () => {
    const name = document.getElementById("shortcutNameInput").value.trim();
    const url = document.getElementById("shortcutUrlInput").value.trim();
    if (!name || !url) return;
    shortcuts.push({ name, url });
    saveShortcuts();
    renderShortcuts();
    document.getElementById("shortcutNameInput").value = "";
    document.getElementById("shortcutUrlInput").value = "";
    document.getElementById("addShortcutModal").classList.add("hidden");
});
document.getElementById("addShortcutModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.target.classList.add("hidden");
});
renderShortcuts();

/* ===== Chat System ===== */
const chatName = document.querySelector("#chatName");
const roomCode = document.querySelector("#roomCode");
const roomList = document.querySelector("#roomList");
const messages = document.querySelector("#messages");
const messageForm = document.querySelector("#messageForm");
const messageInput = document.querySelector("#messageInput");
const activeRoomTitle = document.querySelector("#activeRoomTitle");
const activeRoomMeta = document.querySelector("#activeRoomMeta");
const firebaseDb = window.kHubFirebaseDb || null;

let chatRooms = normalizeRooms(parseJson(storageGet("kHubRooms"), {}));
let currentRoom = storageGet("kHubCurrentRoom") || "";
let chatStopMessageListener = null;
let firebaseConnected = false;
let roomNames = parseJson(storageGet("kHubRoomNames"), {});
if (!roomNames || typeof roomNames !== "object" || Array.isArray(roomNames)) roomNames = {};
chatName.value = storageGet("kHubName") || "";
roomCode.value = currentRoom;

function getChatNickname(orig) {
    const map = parseJson(storageGet("kHubNicknames"), {});
    if (map[orig]) return stripPhone(map[orig]);
    return stripPhone(orig);
}
function setChatNickname(orig, custom) {
    const map = parseJson(storageGet("kHubNicknames"), {});
    map[orig] = custom;
    storageSet("kHubNicknames", JSON.stringify(map));
}
function stripPhone(s) { return s.replace(/\+\d[\d\s\-().]{6,}\d/g, "Guest"); }

document.querySelector("#createRoomBtn").addEventListener("click", createChatRoom);
document.querySelector("#joinRoomBtn").addEventListener("click", joinChatRoom);
document.querySelector("#leaveRoomBtn").addEventListener("click", leaveChatRoom);
document.querySelector("#clearRoomBtn").addEventListener("click", clearChatRoom);

function saveChatRooms() {
    storageSet("kHubRooms", JSON.stringify(chatRooms));
    storageSet("kHubCurrentRoom", currentRoom);
    storageSet("kHubName", chatName.value.trim());
    saveChatRoomNames();
}
function saveChatRoomNames() { storageSet("kHubRoomNames", JSON.stringify(roomNames)); }
function chatRoomDisplayName(room) { return roomNames[room] || room; }

function joinChatRoom() {
    const code = roomCode.value.trim();
    if (!code) return;
    if (!Array.isArray(chatRooms[code])) chatRooms[code] = [];
    currentRoom = code;
    saveChatRooms();
    renderChatRooms();
    renderChatMessages();
    listenToChatMessages();
    saveChatRoomOnline(code);
}
function createChatRoom() { roomCode.value = generateChatCode(); joinChatRoom(); }
function leaveChatRoom() {
    if (!currentRoom) return;
    delete chatRooms[currentRoom];
    if (chatStopMessageListener) { chatStopMessageListener(); chatStopMessageListener = null; }
    currentRoom = "";
    roomCode.value = "";
    saveChatRooms();
    renderChatRooms();
    renderChatMessages();
}
function clearChatRoom() {
    if (!currentRoom || !chatRooms[currentRoom]) return;
    chatRooms[currentRoom] = [];
    saveChatRooms();
    renderChatMessages();
    toast("Room cleared");
}

function renderChatRooms() {
    roomList.innerHTML = "";
    Object.keys(chatRooms).sort().forEach((room) => {
        const display = chatRoomDisplayName(room);
        const isActive = room === currentRoom;
        const btn = document.createElement("button");
        btn.className = "room-pill" + (isActive ? " active" : "");
        btn.textContent = display;
        btn.addEventListener("click", () => {
            currentRoom = room;
            roomCode.value = room;
            saveChatRooms();
            renderChatRooms();
            renderChatMessages();
            listenToChatMessages();
        });
        roomList.appendChild(btn);
    });
}

const MSG_TTL = 90000;

function addViewedAt(msg) { if (!msg._viewedAt) msg._viewedAt = msg.at || Date.now(); return msg; }
function cleanupExpired(room) {
    if (!chatRooms[room]) return;
    const before = chatRooms[room].length;
    chatRooms[room] = chatRooms[room].filter((m) => Date.now() - (m._viewedAt || m.at || 0) < MSG_TTL);
    if (chatRooms[room].length !== before) saveChatRooms();
}

setInterval(() => {
    const changed = [];
    Object.keys(chatRooms).forEach((room) => {
        const before = chatRooms[room].length;
        cleanupExpired(room);
        if (chatRooms[room].length !== before) changed.push(room);
    });
    if (changed.includes(currentRoom)) renderChatMessages();
    if (changed.length) renderChatRooms();
}, 5000);

function renderChatMessages() {
    messages.innerHTML = "";
    if (!currentRoom) {
        activeRoomTitle.textContent = "No room yet";
        activeRoomMeta.textContent = firebaseChatReady() ? "Join a room to start online chat." : "Firebase not connected.";
        return;
    }
    cleanupExpired(currentRoom);
    const msgs = chatRooms[currentRoom] || [];
    activeRoomTitle.textContent = "# " + chatRoomDisplayName(currentRoom);
    activeRoomMeta.textContent = firebaseChatReady() && firebaseConnected
        ? msgs.length + " online messages."
        : msgs.length + " saved messages.";
    msgs.forEach((msg) => {
        const bubble = document.createElement("div");
        bubble.className = "msg" + (msg.name === chatName.value.trim() ? " mine" : "");
        const rawName = msg.name || "Guest";
        const displayName = escapeHtml(getChatNickname(rawName));
        bubble.innerHTML = "<b data-nick='" + escapeHtml(rawName) + "'>" + displayName + "</b>" + escapeHtml(msg.text);
        messages.appendChild(bubble);
    });
    messages.querySelectorAll("[data-nick]").forEach(el => {
        el.style.cursor = "pointer";
        el.title = "Click to rename";
        el.addEventListener("click", () => {
            const orig = el.dataset.nick;
            const current = getChatNickname(orig);
            const input = prompt("Rename '" + current + "' to:", current);
            if (input && input.trim() && input.trim() !== current) {
                setChatNickname(orig, input.trim());
                renderChatMessages();
            }
        });
    });
    messages.scrollTop = messages.scrollHeight;
}

messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentRoom) joinChatRoom();
    const text = messageInput.value.trim();
    if (!currentRoom || !text) return;
    const cleanName = stripPhone(chatName.value.trim() || "Guest");
    const msg = addViewedAt({ name: cleanName, text, at: Date.now() });
    messageInput.value = "";
    chatRooms[currentRoom] ||= [];
    chatRooms[currentRoom].push(msg);
    saveChatRooms();
    renderChatMessages();
    if (firebaseChatReady()) {
        try {
            await chatRoomRef(currentRoom).update({ name: currentRoom, updatedAt: Date.now() });
            await chatRoomRef(currentRoom).child("messages").push(msg);
        } catch (error) { console.error("Firebase message send failed:", error); }
    }
});

chatName.addEventListener("input", () => {
    chatName.value = stripPhone(chatName.value);
    saveChatRooms();
    renderChatMessages();
    const sn = document.getElementById("settingsNickname");
    if (sn) sn.value = chatName.value;
});

function connectFirebaseChat() {
    if (!firebaseChatReady()) return;
    firebaseDb.ref(".info/connected").on("value", (snapshot) => {
        firebaseConnected = snapshot.val() === true;
        renderChatMessages();
    });
    listenToChatMessages();
}

function listenToChatMessages() {
    if (!firebaseChatReady() || !currentRoom) return;
    if (chatStopMessageListener) chatStopMessageListener();
    const msgsRef = chatRoomRef(currentRoom).child("messages").orderByChild("at").limitToLast(200);
    msgsRef.on("value", (snapshot) => {
        const next = [];
        snapshot.forEach((child) => { next.push(addViewedAt({ id: child.key, ...child.val() })); });
        chatRooms[currentRoom] = next;
        saveChatRooms();
        renderChatRooms();
        renderChatMessages();
    }, () => { activeRoomMeta.textContent = "Firebase could not load messages."; });
    chatStopMessageListener = () => msgsRef.off();
}

async function saveChatRoomOnline(room) {
    if (!firebaseChatReady() || !room) return;
    try { await chatRoomRef(room).update({ name: room, updatedAt: Date.now() }); } catch (error) { console.error("Firebase room save failed:", error); }
}
function chatRoomRef(room) { return firebaseDb.ref("chatRooms/" + chatRoomKey(room)); }
function chatRoomKey(room) { return encodeURIComponent(room.trim().toLowerCase()).replace(/[.#$/[\]]/g, "_"); }
function generateChatCode() { const p = () => Math.random().toString(36).slice(2, 5).toUpperCase(); return p() + "-" + p(); }
function firebaseChatReady() { return Boolean(firebaseDb && window.firebase && window.kHubFirebaseDb); }
function normalizeRooms(val) { if (!val || typeof val !== "object" || Array.isArray(val)) return {}; return Object.fromEntries(Object.entries(val).filter((e) => Array.isArray(e[1]))); }
function parseJson(val, fallback) { if (!val) return fallback; try { return JSON.parse(val); } catch { return fallback; } }
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); } catch {} }
function escapeHtml(val) { return String(val).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

/* Chat settings sync */
const settingsNickname = document.getElementById("settingsNickname");
if (settingsNickname) {
    settingsNickname.value = chatName.value;
    settingsNickname.addEventListener("input", () => {
        settingsNickname.value = stripPhone(settingsNickname.value);
        chatName.value = settingsNickname.value;
        saveChatRooms();
        renderChatMessages();
    });
}

document.getElementById("clearAllRoomsBtn")?.addEventListener("click", () => {
    if (!confirm("Delete all rooms and messages? This cannot be undone.")) return;
    chatRooms = {};
    roomNames = {};
    saveChatRoomNames();
    if (chatStopMessageListener) { chatStopMessageListener(); chatStopMessageListener = null; }
    currentRoom = "";
    roomCode.value = "";
    saveChatRooms();
    renderChatRooms();
    renderChatMessages();
    toast("All rooms deleted");
});

/* Handle cross-tab sync */
function fixupViewedAt() {
    Object.keys(chatRooms).forEach((room) => {
        if (Array.isArray(chatRooms[room])) {
            chatRooms[room] = chatRooms[room].map(addViewedAt);
        }
    });
}

window.addEventListener("storage", () => {
    chatRooms = normalizeRooms(parseJson(storageGet("kHubRooms"), {}));
    fixupViewedAt();
    currentRoom = storageGet("kHubCurrentRoom") || currentRoom;
    roomNames = parseJson(storageGet("kHubRoomNames"), {});
    if (!roomNames || typeof roomNames !== "object" || Array.isArray(roomNames)) roomNames = {};
    renderChatRooms();
    renderChatMessages();
});

fixupViewedAt();
renderChatRooms();
renderChatMessages();
connectFirebaseChat();

/* ── Account (Firebase Auth) ── */
let currentUser = null;

function firebaseAuthReady() { return typeof firebase !== "undefined" && firebase.auth && firebase.apps.length > 0; }

const accountEmail = document.getElementById("account-email");
const accountPassword = document.getElementById("account-password");
const accountSignIn = document.getElementById("account-signin-btn");
const accountSignUp = document.getElementById("account-signup-btn");
const accountSignOut = document.getElementById("account-signout-btn");
const accountError = document.getElementById("account-error");
const accountSignedOut = document.getElementById("account-signed-out");
const accountSignedIn = document.getElementById("account-signed-in");
const accountEmailDisplay = document.getElementById("account-email-display");
const accountStatusDesc = document.getElementById("account-status-desc");
const accountSyncBtn = document.getElementById("account-sync-btn");
const accountSyncStatus = document.getElementById("account-sync-status");

function showAccountError(msg) { accountError.textContent = msg; accountError.style.display = "block"; }
function hideAccountError() { accountError.style.display = "none"; }

function updateAccountUI(user) {
    currentUser = user;
    if (user) {
        accountSignedOut.style.display = "none";
        accountSignedIn.style.display = "block";
        accountEmailDisplay.textContent = user.email;
        accountStatusDesc.textContent = "Your data is saved to the cloud";
        accountSyncBtn.disabled = false;
    } else {
        accountSignedOut.style.display = "block";
        accountSignedIn.style.display = "none";
        accountStatusDesc.textContent = "Sign in to sync your data across devices";
        accountSyncBtn.disabled = true;
    }
}

let autoSyncDone = false;

if (firebaseAuthReady()) {
    firebase.auth().onAuthStateChanged((user) => {
        updateAccountUI(user);
        if (user && !autoSyncDone) { autoSyncDone = true; syncFromCloud(); }
    });
}

accountSignIn.addEventListener("click", async () => {
    if (!firebaseAuthReady()) { showAccountError("Firebase Auth not loaded"); return; }
    hideAccountError();
    const email = accountEmail.value.trim();
    const pass = accountPassword.value.trim();
    if (!email || !pass) { showAccountError("Enter email and password"); return; }
    try { await firebase.auth().signInWithEmailAndPassword(email, pass); toast("Signed in"); } catch (e) { showAccountError(e.message); }
});

accountSignUp.addEventListener("click", async () => {
    if (!firebaseAuthReady()) { showAccountError("Firebase Auth not loaded"); return; }
    hideAccountError();
    const email = accountEmail.value.trim();
    const pass = accountPassword.value.trim();
    if (!email || !pass) { showAccountError("Enter email and password"); return; }
    if (pass.length < 6) { showAccountError("Password must be at least 6 characters"); return; }
    try { await firebase.auth().createUserWithEmailAndPassword(email, pass); toast("Account created"); } catch (e) { showAccountError(e.message); }
});

accountSignOut.addEventListener("click", async () => {
    if (!firebaseAuthReady()) return;
    try { await firebase.auth().signOut(); toast("Signed out"); } catch (e) { showAccountError(e.message); }
});

/* Cloud sync */
async function syncToCloud() {
    if (!currentUser) return;
    accountSyncStatus.textContent = "Syncing...";
    const data = {
        settings: {
            theme: (() => { try { return localStorage.getItem("stratus-theme"); } catch(e) {} })(),
            cloak: (() => { try { return localStorage.getItem("stratus-cloak"); } catch(e) {} })(),
            autocloak: (() => { try { return localStorage.getItem("stratus-autocloak"); } catch(e) {} })(),
            nickname: (() => { try { return localStorage.getItem("kHubName"); } catch(e) {} })(),
        },
        shortcuts: (() => { try { return JSON.parse(localStorage.getItem("stratus-shortcuts")) || []; } catch(e) { return []; } })(),
        musicQueue: musicQueue,
        musicIndex: musicIndex,
        aiHistory: aiHistory,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
    };
    try {
        await firebase.database().ref("users/" + currentUser.uid).update(data);
        accountSyncStatus.textContent = "Synced " + new Date().toLocaleTimeString();
        toast("Data saved to cloud");
    } catch (e) { accountSyncStatus.textContent = "Sync failed: " + e.message; }
}

async function syncFromCloud() {
    if (!currentUser) return;
    accountSyncStatus.textContent = "Loading...";
    try {
        const snap = await firebase.database().ref("users/" + currentUser.uid).once("value");
        const data = snap.val();
        if (!data) { accountSyncStatus.textContent = "No cloud data found"; return; }
        if (data.settings) {
            const s = data.settings;
            if (s.theme) { document.documentElement.setAttribute("data-theme", s.theme); localStorage.setItem("stratus-theme", s.theme); themeSelect.value = s.theme; }
            if (s.cloak) { localStorage.setItem("stratus-cloak", s.cloak); activeCloak = s.cloak; }
            if (s.autocloak) { localStorage.setItem("stratus-autocloak", s.autocloak); autocloakToggle.checked = s.autocloak === "true"; }
            if (s.nickname) { chatName.value = s.nickname; localStorage.setItem("kHubName", s.nickname); document.getElementById("settingsNickname").value = s.nickname; }
        }
        if (data.shortcuts) { localStorage.setItem("stratus-shortcuts", JSON.stringify(data.shortcuts)); shortcuts = data.shortcuts; renderShortcuts(); }
        if (data.aiHistory) { aiHistory = data.aiHistory; aiConversation.innerHTML = ""; aiHistory.forEach(m => aiAddMsg(m.role, m.content)); }
        if (data.musicQueue) {
            musicQueue.length = 0;
            data.musicQueue.forEach(t => musicQueue.push(t));
            musicIndex = data.musicIndex || 0;
            updateQueueUI();
            if (musicQueue.length > 0) playCurrent();
        }
        accountSyncStatus.textContent = "Loaded from cloud " + new Date().toLocaleTimeString();
        toast("Cloud data loaded");
    } catch (e) { accountSyncStatus.textContent = "Load failed: " + e.message; }
}

accountSyncBtn.addEventListener("click", syncToCloud);

/* ── Stratus AI ── */
const aiInput = document.getElementById("aiInput");
const aiForm = document.getElementById("aiForm");
const aiConversation = document.getElementById("aiConversation");

let aiHistory = [];

function aiAddMsg(role, content) {
    const div = document.createElement("div");
    div.className = "ai-msg " + role;
    if (role === "assistant") {
        const label = document.createElement("div");
        label.className = "ai-role";
        label.textContent = "Stratus AI";
        div.appendChild(label);
    }
    const bubble = document.createElement("div");
    bubble.className = "ai-msg-content";
    bubble.textContent = content;
    div.appendChild(bubble);
    aiConversation.appendChild(div);
    aiConversation.scrollTop = aiConversation.scrollHeight;
}

function aiShowLoading() {
    const div = document.createElement("div");
    div.className = "ai-msg assistant";
    div.id = "aiLoading";
    const bubble = document.createElement("div");
    bubble.className = "ai-msg-content";
    bubble.innerHTML = '<div class="ai-loading"><span></span><span></span><span></span></div>';
    div.appendChild(bubble);
    aiConversation.appendChild(div);
    aiConversation.scrollTop = aiConversation.scrollHeight;
}

function aiRemoveLoading() {
    const el = document.getElementById("aiLoading");
    if (el) el.remove();
}

aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = aiInput.value.trim();
    if (!text) return;

    aiInput.value = "";
    aiAddMsg("user", text);
    aiHistory.push({ role: "user", content: text });
    aiShowLoading();

    try {
        let reply = null;

        // Try Chrome built-in AI (Prompt API) — Chrome 131+ with no setup
        if (window.ai && window.ai.languageModel) {
            try {
                const session = await window.ai.languageModel.create({
                    systemPrompt: "You are Stratus AI, a helpful assistant. Keep answers concise and clear."
                });
                reply = await session.prompt(text);
                session.destroy();
            } catch (e) { console.warn("Chrome AI failed, falling back to server:", e); }
        }

        // Fallback: server endpoint
        if (!reply) {
            const res = await fetch("/api/ai/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "You are Stratus AI, a helpful assistant. Keep answers concise and clear." },
                        ...aiHistory.slice(-20)
                    ],
                    max_tokens: 1024
                })
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            reply = data.choices[0]?.message?.content || "";
        }

        if (!reply) throw new Error("Empty response");
        aiRemoveLoading();
        aiAddMsg("assistant", reply);
        aiHistory.push({ role: "assistant", content: reply });
    } catch (err) {
        aiRemoveLoading();
        aiAddMsg("assistant", "Error: AI unavailable right now. Try again later.");
    }
});

/* Patch Notes */
const PATCH_NOTES_VERSION = 2;
const patchModal = document.getElementById("patchModal");
if (!localStorage.getItem("stratus-patch-seen") && patchModal) {
    patchModal.classList.remove("hidden");
}
function dismissPatch() {
    patchModal.classList.add("hidden");
    try { localStorage.setItem("stratus-patch-seen", String(PATCH_NOTES_VERSION)); } catch (e) {}
}
document.getElementById("patchClose")?.addEventListener("click", dismissPatch);
document.getElementById("patchGotIt")?.addEventListener("click", dismissPatch);
patchModal?.addEventListener("click", (e) => { if (e.target === patchModal) dismissPatch(); });
