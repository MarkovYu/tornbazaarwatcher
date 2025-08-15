// ===== TW3B Watcher page (robust wait, deep debug, console.table) =====
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = (...a) => ($("#status").textContent = a.join(" "));
const esc = (s) =>
  String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
const fmt = (n) => (Number.isFinite(n) ? `$${Number(n).toLocaleString()}` : "");

const DEBUG = true;
const wlog = (...a) => DEBUG && console.log("[WATCHER]", ...a);

let RESULTS = [];
let STOP = false;
let SORT_KEY = "profit_total";
let SORT_DIR = "desc";

/* ---------------- CSV helpers ---------------- */

async function loadCsvIdsIntoBox() {
  try {
    const url = chrome.runtime.getURL("itemids.csv");
    const r = await fetch(url);
    if (!r.ok) throw new Error("CSV not found");
    const text = await r.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const hdr = lines.shift().split(",");
    const idIdx = hdr.findIndex((h) => /^(id|item_id)\s*$/i.test(h.trim()));
    if (idIdx < 0) throw new Error("CSV header must include id or item_id");
    const ids = [];
    for (const ln of lines) {
      const cells = ln.split(",");
      const n = Number(cells[idIdx]);
      if (Number.isFinite(n)) ids.push(n);
    }
    $("#ids").value = ids.join(", ");
    stat(`Loaded ${ids.length} IDs into the box.`);
  } catch (e) {
    console.warn("[Watcher] CSV load failed:", e);
    stat("CSV not found / failed.");
  }
}

async function loadCsvObjects() {
  const url = chrome.runtime.getURL("itemids.csv");
  const r = await fetch(url);
  if (!r.ok) throw new Error("CSV not found");
  const text = await r.text();
  return parseCsvToObjects(text);
}
function parseCsvToObjects(csvText) {
  const rows = [];
  let cur = [],
    val = "",
    q = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i],
      nx = csvText[i + 1];
    if (q) {
      if (ch === '"') {
        if (nx === '"') {
          val += '"';
          i++;
        } else {
          q = false;
        }
      } else {
        val += ch;
      }
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") {
        cur.push(val);
        val = "";
      } else if (ch === "\n" || ch === "\r") {
        if (val !== "" || cur.length) {
          cur.push(val);
          rows.push(cur);
          cur = [];
          val = "";
        }
        if (ch === "\r" && nx === "\n") i++;
      } else {
        val += ch;
      }
    }
  }
  if (val !== "" || cur.length) {
    cur.push(val);
    rows.push(cur);
  }
  if (!rows.length) return [];
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const idxId = hdr.findIndex((h) => h === "id" || h === "item_id");
  const idxMv = hdr.findIndex((h) =>
    [
      "marketvalue",
      "market_value",
      "marketprice",
      "market_price",
      "market",
      "market price",
    ].includes(h)
  );
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id = Number((row[idxId] || "").replace(/[^0-9.-]/g, ""));
    const mv =
      idxMv >= 0 ? Number((row[idxMv] || "").replace(/[^0-9.-]/g, "")) : NaN;
    if (Number.isFinite(id))
      out.push({ id, marketvalue: Number.isFinite(mv) ? mv : null });
  }
  return out;
}
async function filterCsvByMarketIntoBox() {
  try {
    const mvMinRaw = $("#mvMin").value.trim(),
      mvMaxRaw = $("#mvMax").value.trim();
    const mvMin = mvMinRaw === "" ? -Infinity : Number(mvMinRaw);
    const mvMax = mvMaxRaw === "" ? Infinity : Number(mvMaxRaw);
    if (!Number.isFinite(mvMin) || !Number.isFinite(mvMax)) {
      alert(
        "Please enter valid numbers for Min/Max Market $ (or leave blank)."
      );
      return;
    }
    const list = await loadCsvObjects();
    const filtered = list.filter(
      (o) =>
        o.marketvalue != null &&
        o.marketvalue >= mvMin &&
        o.marketvalue <= mvMax
    );
    $("#ids").value = filtered.map((o) => o.id).join(", ");
    stat(
      `Filtered ${filtered.length} IDs from CSV by market $ in [${
        mvMinRaw || "-∞"
      }, ${mvMaxRaw || "∞"}].`
    );
  } catch (e) {
    console.warn("[Watcher] filterCsvByMarketIntoBox failed:", e);
    stat("CSV not found / failed.");
    alert("Could not load itemids.csv or missing marketvalue column.");
  }
}

