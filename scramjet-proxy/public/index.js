"use strict";

/* Proxy engine - scramjet */
let activeProxy = null;
let proxyInitPromise = null;

async function initProxy() {
    const engine = ProxyEngines.scramjet;
    try {
        await engine.init();
        activeProxy = engine;
        try { localStorage.setItem("nexus-proxy", engine.id); } catch (e) {}
        return engine;
    } catch (e) {
        console.error("Proxy init failed:", e);
        toast("Proxy engine unavailable, using direct mode");
        activeProxy = directFallbackEngine;
        return activeProxy;
    }
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
}

/* URL polling for Frogie's bar */
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

/* Frogie's bar — bottom popup, toggled by page-fold button */
const frogBar = document.getElementById("frog-bar");
const frogToggle = document.getElementById("frog-toggle");

let frogVisible = false;

function showFrogBar() {
    if (frogVisible) return;
    if (currentView !== "proxy") return;
    frogVisible = true;
    frogBar.classList.add("visible");
    frogToggle.classList.add("active");
    clearTimeout(frogHideTimeout);
}

function hideFrogBar(force) {
    if (!frogVisible && !force) return;
    clearTimeout(frogHideTimeout);
    if (document.activeElement && document.activeElement.id === "frog-url") return;
    frogVisible = false;
    frogBar.classList.remove("visible");
    frogToggle.classList.remove("active");
}

frogToggle.addEventListener("click", () => {
    if (currentView !== "proxy") return;
    if (frogVisible) { hideFrogBar(true); }
    else { showFrogBar(); }
});

document.getElementById("frog-url").addEventListener("focus", showFrogBar);
document.getElementById("frog-url").addEventListener("blur", () => {
    setTimeout(() => { if (!frogBar.matches(":hover")) hideFrogBar(); }, 120);
});

