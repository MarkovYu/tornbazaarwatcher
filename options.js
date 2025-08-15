// ===== Options page (MV3-safe) — prettier UI + retention window =====
const $ = (s) => document.querySelector(s);
const olog = (...a) => console.log("[OPT]", ...a);

// keep the KPI in sync as you type (cosmetic)
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "every") {
    const v = Math.max(1, +(e.target.value || 2));
    const el = document.getElementById("kpi-every");
    if (el) el.textContent = String(v);
  }
});

let editIndex = null;
let CATALOG = [];
let CATS = [];
let ITEMS_BY_CAT = new Map();

const DEFAULT_RETAIN_MIN = 30;

/* ---------------- CSV loading ---------------- */
async function loadCSV() {
  const url = chrome.runtime.getURL("itemids.csv");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load CSV: ${res.status}`);
  const text = await res.text();
  return parseCSV(text);
}
function parseCSV(text) {
  const rows = [];
  let cur = [],
    val = "",
    inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i],
      nx = text[i + 1];
    if (inQ) {
      if (ch === '"') {
        if (nx === '"') {
          val += '"';
          i++;
        } else inQ = false;
      } else val += ch;
    } else {
      if (ch === '"') inQ = true;
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
      } else val += ch;
    }
  }
  if (val !== "" || cur.length) {
    cur.push(val);
    rows.push(cur);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    id: headers.findIndex((h) => ["id", "item_id"].includes(h)),
    name: headers.findIndex((h) => ["name", "item_name"].includes(h)),
    category: headers.findIndex((h) => ["category", "type"].includes(h)),
  };
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const idRaw = row[idx.id]?.trim();
    const nameRaw = row[idx.name]?.trim();
    const catRaw = row[idx.category]?.trim();
    if (!idRaw || !nameRaw) continue;
    const id = Number(idRaw);
    if (!Number.isFinite(id)) continue;
    out.push({ id, name: nameRaw, category: catRaw || "" });
  }
  return out;
}
function buildCatalogStructures(list) {
  CATALOG = list;
  ITEMS_BY_CAT = new Map();
  for (const it of list) {
    const cat = it.category || "(Uncategorized)";
    if (!ITEMS_BY_CAT.has(cat)) ITEMS_BY_CAT.set(cat, []);
    ITEMS_BY_CAT.get(cat).push(it);
  }
  CATS = [...ITEMS_BY_CAT.keys()].sort((a, b) => a.localeCompare(b));
  for (const arr of ITEMS_BY_CAT.values())
    arr.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- Catalog UI ---------------- */
function renderCategorySelect() {
  const sel = $("#catSelect");
  sel.innerHTML =
    '<option value="">— Select category —</option>' +
    CATS.map(
      (c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`
    ).join("");
  chrome.storage.local.get("lastCat").then((s) => {
    if (s.lastCat && CATS.includes(s.lastCat)) {
      sel.value = s.lastCat;
      fillItemsForCategory(s.lastCat);
    }
  });
}
function fillItemsForCategory(cat, filterText = "") {
  const sel = $("#itemSelect");
  const search = (filterText || "").trim().toLowerCase();
  sel.disabled = !cat;
  sel.innerHTML = cat
    ? buildItemOptions(ITEMS_BY_CAT.get(cat) || [], search)
    : '<option value="">— Select a category first —</option>';
}
function buildItemOptions(items, search) {
  const filtered = search
    ? items.filter((it) => it.name.toLowerCase().includes(search))
    : items;
  if (!filtered.length) return '<option value="">— No items match —</option>';
  return ['<option value="">— Select item —</option>']
    .concat(
      filtered.map(
        (it) =>
          `<option value="${it.id}" data-name="${escapeHTML(
            it.name
          )}">${escapeHTML(it.name)} [${it.id}]</option>`
      )
    )
    .join("");
}
function escapeHTML(str) {
  return (str || "").replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        s
      ])
  );
}