/* ---------------- Tab helpers ---------------- */

async function ensureItemTab(itemId) {
  let [tab] = await chrome.tabs.query({ url: "https://weav3r.dev/*" });
  const targetUrl = `https://weav3r.dev/item/${itemId}`;
  if (!tab) {
    wlog("create tab:", targetUrl);
    tab = await new Promise((res) =>
      chrome.tabs.create({ url: targetUrl, active: false }, (t) => res(t))
    );
  } else if (!tab.url?.includes(`/item/${itemId}`)) {
    wlog("navigate tab:", targetUrl);
    await chrome.tabs.update(tab.id, { url: targetUrl, active: false });
  }
  const ok = await waitTabComplete(tab.id, 30000);
  if (!ok) throw new Error("Tab not ready");
  // Extra small settle after 'complete'
  await sleep(250);
  // In-page readiness (bazaar anchors or “No listings”)
  const ready = await execInTab(tab.id, pageWaitForBazaarReady, 30000);
  if (!ready) wlog("⚠️ pageWaitForBazaarReady timed out");
  return tab;
}
async function waitTabComplete(tabId, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {}
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(150);
  }
}
async function execInTab(tabId, fn, ...args) {
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  });
  return inj?.result;
}

/* ---------------- In-page helpers (run inside weav3r.dev) ---------------- */

// Waits until bazaar links appear OR “No bazaar listings” is visible.
async function pageWaitForBazaarReady(timeoutMs = 30000) {
  function _waitFor(cond, tout = timeoutMs, step = 200) {
    return new Promise((res) => {
      const t0 = Date.now();
      (function tick() {
        try {
          if (cond()) return res(true);
        } catch {}
        if (Date.now() - t0 >= tout) return res(false);
        setTimeout(tick, step);
      })();
    });
  }
  const ok = await _waitFor(
    () => {
      const hasLinks =
        document.querySelectorAll('a[href*="torn.com/bazaar.php?userId="]')
          .length > 0;
      const noList = !![...document.querySelectorAll("*")].find((n) =>
        /No bazaar listings/i.test(n.textContent)
      );
      return hasLinks || noList;
    },
    timeoutMs,
    250
  );
  // tiny settle
  await new Promise((r) => setTimeout(r, 150));
  return ok;
}

