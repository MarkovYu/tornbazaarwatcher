// Runs inside weav3r.dev. Waits out Cloudflare then fetches with cookies.
console.log("[CS] content.js loaded; waiting for CF...");

function cfReadyNow() {
  return (
    !document.querySelector('script[src*="challenge-platform"]') &&
    !document.querySelector('iframe[src*="challenge-platform"]') &&
    !/Just a moment|Checking your browser/i.test(document.title) &&
    document.readyState === "complete"
  );
}
function waitForCF(timeoutMs = 30000) {
  if (cfReadyNow()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (cfReadyNow()) return resolve(true);
      if (performance.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}
async function fetchListings(itemId) {
  const ok = await waitForCF(30000);
  if (!ok) return { ok: false, error: "CF not ready" };
  try {
    const r = await fetch(`/api/bazaar/item/${itemId}`, {
      credentials: "include",
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const arr = await r.json();
    if (!Array.isArray(arr)) return { ok: false, error: "Non-array JSON" };
    return { ok: true, arr };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type === "FETCH_TW3B") {
    console.log("[CS] FETCH_TW3B item", msg.itemId);
    fetchListings(msg.itemId).then((resp) => {
      console.log("[CS] resp", resp?.ok ? `{count:${resp.arr?.length}}` : resp);
      send(resp);
    });
    return true;
  }
});
