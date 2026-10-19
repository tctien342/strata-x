// Model settings for the deployed terminal app, using the existing /config contract.
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[c]);
  let keys = [];
  const headers = json => {
    const h = json ? {"Content-Type":"application/json"} : {};
    const key = $("api-key").value.trim();
    if (key) h.Authorization = "Bearer " + key;
    return h;
  };
  async function load() {
    try {
      const r = await fetch("config", {headers:headers(false)});
      if (!r.ok) { $("cfg-card").hidden = true; return; }
      const cfg = await r.json(); keys = cfg.keys || [];
      $("cfg-file").textContent = cfg.file || "";
      $("cfg-form").innerHTML = keys.map((k, i) => {
        const id = `cfg-${i}`, value = k.value;
        let input;
        if (k.kind === "bool" || k.kind === "enum") {
          const opts = k.kind === "bool" ? [["true","on"],["false","off"]] : k.choices.map(x => [x,x]);
          const current = value == null ? "" : String(value);
          input = `<select class="st-input" id="${id}"><option value=""${current === "" ? " selected" : ""}>default</option>` +
            opts.map(([v,t]) => `<option value="${esc(v)}"${current === v ? " selected" : ""}>${esc(t)}</option>`).join("") + "</select>";
        } else {
          const text = Array.isArray(value) ? value.join(", ") : value;
          input = `<input class="st-input" id="${id}" ${k.kind === "number" ? `type="number" min="0" step="${k.key === "conversation_cache_mib" ? "1" : "any"}"` : 'type="text"'} value="${esc(text)}" placeholder="default" autocomplete="off">`;
        }
        return `<label for="${id}" title="${esc(k.help)}">${esc(k.help)}<code>${esc(k.key)}</code></label>${input}`;
      }).join("");
      $("cfg-card").hidden = false;
    } catch (e) { $("cfg-msg").textContent = "Settings unavailable: " + e.message; }
  }
  $("cfg-save").addEventListener("click", async () => {
    const set = {};
    keys.forEach((k, i) => {
      const text = $(`cfg-${i}`).value.trim();
      const value = text === "" ? null : k.kind === "bool" ? text === "true" : k.kind === "number" ? Number(text) : text;
      const old = Array.isArray(k.value) ? k.value.join(", ") : k.value;
      if (JSON.stringify(value) !== JSON.stringify(old ?? null)) set[k.key] = value;
    });
    if (!Object.keys(set).length) { $("cfg-msg").textContent = "Nothing changed."; return; }
    try {
      const r = await fetch("config", {method:"POST", headers:headers(true), body:JSON.stringify({set})});
      const result = await r.json();
      if (!r.ok) throw new Error(result.error?.message || `HTTP ${r.status}`);
      $("cfg-msg").textContent = "Saved. Restart the server to apply these settings.";
      await load();
    } catch (e) { $("cfg-msg").textContent = "Not saved: " + e.message; }
  });
  $("tab-btn-about").addEventListener("click", load);
  $("api-key").addEventListener("change", load);
  window.addEventListener("hashchange", () => { if (location.hash === "#about") load(); });
  if (location.hash === "#about") load();
})();
