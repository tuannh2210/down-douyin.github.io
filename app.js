#!/usr/bin/env node
/**
 * Douyin Downloader — Desktop App (Light Theme)
 * Chay: node app.js
 * Yeu cau: Node.js >= 18, file cookies.txt cung thu muc
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT        = 3939;
const COOKIE_FILE = path.join(__dirname, "cookies.txt");
const clients     = new Set();

function broadcast(ev) {
  const line = "data: " + JSON.stringify(ev) + "\n\n";
  for (const res of clients) {
    try { res.write(line); } catch (_) { clients.delete(res); }
  }
}

let jobRunning = false;
let jobAborted = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPool(tasks, limit) {
  let idx = 0, active = 0;
  await new Promise((resolve) => {
    const next = () => {
      if (idx >= tasks.length && active === 0) { resolve(); return; }
      while (active < limit && idx < tasks.length) {
        const t = tasks[idx++]; active++;
        t().finally(() => { active--; next(); });
      }
    };
    next();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

const spd = [];
function addBytes(n) {
  spd.push({ t: Date.now(), b: n });
  const cut = Date.now() - 4000;
  while (spd.length > 0 && spd[0].t < cut) spd.shift();
}
function getSpeed() {
  if (spd.length < 2) return 0;
  const tb = spd.reduce((s, x) => s + x.b, 0);
  const dt = (spd[spd.length - 1].t - spd[0].t) / 1000;
  return dt > 0 ? tb / dt : 0;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0";

async function fetchPage(uid, cursor, cookies, retry) {
  retry = retry || 0;
  if (retry > 4) throw new Error("Max retries");
  const url =
    "https://www.douyin.com/aweme/v1/web/aweme/post/" +
    "?device_platform=webapp&aid=6383&channel=channel_pc_web" +
    "&sec_user_id=" + uid + "&max_cursor=" + cursor +
    "&count=20&version_code=170400&version_name=17.4.0";
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json, text/plain, */*", "accept-language": "vi", cookie: cookies, referer: "https://www.douyin.com/user/" + uid, "user-agent": UA },
    });
    if (!r.ok) { await sleep(3000); return fetchPage(uid, cursor, cookies, retry + 1); }
    return r.json();
  } catch { await sleep(3000); return fetchPage(uid, cursor, cookies, retry + 1); }
}

async function fetchAllLinks(uid, cookies, filter) {
  const videos = [];
  let hasMore = 1, cursor = 0, errCnt = 0, scanned = 0, filtered = 0;
  const minLikes   = filter.minLikes   || 0;
  const minViews   = filter.minViews   || 0;
  const dateFrom   = filter.dateFrom   ? Math.floor(new Date(filter.dateFrom).getTime() / 1000) : 0;
  const dateTo     = filter.dateTo     ? Math.floor(new Date(filter.dateTo).getTime()   / 1000) + 86399 : 0;

  while (hasMore === 1 && errCnt < 5 && !jobAborted) {
    const data = await fetchPage(uid, cursor, cookies).catch(() => null);
    if (!data || !data.aweme_list) { errCnt++; await sleep(3000); continue; }
    errCnt = 0; hasMore = data.has_more; cursor = data.max_cursor;

    for (const v of data.aweme_list) {
      scanned++;
      const likes  = (v.statistics && v.statistics.digg_count)  || 0;
      const views  = (v.statistics && v.statistics.play_count)   || 0;
      const ts     = v.create_time || 0;

      if (minLikes > 0 && likes < minLikes) { filtered++; continue; }
      if (minViews > 0 && views < minViews) { filtered++; continue; }
      if (dateFrom > 0 && ts < dateFrom)    { filtered++; continue; }
      if (dateTo   > 0 && ts > dateTo)      { filtered++; continue; }

      const id = v.aweme_id || ("vid_" + (videos.length + 1));
      let url = (v.video && v.video.play_addr && v.video.play_addr.url_list && v.video.play_addr.url_list[0])
             || (v.video && v.video.download_addr && v.video.download_addr.url_list && v.video.download_addr.url_list[0])
             || "";
      if (url) {
        if (!url.startsWith("https")) url = url.replace("http", "https");
        const date = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "unknown";
        videos.push({ id, url, likes, views, date });
      }
    }
    broadcast({ type: "scan", count: videos.length, scanned, filtered });
    await sleep(800);
  }
  return videos;
}

