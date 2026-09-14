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

/* Arabic is the default and English is a choice; i18n.js owns both and is
   loaded first. Destructured once here so every call site reads `t("key")`
   rather than a three-part path. */
const { t, term, isRTL } = window.I18N;

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
    throw new Error(t("common.notJson", { status: response.status }));
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || t("common.requestFailed", { status: response.status }));
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

/* Dates and times, in one format in both languages.

   `toLocaleString()` with no locale follows the browser, which put "12:03:28 AM"
   inside an otherwise Arabic page — and, on an Arabic browser, would put
   Arabic-Indic digits into a timestamp beside Western-digit prices.

   So: a fixed 24-hour clock, Latin digits, Gregorian calendar. The hour format
   is not only a translation question — AM/PM is ambiguous on a screen where
   sessions and funding windows are quoted in 24-hour time everywhere else. */
const DATE_LOCALE = "en-GB";

function fmtTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? "—" : d.toLocaleTimeString(DATE_LOCALE, { hour12: false });
}

function fmtDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return "—";
  return d.toLocaleString(DATE_LOCALE, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fmtDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return "—";
  return d.toLocaleDateString(DATE_LOCALE, { year: "numeric", month: "short", day: "2-digit" });
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
    return `<p class="empty">${esc(t("common.noClosedTradesCurve"))}</p>`;
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
      data-tip="${esc(`<div class='t-title'>${fmtDateTime(p.at)}</div><div class='t-value'>${t("common.balanceAt", { value: fmtMoney(balance) })}</div><div class='t-value'>${t("common.fromStart", { value: `${change >= 0 ? "+" : ""}${fmtMoney(change)}` })}</div>`)}" />`;
  });

  const dots = points.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(num(p.balance)).toFixed(1)}" r="3" fill="${stroke}" stroke="#141820" stroke-width="2" />`
  );

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("common.equityLabel", { n: points.length, from: fmtMoney(starting), to: fmtMoney(last) }))}">
    ${grid.join("")}
    <line x1="${pad.left}" y1="${startY.toFixed(1)}" x2="${pad.left + plotW}" y2="${startY.toFixed(1)}" stroke="#f0b429" stroke-width="1" opacity="0.5" />
    <text x="${pad.left + 4}" y="${(startY - 5).toFixed(1)}" fill="#f0b429" font-size="9" opacity="0.8">${esc(t("common.start"))} ${fmtCompact(starting)}</text>
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" />
    ${dots.join("")}
    ${labels.join("")}
    ${hits.join("")}
  </svg>`;
}

/** Win / loss / breakeven. Status colours, each with a word beside it. */
function renderOutcomes(perf) {
  const total = perf.total_trades;
  if (!total) return `<p class="empty">${esc(t("common.noClosedTrades"))}</p>`;

  const rows = [
    { label: t("common.wins"), value: perf.wins, colour: "#3ecf8e" },
    { label: t("common.losses"), value: perf.losses, colour: "#f2555a" },
    { label: t("common.breakeven"), value: perf.breakeven, colour: "#7d8697" },
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
        data-tip="${esc(`<div class='t-title'>${r.label}</div><div class='t-value'>${t("common.ofTotal", { n: r.value, total, pct })}</div>`)}" />
      <text x="${labelW + w + 8}" y="${y + barH / 2 + 4}" fill="#e8ecf2" font-size="12" font-family="ui-monospace, monospace">${r.value}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("common.outcomeLabel", { list: rows.map((r) => `${r.value} ${r.label}`).join("، "), total }))}">${bars.join("")}</svg>`;
}