/* ---------------- Matches helpers (retention + de-dupe) ---------------- */
function pruneMatches(list, retainMin) {
  const cutoff = Date.now() - Math.max(1, retainMin) * 60_000;
  return (list || []).filter((m) => Number.isFinite(m?.ts) && m.ts >= cutoff);
}
function dedupeMatches(list) {
  const seen = new Set();
  return (list || []).filter((m) => {
    const k = `${m.itemId}|${m.price}|${m.quantity}|${m.player_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------------- Tables & KPIs ---------------- */
function renderWatches(items) {
  const tb = $("#rows");
  tb.innerHTML = "";
  (items || []).forEach((w, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHTML(String(w.id))}</td>
      <td>${escapeHTML(w.name || "")}</td>
      <td>${escapeHTML(String(w.maxPrice))}</td>
      <td>${escapeHTML(String(w.minQty))}</td>
      <td class="row-actions">
        <button class="btn" data-action="edit" data-i="${i}">Edit</button>
        <button class="btn" data-action="del" data-i="${i}">Delete</button>
      </td>`;
    tb.appendChild(tr);
  });
}
function renderMatches(list) {
  const tb = $("#matches");
  tb.innerHTML = "";
  const rows = dedupeMatches(list);
  rows.forEach((m) => {
    const when = new Date(m.ts).toLocaleString();
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHTML(when)}</td>
      <td>${escapeHTML(m.itemName)} (${escapeHTML(String(m.itemId))})</td>
      <td>$${Number(m.price).toLocaleString()}</td>
      <td>${Number(m.quantity).toLocaleString()}</td>
      <td>${escapeHTML(m.player_name)} [${escapeHTML(String(m.player_id))}]</td>
      <td><a class="btn" href="${
        m.bazaar_url
      }" target="_blank" rel="noopener">Open bazaar</a></td>`;
    tb.appendChild(tr);
  });
  $("#kpi-matches").textContent = String(rows.length);
}

/* ---------------- Load & persist ---------------- */
async function loadAll() {
  const s1 = await chrome.storage.sync.get([
    "watches",
    "everyMin",
    "retainMin",
  ]);
  renderWatches(s1.watches || []);
  $("#every").value = s1.everyMin ?? 2;
  $("#kpi-every").textContent = String(s1.everyMin ?? 2);
  $("#retain").value = s1.retainMin ?? DEFAULT_RETAIN_MIN;

  const s2 = await chrome.storage.local.get("matches");
  const retainMin = s1.retainMin ?? DEFAULT_RETAIN_MIN;
  const pruned = pruneMatches(s2.matches || [], retainMin);
  if ((s2.matches || []).length !== pruned.length) {
    await chrome.storage.local.set({ matches: pruned });
  }
  renderMatches(pruned);
}