async function dlVideo(dir, i, total, id, url, date, cookies, stats, retry) {
  retry = retry || 0;
  if (jobAborted) return;
  const prefix = (date && date !== "unknown") ? date + "_" : "";
  const name = String(i + 1).padStart(4, "0") + "_" + prefix + id + ".mp4";
  const fp   = path.join(dir, name);
  if (fs.existsSync(fp) && fs.statSync(fp).size > 0) {
    stats.skipped++; stats.done++;
    broadcast({ type: "progress", done: stats.done, total: stats.total, failed: stats.failed, skipped: stats.skipped, speed: getSpeed(), status: "skip" });
    broadcast({ type: "log", msg: "[" + String(i+1).padStart(3,"0") + "/" + total + "] SKIP  " + name, level: "skip" });
    return;
  }
  try {
    const r = await fetch(url, { headers: { cookie: cookies, referer: "https://www.douyin.com/", "user-agent": UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, fp);
    addBytes(buf.length);
    stats.done++;
    broadcast({ type: "progress", done: stats.done, total: stats.total, failed: stats.failed, skipped: stats.skipped, speed: getSpeed(), status: "ok", bytes: buf.length });
    broadcast({ type: "log", msg: "[" + String(i+1).padStart(3,"0") + "/" + total + "] OK    " + name + "  " + (buf.length/1048576).toFixed(1) + " MB", level: "ok" });
  } catch (e) {
    if (retry < 3 && !jobAborted) { await sleep(2000); return dlVideo(dir, i, total, id, url, cookies, stats, retry + 1); }
    stats.failed++; stats.done++;
    broadcast({ type: "progress", done: stats.done, total: stats.total, failed: stats.failed, skipped: stats.skipped, speed: getSpeed(), status: "fail" });
    broadcast({ type: "log", msg: "[" + String(i+1).padStart(3,"0") + "/" + total + "] FAIL  " + name + "  " + e.message, level: "err" });
  }
}

async function startJob(cfg) {
  if (jobRunning) return;
  jobRunning = true; jobAborted = false; spd.length = 0;
  fs.writeFileSync(COOKIE_FILE, cfg.cookies, "utf-8");
  fs.mkdirSync(cfg.dir, { recursive: true });
  broadcast({ type: "status", state: "scanning" });
  broadcast({ type: "log", msg: "Scanning user: " + cfg.uid, level: "info" });
  const filter = { minLikes: cfg.minLikes||0, minViews: cfg.minViews||0, dateFrom: cfg.dateFrom||"", dateTo: cfg.dateTo||"" };
  if (filter.minLikes) broadcast({ type: "log", msg: "Filter: likes >= " + filter.minLikes.toLocaleString(), level: "info" });
  if (filter.minViews) broadcast({ type: "log", msg: "Filter: views >= " + filter.minViews.toLocaleString(), level: "info" });
  if (filter.dateFrom) broadcast({ type: "log", msg: "Filter: from " + filter.dateFrom, level: "info" });
  if (filter.dateTo)   broadcast({ type: "log", msg: "Filter: to   " + filter.dateTo,   level: "info" });
  const videos = await fetchAllLinks(cfg.uid, cfg.cookies, filter);
  if (jobAborted) {
    broadcast({ type: "log", msg: "Stopped.", level: "warn" });
    broadcast({ type: "status", state: "idle" });
    jobRunning = false; return;
  }
  if (!videos.length) {
    broadcast({ type: "log", msg: "No videos found. Check cookie & user ID.", level: "err" });
    broadcast({ type: "status", state: "idle" });
    jobRunning = false; return;
  }
  broadcast({ type: "log", msg: "Found " + videos.length + " videos. Starting " + cfg.threads + " threads...", level: "info" });
  broadcast({ type: "total", count: videos.length });
  broadcast({ type: "status", state: "downloading" });
  fs.writeFileSync(path.join(cfg.dir, "_links.txt"), videos.map((v) => v.url).join("\n"), "utf-8");
  const stats = { done: 0, total: videos.length, failed: 0, skipped: 0 };
  const tasks = videos.map((v, i) => async () => { if (!jobAborted) await dlVideo(cfg.dir, i, videos.length, v.id, v.url, v.date||"", cfg.cookies, stats); });
  await runPool(tasks, cfg.threads);
  if (jobAborted) {
    broadcast({ type: "log", msg: "Stopped.  Done: " + stats.done + "/" + stats.total, level: "warn" });
  } else {
    broadcast({ type: "done", done: stats.done, total: stats.total, failed: stats.failed, skipped: stats.skipped });
    broadcast({ type: "log", msg: "Finished!  OK:" + (stats.done-stats.failed-stats.skipped) + "  FAIL:" + stats.failed + "  SKIP:" + stats.skipped, level: "ok" });
  }
  broadcast({ type: "status", state: "idle" });
  jobRunning = false;
}

// ── HTML ──────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Douyin DL</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:        #f5f4f1;
  --surface:   #ffffff;
  --panel:     #ffffff;
  --border:    #e4e1da;
  --border2:   #d5d0c8;
  --accent:    #e8533a;
  --accent2:   #c93e28;
  --accent-bg: #fef0ed;
  --text:      #1c1a17;
  --sub:       #6b6660;
  --muted:     #a09b94;
  --muted2:    #c8c3bb;
  --ok:        #2d7a3e;
  --ok-bg:     #edf7f0;
  --err:       #c0392b;
  --err-bg:    #fdecea;
  --warn:      #b8680a;
  --warn-bg:   #fef6e7;
  --skip:      #5a6a82;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: 'DM Sans', system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  min-height: 100vh;
}
.app {
  max-width: 1200px;
  margin: 0 auto;
  padding: 22px 24px 40px;
}
.columns {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 12px;
  align-items: start;
}
.col-left  { display: flex; flex-direction: column; gap: 10px; }
.col-right { display: flex; flex-direction: column; gap: 10px; }
.panel { margin-bottom: 0; }

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
}
.logo {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.3px;
  color: var(--text);
}
.logo em {
  font-style: normal;
  color: var(--accent);
}
.sep { color: var(--muted2); margin: 0 2px; }
.version {
  font-size: 10px;
  font-family: 'DM Mono', monospace;
  color: var(--muted);
  background: var(--border);
  padding: 2px 7px;
  border-radius: 20px;
}
.header-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.status-pill {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 3px 10px;
  border-radius: 20px;
  background: var(--border);
  color: var(--muted);
  transition: all 0.25s;
}
.status-pill.scanning  { background: var(--warn-bg); color: var(--warn); }
.status-pill.downloading { background: var(--ok-bg); color: var(--ok); }

