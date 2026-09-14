/*
 * Arabic first, English by choice.
 *
 * Three rules shaped this file.
 *
 * Arabic is the default, not a fallback. The stored preference decides, and
 * with nothing stored the page is Arabic — which is why index.html ships its
 * Arabic text as literal content rather than as something JavaScript fills in.
 * A reader who arrives before the script does still gets a readable page, and
 * there is no flash of the wrong language.
 *
 * Digits stay Western in both languages. Arabic-Indic numerals are correct
 * Arabic and wrong here: a price is copied, compared against an exchange screen
 * and read back under time pressure, and every venue this desk quotes prints
 * 108,500. Translating the words and leaving the numbers alone is the choice a
 * trading screen has to make.
 *
 * The engine's vocabulary is translated, never paraphrased. `macd-bullish` and
 * `swept-up-liquidity` arrive as keys, so both languages render from the same
 * structured evidence and neither can quietly drift into saying something the
 * analyser did not.
 */

/* Wrapped, so the only name this file adds to the page is `window.I18N`.

   Both files are classic scripts and therefore share one global scope: a
   top-level `function t` here collided with app.js's `const { t } = window.I18N`
   and threw "Identifier 't' has already been declared" — which aborts app.js
   entirely. The page still looked right, because index.html ships its Arabic as
   real markup, so the failure showed up only as data that never arrived. */