/* ---------------- Events ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  $("#openWatcher").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("watcher.html") });
  });

  try {
    const list = await loadCSV();
    buildCatalogStructures(list);
    renderCategorySelect();
    $("#itemSelect").disabled = true;
  } catch (e) {
    console.error("[OPT] Catalog load failed:", e);
    $("#catSelect").innerHTML =
      '<option value="">— Catalog failed to load —</option>';
    $("#itemSelect").innerHTML = '<option value="">— N/A —</option>';
  }

  $("#catSelect").addEventListener("change", (e) => {
    const cat = e.target.value;
    chrome.storage.local.set({ lastCat: cat });
    fillItemsForCategory(cat, $("#itemSearch").value || "");
    $("#itemSelect").focus();
  });
  $("#itemSearch").addEventListener("input", () => {
    const cat = $("#catSelect").value;
    if (!cat) return;
    fillItemsForCategory(cat, $("#itemSearch").value);
  });
  $("#itemSelect").addEventListener("change", (e) => {
    const id = e.target.value;
    const name = e.target.selectedOptions[0]?.getAttribute("data-name") || "";
    $("#id").value = id || "";
    $("#name").value = name;
  });

  await loadAll();

  $("#rows").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const i = +btn.dataset.i;
    const s = await chrome.storage.sync.get("watches");
    const arr = s.watches || [];
    if (btn.dataset.action === "edit") {
      const w = arr[i];
      $("#id").value = w.id;
      $("#name").value = w.name || "";
      $("#max").value = w.maxPrice;
      $("#qty").value = w.minQty;
      const item = CATALOG.find((it) => it.id === Number(w.id));
      if (item) {
        $("#catSelect").value = item.category || "";
        chrome.storage.local.set({ lastCat: item.category || "" });
        fillItemsForCategory(item.category || "", $("#itemSearch").value || "");
        $("#itemSelect").value = String(item.id);
      }
      editIndex = i;
    } else if (btn.dataset.action === "del") {
      arr.splice(i, 1);
      await chrome.storage.sync.set({ watches: arr });
      loadAll();
    }
  });

  $("#add").addEventListener("click", async () => {
    const w = {
      id: +$("#id").value,
      name: $("#name").value.trim(),
      maxPrice: +$("#max").value,
      minQty: +$("#qty").value,
    };
    if (!w.id || !w.maxPrice || !w.minQty)
      return alert("Fill ID, Max price, and Min qty.");
    if (!w.name) {
      const it = CATALOG.find((x) => x.id === w.id);
      if (it) w.name = it.name;
    }
    const s = await chrome.storage.sync.get("watches");
    const arr = s.watches || [];
    if (editIndex != null) {
      arr[editIndex] = w;
      editIndex = null;
    } else {
      arr.push(w);
    }
    await chrome.storage.sync.set({ watches: arr });
    $("#id").value = $("#name").value = $("#max").value = $("#qty").value = "";
    $("#itemSelect").value = "";
    loadAll();
  });

  $("#saveInt").addEventListener("click", async () => {
    const v = Math.max(1, +($("#every").value || 2));
    await chrome.storage.sync.set({ everyMin: v });
    $("#kpi-every").textContent = String(v);
    loadAll();
  });

  $("#saveRetain").addEventListener("click", async () => {
    const minutes = Math.max(1, +($("#retain").value || DEFAULT_RETAIN_MIN));
    await chrome.storage.sync.set({ retainMin: minutes });
    await loadAll(); // this will prune immediately
  });

  $("#checkNow").addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "ping" });
    } catch {}
    try {
      const res = await chrome.runtime.sendMessage({ type: "forcePoll" });
      olog("forcePoll response", res);
      alert("Triggered background check.");
    } catch (e) {
      console.warn("[OPT] sendMessage failed, using alarm fallback:", e);
      chrome.alarms.create("tw3b:poll", { when: Date.now() + 250 });
      alert("Triggered background check (alarm fallback).");
    }
  });

  $("#refreshMatches").addEventListener("click", async () => {
    await loadAll();
  });

  $("#clearMatches").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearMatches" }).catch(() => {});
    await loadAll();
  });

  // Live refresh when background updates storage — with pruning
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && changes.matches) {
      const retain =
        (await chrome.storage.sync.get("retainMin"))?.retainMin ??
        DEFAULT_RETAIN_MIN;
      const next = pruneMatches(changes.matches.newValue || [], retain);
      renderMatches(next);
      // keep storage tidy if pruning removed anything
      if ((changes.matches.newValue || []).length !== next.length) {
        await chrome.storage.local.set({ matches: next });
      }
    }
  });

  // Periodic prune every 60s while Options is open
  setInterval(async () => {
    const [{ retainMin }, { matches }] = await Promise.all([
      chrome.storage.sync.get("retainMin"),
      chrome.storage.local.get("matches"),
    ]);
    const keepMin = retainMin ?? DEFAULT_RETAIN_MIN;
    const pruned = pruneMatches(matches || [], keepMin);
    if ((matches || []).length !== pruned.length) {
      await chrome.storage.local.set({ matches: pruned });
      renderMatches(pruned);
    }
  }, 60_000);
});