/* ── Panel ── */
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 10px;
}
.ptitle {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 14px;
}

/* ── Fields ── */
.field { margin-bottom: 12px; }
.field:last-child { margin-bottom: 0; }
label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--sub);
  margin-bottom: 5px;
}
.hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
}
.field-row { display: flex; gap: 6px; }
.field-row input { flex: 1; }
input[type="text"], textarea {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border2);
  border-radius: 7px;
  color: var(--text);
  font-family: 'DM Mono', monospace;
  font-size: 11.5px;
  padding: 8px 11px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
input[type="text"]::placeholder, textarea::placeholder { color: var(--muted2); }
input[type="text"]:focus, textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(232, 83, 58, 0.1);
}
textarea { height: 60px; resize: none; line-height: 1.5; }

/* ── Slider ── */
.slider-wrap { display: flex; align-items: center; gap: 10px; }
.slider-num {
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
  min-width: 24px;
  text-align: right;
}
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  background: var(--border2);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 1px 4px rgba(232, 83, 58, 0.35);
  cursor: pointer;
  transition: transform 0.1s;
}
input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.2); }

/* ── Browse button ── */
.btn-browse {
  background: var(--bg);
  border: 1px solid var(--border2);
  border-radius: 7px;
  color: var(--sub);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 8px 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-browse:hover { border-color: var(--accent); color: var(--accent); }

/* ── Main button ── */
.btn-main {
  width: 100%;
  padding: 13px;
  background: var(--accent);
  border: none;
  border-radius: 9px;
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  cursor: pointer;
  transition: all 0.18s;
  margin-bottom: 10px;
  box-shadow: 0 2px 8px rgba(232,83,58,0.25), 0 1px 2px rgba(232,83,58,0.15);
}
.btn-main:hover {
  background: var(--accent2);
  box-shadow: 0 4px 16px rgba(232,83,58,0.3);
  transform: translateY(-1px);
}
.btn-main:active { transform: translateY(0); }
.btn-main.stop { background: #fff; color: var(--err); border: 1.5px solid var(--err); box-shadow: none; }
.btn-main.stop:hover { background: var(--err-bg); box-shadow: none; transform: none; }
.btn-main:disabled { opacity: 0.45; pointer-events: none; }

/* ── Progress ── */
.prog-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.prog-pct { font-size: 26px; font-weight: 600; color: var(--text); line-height: 1; letter-spacing: -1px; }
.prog-pct span { font-size: 14px; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.prog-count { font-size: 12px; color: var(--sub); font-family: 'DM Mono', monospace; }
.prog-track {
  height: 6px;
  background: var(--border);
  border-radius: 99px;
  overflow: hidden;
  margin-bottom: 14px;
}
.prog-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent2), var(--accent));
  border-radius: 99px;
  width: 0%;
  transition: width 0.4s ease;
}
.stats-row { display: flex; flex-wrap: wrap; gap: 6px 0; }
.stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--sub);
  padding: 4px 12px 4px 0;
  border-right: 1px solid var(--border);
  margin-right: 12px;
}
.stat:last-child { border-right: none; }
.stat b { font-weight: 600; }
.stat.ok b { color: var(--ok); }
.stat.err b { color: var(--err); }
.stat.spd b { color: var(--accent); }