/** Net result per symbol. Sign is polarity, so the two status hues apply. */
function renderBySymbol(trades) {
  if (trades.length === 0) return `<p class="empty">${esc(t("common.noClosedTrades"))}</p>`;

  const totals = new Map();
  for (const trade of trades) {
    const pnl = num(trade.pnl) ?? 0;
    totals.set(trade.symbol, (totals.get(trade.symbol) ?? 0) + pnl);
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

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("common.bySymbolLabel", { n: trades.length }))}">
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
    return `<p class="empty">${esc(t("market.notNumeric"))}</p>`;
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
    const tip = `<div class='t-title'>${fmtDateTime(c.open_time)}${c.closed ? "" : t("market.formingTip")}</div>
      <div class='t-value'>O ${fmtPrice(c.open)}</div><div class='t-value'>H ${fmtPrice(c.high)}</div>
      <div class='t-value'>L ${fmtPrice(c.low)}</div><div class='t-value'>C ${fmtPrice(c.close)}</div>`;
    return (
      `<line x1="${x.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${colour}" stroke-width="1" />` +
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${height.toFixed(1)}" fill="${fill}" stroke="${colour}" stroke-width="1" />` +
      `<rect class="pt" x="${(x - step / 2).toFixed(1)}" y="${pad.top}" width="${step.toFixed(1)}" height="${plotH}" fill="transparent" data-tip="${esc(tip)}" />`
    );
  });

  const first = fmtDateTime(candles[0].open_time);
  const last = fmtDateTime(candles[candles.length - 1].open_time);

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("market.candleLabel", { n: candles.length, from: first, to: last }))}">
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
      ? `<i style="${positive ? `inset-inline-start:50%` : `inset-inline-end:50%`};width:${pct}%;background:${colour}"></i>`
      : "";
    return `<tr class="${f.available ? "" : "unavailable"}">
      <td>${esc(term(f.dimension))}</td>
      <td class="num">${esc(f.weight)}%</td>
      <td class="bar-cell"><span class="bar"><span class="mid"></span>${bar}</span></td>
      <td class="num">${f.available ? f.contribution.toFixed(1) : esc(t("factors.na"))}</td>
    </tr>`;
  });
  return `<table class="factors">
    <thead><tr><th>${esc(t("factors.dimension"))}</th><th class="num">${esc(t("factors.weight"))}</th><th>${esc(t("factors.lean"))}</th><th class="num">${esc(t("factors.points"))}</th></tr></thead>
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
    aligned: t("confluence.aligned"),
    against: t("confluence.against"),
    "strongly-against": t("confluence.stronglyAgainst"),
    undecided: t("confluence.undecided"),
    unavailable: t("confluence.unavailable"),
  }[c.agreement] || term(c.agreement);

  return `<p class="confluence ${cut ? "cut" : ""}">
    <span class="tag">${esc(c.higher_timeframe || "—")}</span>
    ${esc(label)}${c.higher_trend ? ` · ${esc(term(c.higher_trend))}` : ""}
    ${cut ? `<span class="muted">${esc(t("confluence.cut", { before, after: Math.round(before * c.multiplier * 100) / 100 }))}</span>` : ""}
  </p>`;
}

/* The order ticket: the trade as an instruction, not as four prices.
   "Entry 108500 · Stop 107800 · TP 110600 · R:R 3.0" is everything except what
   a trader actually has to decide — how much to buy and what it costs to be
   wrong. Both were computed all along and neither left the server. */
function renderTicket(plan, symbol) {
  if (!plan) return "";
  const size = plan.size || {};
  const verb = plan.direction === "LONG" ? t("ticket.buy") : t("ticket.sellShort");
  /* <bdi> because a Latin ticker and a price sit inside an Arabic sentence:
     without it the bidirectional algorithm reorders the run at the boundary
     and "BTC 0.009" can render with the number on the wrong side of the name. */
  const base = `<bdi>${esc(symbol.replace(/USDT$/, ""))}</bdi>`;

  return `<p class="ticket">
    <strong>${esc(verb)} <bdi>${esc(size.quantity)}</bdi> ${base}</strong> ${esc(t("ticket.at"))} <bdi>${esc(plan.entry_display)}</bdi>
    <span class="muted">(${fmtMoney(size.notional)})</span><br />
    ${t("ticket.risk", { loss: fmtMoney(plan.realistic_loss), stop: `<bdi>${esc(plan.stop_display)}</bdi>` })}
    ${t("ticket.make", { profit: fmtMoney(plan.max_profit) })}
  </p>`;
}

/* The exit is staged in three parts. Shown as one "take profit" price, the
   screen describes a trade the bot does not take: only a fifth of the position
   ever reaches the final target, so the headline 3.0R pays 1.7R. */
function renderLadder(plan) {
  if (!plan || !(plan.targets || []).length) return "";

  /* Four columns, not six. The first version carried R and a running total as
     columns of their own and overflowed a card this narrow — clipping "pays",
     which is the one column the table exists for. R rides along with the exit
     label, and the running total is the ticket's closing clause already. */
  const rows = plan.targets.map((rung, i) => `<tr>
    <td>T${i + 1} <span class="muted">${esc(rung.r_multiple)}R</span></td>
    <td class="num">${esc(rung.price_display)}</td>
    <td class="num">${esc(rung.allocation_pct)}%</td>
    <td class="num up">+${fmtMoney(rung.profit)}</td>
  </tr>`).join("");

  return `<table class="ladder">
    <caption>${esc(t("ladder.caption"))}</caption>
    <thead><tr>
      <th scope="col">${esc(t("ladder.exit"))}</th>
      <th scope="col" class="num">${esc(t("ladder.price"))}</th>
      <th scope="col" class="num">${esc(t("ladder.sells"))}</th>
      <th scope="col" class="num">${esc(t("ladder.pays"))}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* Three sentences the server writes in English, restated here from the numbers
   it now publishes alongside them. Restating beats translating: the English
   stays exactly as the engine wrote it, and the Arabic is built from the same
   values rather than from a parse of the prose. */
function invalidation(s) {
  if (!isRTL()) return s.invalidation;
  const p = s.plan;
  if (!p) return "لا خطة، فلا مستوى نقض.";
  const atr = p.atr_multiple;
  return atr
    ? `إغلاق تحت ${p.stop_display} (قرابة ${atr} من متوسط المدى الحقيقي) ينقض الفكرة`
    : `إغلاق تحت ${p.stop_display} ينقض الفكرة`;
}

function capNote(size) {
  if (!isRTL()) return size.cap_note;
  return `الوقف يبعد ${size.stop_distance_pct}%، فالمخاطرة بكامل ${size.requested_risk_amount} ` +
         `تحتاج انكشافاً أكبر مما يسمح به التحجيم الفوري. خُفّضت المخاطرة إلى ${size.risk_amount}.`;
}

function costNote() {
  if (!isRTL()) return null;
  return "الخسارة تشمل رسوم التنفيذ والانزلاق المعاكس على الطرفين. أرباح الأهداف لا تشملها: " +
         "تكاليف الخروج تقع عند أسعار غير معروفة بعد.";
}

/* The engine's own sentence is English prose, assembled on the server from the
   same factor keys the payload already carries. Translating that sentence would
   mean parsing it back apart; composing it here from `evidence` instead means
   both languages are generated from the identical structured evidence and
   neither can drift into claiming something the analyser did not find. */
function composeReason(s) {
  if (!isRTL()) return s.reason;

  const ev = s.evidence || {};
  const up = s.signal === "LONG";
  const supporting = (up ? ev.bullish : ev.bearish) || [];
  const against = (up ? ev.bearish : ev.bullish) || [];

  if (s.decision !== "TRADE") {
    const parts = [];
    if (Number(s.confidence) < 75) {
      parts.push(`الثقة ${Number(s.confidence).toFixed(0)} دون عتبة 75`);
    }
    if (s.risk_level === "EXTREME") parts.push("التذبذب شديد");
    if (supporting.length) {
      parts.push(`الأدلة حتى الآن: ${supporting.slice(0, 3).map(term).join("، ")}`);
    }
    return `لا صفقة: ${parts.length ? parts.join("؛ ") : "لا فرصة مؤهّلة."}`;
  }

  const side = up ? "شراء" : "بيع";
  let sentence = `${side}: ${supporting.slice(0, 4).map(term).join("، ")}.`;
  if (against.length) sentence += ` ما يعارضها: ${against.slice(0, 3).map(term).join("، ")}.`;
  return sentence;
}

