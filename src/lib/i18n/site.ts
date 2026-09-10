import type { Area } from "./types";

/** Public-website copy. Arabic is the source of truth; English mirrors it. */
export const site: Area = {
  ar: {
    "site.skip": "تخطَّ إلى المحتوى",
    "site.badge": "توصيات مبنية على أدلة",
    "site.hero.line1": "كل توصية",
    "site.hero.line2": "تحمل أدلتها",
    "site.hero.lede":
      "محرك تحليل يقرأ أربعة أطر زمنية، ويعرض لك بالضبط ما الذي رجّح القرار — وما الذي عارضه. مع نقطة إبطال واضحة قبل الدخول، لا بعده.",
    "site.hero.cta": "افتح المنصة",
    "site.hero.secondary": "كيف يعمل",
    "site.hero.note": "لا تسجيل. لا رسوم. لا وصول إلى أموالك.",

    "site.stat.timeframes": "أطر زمنية",
    "site.stat.assets": "أصل مُتابَع",
    "site.stat.venues": "منصات للتحقق",
    "site.stat.checks": "اختبار آلي",

    "site.live.title": "أحدث القراءات",
    "site.live.subtitle": "مباشر من المحرك، لا قائمة محرّرة يدوياً",
    "site.live.empty": "لا توجد إعدادات مؤهَّلة الآن — وهذا بحد ذاته معلومة.",
    "site.live.all": "كل التوصيات",

    "site.method.eyebrow": "المنهجية",
    "site.method.title": "لماذا تثق برقم؟",
    "site.method.lede":
      "لأنك تستطيع تتبّعه. كل رقم هنا مشتقّ من بيانات سوق حقيقية عبر خطوات مكشوفة، ولا شيء منه مخزَّن أو مُجمَّل.",

    "site.method.1.title": "بيانات من ثلاث منصات",
    "site.method.1.body":
      "الأسعار تُجلب من Binance وOKX وBybit مع تبديل تلقائي عند تعطّل أي منها، ويُقارَن السعر بين دفاتر أوامر مستقلة. اختلاف يتجاوز ١٪ يعني أن هناك خللاً — ولا نبني عليه توصية.",
    "site.method.2.title": "تحليل متعدد الأطر",
    "site.method.2.body":
      "يُقرأ كل أصل على الأطر اليومي و٤ ساعات وساعة و١٥ دقيقة، عبر خمس زوايا مستقلة: الاتجاه، الزخم، البنية السعرية، الحجم، والموقع داخل النطاق. الاستقلال مقصود — ثلاثة مؤشرات زخم متفقة هي ملاحظة واحدة بثلاث أقنعة.",
    "site.method.3.title": "حالة السوق تحكم أولاً",
    "site.method.3.body":
      "قبل أي إعداد فردي، يُصنَّف السوق ككل: البيتكوين يحدّد المدّ، واتساع السوق يقول هل بقية الأصول تتبعه. النتيجة ميزانية مخاطرة تُصغّر كل مركز تلقائياً حين تسوء الظروف.",
    "site.method.4.title": "الإبطال قبل الدخول",
    "site.method.4.body":
      "وقف الخسارة يُحدَّد أولاً، عند المستوى الذي يُثبت خطأ الفكرة — لا عند نسبة مريحة. ثم يُشتقّ حجم المركز من مسافة الوقف، فالوقف الأوسع يعني مركزاً أصغر والخسارة واحدة في الحالتين.",
    "site.method.5.title": "الطرفان معاً، دائماً",
    "site.method.5.body":
      "الأدلة المعاكسة تُنشر بجانب المؤيدة حتى حين تكون التوصية إيجابية. عرض الجانب المتفق فقط هو أتمتة لانحياز التأكيد، لا تحليل.",

    "site.signal.eyebrow": "بطاقة التوصية",
    "site.signal.title": "هكذا تُقرأ التوصية",
    "site.signal.lede":
      "ليست سهماً أخضر. بل خطة كاملة: نطاق دخول، نقطة إبطال، أهداف مرحلية عند مستويات احترمها السوق فعلاً، وسجل بما رجّح القرار.",

    "site.bot.eyebrow": "الروبوت",
    "site.bot.title": "ينفّذ الخطة كما كُتبت",
    "site.bot.lede":
      "روبوت تداول ورقي يعمل على مدار الساعة. يدخل حين تتحقق الشروط، يجني الأرباح على مراحل، ينقل الوقف إلى التعادل، ثم يتتبّعه — ويكتب كل ذلك في سجل عام.",
    "site.bot.does": "ما يفعله",
    "site.bot.never": "ما لا يفعله أبداً",
    "site.bot.do.1": "يدخل فقط عند تصنيف A أو B ونسبة عائد/مخاطرة ١٫٨ فأعلى",
    "site.bot.do.2": "يجني الأرباح على ثلاث مراحل عند مستويات حقيقية",
    "site.bot.do.3": "ينقل الوقف إلى التعادل بعد الهدف الأول",
    "site.bot.do.4": "يغلق الدفتر كاملاً حين ينقلب السوق بوضوح",
    "site.bot.do.5": "يسجّل كل صفقة — الرابحة والخاسرة — بأسبابها",
    "site.bot.dont.1": "لا يلمس أموالك ولا يطلب مفاتيح منصة",
    "site.bot.dont.2": "لا يستخدم رافعة مالية إطلاقاً",
    "site.bot.dont.3": "لا يوسّع وقف خسارة أبداً",
    "site.bot.dont.4": "لا يتداول على بيانات تجريبية",
    "site.bot.dont.5": "لا يخفي صفقة خاسرة من السجل",

    "site.record.eyebrow": "السجل",
    "site.record.title": "الأداء كما هو",
    "site.record.lede":
      "كل الأرقام مشتقّة من الصفقات المغلقة، لا شيء منها مُنتقى. الخسائر معروضة بنفس وضوح الأرباح، لأن سجلاً بلا خسائر ليس سجلاً.",
    "site.record.empty": "لم يُغلق الروبوت أي صفقة بعد. حين يفعل، ستظهر هنا كاملة.",
    "site.record.expectancy": "التوقّع لكل صفقة",
    "site.record.expectancy.note":
      "الرقم الذي يقرّر وجود أفضلية فعلية. نسبة نجاح ٤٠٪ بمعدل ‎+٢R‎ تتفوّق على ٧٠٪ بمعدل ‎+٠٫٣R‎.",
    "site.record.disclaimerTitle": "الأداء الماضي لا يضمن شيئاً",
    "site.record.disclaimerBody":
      "هذه نتائج تداول ورقي بأسعار سوق حقيقية، مع احتساب انزلاق سعري ضدّنا. لا تتضمّن الرسوم ولا الضرائب ولا الأثر النفسي للتنفيذ الحقيقي.",

    "site.cta.title": "افتح المنصة",
    "site.cta.body": "كل التوصيات، تحليل كل أصل، دفتر الروبوت، والاختبار التاريخي.",
    "site.cta.button": "ادخل الآن",

    "site.footer.built": "أداة تعليمية مفتوحة — ليست نصيحة مالية",
    "site.footer.data": "البيانات",
    "site.footer.product": "المنتج",
    "site.footer.legal": "قانوني",

    "site.disclosure.title": "إفصاح المخاطر",
    "site.disclosure.lede":
      "اقرأ هذا قبل أن تبني أي قرار على ما تراه في هذا الموقع.",
    "site.disclosure.1.title": "ليست نصيحة مالية",
    "site.disclosure.1.body":
      "كل ما يظهر هنا نتاج نماذج تحليلية آلية، لأغراض تعليمية وبحثية فقط. ليس نصيحة استثمارية، وليس توصية شخصية، وليس دعوة للشراء أو البيع. لسنا جهة مرخّصة لتقديم الاستشارات المالية.",
    "site.disclosure.2.title": "لا أحد يتنبّأ بالسوق",
    "site.disclosure.2.body":
      "المحرك ينتج احتمالات وسيناريوهات، لا يقيناً. كل توصية تحمل احتمال فشل صريحاً ونقطة إبطال محدّدة. أي جهة تعدك بأرباح مضمونة تكذب عليك.",
    "site.disclosure.3.title": "مخاطر الخسارة الكاملة",
    "site.disclosure.3.body":
      "سوق العملات الرقمية شديد التقلّب. من الوارد تماماً خسارة رأس المال بالكامل، خصوصاً في الأصول الصغيرة وعملات الميم. لا تستثمر أبداً أكثر مما تتحمّل خسارته كلياً.",
    "site.disclosure.4.title": "الروبوت ورقيّ بالكامل",
    "site.disclosure.4.body":
      "الروبوت لا ينفّذ أوامر حقيقية، ولا يحتفظ بمفاتيح منصات، ولا يصل إلى أي أموال. نتائجه محاكاة بأسعار حقيقية — والتنفيذ الحقيقي يواجه رسوماً وسيولة وضغطاً نفسياً لا تحاكيه أي محاكاة.",
    "site.disclosure.5.title": "الارتباط ليس تنويعاً",
    "site.disclosure.5.body":
      "معظم العملات البديلة تتحرّك مع البيتكوين. خمسة مراكز في خمسة أصول قد تكون في الواقع رهاناً واحداً — وهذا ما يجعل التنويع الظاهري خطراً مضاعفاً لا مخفَّضاً.",
    "site.disclosure.6.title": "مسؤوليتك وحدك",
    "site.disclosure.6.body":
      "أنت وحدك مسؤول عن قراراتك المالية ونتائجها. ابحث بنفسك، واستشر مختصاً مرخّصاً قبل أي التزام مالي.",

    "site.demo.title": "بيانات تجريبية",
    "site.demo.body":
      "تعذّر الوصول إلى منصات التداول من هذا الخادم، فما تراه الآن سلاسل مُولَّدة للعرض فقط — ليست أسعاراً حقيقية. الروبوت لا يتداول في هذه الحالة.",
    "site.stale.title": "بيانات متأخرة",
    "site.stale.body": "تعذّر التحديث من المصدر، ونعرض آخر نسخة ناجحة.",
  },
  en: {
    "site.skip": "Skip to content",
    "site.badge": "Recommendations with their evidence attached",
    "site.hero.line1": "Every call",
    "site.hero.line2": "shows its work",
    "site.hero.lede":
      "An analysis engine that reads four timeframes and shows you exactly what argued for the decision — and what argued against it. With the invalidation level set before entry, not after.",
    "site.hero.cta": "Open the terminal",
    "site.hero.secondary": "How it works",
    "site.hero.note": "No sign-up. No fees. No access to your money.",

    "site.stat.timeframes": "timeframes",
    "site.stat.assets": "assets tracked",
    "site.stat.venues": "venues cross-checked",
    "site.stat.checks": "automated checks",

    "site.live.title": "Latest reads",
    "site.live.subtitle": "Straight from the engine — not a hand-curated list",
    "site.live.empty": "Nothing qualifies right now. That is itself the finding.",
    "site.live.all": "All recommendations",

    "site.method.eyebrow": "Method",
    "site.method.title": "Why trust a number?",
    "site.method.lede":
      "Because you can trace it. Every figure here is derived from real market data through steps you can inspect, and none of it is stored or tidied up afterwards.",

    "site.method.1.title": "Three venues, cross-checked",
    "site.method.1.body":
      "Prices come from Binance, OKX and Bybit with automatic failover, and the quote is compared across independent order books. A disagreement wider than 1% means something is wrong — and nothing gets recommended on it.",
    "site.method.2.title": "Four timeframes, five angles",
    "site.method.2.body":
      "Each asset is read on the daily, 4h, 1h and 15m across five independent angles: trend, momentum, structure, volume and location in range. The independence is the point — three momentum oscillators agreeing is one observation wearing three hats.",
    "site.method.3.title": "Regime decides first",
    "site.method.3.body":
      "Before any individual setup, the market itself is classified. Bitcoin sets the tide and breadth says whether the rest is following. The output is a risk budget that shrinks every position automatically when conditions turn.",
    "site.method.4.title": "Invalidation before entry",
    "site.method.4.body":
      "The stop is set first, at the level that would prove the idea wrong — never at a comfortable percentage. Position size is then derived from that distance, so a wider stop buys a smaller position and the loss taken is the same either way.",
    "site.method.5.title": "Both sides, always",
    "site.method.5.body":
      "Contradicting evidence is published beside supporting evidence even when the call is positive. Showing only the side that agrees is confirmation bias with a schedule, not analysis.",

    "site.signal.eyebrow": "The signal card",
    "site.signal.title": "How a recommendation reads",
    "site.signal.lede":
      "Not a green arrow. A complete plan: an entry zone, an invalidation level, staged targets at levels the market actually respected, and the record of what drove the decision.",

    "site.bot.eyebrow": "The bot",
    "site.bot.title": "It executes the plan as written",
    "site.bot.lede":
      "A paper-trading bot running around the clock. It enters when the conditions are met, takes profit in stages, moves the stop to breakeven and then trails it — and writes all of it into a public ledger.",
    "site.bot.does": "What it does",
    "site.bot.never": "What it never does",
    "site.bot.do.1": "Enters only on grade A or B at 1.8 reward-to-risk or better",
    "site.bot.do.2": "Takes profit in three stages at real levels",
    "site.bot.do.3": "Moves the stop to breakeven after the first target",
    "site.bot.do.4": "Closes the whole book when the market clearly turns",
    "site.bot.do.5": "Logs every trade, winning and losing, with its reasons",
    "site.bot.dont.1": "Never touches your money or asks for exchange keys",
    "site.bot.dont.2": "Never uses leverage",
    "site.bot.dont.3": "Never widens a stop",
    "site.bot.dont.4": "Never trades on demo data",
    "site.bot.dont.5": "Never hides a losing trade from the record",

    "site.record.eyebrow": "Track record",
    "site.record.title": "Performance, unedited",
    "site.record.lede":
      "Every figure is derived from closed trades, none of it selected. Losses are shown as plainly as wins, because a record without losses is not a record.",
    "site.record.empty": "The bot has not closed a trade yet. When it does, it appears here in full.",
    "site.record.expectancy": "Expectancy per trade",
    "site.record.expectancy.note":
      "The figure that decides whether an edge exists. A 40% win rate at +2R beats 70% at +0.3R.",
    "site.record.disclaimerTitle": "Past performance guarantees nothing",
    "site.record.disclaimerBody":
      "These are paper results at real market prices, with slippage charged against us. They exclude fees, taxes, and the psychological weight of real execution.",

    "site.cta.title": "Open the terminal",
    "site.cta.body": "Every recommendation, per-asset analysis, the bot's book, and the backtester.",
    "site.cta.button": "Enter",

    "site.footer.built": "An open educational tool — not financial advice",
    "site.footer.data": "Data",
    "site.footer.product": "Product",
    "site.footer.legal": "Legal",

    "site.disclosure.title": "Risk disclosure",
    "site.disclosure.lede": "Read this before basing any decision on what you see on this site.",
    "site.disclosure.1.title": "Not financial advice",
    "site.disclosure.1.body":
      "Everything here is produced by automated analytical models for education and research only. It is not investment advice, not a personal recommendation, and not a solicitation to buy or sell. We are not licensed to give financial advice.",
    "site.disclosure.2.title": "Nobody predicts the market",
    "site.disclosure.2.body":
      "The engine produces probabilities and scenarios, not certainty. Every recommendation carries an explicit chance of failure and a defined invalidation level. Anyone promising you guaranteed returns is lying to you.",
    "site.disclosure.3.title": "Total loss is possible",
    "site.disclosure.3.body":
      "Crypto markets are extremely volatile. Losing your entire capital is entirely possible, especially in small caps and meme assets. Never invest more than you can afford to lose completely.",
    "site.disclosure.4.title": "The bot is entirely on paper",
    "site.disclosure.4.body":
      "The bot places no real orders, holds no exchange keys, and has access to no funds. Its results are a simulation at real prices — and real execution meets fees, liquidity and psychological pressure that no simulation reproduces.",
    "site.disclosure.5.title": "Correlation is not diversification",
    "site.disclosure.5.body":
      "Most altcoins move with Bitcoin. Five positions in five assets can in reality be one bet — which is what makes apparent diversification a multiplier of risk rather than a reducer of it.",
    "site.disclosure.6.title": "The responsibility is yours alone",
    "site.disclosure.6.body":
      "You alone are responsible for your financial decisions and their outcomes. Do your own research and consult a licensed professional before any financial commitment.",

    "site.demo.title": "Demo data",
    "site.demo.body":
      "Exchanges are unreachable from this server, so what you are seeing is a generated series for display only — not real prices. The bot does not trade in this state.",
    "site.stale.title": "Stale data",
    "site.stale.body": "The source could not be refreshed; showing the last successful copy.",
  },
};