// Returns {ok,item:{id,name,market}, listings:[...], debug:[...], rowsForLog:[...] }
async function scrapeWithMarket_DEBUG(limit) {
  function _waitFor(condFn, timeoutMs = 15000, stepMs = 200) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function tick() {
        try {
          if (condFn()) return resolve(true);
        } catch {}
        if (Date.now() - t0 >= timeoutMs) return resolve(false);
        setTimeout(tick, stepMs);
      })();
    });
  }
  const dbg = [];
  const dlog = (...a) => dbg.push(a.map(String).join(" "));
  const ok = await _waitFor(
    () =>
      document.querySelectorAll('a[href*="torn.com/bazaar.php?userId="]')
        .length > 0 ||
      !![...document.querySelectorAll("*")].find((n) =>
        /No bazaar listings/i.test(n.textContent)
      ),
    15000,
    250
  );
  if (!ok) {
    dlog("Timeout waiting for listings.");
    return {
      ok: true,
      item: { id: null, name: null, market: null },
      listings: [],
      debug: dbg,
      rowsForLog: [],
    };
  }

  // Item meta
  let itemName = null,
    market = null,
    itemId = null;
  const h1 = document.querySelector("h1");
  if (h1) itemName = h1.textContent.trim();

  const mpEl = [...document.querySelectorAll("*")].find((n) =>
    /Market Price/i.test(n.textContent)
  );
  if (mpEl) {
    const m = mpEl.closest("div")?.textContent.match(/\$\s*([\d,]+)/);
    if (m) market = Number(m[1].replace(/,/g, ""));
  }
  if (!market) {
    const m = document.body.textContent.match(
      /Market Price[^$]*\$\s*([\d,]+)/i
    );
    if (m) market = Number(m[1].replace(/,/g, ""));
  }

  const img = document.querySelector('img[src*="/images/items/"]');
  if (img) {
    const mm = img.src.match(/\/images\/items\/(\d+)\//);
    if (mm) itemId = Number(mm[1]);
  }
  dlog("Header:", itemName || "(none)");
  dlog("Market:", market);
  dlog("ItemID:", itemId);

  const num = (s) => {
    const m = String(s).match(/-?\d[\d,]*/);
    return m ? Number(m[0].replace(/,/g, "")) : null;
  };
  const money = (s) => {
    const m = String(s).match(/\$\s*([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  const pct = (s) => {
    const m = String(s).match(/-?\d+%/);
    return m ? Number(m[0].replace("%", "")) : null;
  };

  // Rows
  const anchors = [
    ...document.querySelectorAll('a[href*="torn.com/bazaar.php?userId="]'),
  ];
  dlog("Anchors:", anchors.length);

  const rows = anchors
    .map((a, idx) => {
      const row = a.closest('tr,[role="row"]') || a.closest("div");
      if (!row) return null;
      const cell = (i) =>
        row.querySelector(`[aria-colindex="${i}"]`) ||
        row.children[i - 1] ||
        null;

      const playerRaw = a.textContent.trim();
      const player_id = (playerRaw.match(/\[(\d+)\]/) ||
        a.href.match(/userId=(\d+)/) ||
        [])[1];
      const player_name = playerRaw.replace(/\s*\[\d+\]\s*$/, "").trim();

      const qtyEl = cell(2),
        priceEl = cell(3),
        vsEl = cell(4);
      const quantity = qtyEl ? num(qtyEl.textContent) : null;

      let price = priceEl ? money(priceEl.textContent) : null;
      if (price == null) price = money(row.textContent);

      let vs_market = vsEl ? pct(vsEl.textContent) : null;
      if (
        vs_market == null &&
        Number.isFinite(price) &&
        Number.isFinite(market) &&
        market > 0
      ) {
        vs_market = Math.round(((price - market) / market) * 100);
        dlog(`Row#${idx} computed vs%:`, vs_market);
      }

      if (!player_id || !Number.isFinite(price) || !Number.isFinite(quantity))
        return null;
      const rec = { player_name, player_id, price, quantity, vs_market };
      dlog(`Row#${idx}:`, JSON.stringify(rec));
      return rec;
    })
    .filter(Boolean);

  rows.sort((a, b) => a.price - b.price);

  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = `${r.player_id}|${r.price}|${r.quantity}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const top = unique.slice(0, Math.max(1, Number(limit) || 20));
  dlog(
    "Parsed:",
    rows.length,
    "Unique:",
    unique.length,
    "Top returned:",
    top.length
  );

  // expose a simplified array for console.table in the watcher page
  const rowsForLog = top.map((r) => ({
    player: r.player_name,
    id: r.player_id,
    price: r.price,
    qty: r.quantity,
    vs_market: r.vs_market,
  }));

  return {
    ok: true,
    item: { id: itemId, name: itemName, market },
    listings: top,
    debug: dbg,
    rowsForLog,
  };
}

/* ---------------- Rendering & sorting ---------------- */

function rowToResult(item, r) {
  const pu = Number.isFinite(item.market) ? item.market - r.price : null;
  const pt = Number.isFinite(pu) ? pu * r.quantity : null;
  return {
    itemName: item.name || "",
    itemId: item.id || "",
    market: item.market ?? null,
    player_name: r.player_name,
    player_id: r.player_id,
    quantity: r.quantity,
    price: r.price,
    vs_market: r.vs_market,
    profit_unit: pu,
    profit_total: pt,
  };
}
function renderResults(rows) {
  const tb = $("#rows");
  tb.innerHTML = "";
  const arr = [...rows].sort((a, b) => {
    const k = SORT_KEY,
      av = a[k],
      bv = b[k];
    if (typeof av === "string" || typeof bv === "string") {
      const cmp = String(av || "").localeCompare(String(bv || ""));
      return SORT_DIR === "asc" ? cmp : -cmp;
    }
    const na = av == null ? -Infinity : av,
      nb = bv == null ? -Infinity : bv;
    const cmp = na - nb;
    return SORT_DIR === "asc" ? cmp : -cmp;
  });
  document.querySelectorAll(".sort-ind").forEach((el) => (el.textContent = ""));
  const si = document.getElementById(`si-${SORT_KEY}`);
  if (si) si.textContent = SORT_DIR === "asc" ? "▲" : "▼";
  arr.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(o.itemName)}</td>
      <td>${esc(String(o.itemId))}</td>
      <td>${fmt(o.market)}</td>
      <td>${esc(o.player_name)} [${esc(o.player_id)}]</td>
      <td>${o.quantity}</td>
      <td>${fmt(o.price)}</td>
      <td class="${(o.vs_market ?? 0) <= 0 ? "ok" : "warn"}">${
      o.vs_market ?? ""
    }</td>
      <td>${Number.isFinite(o.profit_unit) ? fmt(o.profit_unit) : ""}</td>
      <td>${Number.isFinite(o.profit_total) ? fmt(o.profit_total) : ""}</td>
      <td><a href="https://www.torn.com/bazaar.php?userId=${
        o.player_id
      }" target="_blank" rel="noopener">Open</a></td>`;
    tb.appendChild(tr);
  });
}
function setSort(key) {
  if (SORT_KEY === key) SORT_DIR = SORT_DIR === "asc" ? "desc" : "asc";
  else {
    SORT_KEY = key;
    SORT_DIR = "desc";
  }
  renderResults(RESULTS);
}

/* ---------------- Controller (always-wait + diagnostics) ---------------- */

async function runScan() {
  STOP = false;
  RESULTS = [];
  renderResults(RESULTS);
  const maxVs = Number($("#maxVs").value || "-5");
  const delay = Math.max(0, Number($("#delay").value || "800"));
  const rowsLimit = Math.max(
    1,
    Math.min(100, Number($("#rowsPerItem").value || "20"))
  );
  const raw = $("#ids").value.trim();
  const ids = raw
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (!ids.length) {
    alert(
      "Please paste item IDs into the textbox (or use CSV buttons to fill it first)."
    );
    return;
  }

  wlog("Starting scan. IDs:", ids.join(", "));
  stat(`Scanning ${ids.length} items…`);

  let tab = null;
  for (let i = 0; i < ids.length && !STOP; i++) {
    const id = ids[i];
    try {
      stat(`(${i + 1}/${ids.length}) Item ${id} …`);
      wlog(`Navigate → /item/${id}`);
      tab = await ensureItemTab(id);

      const res = await execInTab(tab.id, scrapeWithMarket_DEBUG, rowsLimit);

      // Dump raw table of what we scraped for this item
      if (Array.isArray(res?.rowsForLog) && res.rowsForLog.length) {
        console.group(`[Watcher] Item ${id} scraped rows`);
        console.table(res.rowsForLog);
        console.groupEnd();
      }

      if (Array.isArray(res?.debug))
        res.debug.forEach((line) => wlog(`[item ${id}]`, line));
      if (!res?.ok) {
        wlog(`[item ${id}] scrape not ok`);
        continue;
      }

      const { item, listings } = res;
      wlog(
        `[item ${id}] market=${item.market} name="${item.name}" rows=${listings.length}`
      );

      const kept = [];
      for (const r of listings) {
        if (r.price === 1) {
          wlog(`[item ${id}] drop price=1`, r);
          continue;
        }
        if (!Number.isFinite(r.vs_market)) {
          wlog(`[item ${id}] drop vs% missing`, r);
          continue;
        }
        if (!(r.vs_market <= maxVs)) {
          wlog(`[item ${id}] drop vs% ${r.vs_market} > max ${maxVs}`, r);
          continue;
        }
        kept.push(r);
      }
      wlog(`[item ${id}] kept ${kept.length} rows after filter`);

      kept.forEach((r) => RESULTS.push(rowToResult(item, r)));
      renderResults(RESULTS);
    } catch (e) {
      console.warn("[Watcher] item", id, "failed:", e);
      wlog(`[item ${id}] ERROR`, e?.message || e);
    }
    if (i < ids.length - 1 && !STOP)
      await sleep(delay + Math.floor(Math.random() * 300));
  }

  stat(STOP ? "Stopped." : "Done.");
  wlog("Scan complete. RESULTS size:", RESULTS.length);
}

/* ---------------- Bindings ---------------- */
const on = (sel, ev, fn) => {
  const el = $(sel);
  if (el) el.addEventListener(ev, fn);
};
on("#start", "click", runScan);
on("#stop", "click", () => {
  STOP = true;
  stat("Stopping…");
});
on("#clear", "click", () => {
  RESULTS = [];
  renderResults(RESULTS);
  stat("Cleared.");
});
on("#loadCsv", "click", loadCsvIdsIntoBox);
on("#filterCsvByMarket", "click", filterCsvByMarketIntoBox);
document
  .querySelectorAll("#tbl thead th[data-sort]")
  .forEach((th) =>
    th.addEventListener("click", () => setSort(th.dataset.sort))
  );
renderResults(RESULTS);