document.addEventListener("click", (e) => {
    if (frogVisible && !frogBar.contains(e.target) && e.target !== frogToggle) {
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
        const saved = localStorage.getItem("nexus-frog-pos");
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
        localStorage.setItem("nexus-frog-pos", JSON.stringify({
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

/* Frogie's controls */
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

document.getElementById("frog-popout").addEventListener("click", async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.url) { toast("Open a page first"); return; }
    await openAboutBlank(tab.url);
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
    frogToggle.classList.remove("active");
    frogToggle.style.display = view === "proxy" ? "flex" : "none";
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

/* Settings */
const engineSelect = document.getElementById("engine-select");
searchEngine.value = engineSelect.value;
engineSelect.addEventListener("change", () => { searchEngine.value = engineSelect.value; });

const proxySelect = document.getElementById("proxy-select");
proxySelect.addEventListener("change", async () => {
    const val = proxySelect.value;
    try { localStorage.setItem("nexus-proxy", val); } catch (e) {}
    toast("Reloading proxy engine...");
    // Reload page so the new SW takes control
    setTimeout(() => location.reload(), 500);
});

const cloakMap = {
    google: { title: "Google", icon: "https://www.google.com/favicon.ico" },
    classroom: { title: "Classroom", icon: "https://ssl.gstatic.com/classroom/favicon.png" },
    drive: { title: "Google Drive", icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" },
};
const defaultCloak = { title: "Nexus", icon: "icon.png" };

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
    // If there's an active proxied tab, proxy its URL; otherwise load main page directly (no proxy loop)
    const frameUrl = tab?.url
        ? location.origin + activeProxy.encodeUrl(tab.url)
        : location.href;
    win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + cloak.title + '</title><link id="cloakFavicon" rel="shortcut icon" href="' + cloak.icon + '"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;overflow:hidden}iframe{width:100%;height:100%;border:none;display:block}</style></head><body><iframe id="cloakFrame" src="' + frameUrl + '" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe><script>const icon="' + cloak.icon + '";const link=document.getElementById("cloakFavicon");function force(){link.href=icon;}document.getElementById("cloakFrame").onload=force;setInterval(force,500);<\/script></body></html>');
    win.document.close();
    blankWindows.push(win);
    window.location.replace("https://www.google.com");
}

document.querySelectorAll(".cloak-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
        document.querySelectorAll(".cloak-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeCloak = btn.dataset.cloak;
        try { localStorage.setItem("nexus-cloak", activeCloak); } catch (e) {}
        applyCloak(activeCloak);
        recloakBlanks();
        await autoCloakRedirect();
    });
});

(function loadSavedCloak() {
    try {
        const saved = localStorage.getItem("nexus-cloak");
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
    if (localStorage.getItem("nexus-autocloak") === "true") {
        autocloakToggle.checked = true;
        autocloakLabel.textContent = "On";
    }
} catch (e) {}

autocloakToggle.addEventListener("change", async () => {
    const on = autocloakToggle.checked;
    autocloakLabel.textContent = on ? "On" : "Off";
    try { localStorage.setItem("nexus-autocloak", on ? "true" : "false"); } catch (e) {}
    if (on && activeCloak) applyCloak(activeCloak);
    await autoCloakRedirect();
});

const themeSelect = document.getElementById("theme-select");
const savedTheme = (() => { try { return localStorage.getItem("nexus-theme"); } catch (e) { return null; } })() || "nexus";
document.documentElement.setAttribute("data-theme", savedTheme);
themeSelect.value = savedTheme;

const savedProxy = (() => { try { return localStorage.getItem("nexus-proxy"); } catch (e) { return null; } })() || "scramjet";
proxySelect.value = savedProxy;

themeSelect.addEventListener("change", () => {
    const val = themeSelect.value;
    document.documentElement.setAttribute("data-theme", val);
    try { localStorage.setItem("nexus-theme", val); } catch (e) {}
    toast("Theme: " + themeSelect.options[themeSelect.selectedIndex].text);
});

autoCloakRedirect();

/* About:blank popout */
async function openAboutBlank(url) {
    await ensureProxy();
    const win = window.open("about:blank", "_blank");
    if (!win) { toast("Pop-up blocked"); return; }
    const cloak = activeCloak && cloakMap[activeCloak] ? cloakMap[activeCloak] : defaultCloak;
    const encodedUrl = location.origin + activeProxy.encodeUrl(url);
    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${cloak.title}</title>
<link id="cloakFavicon" rel="shortcut icon" href="${cloak.icon}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#fff}
iframe{width:100%;height:100%;border:none;display:block}
</style>
</head>
<body>
<iframe id="cloakFrame" src="${encodedUrl}" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>
<script>
const icon = '${cloak.icon}';
const link = document.getElementById('cloakFavicon');
function forceIcon() { link.href = icon; }
document.getElementById('cloakFrame').onload = forceIcon;
setInterval(forceIcon, 500);
<\/script>
</body>
</html>`);
    win.document.close();
    blankWindows.push(win);
    toast("Opened in about:blank");
}

/* Games — premium unique SVG fallback icons */
function gameFallback(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const ah = Math.abs(hash);
    const hue = ((ah % 360) + 360) % 360;
    const h2 = (hue + 40) % 360;
    const h3 = (hue + 200) % 360;
    const letter = name.replace(/[^a-zA-Z0-9]/g, "").charAt(0).toUpperCase() || "G";
    const dark = `hsl(${hue},40%25,25%25)`;
    const mid = `hsl(${hue},45%25,38%25)`;
    const light = `hsl(${h2},50%25,50%25)`;
    const accent2 = `hsl(${h3},35%25,30%25)`;
    const pattern = `M0 ${ah%30+10}L${ah%15+5} 0L${ah%25+15} ${ah%35+10}L${ah%10+5} ${ah%20+15}Z`;
    return `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22gg%22 x1=%220%25%22 y1=%220%25%22 x2=%22100%25%22 y2=%22100%25%22><stop offset=%220%25%22 stop-color=%22${dark}%22/><stop offset=%2250%25%22 stop-color=%22${mid}%22/><stop offset=%22100%25%22 stop-color=%22${light}%22/></linearGradient><radialGradient id=%22ggr%22 cx=%2230%25%22 cy=%2230%25%22 r=%2270%25%22><stop offset=%220%25%22 stop-color=%22rgba(255,255,255,0.15)%22/><stop offset=%22100%25%22 stop-color=%22rgba(0,0,0,0.2)%22/></radialGradient><linearGradient id=%22pat%22 x1=%220%22 y1=%220%22 x2=%22100%22 y2=%22100%22><stop offset=%220%25%22 stop-color=%22rgba(255,255,255,0.06)%22/><stop offset=%22100%25%22 stop-color=%22rgba(255,255,255,0)%22/></linearGradient><filter id=%22gs%22><feDropShadow dx=%220%22 dy=%222%22 stdDeviation=%223%22 flood-opacity=%220.35%22/></filter></defs><rect width=%22100%22 height=%22100%22 rx=%2222%22 fill=%22url(%23gg)%22/><rect width=%22100%22 height=%22100%22 rx=%2222%22 fill=%22url(%23ggr)%22/><path d=%22${pattern}%22 fill=%22url(%23pat)%22/%3E<circle cx=%2222%22 cy=%2222%22 r=%2230%22 fill=%22rgba(255,255,255,0.03)%22/%3E<text x=%2250%22 y=%2267%22 text-anchor=%22middle%22 font-size=%2248%22 font-weight=%22800%22 font-family=%22-apple-system,BlinkMacSystemFont,sans-serif%22 fill=%22rgba(255,255,255,0.92)%22 filter=%22url(%23gs)%22 letter-spacing=%221%22>${letter}</text><rect x=%222%22 y=%222%22 width=%2296%22 height=%2296%22 rx=%2222%22 fill=%22none%22 stroke=%22rgba(255,255,255,0.08)%22 stroke-width=%221%22/></svg>`;
}

async function loadGames() {
    try {
        const res = await fetch("/games/index.json");
        if (!res.ok) { document.getElementById("game-count").textContent = "0"; return; }
        const games = await res.json();
        const grid = document.getElementById("games-grid");
        grid.innerHTML = "";
        document.getElementById("game-count").textContent = games.length;
        games.forEach((game) => {
            const card = document.createElement("div");
            card.className = "game-card";
            const imgSrc = "games/" + game.file.replace(".html", ".png");
            const fallback = gameFallback(game.name);
            card.innerHTML = `<img src="${imgSrc}" alt="${game.name}" onerror="this.src='${fallback}'"><div class="game-name">${game.name}</div>`;
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
    } catch (e) {
        document.getElementById("game-count").textContent = "0";
    }
}

loadGames();

/* ===== Home Shortcuts ===== */
let shortcuts = parseJson(storageGet("nexus-shortcuts"), []);
if (!Array.isArray(shortcuts)) shortcuts = [];

function saveShortcuts() {
    storageSet("nexus-shortcuts", JSON.stringify(shortcuts));
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

function saveChatRoomNames() {
    storageSet("kHubRoomNames", JSON.stringify(roomNames));
}

function chatRoomDisplayName(room) {
    return roomNames[room] || room;
}

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

function createChatRoom() {
    roomCode.value = generateChatCode();
    joinChatRoom();
}

function leaveChatRoom() {
    if (!currentRoom) return;
    delete chatRooms[currentRoom];
    if (chatStopMessageListener) {
        chatStopMessageListener();
        chatStopMessageListener = null;
    }
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

function addViewedAt(msg) {
    if (!msg._viewedAt) msg._viewedAt = msg.at || Date.now();
    return msg;
}

function cleanupExpired(room) {
    if (!chatRooms[room]) return;
    const before = chatRooms[room].length;
    chatRooms[room] = chatRooms[room].filter((m) => Date.now() - (m._viewedAt || m.at || 0) < MSG_TTL);
    if (chatRooms[room].length !== before) {
        saveChatRooms();
    }
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
        bubble.innerHTML = "<b>" + escapeHtml(msg.name || "Guest") + "</b>" + escapeHtml(msg.text);
        messages.appendChild(bubble);
    });
    messages.scrollTop = messages.scrollHeight;
}

messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentRoom) joinChatRoom();
    const text = messageInput.value.trim();
    if (!currentRoom || !text) return;
    const msg = addViewedAt({ name: chatName.value.trim() || "Guest", text, at: Date.now() });
    messageInput.value = "";
    chatRooms[currentRoom] ||= [];
    chatRooms[currentRoom].push(msg);
    saveChatRooms();
    renderChatMessages();
    if (firebaseChatReady()) {
        try {
            await chatRoomRef(currentRoom).update({ name: currentRoom, updatedAt: Date.now() });
            await chatRoomRef(currentRoom).child("messages").push(msg);
        } catch (error) {
            console.error("Firebase message send failed:", error);
            activeRoomMeta.textContent = "Message saved locally, but Firebase blocked the send.";
        }
    }
});

chatName.addEventListener("input", () => {
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
    }, () => {
        activeRoomMeta.textContent = "Firebase could not load messages.";
    });
    chatStopMessageListener = () => msgsRef.off();
}

async function saveChatRoomOnline(room) {
    if (!firebaseChatReady() || !room) return;
    try {
        await chatRoomRef(room).update({ name: room, updatedAt: Date.now() });
    } catch (error) {
        console.error("Firebase room save failed:", error);
    }
}

function chatRoomRef(room) {
    return firebaseDb.ref("chatRooms/" + chatRoomKey(room));
}

function chatRoomKey(room) {
    return encodeURIComponent(room.trim().toLowerCase()).replace(/[.#$/[\]]/g, "_");
}

function generateChatCode() {
    const p = () => Math.random().toString(36).slice(2, 5).toUpperCase();
    return p() + "-" + p();
}

function firebaseChatReady() {
    return Boolean(firebaseDb && window.firebase && window.kHubFirebaseDb);
}

function normalizeRooms(val) {
    if (!val || typeof val !== "object" || Array.isArray(val)) return {};
    return Object.fromEntries(Object.entries(val).filter((e) => Array.isArray(e[1])));
}

function parseJson(val, fallback) {
    if (!val) return fallback;
    try { return JSON.parse(val); } catch { return fallback; }
}

function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, val) {
    try { localStorage.setItem(key, val); } catch {}
}

function escapeHtml(val) {
    return String(val).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/* Chat settings sync */
const settingsNickname = document.getElementById("settingsNickname");
if (settingsNickname) {
    settingsNickname.value = chatName.value;
    settingsNickname.addEventListener("input", () => {
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

/* ===== Nexus AI ===== */
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
        label.textContent = "Nexus AI";
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
        const res = await fetch("/api/ai/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are Nexus AI, a helpful assistant. Keep answers concise and clear." },
                    ...aiHistory.slice(-20)
                ],
                max_tokens: 1024
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(err);
        }

        const data = await res.json();
        const reply = data.choices[0].message.content;
        aiRemoveLoading();
        aiAddMsg("assistant", reply);
        aiHistory.push({ role: "assistant", content: reply });
    } catch (err) {
        aiRemoveLoading();
        aiAddMsg("assistant", "Error: AI unavailable. Install Ollama (ollama.com) for free local AI, or set OPENAI_API_KEY as a server environment variable.");
    }
});

/* ── Music Player ── */
let ytPlayer = null;
let ytReady = false;
const musicQueue = [];
let musicIndex = -1;
let musicShuffle = false;
let musicRepeat = false;
let musicMinimized = true;
let musicHidden = false;
let musicProgressInterval = null;
const FALLBACK_THUMB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Ccircle cx='24' cy='24' r='22' fill='%23222'/%3E%3Cpath d='M18 14v20l16-10z' fill='%23888'/%3E%3C/svg%3E";
window.FALLBACK_THUMB = FALLBACK_THUMB;

const musicEl = document.getElementById("music-player");
const musicThumb = document.getElementById("music-thumb");
const musicTitle = document.getElementById("music-title");
const musicAuthor = document.getElementById("music-author");
const musicFullThumb = document.getElementById("music-full-thumb");
const musicFullTitle = document.getElementById("music-full-title");
const musicFullAuthor = document.getElementById("music-full-author");
const musicPlayBtn = document.getElementById("music-play-btn");
const musicPlayIcon = document.getElementById("music-play-icon");
const musicPrevBtn = document.getElementById("music-prev-btn");
const musicNextBtn = document.getElementById("music-next-btn");
const musicShuffleBtn = document.getElementById("music-shuffle-btn");
const musicRepeatBtn = document.getElementById("music-repeat-btn");
const musicSearchInput = document.getElementById("music-search-input");
const musicResults = document.getElementById("music-results");
const musicSearchToggle = document.getElementById("music-search-toggle");
const musicSearchArea = document.getElementById("music-search-area");
const musicToggleBtn = document.getElementById("music-toggle-btn");
const musicToggleIcon = document.getElementById("music-toggle-icon");
const musicProgressFill = document.getElementById("music-progress-fill");
const musicProgressBar = document.getElementById("music-progress-bar");
const musicCurrentTime = document.getElementById("music-current-time");
const musicDuration = document.getElementById("music-duration");
const musicVolume = document.getElementById("music-volume");
const musicQueueList = document.getElementById("music-queue-list");
const musicQueueCount = document.getElementById("music-queue-count");
const frogMusicBtn = document.getElementById("frog-music-btn");

function loadYouTubeAPI() {
    if (typeof YT !== "undefined" && YT.Player) { onYouTubeIframeAPIReady(); return; }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    const first = document.getElementsByTagName("script")[0];
    first.parentNode.insertBefore(tag, first);
}

function onYouTubeIframeAPIReady() {
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
            iv_load_policy: 3
        },
        events: {
            onReady: onPlayerReady,
            onStateChange: onPlayerStateChange,
            onError: onPlayerError
        }
    });
}

function onPlayerError(e) {
    if (musicIndex >= 0 && musicIndex < musicQueue.length) {
        const track = musicQueue[musicIndex];
        toast("Can't play: " + track.title);
    } else {
        toast("Can't play this video");
    }
    if (musicQueue.length > 1) {
        playNext();
    } else {
        stopPlayback();
    }
}

function onPlayerReady() {
    ytReady = true;
    ytPlayer.setVolume(parseInt(musicVolume.value));
    if (musicIndex >= 0 && musicIndex < musicQueue.length) {
        playCurrent();
    }
}

function onPlayerStateChange(e) {
    if (e.data === YT.PlayerState.ENDED) {
        if (musicRepeat) {
            ytPlayer.seekTo(0);
            ytPlayer.playVideo();
        } else if (musicIndex < musicQueue.length - 1) {
            musicIndex++;
            playCurrent();
        } else if (musicShuffle) {
            musicIndex = Math.floor(Math.random() * musicQueue.length);
            playCurrent();
        } else {
            updatePlayIcon(false);
            clearInterval(musicProgressInterval);
        }
    }
    updatePlayIcon(e.data === YT.PlayerState.PLAYING);
}

function updatePlayIcon(playing) {
    musicPlayIcon.innerHTML = playing
        ? '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>'
        : '<polygon points="5 3 19 12 5 21 5 3"/>';
}

function playSong(videoId, title, author, thumbnail) {
    const existingIdx = musicQueue.findIndex(t => t.id === videoId);
    if (existingIdx >= 0) {
        musicIndex = existingIdx;
    } else {
        musicQueue.push({ id: videoId, title, author, thumbnail });
        musicIndex = musicQueue.length - 1;
    }
    if (!ytReady) {
        toast("Loading YouTube player...");
        updateNowPlaying(musicQueue[musicIndex]);
        updateQueueUI();
        showPlayer();
        loadYouTubeAPI();
        return;
    }
    playCurrent();
    updateQueueUI();
    showPlayer();
}

function playCurrent() {
    if (musicIndex < 0 || musicIndex >= musicQueue.length) return;
    const track = musicQueue[musicIndex];
    ytPlayer.loadVideoById(track.id);
    ytPlayer.playVideo();
    updateNowPlaying(track);
    updateQueueUI();
    if (musicProgressInterval) clearInterval(musicProgressInterval);
    musicProgressInterval = setInterval(updateProgress, 500);
}

function updateNowPlaying(track) {
    const thumb = track.thumbnail || `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`;
    musicThumb.src = thumb;
    musicThumb.onerror = () => { musicThumb.src = window.FALLBACK_THUMB; };
    musicTitle.textContent = track.title;
    musicAuthor.textContent = track.author;
    musicFullThumb.src = thumb;
    musicFullThumb.onerror = () => { musicFullThumb.src = window.FALLBACK_THUMB; };
    musicFullTitle.textContent = track.title;
    musicFullAuthor.textContent = track.author;
}

function updateProgress() {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    const current = ytPlayer.getCurrentTime();
    const dur = ytPlayer.getDuration();
    if (dur > 0) {
        const pct = (current / dur) * 100;
        musicProgressFill.style.width = pct + "%";
    }
    musicCurrentTime.textContent = formatTime(current);
    musicDuration.textContent = formatTime(dur);
}

function formatTime(t) {
    if (!t || isNaN(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
}

function togglePlay() {
    if (!ytReady || musicIndex < 0) return;
    const state = ytPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
        clearInterval(musicProgressInterval);
    } else {
        ytPlayer.playVideo();
        musicProgressInterval = setInterval(updateProgress, 500);
    }
}

function playNext() {
    if (musicQueue.length === 0) return;
    if (musicShuffle) {
        musicIndex = Math.floor(Math.random() * musicQueue.length);
    } else if (musicIndex < musicQueue.length - 1) {
        musicIndex++;
    } else if (musicRepeat) {
        musicIndex = 0;
    } else return;
    playCurrent();
}

function playPrev() {
    if (musicQueue.length === 0) return;
    if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 3) {
        ytPlayer.seekTo(0);
        return;
    }
    if (musicIndex > 0) {
        musicIndex--;
    } else if (musicRepeat) {
        musicIndex = musicQueue.length - 1;
    } else return;
    playCurrent();
}

function toggleShuffle() {
    musicShuffle = !musicShuffle;
    musicShuffleBtn.classList.toggle("active", musicShuffle);
}

function toggleRepeat() {
    musicRepeat = !musicRepeat;
    musicRepeatBtn.classList.toggle("active", musicRepeat);
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
    musicResults.innerHTML = results.map(r => `
        <div class="music-result-item" data-id="${r.id}" data-title="${escapeHtml(r.title)}" data-author="${escapeHtml(r.author)}" data-thumb="${r.thumbnail}">
            <img src="${r.thumbnail}" alt="" loading="lazy" onerror="this.src=FALLBACK_THUMB" />
            <div class="r-title">${escapeHtml(r.title)}</div>
            <div class="r-meta">${r.author} · ${r.duration}</div>
        </div>
    `).join("");
    musicResults.querySelectorAll(".music-result-item").forEach(el => {
        el.addEventListener("click", () => {
            const id = el.dataset.id;
            const title = el.dataset.title;
            const author = el.dataset.author;
            const thumb = el.dataset.thumb;
            playSong(id, title, author, thumb);
            musicSearchInput.value = "";
            musicResults.innerHTML = "";
            musicSearchArea.classList.add("music-hidden");
        });
    });
}

function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

/* Queue UI */
function updateQueueUI() {
    musicQueueList.innerHTML = musicQueue.map((t, i) => `
        <div class="music-qitem ${i === musicIndex ? "active" : ""}" data-idx="${i}">
            <img src="${t.thumbnail || "https://i.ytimg.com/vi/" + t.id + "/mqdefault.jpg"}" alt="" onerror="this.src=window.FALLBACK_THUMB" />
            <span class="q-title">${escapeHtml(t.title)}</span>
            <button class="q-remove" data-idx="${i}">×</button>
        </div>
    `).join("");
    musicQueueCount.textContent = musicQueue.length + " song" + (musicQueue.length !== 1 ? "s" : "");
    musicQueueList.querySelectorAll(".music-qitem").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target.classList.contains("q-remove")) return;
            musicIndex = parseInt(el.dataset.idx);
            playCurrent();
        });
    });
    musicQueueList.querySelectorAll(".q-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            musicQueue.splice(idx, 1);
            if (idx < musicIndex) musicIndex--;
            else if (idx === musicIndex) {
                if (musicQueue.length === 0) { musicIndex = -1; stopPlayback(); }
                else { if (musicIndex >= musicQueue.length) musicIndex = musicQueue.length - 1; playCurrent(); }
            }
            updateQueueUI();
        });
    });
}

function stopPlayback() {
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    clearInterval(musicProgressInterval);
    musicProgressFill.style.width = "0%";
    musicCurrentTime.textContent = "0:00";
    musicDuration.textContent = "0:00";
    musicThumb.removeAttribute("src");
    musicFullThumb.removeAttribute("src");
    musicTitle.textContent = "No track";
    musicAuthor.textContent = "";
    musicFullTitle.textContent = "No track selected";
    musicFullAuthor.textContent = "";
    updatePlayIcon(false);
}

function showPlayer() {
    musicHidden = false;
    musicEl.classList.remove("music-hidden");
    frogMusicBtn.classList.add("active");
}

/* Event listeners */
musicPlayBtn.addEventListener("click", togglePlay);
musicNextBtn.addEventListener("click", playNext);
musicPrevBtn.addEventListener("click", playPrev);
musicShuffleBtn.addEventListener("click", toggleShuffle);
musicRepeatBtn.addEventListener("click", toggleRepeat);

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

musicVolume.addEventListener("input", () => {
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(parseInt(musicVolume.value));
});

musicProgressBar.addEventListener("click", (e) => {
    if (!ytPlayer || !ytPlayer.getDuration) return;
    const rect = musicProgressBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const dur = ytPlayer.getDuration();
    ytPlayer.seekTo(dur * Math.max(0, Math.min(1, pct)));
});

/* Keyboard shortcuts */
document.addEventListener("keydown", (e) => {
    if (musicHidden) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT") return;
    if (e.target.type === "range") return;
    if (e.code === "Space" && !e.repeat) { e.preventDefault(); togglePlay(); }
    if (e.key === "Escape" && !musicSearchArea.classList.contains("music-hidden")) {
        musicSearchArea.classList.add("music-hidden");
    }
});

/* Init */
frogMusicBtn.classList.add("active");
loadYouTubeAPI();

/* ── Patch Notes ── */
const PATCH_NOTES_VERSION = 1;
const patchModal = document.getElementById("patchModal");
if (!localStorage.getItem("nexus-patch-seen") && patchModal) {
    patchModal.classList.remove("hidden");
}
function dismissPatch() {
    patchModal.classList.add("hidden");
    try { localStorage.setItem("nexus-patch-seen", String(PATCH_NOTES_VERSION)); } catch (e) {}
}
document.getElementById("patchClose")?.addEventListener("click", dismissPatch);
document.getElementById("patchGotIt")?.addEventListener("click", dismissPatch);
patchModal?.addEventListener("click", (e) => { if (e.target === patchModal) dismissPatch(); });