/* ── Log ── */
.log-wrap {
  background: #1e1c19;
  border-radius: 8px;
  height: calc(100vh - 320px); min-height: 260px;
  overflow-y: auto;
  padding: 12px 14px;
  font-family: 'DM Mono', monospace;
  font-size: 11.5px;
  line-height: 1.85;
  scrollbar-width: thin;
  scrollbar-color: #3a3630 transparent;
}
.log-wrap::-webkit-scrollbar { width: 3px; }
.log-wrap::-webkit-scrollbar-thumb { background: #3a3630; border-radius: 2px; }

/* ── Filter ── */
.filter-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.filter-grid .field { margin-bottom: 0; }
.input-prefix-wrap { display: flex; align-items: center; background: var(--bg); border: 1px solid var(--border2); border-radius: 7px; overflow: hidden; }
.input-prefix-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(232,83,58,0.1); }
.input-prefix { font-size: 11px; font-weight: 500; color: var(--muted); padding: 0 8px 0 10px; white-space: nowrap; user-select: none; border-right: 1px solid var(--border2); line-height: 32px; }
.input-prefix-wrap input { border: none; border-radius: 0; box-shadow: none; background: transparent; flex: 1; min-width: 0; }
.input-prefix-wrap input:focus { box-shadow: none; }
.ll { display: flex; gap: 10px; white-space: pre-wrap; word-break: break-all; }
.ll .ts { color: #5a5550; flex-shrink: 0; user-select: none; }
.ll.info { color: #8a8680; }
.ll.ok   { color: #5db874; }
.ll.err  { color: #e05050; }
.ll.warn { color: #d4922a; }
.ll.skip { color: #6a7a95; }
</style>
</head>
<body>
<div class="app">

  <div class="header">
    <div class="logo">Douyin<em>/</em>DL</div>
    <div class="version">v2.0</div>
    <div class="header-right">
      <div class="status-pill idle" id="statusPill">Idle</div>
    </div>
  </div>

  <div class="columns">

    <!-- LEFT: config + filters + button -->
    <div class="col-left">

      <div class="panel">
        <div class="ptitle">Configuration</div>

        <div class="field">
          <label>Sec User ID</label>
          <input type="text" id="uid" placeholder="MS4wLjABAAAA..." spellcheck="false">
        </div>

        <div class="field">
          <label>Output Folder</label>
          <div class="field-row">
            <input type="text" id="outdir" placeholder="D:\\Videos\\douyin" spellcheck="false" value="">
            <button class="btn-browse" onclick="browseFolder()">Browse…</button>
          </div>
        </div>

        <div class="field">
          <label>Threads &nbsp;<span class="slider-num" id="threadVal">5</span></label>
          <div class="slider-wrap">
            <input type="range" id="threads" min="1" max="100" value="5"
              oninput="document.getElementById('threadVal').textContent = this.value">
          </div>
        </div>

        <div class="field">
          <label>Cookie &nbsp;<span class="hint">F12 → Network → aweme/post → Headers → copy dòng "cookie:"</span></label>
          <textarea id="cookies" placeholder="passport_csrf_token=...; ttwid=...; msToken=...;" spellcheck="false"></textarea>
        </div>
      </div>

      <div class="panel">
        <div class="ptitle">Filters &nbsp;<span class="hint" style="text-transform:none;letter-spacing:0;font-weight:400">— bỏ trống = lấy tất cả</span></div>
        <div class="filter-grid">
          <div class="field">
            <label>Tim tối thiểu</label>
            <div class="input-prefix-wrap">
              <span class="input-prefix">❤</span>
              <input type="text" id="minLikes" placeholder="0" spellcheck="false">
            </div>
          </div>
          <div class="field">
            <label>View tối thiểu</label>
            <div class="input-prefix-wrap">
              <span class="input-prefix">▶</span>
              <input type="text" id="minViews" placeholder="0" spellcheck="false">
            </div>
          </div>
          <div class="field">
            <label>Từ ngày</label>
            <input type="date" id="dateFrom" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:7px;color:var(--text);font-family:inherit;font-size:12px;padding:7px 10px;outline:none;">
          </div>
          <div class="field">
            <label>Đến ngày</label>
            <input type="date" id="dateTo" style="width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:7px;color:var(--text);font-family:inherit;font-size:12px;padding:7px 10px;outline:none;">
          </div>
        </div>
      </div>

      <button class="btn-main" id="mainBtn" onclick="handleBtn()">Start Download</button>

    </div><!-- /col-left -->

    <!-- RIGHT: progress + log -->
    <div class="col-right">

      <div class="panel">
        <div class="ptitle">Progress</div>
        <div class="prog-header">
          <div class="prog-pct"><span id="pct">0</span><span>%</span></div>
          <div class="prog-count"><span id="sDone">0</span> / <span id="sTotal">—</span></div>
        </div>
        <div class="prog-track">
          <div class="prog-fill" id="progFill"></div>
        </div>
        <div class="stats-row">
          <div class="stat ok">OK <b id="sOk">0</b></div>
          <div class="stat err">Failed <b id="sFail">0</b></div>
          <div class="stat">Skipped <b id="sSkip">0</b></div>
          <div class="stat spd">Speed <b id="sSpeed">—</b></div>
          <div class="stat">ETA <b id="sEta">—</b></div>
        </div>
      </div>

      <div class="panel">
        <div class="ptitle">Log</div>
        <div class="log-wrap" id="log"></div>
      </div>

    </div><!-- /col-right -->

  </div><!-- /columns -->

</div>

<script>
var running = false;
var total   = 0;

fetch('/load-cookies').then(function(r){ return r.json(); }).then(function(d){
  if (d.cookies) document.getElementById('cookies').value = d.cookies;
});

var evts = new EventSource('/events');
evts.onmessage = function(e) {
  var msg = JSON.parse(e.data);

  if (msg.type === 'status') {
    var pill = document.getElementById('statusPill');
    pill.className = 'status-pill ' + msg.state;
    pill.textContent = msg.state.charAt(0).toUpperCase() + msg.state.slice(1);
    if (msg.state === 'idle') {
      running = false;
      var btn = document.getElementById('mainBtn');
      btn.textContent = 'Start Download';
      btn.classList.remove('stop');
      btn.disabled = false;
    }
  }

  if (msg.type === 'scan') {
    var txt = msg.count + '…';
    if (msg.filtered > 0) txt += ' (' + msg.filtered + ' filtered)';
    document.getElementById('sTotal').textContent = txt;
  }
  if (msg.type === 'total') {
    total = msg.count;
    document.getElementById('sTotal').textContent = msg.count;
  }

  if (msg.type === 'progress') {
    var pct = total > 0 ? Math.round((msg.done / msg.total) * 100) : 0;
    document.getElementById('progFill').style.width = pct + '%';
    document.getElementById('pct').textContent = pct;
    document.getElementById('sDone').textContent = msg.done;
    document.getElementById('sOk').textContent = msg.done - msg.failed - msg.skipped;
    document.getElementById('sFail').textContent = msg.failed;
    document.getElementById('sSkip').textContent = msg.skipped;

    var spd = msg.speed || 0;
    document.getElementById('sSpeed').textContent =
      spd >= 1048576 ? (spd/1048576).toFixed(1)+' MB/s' :
      spd > 0 ? (spd/1024).toFixed(0)+' KB/s' : '—';

    var rem = msg.total - msg.done;
    if (spd > 0 && rem > 0) {
      var eta = rem * 3 * 1048576 / spd;
      document.getElementById('sEta').textContent = eta < 60 ? Math.round(eta)+'s' : Math.round(eta/60)+'m';
    } else {
      document.getElementById('sEta').textContent = '—';
    }
  }

  if (msg.type === 'log') addLog(msg.msg, msg.level || 'info');

  if (msg.type === 'done') {
    document.getElementById('progFill').style.width = '100%';
    document.getElementById('pct').textContent = '100';
  }
};

function addLog(msg, level) {
  var log  = document.getElementById('log');
  var line = document.createElement('div');
  line.className = 'll ' + (level || 'info');
  var now = new Date();
  var ts  = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  line.innerHTML = '<span class="ts">' + ts + '</span><span>' + esc(msg) + '</span>';
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 400) log.removeChild(log.firstChild);
}
function pad(n) { return n < 10 ? '0' + n : n; }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function browseFolder() {
  fetch('/browse', { method: 'POST' }).then(function(r){ return r.json(); })
    .then(function(d){ if (d.folder) document.getElementById('outdir').value = d.folder; });
}

function handleBtn() {
  if (running) {
    fetch('/stop', { method: 'POST' });
    var btn = document.getElementById('mainBtn');
    btn.textContent = 'Stopping…';
    btn.disabled = true;
    return;
  }

  var uid      = document.getElementById('uid').value.trim();
  var outdir   = document.getElementById('outdir').value.trim();
  var cookies  = document.getElementById('cookies').value.trim();
  var threads  = parseInt(document.getElementById('threads').value);
  var minLikes = document.getElementById('minLikes').value.trim().replace(/[^0-9]/g,'');
  var minViews = document.getElementById('minViews').value.trim().replace(/[^0-9]/g,'');
  var dateFrom = document.getElementById('dateFrom').value;
  var dateTo   = document.getElementById('dateTo').value;

  if (!uid)    { addLog('Missing User ID', 'err'); return; }
  if (!outdir) { addLog('Missing output folder', 'err'); return; }
  if (!cookies){ addLog('Missing cookies', 'err'); return; }

  running = true;
  var btn = document.getElementById('mainBtn');
  btn.textContent = 'Stop';
  btn.classList.add('stop');

  document.getElementById('progFill').style.width = '0%';
  document.getElementById('pct').textContent = '0';
  document.getElementById('sDone').textContent = '0';
  document.getElementById('sTotal').textContent = '—';
  document.getElementById('sOk').textContent = '0';
  document.getElementById('sFail').textContent = '0';
  document.getElementById('sSkip').textContent = '0';
  document.getElementById('sSpeed').textContent = '—';
  document.getElementById('sEta').textContent = '—';
  document.getElementById('log').innerHTML = '';
  total = 0;

  fetch('/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, dir: outdir, threads, cookies,
      minLikes: parseInt(minLikes)||0, minViews: parseInt(minViews)||0,
      dateFrom, dateTo }),
  });
}
</script>
</body>
</html>`;

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const route = req.method + " " + req.url;

  if (route === "GET /") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(HTML);
  }
  if (route === "GET /events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (route === "POST /start") {
    const body = await readBody(req);
    if (!body.uid || !body.dir || !body.cookies) { res.writeHead(400); return res.end("{}"); }
    res.writeHead(200); res.end("{}");
    startJob({
      uid:      body.uid.trim(),
      dir:      body.dir.trim(),
      threads:  Math.max(1, Math.min(parseInt(body.threads)||5, 100)),
      cookies:  body.cookies.trim(),
      minLikes: parseInt(body.minLikes) || 0,
      minViews: parseInt(body.minViews) || 0,
      dateFrom: body.dateFrom || "",
      dateTo:   body.dateTo   || "",
    });
    return;
  }
  if (route === "POST /stop") {
    jobAborted = true; res.writeHead(200); return res.end("{}");
  }
  if (route === "POST /browse") {
    const os  = require("os");
    const out = path.join(os.tmpdir(), "_dydl_browse.txt").replace(/\\/g, "\\\\");
    if (fs.existsSync(out)) try { fs.unlinkSync(out); } catch {}
    // Tạo STA thread tường minh — cách duy nhất đáng tin cậy cho WinForms dialog
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$result = ''",
      "$th = New-Object System.Threading.Thread({",
      "  [System.Windows.Forms.Application]::EnableVisualStyles()",
      "  $d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "  $d.Description = 'Chon thu muc luu video'",
      "  $d.ShowNewFolderButton = $true",
      "  if ($d.ShowDialog() -eq 'OK') {",
      "    [System.IO.File]::WriteAllText('" + out + "', $d.SelectedPath)",
      "  }",
      "})",
      "$th.SetApartmentState([System.Threading.ApartmentState]::STA)",
      "$th.Start()",
      "$th.Join()"
    ].join("; ");
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    exec("powershell -NonInteractive -EncodedCommand " + enc, { timeout: 60000 }, () => {
      let folder = "";
      try { folder = fs.existsSync(out) ? fs.readFileSync(out, "utf-8").trim() : ""; } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ folder }));
    });
    return;
  }
  if (route === "GET /load-cookies") {
    const c = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, "utf-8").trim() : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ cookies: c }));
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n  ┌─────────────────────────────────┐");
  console.log("  │     Douyin DL  ·  Light Theme   │");
  console.log("  └─────────────────────────────────┘");
  console.log("  Running at  \x1b[36mhttp://localhost:" + PORT + "\x1b[0m");
  console.log("  Press Ctrl+C to quit\n");
  exec("start http://localhost:" + PORT);
});