function renderSignalCard(s) {
  const isTrade = s.decision === "TRADE";
  const sideTag = s.signal === "LONG" ? "long" : s.signal === "SHORT" ? "short" : "";
  const ev = s.evidence || {};
  const p = s.plan;

  /* Two reward-to-risk numbers, both true about different things. The blended
     one is what this ladder pays; the headline one is what holding everything
     to the last target would pay, and it is the number the entry gate checks. */
  const ratios = p
    ? `<div class="kv"><dt>${esc(t("signals.rewardRisk"))}</dt><dd>
         ${esc(p.blended_reward_risk)}<span class="muted">${esc(t("signals.asStaged", { headline: p.reward_risk }))}</span>
       </dd></div>`
    : `<div class="kv"><dt>${esc(t("signals.rewardRisk"))}</dt><dd>${esc(s.risk_reward ?? "—")}</dd></div>`;

  const plan = isTrade
    ? `${renderTicket(p, s.symbol)}
       <dl class="kv-list">
        <div class="kv"><dt>${esc(t("signals.entry"))}</dt><dd>${fmtPrice(s.entry)}</dd></div>
        <div class="kv"><dt>${esc(t("signals.stopLoss"))}</dt><dd class="down">${fmtPrice(s.stop_loss)}${
          p ? ` <span class="muted">−${esc(p.size.stop_distance_pct)}%</span>` : ""
        }</dd></div>
        ${ratios}
        <div class="kv"><dt>${esc(t("signals.riskLevel"))}</dt><dd>${esc(term(s.risk_level))}</dd></div>
       </dl>
       ${renderLadder(p)}
       ${p && p.size.cap_note ? `<p class="cap-note">${esc(capNote(p.size))}</p>` : ""}
       ${p ? `<p class="muted cost-note">${esc(costNote() ?? p.cost_note)}</p>` : ""}`
    : `<p class="muted" style="margin:0">${esc(t("signals.noLevels"))}</p>`;

  const warnings = (s.warnings || []).length
    ? `<ul class="warnings">${s.warnings.map((w) => `<li>${esc(term(w))}</li>`).join("")}</ul>`
    : "";

  return `<article class="card ${isTrade ? "is-trade" : ""}">
    <header class="card-head">
      <span class="sym">${esc(s.symbol)}</span>
      <span>
        ${sideTag ? `<span class="tag ${sideTag}">${esc(term(s.signal))}</span>` : `<span class="tag">${esc(t("signals.noTrade"))}</span>`}
        <span class="tag">${esc(t("signals.confidence", { value: Number(s.confidence).toFixed(1) }))}</span>
      </span>
    </header>
    <div class="card-body">
      ${plan}
      <p class="card-reason">${esc(composeReason(s))}</p>
      ${isTrade ? `<p class="muted" style="margin:6px 0 0">${esc(t("signals.invalidation", { text: invalidation(s) }))}</p>` : ""}
      ${warnings}
      ${renderConfluence(ev)}
      <details class="evidence">
        <summary>${esc(t("signals.evidence", { n: (ev.detected || []).length }))}</summary>
        ${renderFactors(ev.factors)}
        ${(ev.detected || []).length ? `<p class="muted" style="margin-top:8px">${esc(t("signals.detected", { list: (ev.detected || []).map(term).join("، ") }))}</p>` : ""}
      </details>
    </div>
  </article>`;
}

/* Where price actually sits between the stop and the target.

   Eight numbers in a list tell a trader the levels; none of them answers the
   only question being asked while a position is open, which is "how close am I
   to either end". The bar is that answer, and the two distances beside it are
   the same answer for anyone who cannot see it. */
function renderProgress(pos) {
  const entry = Number(pos.entry);
  const stop = Number(pos.stop_loss);
  const target = Number(pos.take_profit);
  const now = Number(pos.current_price);
  if (![entry, stop, target, now].every(Number.isFinite)) return "";

  const span = pos.direction === "LONG" ? target - stop : stop - target;
  if (!(span > 0)) return "";

  const at = (price) => {
    const raw = pos.direction === "LONG" ? (price - stop) / span : (stop - price) / span;
    return Math.max(0, Math.min(1, raw)) * 100;
  };

  const entryPct = at(entry);
  const nowPct = at(now);
  /* The fill runs from entry to the current price, not from the stop: it is
     the distance TRAVELLED that matters, and colouring the whole left-hand
     side green would show profit on a position that is down. */
  const left = Math.min(entryPct, nowPct);
  const width = Math.abs(nowPct - entryPct);
  const winning = pos.direction === "LONG" ? now >= entry : now <= entry;

  const away = (price) => (Math.abs(now - price) / now * 100).toFixed(2);

  return `<div class="progress" role="img"
      aria-label="${esc(t("progress.label", { stop: away(stop), target: away(target) }))}">
    <span class="track">
      <i class="fill ${winning ? "up" : "down"}" style="inset-inline-start:${left}%;width:${width}%"></i>
      <i class="mark entry" style="inset-inline-start:${entryPct}%"></i>
      <i class="mark now" style="inset-inline-start:${nowPct}%"></i>
    </span>
    <span class="ends">
      <span class="down">${esc(t("progress.stopAway", { pct: away(stop) }))}</span>
      <span class="up">${esc(t("progress.targetAway", { pct: away(target) }))}</span>
    </span>
  </div>`;
}