(function () {
"use strict";

const STORAGE_KEY = "alslmany.lang";
const LANGS = ["ar", "en"];

/* Interface text. Keys are addressed by area so a missing one is obvious in a
   diff, and `test_i18n.py` fails the build if any key exists in one language
   and not the other. */
const DICT = {
  // ---- chrome ----------------------------------------------------------
  "app.tagline": { ar: "تحليل وتداول ورقي", en: "Analysis & paper trading" },
  "app.sections": { ar: "الأقسام", en: "Sections" },
  "app.paperOnly": { ar: "ورقي فقط", en: "PAPER ONLY" },
  "app.paperTitle": {
    ar: "هذه المنصّة لا تحمل أي مفاتيح منصّات تداول، ولا يوجد فيها مسار برمجي لإرسال أمر.",
    en: "This platform holds no exchange credentials and has no order-placement code path.",
  },
  "app.checking": { ar: "جارٍ الفحص", en: "CHECKING" },
  "app.switchLang": { ar: "English", en: "العربية" },
  "app.switchLangTitle": { ar: "Switch to English", en: "التبديل إلى العربية" },
  "app.disclaimer": {
    ar: "أداة بحث تعليمية، وليست نصيحة مالية. كل صفقة هنا محاكاة على رصيد افتراضي. لا تُحفظ أي مفاتيح منصّات ولا يمكن إرسال أي أمر.",
    en: "Educational research tool, not financial advice. Every trade in this system is simulated against a virtual balance. No exchange credentials are held and no order can be placed.",
  },

  // ---- tabs ------------------------------------------------------------
  "tab.portfolio": { ar: "المحفظة", en: "Portfolio" },
  "tab.signals": { ar: "الإشارات", en: "Signals" },
  "tab.positions": { ar: "المفتوحة", en: "Open" },
  "tab.history": { ar: "السجل", en: "History" },
  "tab.market": { ar: "السوق", en: "Market" },
  "tab.analytics": { ar: "التحليلات", en: "Analytics" },
  "tab.backtest": { ar: "الاختبار التاريخي", en: "Backtest" },

  // ---- feed badge ------------------------------------------------------
  "feed.live": { ar: "البث حيّ", en: "FEED LIVE" },
  "feed.liveShort": { ar: "حيّ", en: "LIVE" },
  "feed.stale": { ar: "البث قديم", en: "FEED STALE" },
  "feed.partial": { ar: "البث جزئي", en: "FEED PARTIAL" },
  "feed.down": { ar: "البث متوقف", en: "FEED DOWN" },
  "feed.liveStale": { ar: "حيّ · قديم", en: "LIVE · STALE" },
  "feed.livePartial": { ar: "حيّ · جزئي", en: "LIVE · PARTIAL" },

  // ---- portfolio -------------------------------------------------------
  "portfolio.equityCurve": { ar: "منحنى رأس المال", en: "Equity curve" },
  "portfolio.equitySub": { ar: "الرصيد بعد كل صفقة مغلقة", en: "Balance after each closed trade" },
  "portfolio.outcomes": { ar: "توزيع النتائج", en: "Outcome distribution" },
  "portfolio.bySymbol": { ar: "النتيجة حسب الرمز", en: "Result by symbol" },
  "portfolio.concentration": { ar: "التركّز", en: "Concentration" },
  "portfolio.concentrationSub": { ar: "ما تخسره المراكز المفتوحة معاً", en: "What the open book loses together" },
  "portfolio.alerts": { ar: "التنبيهات", en: "Alerts" },
  "portfolio.alertsSub": { ar: "تيليجرام — يُرسل فقط ولا يستقبل أبداً", en: "Telegram — sends only, never receives" },
  "portfolio.limits": { ar: "حدود المخاطرة", en: "Risk limits" },
  "portfolio.limitsSub": { ar: "مضمّنة في الكود — تُعرض كحقائق لا كمفاتيح", en: "Compiled in — shown as facts, not toggles" },
  "portfolio.unavailable": { ar: "المحفظة غير متاحة", en: "Portfolio unavailable" },

  "tile.balance": { ar: "الرصيد", en: "Balance" },
  "tile.startedAt": { ar: "بدأ من {value}", en: "started at {value}" },
  "tile.equity": { ar: "حقوق الملكية", en: "Equity" },
  "tile.openCount": { ar: "{n} مفتوحة", en: "{n} open" },
  "tile.totalPnl": { ar: "إجمالي الربح/الخسارة", en: "Total P/L" },
  "tile.tradesCount": { ar: "{n} صفقة", en: "{n} trades" },
  "tile.today": { ar: "اليوم", en: "Today" },
  "tile.limitPct": { ar: "الحد {value}%", en: "limit {value}%" },
  "tile.winRate": { ar: "نسبة الربح", en: "Win rate" },
  "tile.winLoss": { ar: "{w} ربح / {l} خسارة", en: "{w}W / {l}L" },
  "tile.profitFactor": { ar: "معامل الربح", en: "Profit factor" },
  "tile.grossRatio": { ar: "إجمالي الربح ÷ إجمالي الخسارة", en: "gross win ÷ gross loss" },
  "tile.noLossesYet": { ar: "لا خسائر بعد", en: "no losses yet" },
  "tile.noLossesRecorded": { ar: "لم تُسجَّل خسائر", en: "no losses recorded" },
  "tile.expectancy": { ar: "التوقّع", en: "Expectancy" },
  "tile.perTradeR": { ar: "لكل صفقة، بوحدة R", en: "per trade, in R" },
  "tile.maxDrawdown": { ar: "أقصى تراجع", en: "Max drawdown" },
  "tile.feesPaid": { ar: "الرسوم المدفوعة {value}", en: "fees paid {value}" },

  "limits.riskPerTrade": { ar: "المخاطرة لكل صفقة", en: "Risk per trade" },
  "limits.maxOpenTrades": { ar: "أقصى عدد صفقات مفتوحة", en: "Max open trades" },
  "limits.maxDailyLoss": { ar: "أقصى خسارة يومية", en: "Max daily loss" },
  "limits.maxDrawdown": { ar: "أقصى تراجع", en: "Max drawdown" },
  "limits.maxCombinedRisk": { ar: "أقصى مخاطرة مجمّعة", en: "Max combined risk" },
  "limits.longestLosingStreak": { ar: "أطول سلسلة خسائر", en: "Longest losing streak" },
  "limits.feesPaid": { ar: "الرسوم المدفوعة", en: "Fees paid" },

  // ---- halt ------------------------------------------------------------
  "halt.title": { ar: "البوت أوقف التداول", en: "The bot has stopped trading" },
  "halt.against": { ar: "{value}% مقابل حدّ {threshold}%.", en: "{value}% against a {threshold}% limit." },
  "halt.clears": { ar: "يزول بـ: {how}.", en: "Clears: {how}." },
  "halt.lastAck": {
    ar: "آخر إقرار {at} عند {equity}، بعد تراجع {pct}%.",
    en: "Last acknowledged {at} at {equity}, after a {pct}% drawdown.",
  },
  "halt.acknowledge": { ar: "أقرّ واستأنف", en: "Acknowledge and resume" },
  "halt.recording": { ar: "جارٍ التسجيل…", en: "Recording…" },
  "halt.permanent": { ar: "يُسجَّل نهائياً. القمّة السابقة لا تُستعاد.", en: "Recorded permanently. The previous peak is not restored." },
  "halt.nothingToAck": { ar: "لا شيء للإقرار به", en: "Nothing to acknowledge" },
  "halt.ackFailed": { ar: "لم يُسجَّل الإقرار", en: "The acknowledgement was not recorded" },

  // ---- heat ------------------------------------------------------------
  "heat.none": { ar: "لا مراكز مفتوحة، فلا شيء متركّز.", en: "No open positions, so nothing is concentrated." },
  "heat.atRisk": { ar: "المعرَّض للخطر معاً", en: "At risk together" },
  "heat.limitOf": { ar: "الحد {limit}% · {amount} من الحساب", en: "limit {limit}% · {amount} of the account" },
  "heat.sum": { ar: "مجموع المراكز", en: "Sum of the positions" },
  "heat.sumSub": { ar: "ما تخاطر به لو لم يتحرك شيء معاً", en: "what they risk if nothing moves together" },
  "heat.bar": {
    ar: "المخاطرة المجمّعة {value} بالمئة من الحساب مقابل حدّ {limit} بالمئة.",
    en: "Combined risk {value} percent of the account against a limit of {limit} percent.",
  },
  "heat.concentration": { ar: "التركّز", en: "Concentration" },
  "heat.oneBet": { ar: "— عملياً مركز واحد", en: "— effectively one position" },
  "heat.partly": { ar: "— جزئياً نفس الرهان", en: "— partly the same bet" },
  "heat.spread": { ar: "— موزّع فعلاً", en: "— genuinely spread" },
  "heat.worstPair": { ar: "أكثر زوج مترابط", en: "Most correlated pair" },
  "heat.assumed": {
    ar: "غير مقاس، لذا يُفترض مترابطاً: {pairs}. التاريخ المشترك أقصر من أن يُحسب، وافتراض استقلالها يجعل محفظة متركّزة تبدو موزّعة.",
    en: "Not measured, so assumed correlated: {pairs}. Too little shared history to compute these, and guessing them apart would report a concentrated book as a diversified one.",
  },

  // ---- alerts ----------------------------------------------------------
  "alerts.configured": { ar: "مُفعّلة", en: "CONFIGURED" },
  "alerts.off": { ar: "معطّلة", en: "OFF" },
  "alerts.on": { ar: "تُرسَل إشعارات الفتح والإغلاق والإيقاف إلى المحادثة المضبوطة.", en: "Open, close and halt notifications are sent to the configured chat." },
  "alerts.setEnv": {
    ar: "اضبط <code>TELEGRAM_BOT_TOKEN</code> و <code>TELEGRAM_CHAT_ID</code> على الخادم لتفعيلها. لا شيء آخر يتأثر.",
    en: "Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> on the server to turn these on. Nothing else is affected.",
  },
  "alerts.sendOnly": {
    ar: "البوت يُرسل فقط. لا يقرأ أي رسالة ولا يقبل أي أمر، فالتوكن المسروق يكشف أن مركزاً ورقياً فُتح — ولا شيء غير ذلك.",
    en: "The bot only sends. It reads no messages and accepts no commands, so a stolen token leaks the fact that a paper position opened — and nothing else.",
  },
  "alerts.test": { ar: "أرسل رسالة تجريبية", en: "Send a test message" },
  "alerts.sending": { ar: "جارٍ الإرسال…", en: "Sending…" },
  "alerts.sent": { ar: "أُرسلت.", en: "Sent." },
  "alerts.notSent": { ar: "لم تُرسل — {reason}", en: "Not sent — {reason}" },
  "alerts.refused": { ar: "تيليجرام رفضها.", en: "Telegram refused it." },
  "alerts.failed": { ar: "فشل — {message}", en: "Failed — {message}" },

  // ---- signals ---------------------------------------------------------
  "signals.title": { ar: "إشارات التحليل", en: "AI signals" },
  "signals.timeframe": { ar: "الإطار الزمني", en: "Timeframe" },
  "signals.runTick": { ar: "شغّل دورة البوت", en: "Run bot tick" },
  "signals.running": { ar: "جارٍ التشغيل…", en: "Running…" },
  "signals.scanning": { ar: "جارٍ المسح…", en: "Scanning…" },
  "signals.lastTick": { ar: "آخر دورة", en: "Last tick" },
  "signals.unavailable": { ar: "الإشارات غير متاحة", en: "Signals unavailable" },
  "signals.noSymbols": { ar: "لا رموز مضبوطة.", en: "No symbols configured." },
  "signals.noTrade": { ar: "لا صفقة", en: "NO TRADE" },
  "signals.confidence": { ar: "{value}% ثقة", en: "{value}% conf" },
  "signals.entry": { ar: "الدخول", en: "Entry" },
  "signals.stopLoss": { ar: "وقف الخسارة", en: "Stop loss" },
  "signals.takeProfit": { ar: "جني الربح", en: "Take profit" },
  "signals.rewardRisk": { ar: "العائد / المخاطرة", en: "Reward / risk" },
  "signals.asStaged": { ar: " على التدرّج · {headline} حتى الهدف الأخير", en: " as staged · {headline} to last target" },
  "signals.riskLevel": { ar: "مستوى المخاطرة", en: "Risk level" },
  "signals.noLevels": {
    ar: "لا يُعرض دخول أو وقف أو هدف عند «لا صفقة». نشر المستويات بجانب قرار بعدم التداول دعوة لأخذها رغم ذلك.",
    en: "No entry, stop or target is shown for a NO_TRADE. Publishing levels beside a decision not to trade invites taking it anyway.",
  },
  "signals.invalidation": { ar: "نقض الفكرة: {text}", en: "Invalidation: {text}" },
  "signals.evidence": { ar: "الأدلّة · {n} نمط مرصود", en: "Evidence · {n} patterns detected" },
  "signals.detected": { ar: "المرصود: {list}", en: "Detected: {list}" },
  "signals.unavailableTag": { ar: "غير متاح", en: "unavailable" },

  "ticket.buy": { ar: "اشترِ", en: "Buy" },
  "ticket.sellShort": { ar: "بِع على المكشوف", en: "Sell short" },
  "ticket.at": { ar: "عند", en: "at" },
  "ticket.risk": {
    ar: "تخاطر بـ <strong class=\"down\">{loss}</strong> إذا لُمس {stop}",
    en: "Risk <strong class=\"down\">{loss}</strong> if {stop} is hit",
  },
  "ticket.make": {
    ar: "· وتربح <strong class=\"up\">{profit}</strong> إذا اكتملت الخطة.",
    en: "· make <strong class=\"up\">{profit}</strong> if the plan runs in full.",
  },

  "ladder.caption": { ar: "الخروج متدرّج — كل درجة تبيع حصّتها وحدها", en: "Exit is staged — each rung sells only its own slice" },
  "ladder.exit": { ar: "الخروج", en: "Exit" },
  "ladder.price": { ar: "السعر", en: "Price" },
  "ladder.sells": { ar: "يبيع", en: "Sells" },
  "ladder.pays": { ar: "يدفع", en: "Pays" },

  "factors.dimension": { ar: "البُعد", en: "Dimension" },
  "factors.weight": { ar: "الوزن", en: "Weight" },
  "factors.lean": { ar: "الميل", en: "Lean" },
  "factors.points": { ar: "النقاط", en: "Points" },
  "factors.na": { ar: "غير متاح", en: "n/a" },

  "confluence.cut": { ar: " — الثقة خُفّضت من {before} إلى {after}", en: " — confidence cut from {before} to {after}" },
  "confluence.aligned": { ar: "مع الاتجاه الأعلى", en: "with the trend above" },
  "confluence.against": { ar: "ضد الاتجاه الأعلى", en: "against the trend above" },
  "confluence.stronglyAgainst": { ar: "ضد اتجاه أعلى قوي", en: "against a strong trend above" },
  "confluence.undecided": { ar: "الاتجاه الأعلى غير محسوم", en: "the trend above is undecided" },
  "confluence.unavailable": { ar: "لم يُفحص", en: "not checked" },

  // ---- tick report -----------------------------------------------------
  "tick.scanned": {
    ar: "مُسح {n} رمزاً. فُتح <strong>{opened}</strong> وأُغلق <strong>{closed}</strong>.",
    en: "Scanned {n} symbols. Opened <strong>{opened}</strong>, closed <strong>{closed}</strong>.",
  },
  "tick.opened": { ar: "فُتح: {list}", en: "Opened: {list}" },
  "tick.closed": { ar: "أُغلق: {list}", en: "Closed: {list}" },
  "tick.declined": { ar: "رُفض، مع الأسباب:", en: "Declined, with reasons:" },
  "tick.errors": { ar: "أخطاء: {list}", en: "Errors: {list}" },
  "tick.failed": { ar: "فشلت الدورة — {message}", en: "Tick failed — {message}" },

  // ---- positions -------------------------------------------------------
  "positions.title": { ar: "المراكز المفتوحة", en: "Open positions" },
  "positions.none": { ar: "لا مراكز مفتوحة.", en: "No open positions." },
  "positions.current": { ar: "السعر الحالي", en: "Current" },
  "positions.quantity": { ar: "الكمية", en: "Quantity" },
  "positions.risked": { ar: "المخاطَر به", en: "Risked" },
  "positions.unrealised": { ar: "غير محقّق", en: "Unrealised" },
  "positions.opened": { ar: "فُتح في", en: "Opened" },
  "positions.paper": { ar: "ورقي", en: "PAPER" },
  "progress.label": {
    ar: "السعر يبعد {stop} بالمئة عن الوقف و {target} بالمئة عن الهدف.",
    en: "Price is {stop} percent from the stop and {target} percent from the target.",
  },
  "progress.stopAway": { ar: "الوقف · يبعد {pct}%", en: "Stop · {pct}% away" },
  "progress.targetAway": { ar: "يبعد {pct}% · الهدف", en: "{pct}% away · Target" },

  // ---- history ---------------------------------------------------------
  "history.title": { ar: "سجل الصفقات", en: "Trade history" },
  "history.symbol": { ar: "الرمز", en: "Symbol" },
  "history.allSymbols": { ar: "كل الرموز", en: "All symbols" },
  "history.direction": { ar: "الاتجاه", en: "Direction" },
  "history.longShort": { ar: "شراء وبيع", en: "Long & short" },
  "history.long": { ar: "شراء", en: "Long" },
  "history.short": { ar: "بيع", en: "Short" },
  "history.result": { ar: "النتيجة", en: "Result" },
  "history.winsLosses": { ar: "أرباح وخسائر", en: "Wins & losses" },
  "history.wins": { ar: "الأرباح", en: "Wins" },
  "history.losses": { ar: "الخسائر", en: "Losses" },
  "history.side": { ar: "الجهة", en: "Side" },
  "history.exit": { ar: "الخروج", en: "Exit" },
  "history.pnl": { ar: "الربح/الخسارة", en: "P/L" },
  "history.r": { ar: "R", en: "R" },
  "history.exitReason": { ar: "سبب الخروج", en: "Exit reason" },
  "history.conf": { ar: "الثقة", en: "Conf." },
  "history.noMatch": { ar: "لا صفقات تطابق هذه المرشّحات.", en: "No trades match these filters." },

  // ---- market ----------------------------------------------------------
  "market.overview": { ar: "نظرة على السوق", en: "Market overview" },
  "market.price": { ar: "السعر", en: "Price" },
  "market.change24": { ar: "٢٤ ساعة", en: "24h" },
  "market.high24": { ar: "أعلى ٢٤ س", en: "24h high" },
  "market.low24": { ar: "أدنى ٢٤ س", en: "24h low" },
  "market.volume": { ar: "الحجم", en: "Volume" },
  "market.source": { ar: "المصدر", en: "Source" },
  "market.candles": { ar: "الشموع", en: "Candles" },
  "market.selectSymbol": { ar: "اختر رمزاً.", en: "Select a symbol." },
  "market.noCandles": { ar: "لم تُرجَع أي شموع.", en: "No candles returned." },
  "market.notNumeric": { ar: "بيانات الشموع لم تكن رقمية.", en: "Candle data was not numeric." },
  "market.noData": { ar: "لا بيانات سوق.", en: "No market data." },
  "market.dataUnavailable": { ar: "بيانات السوق غير متاحة", en: "Market data is unavailable" },
  "market.noneShown": { ar: "{message}<br />لا تُعرض أي أسعار، لأنه لم يُمكن الحصول على أي منها.", en: "{message}<br />No prices are shown, because none could be obtained." },
  "market.updated": { ar: "حُدّث {time}", en: "updated {time}" },
  "market.stale": { ar: "قديم", en: "stale" },
  "market.fallback": { ar: "احتياطي", en: "fallback" },
  "market.showingLast": {
    ar: "تُعرض آخر أسعار معروفة لـ {n} من {total} رمزاً",
    en: "Showing last known prices for {n} of {total} symbols",
  },
  "market.providersDown": {
    ar: "المزوّدون لا يستجيبون. هذه القيم كانت حقيقية وقت جلبها، لكنها ليست حالية.",
    en: "The providers are not responding. These values were real when they were fetched, but they are not current.",
  },
  "market.someFailed": { ar: "{n} من {total} رمزاً تعذّر تسعيرها", en: "{n} of {total} symbols could not be quoted" },
  "market.noneQuoted": { ar: "تعذّر تسعير أي رمز", en: "No symbol could be quoted" },
  "market.missingListed": {
    ar: "الرموز المفقودة تُدرج كغير متاحة بدل ملئها بقيم مختلَقة.",
    en: "Missing symbols are listed as unavailable rather than filled in.",
  },
  "market.someUnavailable": { ar: "{n} من {total} رمزاً غير متاح", en: "{n} of {total} symbols unavailable" },
  "market.noPriceShown": {
    ar: "<br />لا يُعرض سعر لهذه، لأنه لم يُمكن الحصول على أي منها.",
    en: "<br />No price is shown for these, because none could be obtained.",
  },
  "market.chartMeta": { ar: "{n} شمعة · {symbol} {tf} · المصدر {source}", en: "{n} bars · {symbol} {tf} · source {source}" },
  "market.cached": { ar: " · مخزّن", en: " · cached" },
  "market.staleFlag": { ar: " · قديم", en: " · STALE" },
  "market.forming": { ar: " · {n} ما زالت تتشكّل", en: " · {n} still forming" },
  "market.candleLabel": { ar: "رسم شموع، {n} شمعة من {from} إلى {to}.", en: "Candlestick chart, {n} bars from {from} to {to}." },
  "market.formingTip": { ar: " · تتشكّل", en: " · forming" },

  // ---- analytics -------------------------------------------------------
  "analytics.observations": { ar: "الملاحظات", en: "Observations" },
  "analytics.observationsSub": { ar: "يقرأها إنسان، ولا يطبّقها أحد", en: "Read by a human, applied by nobody" },
  "analytics.advisory": {
    ar: "لا شيء في هذه الصفحة يغيّر المحرّك. استراتيجية تعيد ضبط نفسها على الصفقات التي أخذتها تُلائم الضجيج — فالعيّنة التي تتعلّم منها هي العيّنة التي اختارتها — لذا كل ملاحظة هنا استشارية وتقول ذلك صراحةً.",
    en: "Nothing on this page changes the engine. A strategy that retunes itself on the trades it already took is fitting noise — the sample it learns from is the sample it chose — so every observation here is advisory and says so.",
  },
  "analytics.breakdown": { ar: "تفصيل الأداء", en: "Performance breakdown" },
  "analytics.groupBy": { ar: "التجميع حسب", en: "Group by" },
  "analytics.bySymbol": { ar: "حسب الرمز", en: "By symbol" },
  "analytics.byConfidence": { ar: "حسب نطاق الثقة", en: "By confidence band" },
  "analytics.byTimeframe": { ar: "حسب الإطار الزمني", en: "By timeframe" },
  "analytics.byDirection": { ar: "حسب الاتجاه", en: "By direction" },
  "analytics.byExitReason": { ar: "حسب سبب الخروج", en: "By exit reason" },
  "analytics.byStrategy": { ar: "حسب الاستراتيجية", en: "By strategy" },
  "analytics.group": { ar: "المجموعة", en: "Group" },
  "analytics.trades": { ar: "الصفقات", en: "Trades" },
  "analytics.share": { ar: "الحصة", en: "Share" },
  "analytics.interval": { ar: "مجال ثقة ٩٥٪", en: "95% interval" },
  "analytics.totalR": { ar: "إجمالي R", en: "Total R" },
  "analytics.floor": {
    ar: "{n} صفقة مغلقة. تحتاج المجموعة {min} قبل أن تُرتَّب؛ الأصغر تُعرض مائلةً وموسومة «قليلة»، لأن إخفاءها يشوّه الصورة تماماً كما يشوّهها ترتيبها.",
    en: "{n} closed trades. A group needs {min} before it is ranked; smaller groups are still shown, set in italic and marked THIN, because hiding them would distort the picture as surely as ranking them would.",
  },
  "analytics.thin": { ar: "قليلة", en: "thin" },
  "analytics.versusHolding": { ar: "مقابل الاحتفاظ فقط", en: "Against simply holding" },
  "analytics.sameWindow": { ar: "نفس النافذة، لكل رمز", en: "Same window, per symbol" },
  "analytics.windowTraded": { ar: "النافذة المتداوَلة", en: "Window traded" },
  "analytics.holdingReturned": { ar: "عائد الاحتفاظ", en: "Holding returned" },
  "analytics.strategyPnl": { ar: "ربح الاستراتيجية", en: "Strategy P/L" },
  "analytics.ofAccount": { ar: "من الحساب", en: "of account" },
  "analytics.noCompare": { ar: "لا صفقات مغلقة للمقارنة بعد.", en: "No closed trades to compare yet." },
  "analytics.noHistory": {
    ar: "{symbol} — تاريخ الأسعار غير متاح ({code})، فلا تُعرض مقارنة.",
    en: "{symbol} — price history unavailable ({code}), so no comparison is shown.",
  },
  "analytics.consider": { ar: "للنظر:", en: "Consider:" },
  "analytics.appliedAuto": { ar: "يُطبَّق تلقائياً: <strong>لا</strong>.", en: "Applied automatically: <strong>no</strong>." },
  "strength.insufficient": { ar: "بيانات غير كافية", en: "not enough data" },
  "strength.suggestive": { ar: "مُرجِّح", en: "suggestive" },
  "strength.supported": { ar: "مدعوم", en: "supported" },

  // ---- backtest --------------------------------------------------------
  "backtest.title": { ar: "إعادة التشغيل التاريخية", en: "Historical replay" },
  "backtest.scope": { ar: "النطاق", en: "Scope" },
  "backtest.oneSymbol": { ar: "رمز واحد", en: "One symbol" },
  "backtest.wholePortfolio": { ar: "المحفظة كاملة", en: "Whole portfolio" },
  "backtest.bars": { ar: "الشموع", en: "Bars" },
  "backtest.barsN": { ar: "{n} شمعة", en: "{n} bars" },
  "backtest.run": { ar: "شغّل الإعادة", en: "Run replay" },
  "backtest.replaying": { ar: "جارٍ الإعادة…", en: "Replaying…" },
  "backtest.replayingOf": {
    ar: "<strong>جارٍ إعادة {what} {tf} على {bars} شمعة…</strong>",
    en: "<strong>Replaying {what} {tf} over {bars} bars…</strong>",
  },
  "backtest.thePortfolio": { ar: "المحفظة كاملة", en: "the whole portfolio" },
  "backtest.method": {
    ar: "تستخدم الإعادة نفس المحلّل ونفس مدير المخاطر ونفس الوسيط الذي يستخدمه البوت الحيّ. تقرّر عند إغلاق الشمعة وتنفّذ عند فتح الشمعة <em>التالية</em>؛ وحين تحتوي شمعة واحدة على الوقف والهدف معاً تأخذ الوقف؛ وتحتسب الرسوم والانزلاق المعاكس على كل دخول وخروج. هذه كلها تجعل النتيجة أسوأ من اختبار ساذج، وهذا هو المقصود.",
    en: "The replay runs the same analyser, the same risk manager and the same broker the live bot uses. It decides on a bar's close and fills on the <em>next</em> bar's open; when one bar contains both the stop and the target it takes the stop; and it charges fees and adverse slippage on every entry and exit. These make the result worse than a naive backtest, which is the point.",
  },
  "backtest.couldNotRun": { ar: "تعذّر تشغيل الإعادة", en: "The replay could not run" },
  "backtest.equityTitle": { ar: "منحنى رأس المال في الإعادة", en: "Replay equity curve" },
  "backtest.equitySub": { ar: "الرصيد بعد كل صفقة مغلقة — محاكاة", en: "Balance after each closed trade — simulated" },
  "backtest.tradesTitle": { ar: "صفقات الإعادة", en: "Replay trades" },
  "backtest.closedN": { ar: "{n} مغلقة", en: "{n} closed" },
  "backtest.simulated": { ar: "<strong>نتيجة محاكاة — {what} {tf}</strong><br />", en: "<strong>Simulated result — {what} {tf}</strong><br />" },
  "backtest.symbolsOnAccount": { ar: "{n} رمزاً على حساب واحد", en: "{n} symbols on one account" },
  "backtest.portfolioLine": {
    ar: "{bars} شمعة أُعيدت عبر {symbols} · {qualified} مؤهّلة · {trades} صفقة · ذروة {peak} مفتوحة معاً",
    en: "{bars} bars replayed across {symbols} · {qualified} qualified · {trades} trades · peak {peak} open at once",
  },
  "backtest.symbolLine": {
    ar: "{received} شمعة مُستلمة من {requested} مطلوبة · {analysed} وصلت المحلّل · {qualified} مؤهّلة · {trades} صفقة · المصدر {source}",
    en: "{received} bars received of {requested} asked for · {analysed} reached the analyser · {qualified} qualified · {trades} trades taken · source {source}",
  },
  "backtest.strategyReturn": { ar: "عائد الاستراتيجية", en: "Strategy return" },
  "backtest.fromRisk": { ar: "من {balance} · مخاطرة {pct}% لكل صفقة", en: "from {balance} · risk {pct}%/trade" },
  "backtest.buyHold": { ar: "الشراء والاحتفاظ", en: "Buy and hold" },
  "backtest.basket": { ar: "سلّة متساوية الأوزان، نفس النافذة", en: "equal-weight basket, same window" },
  "backtest.sameWindowNoTrade": { ar: "نفس النافذة، بلا تداول", en: "same window, no trading" },
  "backtest.versusHolding": { ar: "مقابل الاحتفاظ", en: "Versus holding" },
  "backtest.strategyAdded": { ar: "هذا ما أضافته الاستراتيجية", en: "the strategy added this" },
  "backtest.holdingWon": { ar: "الاحتفاظ كان سيربح", en: "holding would have won" },
  "backtest.longestStreak": { ar: "أطول سلسلة خسائر {n}", en: "longest losing streak {n}" },
  "backtest.noTrades": {
    ar: "لم تأخذ الاستراتيجية أي صفقة في هذه النافذة. هذه نتيجة لا فشل — رفضت كل فرصة عُرضت عليها.",
    en: "The strategy took no trade in this window. That is a result, not a failure — it declined every setup on offer.",
  },
  "backtest.whyDeclined": { ar: "لماذا رفضت", en: "Why it declined" },
  "backtest.account": { ar: "الحساب", en: "account" },
  "backtest.setup": { ar: "الفرصة", en: "setup" },
  "backtest.refusalNote": {
    ar: "رفض «الفرصة» يعني أن لا شيء تأهّل. ورفض «الحساب» يعني أن الصفقة كانت جيدة بما يكفي والمحفظة لم تحتملها — وهذا وحده ما لا تستطيع إعادةُ رمز واحد أن تخبرك به أبداً.",
    en: "A setup refusal means nothing qualified. An account refusal means the trade was good enough and the book would not carry it — which is the only thing a single-symbol replay can never tell you.",
  },
  "backtest.opened": { ar: "فُتحت", en: "Opened" },

  // ---- shared ----------------------------------------------------------
  "common.loading": { ar: "جارٍ التحميل…", en: "Loading…" },
  "common.unavailable": { ar: "غير متاح — {message}", en: "Unavailable — {message}" },
  "common.unavailableWord": { ar: "غير متاح", en: "unavailable" },
  "common.noClosedTrades": { ar: "لا صفقات مغلقة بعد.", en: "No closed trades yet." },
  "common.noClosedTradesCurve": {
    ar: "لا صفقات مغلقة بعد. يظهر المنحنى بعد أن يأخذ البوت مركزاً ويغلقه.",
    en: "No closed trades yet. The curve appears once the bot has taken and settled a position.",
  },
  "common.wins": { ar: "أرباح", en: "Wins" },
  "common.losses": { ar: "خسائر", en: "Losses" },
  "common.breakeven": { ar: "تعادل", en: "Breakeven" },
  "common.start": { ar: "البداية", en: "start" },
  "common.balanceAt": { ar: "الرصيد {value}", en: "Balance {value}" },
  "common.fromStart": { ar: "{value} عن البداية", en: "{value} from start" },
  "common.ofTotal": { ar: "{n} من {total} · {pct}%", en: "{n} of {total} · {pct}%" },
  "common.equityLabel": {
    ar: "منحنى رأس المال: الرصيد بعد كل واحدة من {n} صفقة مغلقة، من {from} إلى {to}.",
    en: "Equity curve: balance after each of {n} closed trades, starting from {from} and ending at {to}.",
  },
  "common.outcomeLabel": { ar: "توزيع النتائج: {list} من {total} صفقة مغلقة.", en: "Outcome distribution: {list} of {total} closed trades." },
  "common.bySymbolLabel": { ar: "صافي النتيجة حسب الرمز عبر {n} صفقة مغلقة.", en: "Net result by symbol across {n} closed trades." },
  "common.notJson": { ar: "{status} — لم يُرجع الخادم JSON", en: "{status} — the server did not return JSON" },
  "common.requestFailed": { ar: "فشل الطلب ({status})", en: "Request failed ({status})" },
};

/* The engine's own vocabulary. These arrive as machine keys — `macd-bullish`,
   `swept-up-liquidity` — so the card is composed from structured evidence in
   both languages rather than from a sentence written on the server. */
const TERMS = {
  // directions and decisions
  LONG: { ar: "شراء", en: "LONG" },
  SHORT: { ar: "بيع", en: "SHORT" },
  NO_TRADE: { ar: "لا صفقة", en: "NO TRADE" },
  WIN: { ar: "ربح", en: "WIN" },
  LOSS: { ar: "خسارة", en: "LOSS" },
  BREAKEVEN: { ar: "تعادل", en: "BREAKEVEN" },

  // risk levels
  LOW: { ar: "منخفض", en: "LOW" },
  MEDIUM: { ar: "متوسط", en: "MEDIUM" },
  HIGH: { ar: "مرتفع", en: "HIGH" },
  EXTREME: { ar: "شديد", en: "EXTREME" },

  // scoring dimensions
  trend: { ar: "الاتجاه", en: "trend" },
  momentum: { ar: "الزخم", en: "momentum" },
  volume: { ar: "الحجم", en: "volume" },
  volatility: { ar: "التذبذب", en: "volatility" },
  structure: { ar: "البنية", en: "structure" },
  liquidity: { ar: "السيولة", en: "liquidity" },
  risk_reward: { ar: "العائد/المخاطرة", en: "risk reward" },
  news_risk: { ar: "مخاطر الأخبار", en: "news risk" },

  // factor findings
  "macd-bullish": { ar: "ماكد صاعد", en: "MACD bullish" },
  "macd-bearish": { ar: "ماكد هابط", en: "MACD bearish" },
  "rsi-overbought": { ar: "RSI تشبّع شرائي", en: "RSI overbought" },
  "rsi-oversold": { ar: "RSI تشبّع بيعي", en: "RSI oversold" },
  "stoch-overbought": { ar: "ستوكاستك تشبّع شرائي", en: "Stochastic overbought" },
  "stoch-oversold": { ar: "ستوكاستك تشبّع بيعي", en: "Stochastic oversold" },
  "price-above-vwap": { ar: "السعر فوق VWAP", en: "price above VWAP" },
  "price-below-vwap": { ar: "السعر تحت VWAP", en: "price below VWAP" },
  "obv-rising": { ar: "OBV صاعد", en: "OBV rising" },
  "obv-falling": { ar: "OBV هابط", en: "OBV falling" },
  "move-unsupported-by-participation": { ar: "حركة بلا حجم يدعمها", en: "move unsupported by participation" },
  "long-from-discount": { ar: "شراء من منطقة خصم", en: "long from discount" },
  "long-into-premium": { ar: "شراء داخل منطقة علاوة", en: "long into premium" },
  "short-into-discount": { ar: "بيع داخل منطقة خصم", en: "short into discount" },
  "range-position-not-scored-in-trend": { ar: "الموقع في النطاق لا يُحتسب داخل اتجاه", en: "range position not scored in trend" },
  "volatility-extreme": { ar: "تذبذب شديد", en: "volatility extreme" },
  "volatility-high": { ar: "تذبذب مرتفع", en: "volatility high" },
  "price-in-premium": { ar: "السعر في منطقة علاوة", en: "price in premium" },
  "price-in-discount": { ar: "السعر في منطقة خصم", en: "price in discount" },
  "price-in-equilibrium": { ar: "السعر في منطقة توازن", en: "price in equilibrium" },
  "bos-up": { ar: "كسر بنية صاعد", en: "break of structure up" },
  "bos-down": { ar: "كسر بنية هابط", en: "break of structure down" },
  "choch-up": { ar: "تغيّر شخصية صاعد", en: "change of character up" },
  "choch-down": { ar: "تغيّر شخصية هابط", en: "change of character down" },
  "swept-up-liquidity": { ar: "اكتساح سيولة علوية", en: "swept upside liquidity" },
  "swept-down-liquidity": { ar: "اكتساح سيولة سفلية", en: "swept downside liquidity" },
  "swept-high-liquidity": { ar: "اكتساح سيولة القمم", en: "swept high liquidity" },
  "swept-low-liquidity": { ar: "اكتساح سيولة القيعان", en: "swept low liquidity" },
  "bullish-fair-value-gap": { ar: "فجوة قيمة عادلة صاعدة", en: "bullish fair value gap" },
  "bearish-fair-value-gap": { ar: "فجوة قيمة عادلة هابطة", en: "bearish fair value gap" },
  "up-fair-value-gap": { ar: "فجوة قيمة عادلة صاعدة", en: "up fair value gap" },
  "down-fair-value-gap": { ar: "فجوة قيمة عادلة هابطة", en: "down fair value gap" },
  "bullish-order-block": { ar: "كتلة أوامر صاعدة", en: "bullish order block" },
  "bearish-order-block": { ar: "كتلة أوامر هابطة", en: "bearish order block" },
  "up-order-block": { ar: "كتلة أوامر صاعدة", en: "up order block" },
  "down-order-block": { ar: "كتلة أوامر هابطة", en: "down order block" },

  // exit reasons
  stop_loss: { ar: "وقف الخسارة", en: "stop loss" },
  take_profit: { ar: "جني الربح", en: "take profit" },
  thesis_invalidated: { ar: "سقوط الفكرة", en: "thesis invalidated" },
  manual: { ar: "إغلاق يدوي", en: "manual" },
  expired: { ar: "انتهت مدّتها", en: "expired" },
  data_unavailable: { ar: "البيانات غير متاحة", en: "data unavailable" },
  end_of_data: { ar: "نهاية البيانات", en: "end of data" },

  // refusal reasons
  no_qualifying_setup: { ar: "لا فرصة مؤهّلة", en: "no qualifying setup" },
  confidence_too_low: { ar: "الثقة منخفضة جداً", en: "confidence too low" },
  risk_reward_too_low: { ar: "العائد/المخاطرة منخفض جداً", en: "risk reward too low" },
  volatility_extreme: { ar: "تذبذب شديد", en: "volatility extreme" },
  portfolio_heat: { ar: "تركّز المحفظة", en: "portfolio heat" },
  duplicate_position: { ar: "مركز مكرّر", en: "duplicate position" },
  max_open_trades: { ar: "بلغ حد الصفقات المفتوحة", en: "max open trades" },
  daily_loss_limit: { ar: "حد الخسارة اليومية", en: "daily loss limit" },
  drawdown_limit: { ar: "حد التراجع", en: "drawdown limit" },
  insufficient_balance: { ar: "رصيد غير كافٍ", en: "insufficient balance" },
  position_too_small: { ar: "حجم المركز صغير جداً", en: "position too small" },
  no_reliable_market_data: { ar: "لا بيانات سوق موثوقة", en: "no reliable market data" },
};

let current = "ar";

function stored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGS.includes(value) ? value : null;
  } catch {
    // Private windows and blocked site data both throw here. The default
    // language is not worth failing the page over.
    return null;
  }
}

