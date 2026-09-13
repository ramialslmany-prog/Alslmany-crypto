/*
 * Alslmany paper-trading desk.
 *
 * Two rules run through every function here.
 *
 * Never render a number the API did not return. When the feed is down the
 * screen says so and shows a dash — not the last value it remembers, not a
 * zero. A dash is information; a stale price passing for live is not.
 *
 * Never state a conclusion without its evidence. Every signal card can be
 * expanded into the seven weighted dimensions that produced its score, with
 * the ones that had nothing to say marked unavailable rather than counted as
 * neutral.
 */

const API = "/api";

const el = (id) => document.getElementById(id);
const tooltip = () => el("tooltip");

const state = {
  view: "portfolio",
  symbols: [],
  history: [],
  // Live-feed state. `live` is true only while a socket is actually delivering
  // frames — not merely while one is open — because a socket that connected
  // and then went silent is the case that looks fine and is not.
  live: false,
  lastFrameAt: 0,
  socket: null,
  reconnectDelay: 1000,
};

/* ---------- plumbing ---------- */

async function getJson(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: "application/json" },
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${response.status} — the server did not return JSON`);
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* Prices arrive as strings to preserve precision. Parse for DISPLAY only —
   never parse one back into a value that is sent or stored. */
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPrice(value) {
  const n = num(value);
  if (n === null) return "—";
  const decimals = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtMoney(value) {
  const n = num(value);
  if (n === null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCompact(value) {
  const n = num(value);
  if (n === null) return "—";
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/* Colour and sign follow what is DISPLAYED, never the underlying value.
   A change of -0.001% rounds to "0.00"; rendering that as a red "-0.00%"
   reports a loss the digits do not show. */
function signed(value, suffix = "", decimals = 2) {
  const n = num(value);
  if (n === null) return { text: "—", cls: "" };
  const shown = n.toFixed(decimals);
  const rounded = Number(shown);
  if (rounded === 0) return { text: `${Math.abs(Number(shown)).toFixed(decimals)}${suffix}`, cls: "" };
  return { text: `${rounded > 0 ? "+" : ""}${shown}${suffix}`, cls: rounded > 0 ? "up" : "down" };
}

function setNotice(kind, title, body) {
  const node = el("notice");
  if (!kind) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  node.hidden = false;
  node.className = `notice ${kind === "warn" ? "warn" : ""}`;
  node.innerHTML = `<h3>${esc(title)}</h3><div>${body}</div>`;
}

function showTooltip(event, html) {
  const node = tooltip();
  node.innerHTML = html;
  node.hidden = false;
  const pad = 14;
  const rect = node.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() {
  tooltip().hidden = true;
}

/* ---------- charts ---------- */

/** Equity curve. One series, so the panel title names it and no legend box is needed. */
function renderEquity(points, starting) {
  if (points.length === 0) {
    return `<p class="empty">No closed trades yet. The curve appears once the bot has taken and settled a position.</p>`;
  }

  const W = 1000;
  const H = 260;
  const pad = { top: 14, right: 66, bottom: 26, left: 10 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const values = [starting, ...points.map((p) => num(p.balance))];
  let max = Math.max(...values);
  let min = Math.min(...values);
  if (max === min) { max += 1; min -= 1; }
  const span = max - min;

  const x = (i) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => pad.top + (1 - (v - min) / span) * plotH;

  const grid = [];
  const labels = [];
  for (let i = 0; i <= 4; i++) {
    const value = min + (span * i) / 4;
    const yy = y(value);
    // Solid hairlines, one shade off the surface. Never dashed.
    grid.push(`<line x1="${pad.left}" y1="${yy.toFixed(1)}" x2="${pad.left + plotW}" y2="${yy.toFixed(1)}" stroke="#262d3a" stroke-width="1" />`);
    labels.push(`<text x="${pad.left + plotW + 8}" y="${(yy + 3.5).toFixed(1)}" fill="#7d8697" font-size="10" font-family="ui-monospace, monospace">${fmtCompact(value)}</text>`);
  }

  const startY = y(starting);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(num(p.balance)).toFixed(1)}`).join(" ");
  const last = num(points[points.length - 1].balance);
  const stroke = last >= starting ? "#3ecf8e" : "#f2555a";

  const hits = points.map((p, i) => {
    const balance = num(p.balance);
    const change = balance - starting;
    return `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(balance).toFixed(1)}" r="10" fill="transparent"
      data-tip="${esc(`<div class='t-title'>${new Date(p.at).toLocaleString()}</div><div class='t-value'>Balance ${fmtMoney(balance)}</div><div class='t-value'>${change >= 0 ? "+" : ""}${fmtMoney(change)} from start</div>`)}" />`;
  });

  const dots = points.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(num(p.balance)).toFixed(1)}" r="3" fill="${stroke}" stroke="#141820" stroke-width="2" />`
  );

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Equity curve: balance after each of ${points.length} closed trades, starting from ${fmtMoney(starting)} and ending at ${fmtMoney(last)}.">
    ${grid.join("")}
    <line x1="${pad.left}" y1="${startY.toFixed(1)}" x2="${pad.left + plotW}" y2="${startY.toFixed(1)}" stroke="#f0b429" stroke-width="1" opacity="0.5" />
    <text x="${pad.left + 4}" y="${(startY - 5).toFixed(1)}" fill="#f0b429" font-size="9" opacity="0.8">start ${fmtCompact(starting)}</text>
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" />
    ${dots.join("")}
    ${labels.join("")}
    ${hits.join("")}
  </svg>`;
}

/** Win / loss / breakeven. Status colours, each with a word beside it. */
function renderOutcomes(perf) {
  const total = perf.total_trades;
  if (!total) return `<p class="empty">No closed trades yet.</p>`;

  const rows = [
    { label: "Wins", value: perf.wins, colour: "#3ecf8e" },
    { label: "Losses", value: perf.losses, colour: "#f2555a" },
    { label: "Breakeven", value: perf.breakeven, colour: "#7d8697" },
  ].filter((r) => r.value > 0);

  const W = 480;
  const barH = 26;
  const gap = 10;
  const labelW = 92;
  const valueW = 58;
  const plotW = W - labelW - valueW;
  const max = Math.max(...rows.map((r) => r.value));
  const H = rows.length * (barH + gap);

  const bars = rows.map((r, i) => {
    const w = Math.max(3, (r.value / max) * plotW);
    const y = i * (barH + gap);
    const pct = ((r.value / total) * 100).toFixed(0);
    return `
      <text x="0" y="${y + barH / 2 + 4}" fill="#a4adbd" font-size="12">${r.label}</text>
      <rect class="pt" x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="${barH - 10}" rx="4" fill="${r.colour}"
        data-tip="${esc(`<div class='t-title'>${r.label}</div><div class='t-value'>${r.value} of ${total} · ${pct}%</div>`)}" />
      <text x="${labelW + w + 8}" y="${y + barH / 2 + 4}" fill="#e8ecf2" font-size="12" font-family="ui-monospace, monospace">${r.value}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Outcome distribution: ${rows.map((r) => `${r.value} ${r.label}`).join(", ")} of ${total} closed trades.">${bars.join("")}</svg>`;
}

