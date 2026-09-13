/*
 * Market-data screen.
 *
 * One rule governs everything here: never render a number the API did not
 * return. When the feed is down the screen says so and shows nothing in the
 * price column — it does not show the last value it happened to remember, and
 * it does not show a zero. A dash is information; a stale price pretending to
 * be live is not.
 */

const API = "/api";

const el = {
  body: document.getElementById("overview-body"),
  notice: document.getElementById("notice"),
  feedState: document.getElementById("feed-state"),
  updated: document.getElementById("updated"),
  refresh: document.getElementById("refresh"),
  symbol: document.getElementById("symbol"),
  timeframe: document.getElementById("timeframe"),
  chartWrap: document.getElementById("chart-wrap"),
  chartMeta: document.getElementById("chart-meta"),
};

/** Fetch JSON, turning a structured API error into a real Error. */
async function getJson(path) {
  const response = await fetch(`${API}${path}`, { headers: { Accept: "application/json" } });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${response.status} — the server did not return JSON`);
  }
  if (!response.ok) {
    const err = payload?.error;
    const error = new Error(err?.message || `Request failed (${response.status})`);
    error.code = err?.code;
    throw error;
  }
  return payload;
}

function setNotice(kind, title, body) {
  if (!kind) {
    el.notice.hidden = true;
    el.notice.innerHTML = "";
    return;
  }
  el.notice.hidden = false;
  el.notice.className = `notice ${kind === "warn" ? "warn" : ""}`;
  el.notice.innerHTML = `<h3>${escapeHtml(title)}</h3><div>${body}</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* Prices arrive as strings to preserve precision; format for display only,
   and never parse them back into the value we store or send. */
function fmtPrice(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const decimals = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtCompact(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

function fmtPct(value) {
  if (value === null || value === undefined) return { text: "—", cls: "" };
  const n = Number(value);
  if (!Number.isFinite(n)) return { text: "—", cls: "" };

  // Colour and sign follow what is DISPLAYED, not the underlying value. A
  // change of -0.001% rounds to "0.00" — rendering that as a red "-0.00%"
  // reports a loss the number does not show, which is exactly the kind of
  // small dishonesty that makes a trading screen untrustworthy.
  const shown = n.toFixed(2);
  const rounded = Number(shown);
  if (rounded === 0) return { text: "0.00%", cls: "" };
  return { text: `${rounded > 0 ? "+" : ""}${shown}%`, cls: rounded > 0 ? "up" : "down" };
}

// --- overview --------------------------------------------------------------

async function loadOverview() {
  try {
    const payload = await getJson("/market/overview");
    renderOverview(payload);
    return payload;
  } catch (error) {
    el.feedState.textContent = "FEED DOWN";
    el.feedState.className = "badge badge-bad";
    el.body.innerHTML = `<tr><td colspan="7" class="empty">No market data.</td></tr>`;
    setNotice(
      "bad",
      "Market data is unavailable",
      `${escapeHtml(error.message)}${error.code ? ` <code>(${escapeHtml(error.code)})</code>` : ""}
       <br />No prices are shown, because none could be obtained.`,
    );
    return null;
  }
}

function renderOverview(payload) {
  const { data = [], failures = [], summary = {} } = payload;

  const staleCount = summary.stale ?? 0;

  if (summary.feed_healthy) {
    el.feedState.textContent = "FEED LIVE";
    el.feedState.className = "badge badge-ok";
    setNotice(null);
  } else if (failures.length === 0 && staleCount > 0) {
    // Every symbol answered, but from cache after the providers failed. The
    // prices below are real prices — they are just not current ones, and the
    // screen has to say so rather than let them pass for live.
    el.feedState.textContent = "FEED STALE";
    el.feedState.className = "badge badge-bad";
    setNotice(
      "warn",
      `Showing last known prices for ${staleCount} of ${summary.tracked} symbols`,
      `The market data providers are not responding. These values were real when
       they were fetched, but they are not current. Rows marked
       <span class="tag stale">stale</span> below should not be treated as live.`,
    );
  } else if (data.length > 0) {
    el.feedState.textContent = "FEED PARTIAL";
    el.feedState.className = "badge badge-bad";
    setNotice(
      "warn",
      `${failures.length} of ${summary.tracked} symbols could not be quoted`,
      `The rows below are real. The missing ones are listed as unavailable rather
       than filled in.`,
    );
  } else {
    el.feedState.textContent = "FEED DOWN";
    el.feedState.className = "badge badge-bad";
    setNotice(
      "bad",
      "No symbol could be quoted",
      `Every configured provider failed. The platform reports this instead of
       showing prices it does not have.`,
    );
  }

  const rows = [];

  for (const row of data) {
    const t = row.ticker;
    const meta = row.meta;
    const change = fmtPct(t.change_24h_pct);
    const tags = [];
    if (meta.stale) tags.push('<span class="tag stale">stale</span>');
    if (meta.fallback_used) tags.push('<span class="tag">fallback</span>');

    rows.push(`
      <tr>
        <td class="sym">${escapeHtml(t.symbol)}</td>
        <td class="num price">${fmtPrice(t.price)}</td>
        <td class="num ${change.cls}">${change.text}</td>
        <td class="num price">${fmtPrice(t.high_24h)}</td>
        <td class="num price">${fmtPrice(t.low_24h)}</td>
        <td class="num">${fmtCompact(t.volume_24h)}</td>
        <td>${escapeHtml(meta.source)} ${tags.join(" ")}</td>
      </tr>`);
  }

  for (const failure of failures) {
    rows.push(`
      <tr class="row-failed">
        <td class="sym">${escapeHtml(failure.symbol)}</td>
        <td colspan="6" class="reason">unavailable — ${escapeHtml(failure.code)}</td>
      </tr>`);
  }

  el.body.innerHTML =
    rows.join("") || `<tr><td colspan="7" class="empty">No symbols configured.</td></tr>`;
  el.updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
}

// --- candles ---------------------------------------------------------------

async function loadCandles() {
  const symbol = el.symbol.value;
  const timeframe = el.timeframe.value;
  if (!symbol) return;

  el.chartWrap.innerHTML = `<p class="empty">Loading…</p>`;
  el.chartMeta.textContent = "";

  try {
    const payload = await getJson(
      `/market/${encodeURIComponent(symbol)}/candles?timeframe=${timeframe}&limit=120`,
    );
    const candles = payload.data ?? [];
    if (candles.length === 0) {
      el.chartWrap.innerHTML = `<p class="empty">No candles returned.</p>`;
      return;
    }
    el.chartWrap.innerHTML = renderCandles(candles);
    const m = payload.meta;
    const forming = candles.filter((c) => !c.closed).length;
    el.chartMeta.textContent =
      `${candles.length} bars · ${symbol} ${timeframe} · source ${m.source}` +
      `${m.cached ? " · cached" : ""}${m.stale ? " · STALE" : ""}` +
      `${forming ? ` · ${forming} still forming` : ""}`;
  } catch (error) {
    el.chartWrap.innerHTML =
      `<p class="empty">Unavailable — ${escapeHtml(error.message)}</p>`;
  }
}

/** A dependency-free candlestick chart. */
function renderCandles(candles) {
  const W = 1000;
  const H = 340;
  const pad = { top: 12, right: 60, bottom: 22, left: 8 };

  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  let max = Math.max(...highs);
  let min = Math.min(...lows);
  if (!Number.isFinite(max) || !Number.isFinite(min)) {
    return `<p class="empty">Candle data was not numeric.</p>`;
  }
  // A flat series would divide by zero; give it a nominal band instead.
  if (max === min) { max += 1; min -= 1; }
  const span = max - min;

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const step = plotW / candles.length;
  const bodyW = Math.max(1, Math.min(10, step * 0.62));
  const y = (v) => pad.top + (1 - (Number(v) - min) / span) * plotH;

  const gridlines = [];
  const labels = [];
  for (let i = 0; i <= 4; i++) {
    const value = min + (span * i) / 4;
    const yy = y(value);
    gridlines.push(
      `<line x1="${pad.left}" y1="${yy.toFixed(1)}" x2="${pad.left + plotW}" y2="${yy.toFixed(1)}" stroke="#262d3a" stroke-width="1" />`,
    );
    labels.push(
      `<text x="${pad.left + plotW + 6}" y="${(yy + 3.5).toFixed(1)}" fill="#7d8697" font-size="10" font-family="ui-monospace, monospace">${fmtPrice(value)}</text>`,
    );
  }

  const bars = candles.map((c, i) => {
    const x = pad.left + i * step + step / 2;
    const open = Number(c.open);
    const close = Number(c.close);
    const rising = close >= open;
    const colour = rising ? "#3ecf8e" : "#f2555a";
    const top = y(Math.max(open, close));
    const bottom = y(Math.min(open, close));
    const height = Math.max(1, bottom - top);
    // A bar that has not closed is drawn hollow, so an incomplete candle is
    // never mistaken for a settled one.
    const fill = c.closed ? colour : "none";
    return (
      `<line x1="${x.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${colour}" stroke-width="1" />` +
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${height.toFixed(1)}" fill="${fill}" stroke="${colour}" stroke-width="1" />`
    );
  });

  const first = new Date(candles[0].open_time).toLocaleString();
  const last = new Date(candles[candles.length - 1].open_time).toLocaleString();

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Candlestick chart, ${candles.length} bars from ${first} to ${last}">
    ${gridlines.join("")}
    ${bars.join("")}
    ${labels.join("")}
    <text x="${pad.left}" y="${H - 6}" fill="#7d8697" font-size="10">${escapeHtml(first)}</text>
    <text x="${pad.left + plotW}" y="${H - 6}" fill="#7d8697" font-size="10" text-anchor="end">${escapeHtml(last)}</text>
  </svg>`;
}

// --- boot ------------------------------------------------------------------

async function boot() {
  try {
    const coins = await getJson("/market/symbols");
    el.symbol.innerHTML = coins
      .map((c) => `<option value="${escapeHtml(c.symbol)}">${escapeHtml(c.symbol)}</option>`)
      .join("");
  } catch {
    el.symbol.innerHTML = `<option value="">unavailable</option>`;
  }

  await loadOverview();
  await loadCandles();

  el.refresh.addEventListener("click", async () => {
    await loadOverview();
    await loadCandles();
  });
  el.symbol.addEventListener("change", loadCandles);
  el.timeframe.addEventListener("change", loadCandles);

  // Polling is the Stage 1 mechanism; Stage 7 replaces it with the WebSocket
  // push described in the architecture, at which point this goes away.
  setInterval(loadOverview, 15000);
}

boot();