function renderPositionCard(trade) {
  const pnl = signed(trade.unrealised_pnl);
  const r = signed(trade.unrealised_r, "R");
  return `<article class="card">
    <header class="card-head">
      <span class="sym">${esc(trade.symbol)}</span>
      <span>
        <span class="tag ${trade.direction === "LONG" ? "long" : "short"}">${esc(term(trade.direction))}</span>
        <span class="tag">${esc(t("positions.paper"))}</span>
      </span>
    </header>
    <div class="card-body">
      <!-- A dl, not loose dt/dd in divs. Outside a list they are invalid and a
           screen reader reads eight labels and eight numbers with nothing
           joining them. -->
      ${renderProgress(trade)}
      <dl class="kv-list">
        <div class="kv"><dt>${esc(t("signals.entry"))}</dt><dd>${fmtPrice(trade.entry)}</dd></div>
        <div class="kv"><dt>${esc(t("positions.current"))}</dt><dd>${fmtPrice(trade.current_price)}</dd></div>
        <div class="kv"><dt>${esc(t("signals.stopLoss"))}</dt><dd class="down">${fmtPrice(trade.stop_loss)}</dd></div>
        <div class="kv"><dt>${esc(t("signals.takeProfit"))}</dt><dd class="up">${fmtPrice(trade.take_profit)}</dd></div>
        <div class="kv"><dt>${esc(t("positions.quantity"))}</dt><dd>${esc(trade.quantity)}</dd></div>
        <div class="kv"><dt>${esc(t("positions.risked"))}</dt><dd>${fmtMoney(trade.risk_amount)}</dd></div>
        <div class="kv"><dt>${esc(t("positions.unrealised"))}</dt><dd class="${pnl.cls}">${pnl.text} <span class="muted">(${r.text})</span></dd></div>
        <div class="kv"><dt>${esc(t("positions.opened"))}</dt><dd>${esc(fmtDateTime(trade.opened_at))}</dd></div>
      </dl>
      <p class="card-reason">${esc(trade.reason)}</p>
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
    <h3>${esc(t("halt.title"))}</h3>
    <ul>${halt.blocks.map((b) => `<li>
      <strong>${esc(term(b.limit))}</strong> —
      ${esc(t("halt.against", { value: b.value, threshold: b.threshold }))}
      ${esc(t("halt.clears", { how: term(b.clears) }))}<br />
      <span class="muted">${esc(b.explanation)}</span>
    </li>`).join("")}</ul>
    ${lastReset ? `<p class="muted">${esc(t("halt.lastAck", {
        at: fmtDateTime(lastReset.at),
        equity: fmtMoney(lastReset.baseline_equity),
        pct: lastReset.drawdown_pct_at_reset,
      }))}</p>` : ""}
    ${manual ? `<p><button id="ack-drawdown" type="button" class="primary">${esc(t("halt.acknowledge"))}</button>
      <span class="muted">${esc(t("halt.permanent"))}</span></p>` : ""}`;

  const button = el("ack-drawdown");
  if (button) button.addEventListener("click", acknowledgeDrawdown);
}

async function acknowledgeDrawdown() {
  const button = el("ack-drawdown");
  button.disabled = true;
  button.textContent = t("halt.recording");
  try {
    const result = await getJson("/bot/risk/acknowledge-drawdown", { method: "POST" });
    if (!result.acknowledged) {
      setNotice("warn", t("halt.nothingToAck"), esc(term(result.reason)));
    }
    await loadPortfolio();
  } catch (error) {
    setNotice("warn", t("halt.ackFailed"), esc(error.message));
    button.disabled = false;
    button.textContent = t("halt.acknowledge");
  }
}

/** Five positions at 1% each are a 5% bet when they move together. The
    position count says "5 of 5"; only this says what is actually at stake. */
function renderHeat(heat, limitPct) {
  if (!heat || num(heat.naive_risk) === 0) {
    return `<p class="empty">${esc(t("heat.none"))}</p>`;
  }

  const effective = num(heat.effective_pct);
  const limit = num(limitPct) ?? 2.5;
  const concentration = num(heat.concentration) ?? 0;
  const over = effective > limit;

  // The bar is the share of the limit consumed, capped so an over-limit book
  // still renders inside its track rather than overflowing the panel.
  const filled = Math.min((effective / limit) * 100, 100);

  const pair = heat.worst_pair
    ? `<div class="kv"><dt>${esc(t("heat.worstPair"))}</dt><dd><bdi>${esc(heat.worst_pair.a)}</bdi> &amp; <bdi>${esc(heat.worst_pair.b)}</bdi> · ${esc(heat.worst_pair.correlation)}</dd></div>`
    : "";

  const assumed = (heat.assumed_pairs || []).length
    ? `<p class="muted assumed">${esc(t("heat.assumed", { pairs: heat.assumed_pairs.join("، ") }))}</p>`
    : "";

  return `
    <div class="heat-head">
      <div>
        <p class="label">${esc(t("heat.atRisk"))}</p>
        <p class="value ${over ? "down" : ""}">${esc(heat.effective_pct)}%</p>
        <p class="sub">${esc(t("heat.limitOf", { limit: limitPct, amount: fmtMoney(heat.effective_risk) }))}</p>
      </div>
      <div>
        <p class="label">${esc(t("heat.sum"))}</p>
        <p class="value">${fmtMoney(heat.naive_risk)}</p>
        <p class="sub">${esc(t("heat.sumSub"))}</p>
      </div>
    </div>
    <div class="heat-bar" role="img"
         aria-label="${esc(t("heat.bar", { value: heat.effective_pct, limit: limitPct }))}">
      <span class="fill ${over ? "over" : ""}" style="width:${filled.toFixed(1)}%"></span>
    </div>
    <dl class="kv-list">
      <div class="kv"><dt>${esc(t("heat.concentration"))}</dt><dd>${esc(heat.concentration)} ${
        esc(concentration > 0.9 ? t("heat.oneBet") :
            concentration > 0.6 ? t("heat.partly") : t("heat.spread"))}</dd></div>
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
        <span class="tag ${on ? "win" : ""}">${esc(on ? t("alerts.configured") : t("alerts.off"))}</span>
        ${on ? esc(t("alerts.on")) : t("alerts.setEnv")}
      </p>
      <p class="muted">${esc(t("alerts.sendOnly"))}</p>
      ${on ? `<p><button id="test-alert" type="button" class="primary">${esc(t("alerts.test"))}</button>
        <span id="alert-result" class="muted"></span></p>` : ""}`;

    const button = el("test-alert");
    if (button) button.addEventListener("click", sendTestAlert);
  } catch (error) {
    el("alerts").innerHTML = `<p class="empty">${esc(t("common.unavailable", { message: error.message }))}</p>`;
  }
}