/** Net result per symbol. Sign is polarity, so the two status hues apply. */
function renderBySymbol(trades) {
  if (trades.length === 0) return `<p class="empty">No closed trades yet.</p>`;

  const totals = new Map();
  for (const t of trades) {
    const pnl = num(t.pnl) ?? 0;
    totals.set(t.symbol, (totals.get(t.symbol) ?? 0) + pnl);
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  const W = 480;
  const barH = 24;
  const gap = 9;
  const labelW = 92;
  const H = rows.length * (barH + gap);
  const plotW = W - labelW - 70;
  const max = Math.max(...rows.map(([, v]) => Math.abs(v)), 1);
  const zero = labelW + plotW / 2;

  const bars = rows.map(([symbol, value], i) => {
    const y = i * (barH + gap);
    const w = Math.max(2, (Math.abs(value) / max) * (plotW / 2));
    const x = value >= 0 ? zero : zero - w;
    const colour = value >= 0 ? "#3ecf8e" : "#f2555a";
    const shown = `${value >= 0 ? "+" : "−"}${fmtMoney(Math.abs(value))}`;
    return `
      <text x="0" y="${y + barH / 2 + 4}" fill="#a4adbd" font-size="11">${esc(symbol)}</text>
      <rect class="pt" x="${x.toFixed(1)}" y="${y + 5}" width="${w.toFixed(1)}" height="${barH - 10}" rx="3" fill="${colour}"
        data-tip="${esc(`<div class='t-title'>${symbol}</div><div class='t-value'>${shown}</div>`)}" />
      <text x="${labelW + plotW + 8}" y="${y + barH / 2 + 4}" fill="${value >= 0 ? "#3ecf8e" : "#f2555a"}" font-size="11" font-family="ui-monospace, monospace">${shown}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net result by symbol across ${trades.length} closed trades.">
    <line x1="${zero}" y1="0" x2="${zero}" y2="${H}" stroke="#262d3a" stroke-width="1" />
    ${bars.join("")}
  </svg>`;
}

/** Dependency-free candlesticks. A forming bar is drawn hollow. */
function renderCandles(candles) {
  const W = 1000;
  const H = 320;
  const pad = { top: 12, right: 62, bottom: 22, left: 8 };

  let max = Math.max(...candles.map((c) => num(c.high)));
  let min = Math.min(...candles.map((c) => num(c.low)));
  if (!Number.isFinite(max) || !Number.isFinite(min)) {
    return `<p class="empty">Candle data was not numeric.</p>`;
  }
  if (max === min) { max += 1; min -= 1; }
  const span = max - min;

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const step = plotW / candles.length;
  const bodyW = Math.max(1, Math.min(10, step * 0.62));
  const y = (v) => pad.top + (1 - (num(v) - min) / span) * plotH;

  const grid = [];
  const labels = [];
  for (let i = 0; i <= 4; i++) {
    const value = min + (span * i) / 4;
    const yy = y(value);
    grid.push(`<line x1="${pad.left}" y1="${yy.toFixed(1)}" x2="${pad.left + plotW}" y2="${yy.toFixed(1)}" stroke="#262d3a" stroke-width="1" />`);
    labels.push(`<text x="${pad.left + plotW + 6}" y="${(yy + 3.5).toFixed(1)}" fill="#7d8697" font-size="10" font-family="ui-monospace, monospace">${fmtPrice(value)}</text>`);
  }

  const bars = candles.map((c, i) => {
    const x = pad.left + i * step + step / 2;
    const open = num(c.open);
    const close = num(c.close);
    const rising = close >= open;
    const colour = rising ? "#3ecf8e" : "#f2555a";
    const top = y(Math.max(open, close));
    const bottom = y(Math.min(open, close));
    const height = Math.max(1, bottom - top);
    const fill = c.closed ? colour : "none";
    const tip = `<div class='t-title'>${new Date(c.open_time).toLocaleString()}${c.closed ? "" : " · forming"}</div>
      <div class='t-value'>O ${fmtPrice(c.open)}</div><div class='t-value'>H ${fmtPrice(c.high)}</div>
      <div class='t-value'>L ${fmtPrice(c.low)}</div><div class='t-value'>C ${fmtPrice(c.close)}</div>`;
    return (
      `<line x1="${x.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${colour}" stroke-width="1" />` +
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${height.toFixed(1)}" fill="${fill}" stroke="${colour}" stroke-width="1" />` +
      `<rect class="pt" x="${(x - step / 2).toFixed(1)}" y="${pad.top}" width="${step.toFixed(1)}" height="${plotH}" fill="transparent" data-tip="${esc(tip)}" />`
    );
  });

  const first = new Date(candles[0].open_time).toLocaleString();
  const last = new Date(candles[candles.length - 1].open_time).toLocaleString();

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Candlestick chart, ${candles.length} bars from ${first} to ${last}.">
    ${grid.join("")}${bars.join("")}${labels.join("")}
    <text x="${pad.left}" y="${H - 6}" fill="#7d8697" font-size="10">${esc(first)}</text>
    <text x="${pad.left + plotW}" y="${H - 6}" fill="#7d8697" font-size="10" text-anchor="end">${esc(last)}</text>
  </svg>`;
}

/** Attach hover to any element carrying data-tip. */
function wireTooltips(root) {
  root.querySelectorAll("[data-tip]").forEach((node) => {
    node.addEventListener("mousemove", (e) => showTooltip(e, node.dataset.tip));
    node.addEventListener("mouseleave", hideTooltip);
  });
}

/* ---------- the evidence table ---------- */

function renderFactors(factors) {
  if (!factors || factors.length === 0) return "";
  const rows = factors.map((f) => {
    const pct = Math.min(Math.abs(f.raw), 1) * 45;
    const positive = f.raw > 0;
    const colour = positive ? "#3ecf8e" : "#f2555a";
    const bar = f.available && f.raw !== 0
      ? `<i style="${positive ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%`};background:${colour}"></i>`
      : "";
    return `<tr class="${f.available ? "" : "unavailable"}">
      <td>${esc(f.dimension.replace(/_/g, " "))}</td>
      <td class="num">${esc(f.weight)}%</td>
      <td class="bar-cell"><span class="bar"><span class="mid"></span>${bar}</span></td>
      <td class="num">${f.available ? f.contribution.toFixed(1) : "n/a"}</td>
    </tr>`;
  });
  return `<table class="factors">
    <thead><tr><th>Dimension</th><th class="num">Weight</th><th>Lean</th><th class="num">Points</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

/* Confidence is shown to one decimal. Rounded to whole numbers, a 74.55 reads
   as "75% conf" on a card whose own reason says "confidence 75 is below the 75
   floor" — the screen contradicting itself in two adjacent lines. */
/** The timeframe above, shown beside the score rather than folded into it.
    A number that was cut has to say so, or the breakdown stops adding up. */
function renderConfluence(ev) {
  const c = ev.confluence;
  if (!c) return "";

  const before = ev.confidence_before_confluence;
  const cut = c.multiplier < 1;

  const label = {
    aligned: "with the trend above",
    against: "against the trend above",
    "strongly-against": "against a strong trend above",
    undecided: "the trend above is undecided",
    unavailable: "not checked",
  }[c.agreement] || c.agreement;

  return `<p class="confluence ${cut ? "cut" : ""}">
    <span class="tag">${esc(c.higher_timeframe || "—")}</span>
    ${esc(label)}${c.higher_trend ? ` · ${esc(c.higher_trend.replace(/_/g, " "))}` : ""}
    ${cut ? `<span class="muted"> — confidence cut from ${esc(before)} to ${esc(Math.round(before * c.multiplier * 100) / 100)}</span>` : ""}
  </p>`;
}

function renderSignalCard(s) {
  const isTrade = s.decision === "TRADE";
  const sideTag = s.signal === "LONG" ? "long" : s.signal === "SHORT" ? "short" : "";
  const ev = s.evidence || {};

  const plan = isTrade
    ? `<dl class="kv-list">
        <div class="kv"><dt>Entry</dt><dd>${fmtPrice(s.entry)}</dd></div>
        <div class="kv"><dt>Stop loss</dt><dd class="down">${fmtPrice(s.stop_loss)}</dd></div>
        <div class="kv"><dt>Take profit</dt><dd class="up">${fmtPrice(s.take_profit)}</dd></div>
        <div class="kv"><dt>Reward / risk</dt><dd>${esc(s.risk_reward ?? "—")}</dd></div>
        <div class="kv"><dt>Risk level</dt><dd>${esc(s.risk_level)}</dd></div>
      </dl>`
    : `<p class="muted" style="margin:0">No entry, stop or target is shown for a NO_TRADE. Publishing levels beside a decision not to trade invites taking it anyway.</p>`;

  const warnings = (s.warnings || []).length
    ? `<ul class="warnings">${s.warnings.map((w) => `<li>${esc(w.replace(/-/g, " "))}</li>`).join("")}</ul>`
    : "";

  return `<article class="card ${isTrade ? "is-trade" : ""}">
    <header class="card-head">
      <span class="sym">${esc(s.symbol)}</span>
      <span>
        ${sideTag ? `<span class="tag ${sideTag}">${esc(s.signal)}</span>` : `<span class="tag">NO TRADE</span>`}
        <span class="tag">${Number(s.confidence).toFixed(1)}% conf</span>
      </span>
    </header>
    <div class="card-body">
      ${plan}
      <p class="card-reason">${esc(s.reason)}</p>
      ${isTrade ? `<p class="muted" style="margin:6px 0 0">Invalidation: ${esc(s.invalidation)}</p>` : ""}
      ${warnings}
      ${renderConfluence(ev)}
      <details class="evidence">
        <summary>Evidence · ${(ev.detected || []).length} patterns detected</summary>
        ${renderFactors(ev.factors)}
        ${(ev.detected || []).length ? `<p class="muted" style="margin-top:8px">Detected: ${esc((ev.detected || []).join(", "))}</p>` : ""}
      </details>
    </div>
  </article>`;
}

function renderPositionCard(t) {
  const pnl = signed(t.unrealised_pnl);
  const r = signed(t.unrealised_r, "R");
  return `<article class="card">
    <header class="card-head">
      <span class="sym">${esc(t.symbol)}</span>
      <span>
        <span class="tag ${t.direction === "LONG" ? "long" : "short"}">${esc(t.direction)}</span>
        <span class="tag">PAPER</span>
      </span>
    </header>
    <div class="card-body">
      <!-- A dl, not loose dt/dd in divs. Outside a list they are invalid and a
           screen reader reads eight labels and eight numbers with nothing
           joining them. -->
      <dl class="kv-list">
        <div class="kv"><dt>Entry</dt><dd>${fmtPrice(t.entry)}</dd></div>
        <div class="kv"><dt>Current</dt><dd>${fmtPrice(t.current_price)}</dd></div>
        <div class="kv"><dt>Stop loss</dt><dd class="down">${fmtPrice(t.stop_loss)}</dd></div>
        <div class="kv"><dt>Take profit</dt><dd class="up">${fmtPrice(t.take_profit)}</dd></div>
        <div class="kv"><dt>Quantity</dt><dd>${esc(t.quantity)}</dd></div>
        <div class="kv"><dt>Risked</dt><dd>${fmtMoney(t.risk_amount)}</dd></div>
        <div class="kv"><dt>Unrealised</dt><dd class="${pnl.cls}">${pnl.text} <span class="muted">(${r.text})</span></dd></div>
        <div class="kv"><dt>Opened</dt><dd>${t.opened_at ? new Date(t.opened_at).toLocaleString() : "—"}</dd></div>
      </dl>
      <p class="card-reason">${esc(t.reason)}</p>
    </div>
  </article>`;
}

/* ---------- views ---------- */

/** A bot that has stopped because nothing qualifies and a bot that has stopped
    because it hit its drawdown limit look identical from outside. Only one of
    them needs a human, so the difference gets the loudest element on the page. */
function renderHalt(halt, lastReset) {
  const node = el("halt");
  if (!halt || !halt.halted) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }

  const manual = halt.blocks.some((b) => b.clears === "manual");
  node.hidden = false;
  node.className = "notice halt";
  node.innerHTML = `
    <h3>The bot has stopped trading</h3>
    <ul>${halt.blocks.map((b) => `<li>
      <strong>${esc(b.limit.replace(/_/g, " "))}</strong> —
      ${esc(b.value)}% against a ${esc(b.threshold)}% limit.
      Clears: ${esc(b.clears)}.<br />
      <span class="muted">${esc(b.explanation)}</span>
    </li>`).join("")}</ul>
    ${lastReset ? `<p class="muted">Last acknowledged ${esc(new Date(lastReset.at).toLocaleString())} at ${fmtMoney(lastReset.baseline_equity)}, after a ${esc(lastReset.drawdown_pct_at_reset)}% drawdown.</p>` : ""}
    ${manual ? `<p><button id="ack-drawdown" type="button" class="primary">Acknowledge and resume</button>
      <span class="muted">Recorded permanently. The previous peak is not restored.</span></p>` : ""}`;

  const button = el("ack-drawdown");
  if (button) button.addEventListener("click", acknowledgeDrawdown);
}

async function acknowledgeDrawdown() {
  const button = el("ack-drawdown");
  button.disabled = true;
  button.textContent = "Recording…";
  try {
    const result = await getJson("/bot/risk/acknowledge-drawdown", { method: "POST" });
    if (!result.acknowledged) {
      setNotice("warn", "Nothing to acknowledge", esc(result.reason));
    }
    await loadPortfolio();
  } catch (error) {
    setNotice("warn", "The acknowledgement was not recorded", esc(error.message));
    button.disabled = false;
    button.textContent = "Acknowledge and resume";
  }
}

/** Five positions at 1% each are a 5% bet when they move together. The
    position count says "5 of 5"; only this says what is actually at stake. */
function renderHeat(heat, limitPct) {
  if (!heat || num(heat.naive_risk) === 0) {
    return `<p class="empty">No open positions, so nothing is concentrated.</p>`;
  }

  const effective = num(heat.effective_pct);
  const limit = num(limitPct) ?? 2.5;
  const concentration = num(heat.concentration) ?? 0;
  const over = effective > limit;

  // The bar is the share of the limit consumed, capped so an over-limit book
  // still renders inside its track rather than overflowing the panel.
  const filled = Math.min((effective / limit) * 100, 100);

  const pair = heat.worst_pair
    ? `<div class="kv"><dt>Most correlated pair</dt><dd>${esc(heat.worst_pair.a)} &amp; ${esc(heat.worst_pair.b)} · ${esc(heat.worst_pair.correlation)}</dd></div>`
    : "";

  const assumed = (heat.assumed_pairs || []).length
    ? `<p class="muted assumed">Not measured, so assumed correlated: ${esc(heat.assumed_pairs.join(", "))}.
       Too little shared history to compute these, and guessing them apart would
       report a concentrated book as a diversified one.</p>`
    : "";

  return `
    <div class="heat-head">
      <div>
        <p class="label">At risk together</p>
        <p class="value ${over ? "down" : ""}">${esc(heat.effective_pct)}%</p>
        <p class="sub">limit ${esc(limitPct)}% · ${fmtMoney(heat.effective_risk)} of the account</p>
      </div>
      <div>
        <p class="label">Sum of the positions</p>
        <p class="value">${fmtMoney(heat.naive_risk)}</p>
        <p class="sub">what they risk if nothing moves together</p>
      </div>
    </div>
    <div class="heat-bar" role="img"
         aria-label="Combined risk ${esc(heat.effective_pct)} percent of the account against a limit of ${esc(limitPct)} percent.">
      <span class="fill ${over ? "over" : ""}" style="width:${filled.toFixed(1)}%"></span>
    </div>
    <dl class="kv-list">
      <div class="kv"><dt>Concentration</dt><dd>${esc(heat.concentration)} ${
        concentration > 0.9 ? "— effectively one position" :
        concentration > 0.6 ? "— partly the same bet" : "— genuinely spread"}</dd></div>
      ${pair}
    </dl>
    ${assumed}`;
}

/** Alerts are configured on the server and nowhere else. This panel reports
    WHETHER they are on — never the token, which never reaches the browser. */
async function loadAlerts() {
  try {
    const config = await getJson("/config");
    const on = config.alerts_configured;
    el("alerts").innerHTML = `
      <p class="alerts-state">
        <span class="tag ${on ? "win" : ""}">${on ? "CONFIGURED" : "OFF"}</span>
        ${on
          ? "Open, close and halt notifications are sent to the configured chat."
          : "Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> on the server to turn these on. Nothing else is affected."}
      </p>
      <p class="muted">
        The bot only sends. It reads no messages and accepts no commands, so a
        stolen token leaks the fact that a paper position opened — and nothing else.
      </p>
      ${on ? `<p><button id="test-alert" type="button" class="primary">Send a test message</button>
        <span id="alert-result" class="muted"></span></p>` : ""}`;

    const button = el("test-alert");
    if (button) button.addEventListener("click", sendTestAlert);
  } catch (error) {
    el("alerts").innerHTML = `<p class="empty">Unavailable — ${esc(error.message)}</p>`;
  }
}

async function sendTestAlert() {
  const button = el("test-alert");
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const result = await getJson("/bot/alerts/test", { method: "POST" });
    el("alert-result").textContent = result.sent
      ? "Sent."
      : `Not sent — ${result.reason || "Telegram refused it."}`;
  } catch (error) {
    el("alert-result").textContent = `Failed — ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "Send a test message";
  }
}

async function loadPortfolio() {
  try {
    const [p, curve, hist] = await Promise.all([
      getJson("/bot/portfolio"),
      getJson("/bot/equity-curve"),
      getJson("/bot/trades/history?limit=500"),
    ]);

    const perf = p.performance;
    const pnl = signed(perf.total_pnl);
    const today = signed(p.realised_today);

    el("tiles").innerHTML = [
      { label: "Balance", value: fmtMoney(p.balance), sub: `started at ${fmtMoney(p.starting_balance)}` },
      { label: "Equity", value: fmtMoney(p.equity), sub: `${p.open_positions} open` },
      { label: "Total P/L", value: pnl.text, cls: pnl.cls, sub: `${perf.total_trades} trades` },
      { label: "Today", value: today.text, cls: today.cls, sub: `limit ${esc(p.limits.max_daily_loss_pct)}%` },
      { label: "Win rate", value: `${perf.win_rate}%`, sub: `${perf.wins}W / ${perf.losses}L` },
      { label: "Profit factor", value: perf.profit_factor ?? "—", sub: perf.profit_factor ? "gross win ÷ gross loss" : "no losses yet" },
      { label: "Expectancy", value: `${perf.expectancy_r}R`, sub: "per trade, in R" },
      { label: "Max drawdown", value: `${perf.max_drawdown_pct}%`, sub: `limit ${esc(p.limits.max_drawdown_pct)}%` },
    ].map((t) => `<div class="tile">
        <p class="label">${esc(t.label)}</p>
        <p class="value ${t.cls || ""}">${esc(t.value)}</p>
        <p class="sub">${esc(t.sub)}</p>
      </div>`).join("");

    renderHalt(p.halt, p.last_drawdown_reset);
    el("heat").innerHTML = renderHeat(p.heat, p.limits.max_portfolio_heat_pct);
    loadAlerts();
    el("equity").innerHTML = renderEquity(curve.data, num(curve.starting_balance));
    el("outcomes").innerHTML = renderOutcomes(perf);
    state.history = hist.data;
    el("by-symbol").innerHTML = renderBySymbol(hist.data);

    el("limits").innerHTML = [
      ["Risk per trade", `${esc(p.limits.risk_per_trade_pct)}%`],
      ["Max open trades", p.limits.max_open_trades],
      ["Max daily loss", `${esc(p.limits.max_daily_loss_pct)}%`],
      ["Max drawdown", `${esc(p.limits.max_drawdown_pct)}%`],
      ["Max combined risk", `${esc(p.limits.max_portfolio_heat_pct)}%`],
      ["Longest losing streak", perf.longest_losing_streak],
      ["Fees paid", fmtMoney(perf.total_fees)],
    ].map(([label, value]) => `<div><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`).join("");

    wireTooltips(document.querySelector('[data-view="portfolio"]'));
  } catch (error) {
    el("tiles").innerHTML = `<p class="empty">Portfolio unavailable — ${esc(error.message)}</p>`;
  }
}

async function loadSignals() {
  const timeframe = el("sig-tf").value;
  el("signals").innerHTML = `<p class="empty">Scanning…</p>`;
  try {
    const payload = await getJson(`/signals?timeframe=${timeframe}`);
    const cards = payload.data.map(renderSignalCard);
    const failed = payload.failures.map((f) =>
      `<article class="card"><header class="card-head"><span class="sym">${esc(f.symbol)}</span>
        <span class="tag stale">unavailable</span></header>
        <div class="card-body"><p class="reason">${esc(f.code)}</p></div></article>`);
    el("signals").innerHTML = [...cards, ...failed].join("") || `<p class="empty">No symbols configured.</p>`;
  } catch (error) {
    el("signals").innerHTML = `<p class="empty">Signals unavailable — ${esc(error.message)}</p>`;
  }
}

async function runTick() {
  const button = el("run-tick");
  button.disabled = true;
  button.textContent = "Running…";
  try {
    const report = await getJson(`/bot/tick?timeframe=${el("sig-tf").value}`, { method: "POST" });
    const rejected = report.rejected.map((r) =>
      `<li><strong>${esc(r.symbol)}</strong> — ${esc((r.reasons || []).join(", "))}${
        r.notes?.length ? `<br><span class="muted">${esc(r.notes.join(" "))}</span>` : ""}</li>`);

    el("tick-body").innerHTML = `
      <p>Scanned ${report.scanned.length} symbols.
         Opened <strong>${report.opened.length}</strong>, closed <strong>${report.closed.length}</strong>.</p>
      ${report.opened.length ? `<p class="up">Opened: ${esc(report.opened.join(", "))}</p>` : ""}
      ${report.closed.length ? `<p>Closed: ${report.closed.map((c) => `${esc(c.symbol)} ${esc(c.result)} ${esc(c.pnl)} (${esc(c.r)}R)`).join(", ")}</p>` : ""}
      ${rejected.length ? `<p class="muted">Declined, with reasons:</p><ul>${rejected.join("")}</ul>` : ""}
      ${report.errors.length ? `<p class="reason">Errors: ${report.errors.map((e) => `${esc(e.symbol)} (${esc(e.code)})`).join(", ")}</p>` : ""}`;
    el("tick-report").hidden = false;

    await Promise.all([loadSignals(), loadPortfolio()]);
  } catch (error) {
    el("tick-body").innerHTML = `<p class="reason">Tick failed — ${esc(error.message)}</p>`;
    el("tick-report").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Run bot tick";
  }
}

async function loadPositions() {
  try {
    const payload = await getJson("/bot/trades/open");
    el("positions").innerHTML = payload.data.length
      ? payload.data.map(renderPositionCard).join("")
      : `<p class="empty">No open positions.</p>`;
  } catch (error) {
    el("positions").innerHTML = `<p class="empty">Unavailable — ${esc(error.message)}</p>`;
  }
}

async function loadHistory() {
  const params = new URLSearchParams();
  for (const [key, id] of [["symbol", "f-symbol"], ["direction", "f-direction"], ["result", "f-result"]]) {
    const value = el(id).value;
    if (value) params.set(key, value);
  }
  try {
    const payload = await getJson(`/bot/trades/history?${params}`);
    el("history-body").innerHTML = payload.data.length
      ? payload.data.map((t) => {
          const pnl = signed(t.pnl);
          const r = signed(t.r_multiple, "R");
          return `<tr>
            <td class="sym">${esc(t.symbol)}</td>
            <td><span class="tag ${t.direction === "LONG" ? "long" : "short"}">${esc(t.direction)}</span></td>
            <td class="num price">${fmtPrice(t.entry)}</td>
            <td class="num price">${fmtPrice(t.exit_price)}</td>
            <td class="num ${pnl.cls}">${pnl.text}</td>
            <td class="num ${r.cls}">${r.text}</td>
            <td><span class="tag ${t.result === "WIN" ? "win" : t.result === "LOSS" ? "loss" : ""}">${esc(t.result || "—")}</span></td>
            <td class="muted">${esc((t.exit_reason || "").replace(/_/g, " "))}</td>
            <td class="num">${Number(t.confidence).toFixed(0)}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="9" class="empty">No trades match these filters.</td></tr>`;
  } catch (error) {
    el("history-body").innerHTML = `<tr><td colspan="9" class="empty">Unavailable — ${esc(error.message)}</td></tr>`;
  }
}

async function loadOverview() {
  try {
    const payload = await getJson("/market/overview");
    const { data = [], failures = [], summary = {} } = payload;
    const staleCount = summary.stale ?? 0;

    if (summary.feed_healthy) {
      el("feed-state").textContent = "FEED LIVE";
      el("feed-state").className = "badge badge-ok";
      setNotice(null);
    } else if (failures.length === 0 && staleCount > 0) {
      el("feed-state").textContent = "FEED STALE";
      el("feed-state").className = "badge badge-bad";
      setNotice("warn", `Showing last known prices for ${staleCount} of ${summary.tracked} symbols`,
        `The providers are not responding. These values were real when they were fetched, but they are not current.`);
    } else {
      el("feed-state").textContent = data.length ? "FEED PARTIAL" : "FEED DOWN";
      el("feed-state").className = "badge badge-bad";
      setNotice("bad", data.length ? `${failures.length} of ${summary.tracked} symbols could not be quoted` : "No symbol could be quoted",
        `Missing symbols are listed as unavailable rather than filled in.`);
    }

    const rows = data.map((row) => {
      const t = row.ticker;
      const change = signed(t.change_24h_pct, "%");
      const tags = [];
      if (row.meta.stale) tags.push('<span class="tag stale">stale</span>');
      if (row.meta.fallback_used) tags.push('<span class="tag">fallback</span>');
      // The symbol and field hooks let the live feed update a row in place.
      // Rebuilding the table on every tick would destroy focus and scroll
      // position several times a minute.
      return `<tr data-symbol="${esc(t.symbol)}">
        <td class="sym">${esc(t.symbol)}</td>
        <td class="num price" data-field="price">${fmtPrice(t.price)}</td>
        <td class="num ${change.cls}" data-field="change">${change.text}</td>
        <td class="num price">${fmtPrice(t.high_24h)}</td>
        <td class="num price">${fmtPrice(t.low_24h)}</td>
        <td class="num">${fmtCompact(t.volume_24h)}</td>
        <td>${esc(row.meta.source)} ${tags.join(" ")}</td>
      </tr>`;
    });

    for (const f of failures) {
      rows.push(`<tr class="row-failed"><td class="sym">${esc(f.symbol)}</td>
        <td colspan="6" class="reason">unavailable — ${esc(f.code)}</td></tr>`);
    }

    el("overview-body").innerHTML = rows.join("") || `<tr><td colspan="7" class="empty">No symbols configured.</td></tr>`;
    el("updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    el("feed-state").textContent = "FEED DOWN";
    el("feed-state").className = "badge badge-bad";
    el("overview-body").innerHTML = `<tr><td colspan="7" class="empty">No market data.</td></tr>`;
    setNotice("bad", "Market data is unavailable",
      `${esc(error.message)}<br />No prices are shown, because none could be obtained.`);
  }
}

async function loadCandles() {
  const symbol = el("symbol").value;
  const timeframe = el("timeframe").value;
  if (!symbol) return;

  el("chart-wrap").innerHTML = `<p class="empty">Loading…</p>`;
  el("chart-meta").textContent = "";
  try {
    const payload = await getJson(`/market/${encodeURIComponent(symbol)}/candles?timeframe=${timeframe}&limit=120`);
    const candles = payload.data ?? [];
    if (candles.length === 0) {
      el("chart-wrap").innerHTML = `<p class="empty">No candles returned.</p>`;
      return;
    }
    el("chart-wrap").innerHTML = renderCandles(candles);
    wireTooltips(el("chart-wrap"));
    const m = payload.meta;
    const forming = candles.filter((c) => !c.closed).length;
    el("chart-meta").textContent =
      `${candles.length} bars · ${symbol} ${timeframe} · source ${m.source}` +
      `${m.cached ? " · cached" : ""}${m.stale ? " · STALE" : ""}${forming ? ` · ${forming} still forming` : ""}`;
  } catch (error) {
    el("chart-wrap").innerHTML = `<p class="empty">Unavailable — ${esc(error.message)}</p>`;
  }
}

/* ---------- analytics ---------- */

const STRENGTH_LABEL = {
  insufficient: "not enough data",
  suggestive: "suggestive",
  supported: "supported",
};

async function loadAnalytics() {
  await Promise.all([loadInsights(), loadBreakdown(), loadBenchmark()]);
}

async function loadInsights() {
  try {
    const payload = await getJson("/analytics/insights");
    el("insights").innerHTML = payload.data.map((o) => `
      <article class="insight insight-${esc(o.strength)}">
        <header>
          <span class="tag">${esc(o.topic)}</span>
          <span class="tag strength">${esc(STRENGTH_LABEL[o.strength] || o.strength)}</span>
          <span class="muted">n = ${esc(o.sample)}</span>
        </header>
        <p class="finding">${esc(o.finding)}</p>
        <p class="muted">${esc(o.evidence)}</p>
        <p class="consider"><strong>Consider:</strong> ${esc(o.consider)}</p>
        <p class="muted applied">Applied automatically: <strong>no</strong>. ${esc(o.requires)}</p>
      </article>`).join("");
  } catch (error) {
    el("insights").innerHTML = `<p class="empty">Unavailable — ${esc(error.message)}</p>`;
  }
}

/** A win rate without its sample size is a number pretending to be evidence,
    so the interval and the count travel with it in every row. */
async function loadBreakdown() {
  const by = el("an-by").value;
  try {
    const payload = await getJson(`/analytics/breakdown?by=${by}`);
    el("an-floor").textContent =
      `${payload.total_closed} closed trades. A group needs ${payload.min_sample} ` +
      `before it is ranked; smaller groups are still shown, set in italic and ` +
      `marked THIN, because hiding them would distort the picture as surely ` +
      `as ranking them would.`;

    el("an-body").innerHTML = payload.data.length
      ? payload.data.map((g) => {
          const p = g.performance;
          const exp = signed(p.expectancy_r, "R");
          const tot = signed(p.total_r, "R");
          const pnl = signed(p.total_pnl);
          const ci = g.win_rate_ci
            ? `${g.win_rate_ci[0]}–${g.win_rate_ci[1]}%`
            : "—";
          return `<tr class="${g.reliable ? "" : "thin"}" ${g.note ? `title="${esc(g.note)}"` : ""}>
            <td class="sym">${esc(g.key)}${g.reliable ? "" : ` <span class="tag thin-tag">thin</span>`}</td>
            <td class="num">${esc(p.total_trades)}</td>
            <td class="num">${esc(g.share_pct)}%</td>
            <td class="num">${g.win_rate_ci ? `${esc(p.win_rate)}%` : "—"}</td>
            <td class="muted">${esc(ci)}</td>
            <td class="num ${exp.cls}">${exp.text}</td>
            <td class="num ${tot.cls}">${tot.text}</td>
            <td class="num ${pnl.cls}">${pnl.text}</td>
            <td class="num">${esc(p.profit_factor ?? "—")}</td>
          </tr>` + (g.note ? `<tr class="note-row"><td colspan="9" class="muted">${esc(g.note)}</td></tr>` : "");
        }).join("")
      : `<tr><td colspan="9" class="empty">No closed trades yet.</td></tr>`;
  } catch (error) {
    el("an-body").innerHTML = `<tr><td colspan="9" class="empty">Unavailable — ${esc(error.message)}</td></tr>`;
  }
}

/** Holding is the benchmark that decides whether any of this was worth doing.
    The two percentages have different denominators, so they sit side by side
    and are never subtracted into a single flattering number. */
async function loadBenchmark() {
  try {
    const payload = await getJson("/analytics/benchmark");
    el("bench-note").textContent = payload.denominator_note;

    const rows = payload.data.map((b) => {
      const hold = signed(b.hold_return_pct, "%");
      const pnl = signed(b.strategy_pnl);
      const acct = signed(b.strategy_return_pct, "%");
      const window = `${new Date(b.window.from).toLocaleDateString()} → ${new Date(b.window.to).toLocaleDateString()}`;
      return `<tr>
        <td class="sym">${esc(b.symbol)}</td>
        <td class="num">${esc(b.trades)}</td>
        <td class="muted">${esc(window)}</td>
        <td class="num ${hold.cls}">${b.hold_return_pct === null ? "—" : hold.text}</td>
        <td class="num ${pnl.cls}">${pnl.text}</td>
        <td class="num ${acct.cls}">${acct.text}</td>
      </tr>` + (b.note ? `<tr class="note-row"><td colspan="6" class="muted">${esc(b.note)}</td></tr>` : "");
    });

    const failed = (payload.failures || []).map((f) =>
      `<tr class="note-row"><td colspan="6" class="muted">${esc(f.symbol)} — price history unavailable (${esc(f.code)}), so no comparison is shown.</td></tr>`);

    el("benchmark-body").innerHTML = [...rows, ...failed].join("")
      || `<tr><td colspan="6" class="empty">No closed trades to compare yet.</td></tr>`;
  } catch (error) {
    el("benchmark-body").innerHTML = `<tr><td colspan="6" class="empty">Unavailable — ${esc(error.message)}</td></tr>`;
  }
}

/* ---------- backtest ---------- */

/** The replay is expensive, so it runs on request and never on tab open. */
async function runBacktest() {
  const scope = el("bt-scope").value;
  const symbol = el("bt-symbol").value;
  const timeframe = el("bt-tf").value;
  const bars = el("bt-bars").value;
  if (scope === "symbol" && !symbol) return;

  const button = el("run-backtest");
  button.disabled = true;
  button.textContent = "Replaying…";
  el("bt-status").hidden = false;
  el("bt-status").className = "notice info";
  el("bt-status").innerHTML = `<strong>Replaying ${
    scope === "portfolio" ? "the whole portfolio" : esc(symbol)
  } ${esc(timeframe)} over ${esc(bars)} bars…</strong>`;

  try {
    const path = scope === "portfolio"
      ? `/backtest?timeframe=${timeframe}&bars=${bars}`
      : `/backtest/${encodeURIComponent(symbol)}?timeframe=${timeframe}&bars=${bars}`;
    const r = await getJson(path);
    renderBacktest(r);
  } catch (error) {
    el("bt-results").hidden = true;
    el("bt-status").className = "notice bad";
    el("bt-status").innerHTML = `<strong>The replay could not run</strong><br />${esc(error.message)}`;
  } finally {
    button.disabled = false;
    button.textContent = "Run replay";
  }
}

function renderBacktest(r) {
  const portfolio = r.kind === "PORTFOLIO_BACKTEST";
  const perf = r.performance;
  const ret = signed(r.total_return_pct, "%");
  const hold = signed(r.buy_and_hold_pct, "%");
  const beat = num(r.total_return_pct) - num(r.buy_and_hold_pct);
  const vs = signed(beat, "%");

  // The status line carries the caveats FIRST. A caveat printed under a
  // headline number has already been outranked by it.
  const caveats = (r.caveats || []).map((c) => `<li>${esc(c)}</li>`).join("");
  el("bt-status").className = caveats ? "notice warn" : "notice info";
  el("bt-status").innerHTML =
    `<strong>Simulated result — ${
      portfolio ? `${r.symbols.length} symbols on one account` : esc(r.symbol)
    } ${esc(r.timeframe)}</strong><br />` +
    (portfolio
      ? `${esc(r.bars_replayed)} bars replayed across ${esc(r.symbols.join(", "))} · ` +
        `${esc(r.signals_generated)} qualified · ${esc(perf.total_trades)} trades · ` +
        `peak ${esc(r.peak_open_positions)} open at once`
      : `${esc(r.meta.bars_received)} bars received of ${esc(r.meta.bars_requested)} asked for · ` +
        `${esc(r.bars_analysed)} reached the analyser · ${esc(r.signals_generated)} qualified · ` +
        `${esc(perf.total_trades)} trades taken · source ${esc(r.meta.source)}`) +
    (caveats ? `<ul>${caveats}</ul>` : "");

  el("bt-tiles").innerHTML = [
    { label: "Strategy return", value: ret.text, cls: ret.cls, sub: `from ${fmtMoney(r.starting_balance)} · risk ${r.risk_pct}%/trade` },
    { label: "Buy and hold", value: hold.text, cls: hold.cls,
      sub: portfolio ? "equal-weight basket, same window" : "same window, no trading" },
    { label: "Versus holding", value: vs.text, cls: vs.cls, sub: beat >= 0 ? "the strategy added this" : "holding would have won" },
    { label: "Trades", value: perf.total_trades, sub: `${perf.wins}W / ${perf.losses}L` },
    { label: "Win rate", value: `${perf.win_rate}%`, sub: `longest losing streak ${perf.longest_losing_streak}` },
    { label: "Profit factor", value: perf.profit_factor ?? "—", sub: perf.profit_factor ? "gross win ÷ gross loss" : "no losses recorded" },
    { label: "Expectancy", value: `${perf.expectancy_r}R`, sub: "per trade, in R" },
    { label: "Max drawdown", value: `${perf.max_drawdown_pct}%`, sub: `fees paid ${fmtMoney(perf.total_fees)}` },
  ].map((t) => `<div class="tile">
      <p class="label">${t.label}</p>
      <p class="value ${t.cls || ""}">${esc(t.value)}</p>
      <p class="sub">${esc(t.sub)}</p>
    </div>`).join("");

  el("bt-equity").innerHTML = renderEquity(r.equity, num(r.starting_balance));
  wireTooltips(el("bt-equity"));

  el("bt-count").textContent = `${r.trades.length} closed`;
  // The symbol column only earns its place when there is more than one symbol.
  document.querySelectorAll("#bt-trades .symbol-col").forEach((cell) => {
    cell.hidden = !portfolio;
  });
  el("bt-trades-body").innerHTML = r.trades.length
    ? r.trades.map((t) => {
        const pnl = signed(t.pnl);
        const rr = signed(t.r_multiple, "R");
        return `<tr>
          <td class="muted">${t.opened_at ? esc(new Date(t.opened_at).toLocaleString()) : "—"}</td>
          <td class="sym symbol-col" ${portfolio ? "" : "hidden"}>${esc(t.symbol || "—")}</td>
          <td><span class="tag ${t.direction === "LONG" ? "long" : "short"}">${esc(t.direction)}</span></td>
          <td class="num price">${fmtPrice(t.entry)}</td>
          <td class="num price">${fmtPrice(t.exit)}</td>
          <td class="num ${pnl.cls}">${pnl.text}</td>
          <td class="num ${rr.cls}">${rr.text}</td>
          <td><span class="tag ${t.result === "WIN" ? "win" : t.result === "LOSS" ? "loss" : ""}">${esc(t.result || "—")}</span></td>
          <td class="muted">${esc((t.exit_reason || "").replace(/_/g, " "))}</td>
          <td class="num">${Number(t.confidence).toFixed(0)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="10" class="empty">The strategy took no trade in this window. That is a result, not a failure — it declined every setup on offer.</td></tr>`;

  renderRefusals(portfolio ? r.refusals : null);
  el("bt-results").hidden = false;
}

/** Why the replay declined. "The bot did not trade" means two completely
    different things, and only one of them is a portfolio effect. */
function renderRefusals(refusals) {
  const node = el("bt-refusals");
  if (!refusals || !Object.keys(refusals).length) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }

  // Setup-level first, then the ones the account imposed — the second group is
  // what a single-symbol replay can never show you.
  const ACCOUNT = new Set([
    "portfolio_heat", "duplicate_position", "max_open_trades",
    "daily_loss_limit", "drawdown_limit", "insufficient_balance",
  ]);
  const rows = Object.entries(refusals).sort((a, b) => b[1] - a[1]);

  node.hidden = false;
  node.innerHTML = `
    <h3>Why it declined</h3>
    <ul>${rows.map(([reason, count]) => `<li>
      <span class="tag ${ACCOUNT.has(reason) ? "account" : ""}">${
        ACCOUNT.has(reason) ? "account" : "setup"}</span>
      <strong>${esc(count)}</strong> ${esc(reason.replace(/_/g, " "))}
    </li>`).join("")}</ul>
    <p class="muted">A setup refusal means nothing qualified. An account refusal
    means the trade was good enough and the book would not carry it — which is
    the only thing a single-symbol replay can never tell you.</p>`;
}

/* ---------- live feed ---------- */

// Polling stays as the fallback, and the two must never run together: a socket
// delivering every five seconds plus a poll every twenty is upstream load for
// no added freshness.
const POLL_MS = 20000;
// A socket that has delivered nothing for this long is treated as dead even if
// the browser still calls it open — half-open TCP connections are the normal
// way a live feed lies about being alive.
const SILENCE_MS = 20000;
const MAX_RECONNECT_MS = 30000;

function connectLive() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
  } catch {
    return; // the polling fallback is already running
  }
  state.socket = socket;

  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    state.live = true;
    state.lastFrameAt = Date.now();
    state.reconnectDelay = 1000;
    applyLiveFrame(frame);
  });

  socket.addEventListener("close", () => {
    state.live = false;
    state.socket = null;
    // Exponential backoff with a ceiling. A tab left open on a dead server
    // should not hammer it, and should still recover on its own when it
    // returns.
    setTimeout(connectLive, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_MS);
  });

  socket.addEventListener("error", () => socket.close());
}

function applyLiveFrame(frame) {
  if (frame.kind === "error") {
    el("feed-state").textContent = "FEED DOWN";
    el("feed-state").className = "badge badge-bad";
    return;
  }
  if (frame.kind !== "tick") return;

  const stale = frame.prices.filter((p) => p.stale).length;
  const down = (frame.unavailable || []).length;

  if (frame.feed_healthy) {
    el("feed-state").textContent = "LIVE";
    el("feed-state").className = "badge badge-ok";
    setNotice(null);
  } else if (frame.prices.length) {
    el("feed-state").textContent = stale ? "LIVE · STALE" : "LIVE · PARTIAL";
    el("feed-state").className = "badge badge-bad";
  } else {
    el("feed-state").textContent = "FEED DOWN";
    el("feed-state").className = "badge badge-bad";
  }
  if (down) {
    setNotice("warn", `${down} of ${down + frame.prices.length} symbols unavailable`,
      frame.unavailable.map((u) => `${esc(u.symbol)} (${esc(u.code)})`).join(", ") +
      "<br />No price is shown for these, because none could be obtained.");
  }

  // Prices are written into the rows already on screen rather than rebuilding
  // the table: re-rendering on every tick would destroy focus and scroll
  // position five times a minute.
  for (const quote of frame.prices) {
    const row = document.querySelector(`#overview-body tr[data-symbol="${CSS.escape(quote.symbol)}"]`);
    if (!row) continue;
    const cell = row.querySelector("[data-field=price]");
    if (cell) cell.textContent = fmtPrice(quote.price);
    const change = row.querySelector("[data-field=change]");
    if (change) {
      const moved = signed(quote.change_24h_pct, "%");
      change.textContent = moved.text;
      change.className = `num ${moved.cls}`;
    }
  }

  el("updated").textContent = `updated ${new Date(frame.at).toLocaleTimeString()}`;

  const account = frame.account;
  if (account && state.view === "portfolio") {
    renderHalt(account.halt, null);
  }
}

/** The fallback. It runs only while the socket is NOT delivering, so the two
    never double up on the same upstream. */
function startPollingFallback() {
  setInterval(() => {
    const silent = Date.now() - state.lastFrameAt > SILENCE_MS;
    if (state.live && !silent) return;
    state.live = false;

    loadOverview();
    if (state.view === "portfolio") loadPortfolio();
    if (state.view === "positions") loadPositions();
  }, POLL_MS);
}

/* ---------- routing ---------- */

const LOADERS = {
  portfolio: loadPortfolio,
  signals: loadSignals,
  positions: loadPositions,
  history: loadHistory,
  market: async () => { await loadOverview(); await loadCandles(); },
  analytics: loadAnalytics,
  // Deliberately absent: a replay costs real CPU and must be asked for.
  backtest: () => {},
};

function show(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.view === view);
  });
  LOADERS[view]?.();
}