function lang() {
  return current;
}

function isRTL() {
  return current === "ar";
}

/** Look up a key. Missing keys degrade to the humanised key rather than to
    "undefined": a screen with one untranslated label is usable, one showing
    "undefined" is not. `test_i18n.py` is what actually stops them shipping. */
function t(key, vars) {
  const entry = DICT[key];
  let text = entry ? entry[current] ?? entry.en : String(key).replace(/[._-]/g, " ");
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Translate one of the engine's own tokens.

    `rsi-72` is generated with the reading baked into it, so it is matched as a
    pattern rather than listed. Anything genuinely unknown falls back to the
    token with its separators opened out, which stays readable in both
    languages and never renders as a blank. */
function term(token) {
  if (token === null || token === undefined) return "";
  const key = String(token);
  const entry = TERMS[key];
  if (entry) return entry[current] ?? entry.en;

  const rsi = key.match(/^rsi-(\d+)$/);
  if (rsi) return current === "ar" ? `RSI ${rsi[1]}` : `RSI ${rsi[1]}`;

  return key.replace(/[_-]/g, " ");
}

/** Apply the dictionary to the static markup.

    Three attributes rather than one, because a label, a tooltip and an accessible
    name are different slots and collapsing them would put markup into places
    that render it literally. */
function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.dataset.i18n;
    if (node.dataset.i18nHtml !== undefined) node.innerHTML = t(key);
    else node.textContent = t(key);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  });
  root.querySelectorAll("[data-i18n-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nLabel));
  });
}

/** Set the language on the document itself.

    `dir` belongs on <html>, not on a wrapper: form controls, scrollbars and the
    browser's own text selection follow the document direction, and setting it
    lower down leaves those mirrored the wrong way. */
function setLang(next, { persist = true } = {}) {
  current = LANGS.includes(next) ? next : "ar";
  const root = document.documentElement;
  root.lang = current;
  root.dir = isRTL() ? "rtl" : "ltr";
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch {
      // Preference not remembered; the page still works this session.
    }
  }
  applyStatic();
}

window.I18N = { t, term, lang, isRTL, setLang, applyStatic, stored, LANGS, DICT, TERMS };
})();