async function sendTestAlert() {
  const button = el("test-alert");
  button.disabled = true;
  button.textContent = t("alerts.sending");
  try {
    const result = await getJson("/bot/alerts/test", { method: "POST" });
    el("alert-result").textContent = result.sent
      ? t("alerts.sent")
      : t("alerts.notSent", { reason: result.reason || t("alerts.refused") });
  } catch (error) {
    el("alert-result").textContent = t("alerts.failed", { message: error.message });
  } finally {
    button.disabled = false;
    button.textContent = t("alerts.test");
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
      { label: t("tile.balance"), value: fmtMoney(p.balance), sub: t("tile.startedAt", { value: fmtMoney(p.starting_balance) }) },
      { label: t("tile.equity"), value: fmtMoney(p.equity), sub: t("tile.openCount", { n: p.open_positions }) },
      { label: t("tile.totalPnl"), value: pnl.text, cls: pnl.cls, sub: t("tile.tradesCount", { n: perf.total_trades }) },
      { label: t("tile.today"), value: today.text, cls: today.cls, sub: t("tile.limitPct", { value: p.limits.max_daily_loss_pct }) },
      { label: t("tile.winRate"), value: `${perf.win_rate}%`, sub: t("tile.winLoss", { w: perf.wins, l: perf.losses }) },
      { label: t("tile.profitFactor"), value: perf.profit_factor ?? "—", sub: perf.profit_factor ? t("tile.grossRatio") : t("tile.noLossesYet") },
      { label: t("tile.expectancy"), value: `${perf.expectancy_r}R`, sub: t("tile.perTradeR") },
      { label: t("tile.maxDrawdown"), value: `${perf.max_drawdown_pct}%`, sub: t("tile.limitPct", { value: p.limits.max_drawdown_pct }) },
    ].map((tile) => `<div class="tile">
        <p class="label">${esc(tile.label)}</p>
        <p class="value ${tile.cls || ""}">${esc(tile.value)}</p>
        <p class="sub">${esc(tile.sub)}</p>
      </div>`).join("");

    renderHalt(p.halt, p.last_drawdown_reset);
    el("heat").innerHTML = renderHeat(p.heat, p.limits.max_portfolio_heat_pct);
    loadAlerts();
    el("equity").innerHTML = renderEquity(curve.data, num(curve.starting_balance));
    el("outcomes").innerHTML = renderOutcomes(perf);
    state.history = hist.data;
    el("by-symbol").innerHTML = renderBySymbol(hist.data);

    el("limits").innerHTML = [
      [t("limits.riskPerTrade"), `${esc(p.limits.risk_per_trade_pct)}%`],
      [t("limits.maxOpenTrades"), p.limits.max_open_trades],
      [t("limits.maxDailyLoss"), `${esc(p.limits.max_daily_loss_pct)}%`],
      [t("limits.maxDrawdown"), `${esc(p.limits.max_drawdown_pct)}%`],
      [t("limits.maxCombinedRisk"), `${esc(p.limits.max_portfolio_heat_pct)}%`],
      [t("limits.longestLosingStreak"), perf.longest_losing_streak],
      [t("limits.feesPaid"), fmtMoney(perf.total_fees)],
    ].map(([label, value]) => `<div><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join("");

    wireTooltips(document.querySelector('[data-view="portfolio"]'));
  } catch (error) {
    el("tiles").innerHTML = `<p class="empty">${esc(t("portfolio.unavailable"))} — ${esc(error.message)}</p>`;
  }
}

async function loadSignals() {
  const timeframe = el("sig-tf").value;
  el("signals").innerHTML = `<p class="empty">${esc(t("signals.scanning"))}</p>`;
  try {
    const payload = await getJson(`/signals?timeframe=${timeframe}`);
    const cards = payload.data.map(renderSignalCard);
    const failed = payload.failures.map((f) =>
      `<article class="card"><header class="card-head"><span class="sym">${esc(f.symbol)}</span>
        <span class="tag stale">${esc(t("signals.unavailableTag"))}</span></header>
        <div class="card-body"><p class="reason">${esc(term(f.code))}</p></div></article>`);
    el("signals").innerHTML = [...cards, ...failed].join("") || `<p class="empty">${esc(t("signals.noSymbols"))}</p>`;
  } catch (error) {
    el("signals").innerHTML = `<p class="empty">${esc(t("signals.unavailable"))} — ${esc(error.message)}</p>`;
  }
}

async function runTick() {
  const button = el("run-tick");
  button.disabled = true;
  button.textContent = t("signals.running");
  try {
    const report = await getJson(`/bot/tick?timeframe=${el("sig-tf").value}`, { method: "POST" });
    const rejected = report.rejected.map((r) =>
      `<li><strong><bdi>${esc(r.symbol)}</bdi></strong> — ${esc((r.reasons || []).map(term).join("، "))}${
        r.notes?.length ? `<br><span class="muted">${esc(r.notes.join(" "))}</span>` : ""}</li>`);

    el("tick-body").innerHTML = `
      <p>${t("tick.scanned", { n: report.scanned.length, opened: report.opened.length, closed: report.closed.length })}</p>
      ${report.opened.length ? `<p class="up">${esc(t("tick.opened", { list: report.opened.join("، ") }))}</p>` : ""}
      ${report.closed.length ? `<p>${esc(t("tick.closed", { list: report.closed.map((c) => `${c.symbol} ${term(c.result)} ${c.pnl} (${c.r}R)`).join("، ") }))}</p>` : ""}
      ${rejected.length ? `<p class="muted">${esc(t("tick.declined"))}</p><ul>${rejected.join("")}</ul>` : ""}
      ${report.errors.length ? `<p class="reason">${esc(t("tick.errors", { list: report.errors.map((e) => `${e.symbol} (${term(e.code)})`).join("، ") }))}</p>` : ""}`;
    el("tick-report").hidden = false;

    await Promise.all([loadSignals(), loadPortfolio()]);
  } catch (error) {
    el("tick-body").innerHTML = `<p class="reason">${esc(t("tick.failed", { message: error.message }))}</p>`;
    el("tick-report").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = t("signals.runTick");
  }
}

async function loadPositions() {
  try {
    const payload = await getJson("/bot/trades/open");
    el("positions").innerHTML = payload.data.length
      ? payload.data.map(renderPositionCard).join("")
      : `<p class="empty">${esc(t("positions.none"))}</p>`;
  } catch (error) {
    el("positions").innerHTML = `<p class="empty">${esc(t("common.unavailable", { message: error.message }))}</p>`;
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
      ? payload.data.map((row) => {
          const pnl = signed(row.pnl);
          const r = signed(row.r_multiple, "R");
          return `<tr>
            <td class="sym">${esc(row.symbol)}</td>
            <td><span class="tag ${row.direction === "LONG" ? "long" : "short"}">${esc(term(row.direction))}</span></td>
            <td class="num price">${fmtPrice(row.entry)}</td>
            <td class="num price">${fmtPrice(row.exit_price)}</td>
            <td class="num ${pnl.cls}">${pnl.text}</td>
            <td class="num ${r.cls}">${r.text}</td>
            <td><span class="tag ${row.result === "WIN" ? "win" : row.result === "LOSS" ? "loss" : ""}">${esc(row.result ? term(row.result) : "—")}</span></td>
            <td class="muted">${esc(term(row.exit_reason || ""))}</td>
            <td class="num">${Number(row.confidence).toFixed(0)}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="9" class="empty">${esc(t("history.noMatch"))}</td></tr>`;
  } catch (error) {
    el("history-body").innerHTML = `<tr><td colspan="9" class="empty">${esc(t("common.unavailable", { message: error.message }))}</td></tr>`;
  }
}

async function loadOverview() {
  try {
    const payload = await getJson("/market/overview");
    const { data = [], failures = [], summary = {} } = payload;
    const staleCount = summary.stale ?? 0;

    if (summary.feed_healthy) {
      el("feed-state").textContent = t("feed.live");
      el("feed-state").className = "badge badge-ok";
      setNotice(null);
    } else if (failures.length === 0 && staleCount > 0) {
      el("feed-state").textContent = t("feed.stale");
      el("feed-state").className = "badge badge-bad";
      setNotice("warn", t("market.showingLast", { n: staleCount, total: summary.tracked }),
        esc(t("market.providersDown")));
    } else {
      el("feed-state").textContent = data.length ? t("feed.partial") : t("feed.down");
      el("feed-state").className = "badge badge-bad";
      setNotice("bad", data.length ? t("market.someFailed", { n: failures.length, total: summary.tracked }) : t("market.noneQuoted"),
        esc(t("market.missingListed")));
    }

    const rows = data.map((row) => {
      const quote = row.ticker;
      const change = signed(quote.change_24h_pct, "%");
      const tags = [];
      if (row.meta.stale) tags.push(`<span class="tag stale">${esc(t("market.stale"))}</span>`);
      if (row.meta.fallback_used) tags.push(`<span class="tag">${esc(t("market.fallback"))}</span>`);
      // The symbol and field hooks let the live feed update a row in place.
      // Rebuilding the table on every tick would destroy focus and scroll
      // position several times a minute.
      return `<tr data-symbol="${esc(quote.symbol)}">
        <td class="sym"><bdi>${esc(quote.symbol)}</bdi></td>
        <td class="num price" data-field="price">${fmtPrice(quote.price)}</td>
        <td class="num ${change.cls}" data-field="change">${change.text}</td>
        <td class="num price">${fmtPrice(quote.high_24h)}</td>
        <td class="num price">${fmtPrice(quote.low_24h)}</td>
        <td class="num">${fmtCompact(quote.volume_24h)}</td>
        <td>${esc(row.meta.source)} ${tags.join(" ")}</td>
      </tr>`;
    });

    for (const f of failures) {
      rows.push(`<tr class="row-failed"><td class="sym"><bdi>${esc(f.symbol)}</bdi></td>
        <td colspan="6" class="reason">${esc(t("common.unavailableWord"))} — ${esc(term(f.code))}</td></tr>`);
    }

    el("overview-body").innerHTML = rows.join("") || `<tr><td colspan="7" class="empty">${esc(t("signals.noSymbols"))}</td></tr>`;
    el("updated").textContent = t("market.updated", { time: fmtTime(Date.now()) });
  } catch (error) {
    el("feed-state").textContent = t("feed.down");
    el("feed-state").className = "badge badge-bad";
    el("overview-body").innerHTML = `<tr><td colspan="7" class="empty">${esc(t("market.noData"))}</td></tr>`;
    setNotice("bad", t("market.dataUnavailable"),
      t("market.noneShown", { message: esc(error.message) }));
  }
}

async function loadCandles() {
  const symbol = el("symbol").value;
  const timeframe = el("timeframe").value;
  if (!symbol) return;

  el("chart-wrap").innerHTML = `<p class="empty">${esc(t("common.loading"))}</p>`;
  el("chart-meta").textContent = "";
  try {
    const payload = await getJson(`/market/${encodeURIComponent(symbol)}/candles?timeframe=${timeframe}&limit=120`);
    const candles = payload.data ?? [];
    if (candles.length === 0) {
      el("chart-wrap").innerHTML = `<p class="empty">${esc(t("market.noCandles"))}</p>`;
      return;
    }
    el("chart-wrap").innerHTML = renderCandles(candles);
    wireTooltips(el("chart-wrap"));
    const m = payload.meta;
    const forming = candles.filter((c) => !c.closed).length;
    el("chart-meta").textContent =
      t("market.chartMeta", { n: candles.length, symbol, tf: timeframe, source: m.source }) +
      `${m.cached ? t("market.cached") : ""}${m.stale ? t("market.staleFlag") : ""}` +
      `${forming ? t("market.forming", { n: forming }) : ""}`;
  } catch (error) {
    el("chart-wrap").innerHTML = `<p class="empty">${esc(t("common.unavailable", { message: error.message }))}</p>`;
  }
}

/* ---------- analytics ---------- */

const strengthLabel = (key) =>
  ({ insufficient: t("strength.insufficient"), suggestive: t("strength.suggestive"),
     supported: t("strength.supported") }[key] || term(key));

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
          <span class="tag strength">${esc(strengthLabel(o.strength))}</span>
          <span class="muted">n = ${esc(o.sample)}</span>
        </header>
        <p class="finding">${esc(o.finding)}</p>
        <p class="muted">${esc(o.evidence)}</p>
        <p class="consider"><strong>${esc(t("analytics.consider"))}</strong> ${esc(o.consider)}</p>
        <p class="muted applied">${t("analytics.appliedAuto")} ${esc(o.requires)}</p>
      </article>`).join("");
  } catch (error) {
    el("insights").innerHTML = `<p class="empty">${esc(t("common.unavailable", { message: error.message }))}</p>`;
  }
}