async function boot() {
  try {
    const coins = await getJson("/market/symbols");
    state.symbols = coins.map((c) => c.symbol);
    const options = state.symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    el("symbol").innerHTML = options;
    el("f-symbol").innerHTML = `<option value="">All symbols</option>${options}`;
    el("bt-symbol").innerHTML = options;
  } catch {
    el("symbol").innerHTML = `<option value="">unavailable</option>`;
    el("bt-symbol").innerHTML = `<option value="">unavailable</option>`;
  }

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => show(tab.dataset.view)));

  el("run-tick").addEventListener("click", runTick);
  el("run-backtest").addEventListener("click", runBacktest);
  el("bt-scope").addEventListener("change", () => {
    el("bt-symbol").disabled = el("bt-scope").value === "portfolio";
  });
  el("an-by").addEventListener("change", loadBreakdown);
  el("sig-tf").addEventListener("change", loadSignals);
  el("symbol").addEventListener("change", loadCandles);
  el("timeframe").addEventListener("change", loadCandles);
  for (const id of ["f-symbol", "f-direction", "f-result"]) {
    el(id).addEventListener("change", loadHistory);
  }

  await loadOverview();   // the feed badge should be right from the first paint
  show("portfolio");

  connectLive();
  startPollingFallback();
}

boot();
