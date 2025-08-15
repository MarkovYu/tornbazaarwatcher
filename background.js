// ===== TW3B Market Watch – Background (DOM-only, waits for React, saves ALL matches) =====
const DEFAULTS = { everyMin: 2, watches: [] };
const log = (...a) => console.log("[BG]", ...a);
const err = (...a) => console.error("[BG]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- lifecycle
chrome.runtime.onInstalled.addListener(async () => {
  log("onInstalled");
  const s = await chrome.storage.sync.get(["everyMin", "watches"]);
  if (!s.watches) await chrome.storage.sync.set({ ...DEFAULTS, ...s });
  schedule(s.everyMin ?? DEFAULTS.everyMin);
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.everyMin) schedule(ch.everyMin.newValue);
});

// ---- alarms
function schedule(min) {
  const period = Math.max(1, +min || 2);
  log("schedule every", period, "min");
  chrome.alarms.clear("tw3b:poll", () =>
    chrome.alarms.create("tw3b:poll", { periodInMinutes: period })
  );
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tw3b:poll") {
    log("alarm -> pollAll");
    pollAll();
  }
});

// ---- messaging
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg?.type === "forcePoll") {
    pollAll().then(() => send({ ok: true }));
    return true;
  }
  if (msg?.type === "clearMatches") {
    chrome.storage.local.set({ matches: [] }).then(() => send({ ok: true }));
    return true;
  }
  if (msg?.type === "ping") send({ ok: true, pong: Date.now() });
});

/* ---------------- Tab helpers ---------------- */
async function waitTabComplete(tabId, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {}
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(200);
  }
}
async function ensureItemTab(itemId) {
  const url = `https://weav3r.dev/item/${itemId}`;
  let [tab] = await chrome.tabs.query({ url: "https://weav3r.dev/*" });
  if (!tab) {
    log("creating hidden tab:", url);
    tab = await new Promise((res) =>
      chrome.tabs.create({ url, active: false }, (t) => res(t))
    );
  } else if (!tab.url?.includes(`/item/${itemId}`)) {
    log("navigating tab to:", url);
    await chrome.tabs.update(tab.id, { url, active: false });
  }
  await waitTabComplete(tab.id, 30000);
  return tab;
}
async function execInTab(tabId, fn, ...args) {
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args,
    });
    return inj?.result;
  } catch (e) {
    return { __error: String(e) };
  }
}

/* ---------------- In-page scraper (WAIT-AWARE) ---------------- */
// Runs inside the page. Waits for bazaar links to appear, then parses.
async function scrapeListingsInPageWait() {
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

  const ok = await _waitFor(
    () =>
      document.querySelectorAll('a[href*="torn.com/bazaar.php?userId="]')
        .length > 0,
    15000,
    250
  );
  if (!ok) return []; // React didn’t render within wait window

  const anchors = [
    ...document.querySelectorAll('a[href*="torn.com/bazaar.php?userId="]'),
  ];

  const getInt = (s) => {
    const m = String(s).match(/\d[\d,]*/);
    return m ? parseInt(m[0].replace(/,/g, ""), 10) : null;
  };
  const getMoney = (s) => {
    const m = String(s).match(/\$\s*([\d,]+)/);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  };
  const getPct = (s) => {
    const m = String(s).match(/-?\d+%/);
    return m ? parseInt(m[0].replace("%", ""), 10) : null;
  };

  const rows = anchors
    .map((a) => {
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
      const quantity = qtyEl ? getInt(qtyEl.textContent) : null;

      let price = priceEl ? getMoney(priceEl.textContent) : null;
      if (price == null) price = getMoney(row.textContent);

      let vs_market = vsEl ? getPct(vsEl.textContent) : getPct(row.textContent);

      if (!player_id || !Number.isFinite(price) || !Number.isFinite(quantity))
        return null;
      return { player_id, player_name, price, quantity, vs_market };
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
  return unique;
}

/* ---------------- Main polling (wait + delay every item) ---------------- */
async function pollAll() {
  try {
    const { watches } = await chrome.storage.sync.get("watches");
    log("pollAll watches:", watches);
    if (!Array.isArray(watches) || watches.length === 0) return;

    for (let i = 0; i < watches.length; i++) {
      const w = watches[i];
      const tab = await ensureItemTab(w.id);
      log("checking item", w.id, "on tab", tab.id);

      const arr = await execInTab(tab.id, scrapeListingsInPageWait);
      if (!Array.isArray(arr)) {
        err("scrape failed", arr?.__error || arr);
        continue;
      }

      const matches = arr.filter(
        (x) =>
          Number(x.price) <= Number(w.maxPrice) &&
          Number(x.quantity) >= Number(w.minQty)
      );
      log(`found ${arr.length} listings; matches=${matches.length}`);
      if (matches.length === 0) {
        await sleep(600 + Math.floor(Math.random() * 300));
        continue;
      }

      const key = "matches";
      const prev = (await chrome.storage.local.get(key))[key] || [];
      const seen = new Set(
        prev.map((m) => `${m.itemId}|${m.price}|${m.quantity}|${m.player_id}`)
      );
      const now = Date.now();
      const newEntries = [];

      for (const hit of matches) {
        const entryKey = `${w.id}|${Number(hit.price)}|${Number(
          hit.quantity
        )}|${hit.player_id}`;
        if (seen.has(entryKey)) continue;
        newEntries.push({
          ts: now,
          itemId: w.id,
          itemName: w.name || `Item ${w.id}`,
          price: Number(hit.price),
          quantity: Number(hit.quantity),
          player_id: hit.player_id,
          player_name: hit.player_name,
          bazaar_url: `https://www.torn.com/bazaar.php?userId=${hit.player_id}`,
        });
        seen.add(entryKey);
      }

      if (newEntries.length > 0) {
        const next = [...newEntries, ...prev].slice(0, 200);
        await chrome.storage.local.set({ [key]: next });
        newEntries.forEach((entry) =>
          chrome.runtime.sendMessage({ type: "match", entry })
        );
        const lowest = Math.min(...newEntries.map((e) => e.price));
        notify(
          w.name || `Item ${w.id}`,
          `Found ${newEntries.length} new deal${
            newEntries.length > 1 ? "s" : ""
          } (lowest $${lowest.toLocaleString()}).`
        );
        log(`saved ${newEntries.length} new matches for item ${w.id}`);
      }

      // gentle delay between items (reduces CF rate-limits and ensures next React mount)
      await sleep(800 + Math.floor(Math.random() * 400));
    }
  } catch (e) {
    err("pollAll error", e);
  }
}

// ---- notifications
function notify(title, message) {
  log("notify:", title, message);
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title: `${title} – deal detected`,
    message,
    priority: 2,
  });
}