/** A win rate without its sample size is a number pretending to be evidence,
    so the interval and the count travel with it in every row. */
async function loadBreakdown() {
  const by = el("an-by").value;
  try {
    const payload = await getJson(`/analytics/breakdown?by=${by}`);
    el("an-floor").textContent =
      t("analytics.floor", { n: payload.total_closed, min: payload.min_sample });

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
            <td class="sym"><bdi>${esc(term(g.key))}</bdi>${g.reliable ? "" : ` <span class="tag thin-tag">${esc(t("analytics.thin"))}</span>`}</td>
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
      : `<tr><td colspan="9" class="empty">${esc(t("common.noClosedTrades"))}</td></tr>`;
  } catch (error) {
    el("an-body").innerHTML = `<tr><td colspan="9" class="empty">${esc(t("common.unavailable", { message: error.message }))}</td></tr>`;
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
      const window = `${fmtDate(b.window.from)} → ${fmtDate(b.window.to)}`;
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
      `<tr class="note-row"><td colspan="6" class="muted">${esc(t("analytics.noHistory", { symbol: f.symbol, code: term(f.code) }))}</td></tr>`);

    el("benchmark-body").innerHTML = [...rows, ...failed].join("")
      || `<tr><td colspan="6" class="empty">${esc(t("analytics.noCompare"))}</td></tr>`;
  } catch (error) {
    el("benchmark-body").innerHTML = `<tr><td colspan="6" class="empty">${esc(t("common.unavailable", { message: error.message }))}</td></tr>`;
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
  button.textContent = t("backtest.replaying");
  el("bt-status").hidden = false;
  el("bt-status").className = "notice info";
  el("bt-status").innerHTML = t("backtest.replayingOf", {
    what: scope === "portfolio" ? esc(t("backtest.thePortfolio")) : esc(symbol),
    tf: esc(timeframe),
    bars: esc(bars),
  });

  try {
    const path = scope === "portfolio"
      ? `/backtest?timeframe=${timeframe}&bars=${bars}`
      : `/backtest/${encodeURIComponent(symbol)}?timeframe=${timeframe}&bars=${bars}`;
    const r = await getJson(path);
    renderBacktest(r);
  } catch (error) {
    el("bt-results").hidden = true;
    el("bt-status").className = "notice bad";
    el("bt-status").innerHTML = `<strong>${esc(t("backtest.couldNotRun"))}</strong><br />${esc(error.message)}`;
  } finally {
    button.disabled = false;
    button.textContent = t("backtest.run");
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
    t("backtest.simulated", {
      what: portfolio ? esc(t("backtest.symbolsOnAccount", { n: r.symbols.length })) : esc(r.symbol),
      tf: esc(r.timeframe),
    }) +
    (portfolio
      ? esc(t("backtest.portfolioLine", {
          bars: r.bars_replayed, symbols: r.symbols.join("، "),
          qualified: r.signals_generated, trades: perf.total_trades,
          peak: r.peak_open_positions,
        }))
      : esc(t("backtest.symbolLine", {
          received: r.meta.bars_received, requested: r.meta.bars_requested,
          analysed: r.bars_analysed, qualified: r.signals_generated,
          trades: perf.total_trades, source: r.meta.source,
        }))) +
    (caveats ? `<ul>${caveats}</ul>` : "");

  el("bt-tiles").innerHTML = [
    { label: t("backtest.strategyReturn"), value: ret.text, cls: ret.cls, sub: t("backtest.fromRisk", { balance: fmtMoney(r.starting_balance), pct: r.risk_pct }) },
    { label: t("backtest.buyHold"), value: hold.text, cls: hold.cls,
      sub: portfolio ? t("backtest.basket") : t("backtest.sameWindowNoTrade") },
    { label: t("backtest.versusHolding"), value: vs.text, cls: vs.cls, sub: beat >= 0 ? t("backtest.strategyAdded") : t("backtest.holdingWon") },
    { label: t("analytics.trades"), value: perf.total_trades, sub: t("tile.winLoss", { w: perf.wins, l: perf.losses }) },
    { label: t("tile.winRate"), value: `${perf.win_rate}%`, sub: t("backtest.longestStreak", { n: perf.longest_losing_streak }) },
    { label: t("tile.profitFactor"), value: perf.profit_factor ?? "—", sub: perf.profit_factor ? t("tile.grossRatio") : t("tile.noLossesRecorded") },
    { label: t("tile.expectancy"), value: `${perf.expectancy_r}R`, sub: t("tile.perTradeR") },
    { label: t("tile.maxDrawdown"), value: `${perf.max_drawdown_pct}%`, sub: t("tile.feesPaid", { value: fmtMoney(perf.total_fees) }) },
  ].map((tile) => `<div class="tile">
      <p class="label">${esc(tile.label)}</p>
      <p class="value ${tile.cls || ""}">${esc(tile.value)}</p>
      <p class="sub">${esc(tile.sub)}</p>
    </div>`).join("");

  el("bt-equity").innerHTML = renderEquity(r.equity, num(r.starting_balance));
  wireTooltips(el("bt-equity"));

  el("bt-count").textContent = t("backtest.closedN", { n: r.trades.length });
  // The symbol column only earns its place when there is more than one symbol.
  document.querySelectorAll("#bt-trades .symbol-col").forEach((cell) => {
    cell.hidden = !portfolio;
  });
  el("bt-trades-body").innerHTML = r.trades.length
    ? r.trades.map((row) => {
        const pnl = signed(row.pnl);
        const rr = signed(row.r_multiple, "R");
        return `<tr>
          <td class="muted">${esc(fmtDateTime(row.opened_at))}</td>
          <td class="sym symbol-col" ${portfolio ? "" : "hidden"}>${esc(row.symbol || "—")}</td>
          <td><span class="tag ${row.direction === "LONG" ? "long" : "short"}">${esc(term(row.direction))}</span></td>
          <td class="num price">${fmtPrice(row.entry)}</td>
          <td class="num price">${fmtPrice(row.exit)}</td>
          <td class="num ${pnl.cls}">${pnl.text}</td>
          <td class="num ${rr.cls}">${rr.text}</td>
          <td><span class="tag ${row.result === "WIN" ? "win" : row.result === "LOSS" ? "loss" : ""}">${esc(row.result ? term(row.result) : "—")}</span></td>
          <td class="muted">${esc(term(row.exit_reason || ""))}</td>
          <td class="num">${Number(row.confidence).toFixed(0)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="10" class="empty">${esc(t("backtest.noTrades"))}</td></tr>`;

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
    <h3>${esc(t("backtest.whyDeclined"))}</h3>
    <ul>${rows.map(([reason, count]) => `<li>
      <span class="tag ${ACCOUNT.has(reason) ? "account" : ""}">${
        esc(ACCOUNT.has(reason) ? t("backtest.account") : t("backtest.setup"))}</span>
      <strong>${esc(count)}</strong> ${esc(term(reason))}
    </li>`).join("")}</ul>
    <p class="muted">${esc(t("backtest.refusalNote"))}</p>`;
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
    el("feed-state").textContent = t("feed.down");
    el("feed-state").className = "badge badge-bad";
    return;
  }
  if (frame.kind !== "tick") return;

  const stale = frame.prices.filter((p) => p.stale).length;
  const down = (frame.unavailable || []).length;

  if (frame.feed_healthy) {
    el("feed-state").textContent = t("feed.liveShort");
    el("feed-state").className = "badge badge-ok";
    setNotice(null);
  } else if (frame.prices.length) {
    el("feed-state").textContent = stale ? t("feed.liveStale") : t("feed.livePartial");
    el("feed-state").className = "badge badge-bad";
  } else {
    el("feed-state").textContent = t("feed.down");
    el("feed-state").className = "badge badge-bad";
  }
  if (down) {
    setNotice("warn", t("market.someUnavailable", { n: down, total: down + frame.prices.length }),
      frame.unavailable.map((u) => `<bdi>${esc(u.symbol)}</bdi> (${esc(term(u.code))})`).join("، ") +
      t("market.noPriceShown"));
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

  el("updated").textContent = t("market.updated", { time: fmtTime(frame.at) });

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

/** Re-render everything that is on screen in the new language.

    The static labels are swapped by the dictionary, but every table row, card
    and chart was built as a string at fetch time — so the view has to be
    rebuilt rather than relabelled. Cheap: the data is already cached upstream
    and the backtest is deliberately excluded, since a replay costs real CPU and
    must stay something the reader asks for. */
function switchLang(next) {
  window.I18N.setLang(next);
  document.querySelectorAll("[data-i18n-swap]").forEach((node) => {
    node.textContent = t(node.dataset.i18nSwap);
  });
  loadOverview();
  LOADERS[state.view]?.();
}

async function boot() {
  // Whatever the inline head script settled on: adopt it without writing it
  // back, so a first visit stays unpinned until the reader actually chooses.
  window.I18N.setLang(window.I18N.stored() || "ar", { persist: false });

  try {
    const coins = await getJson("/market/symbols");
    state.symbols = coins.map((c) => c.symbol);
    const options = state.symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    el("symbol").innerHTML = options;
    el("f-symbol").innerHTML =
      `<option value="" data-i18n-swap="history.allSymbols">${esc(t("history.allSymbols"))}</option>${options}`;
    el("bt-symbol").innerHTML = options;
  } catch {
    const none = `<option value="" data-i18n-swap="common.unavailableWord">${esc(t("common.unavailableWord"))}</option>`;
    el("symbol").innerHTML = none;
    el("bt-symbol").innerHTML = none;
  }

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => show(tab.dataset.view)));

  el("lang-toggle").addEventListener("click", () =>
    switchLang(window.I18N.lang() === "ar" ? "en" : "ar"));

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
