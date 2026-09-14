"""The two languages, kept honest against each other and against the engine.

A translation layer rots in one specific way: someone adds a screen, writes the
English inline because it is faster, and the Arabic silently falls back. Nothing
breaks, no test fails, and the page is bilingual everywhere except the newest
part of it — which is the part being looked at.

So every check here is about a gap rather than about a wording. Wording is a
judgement; a key that exists in one language and not the other is a defect, and
so is a token the analyser can emit that the screen has no word for.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
APP = ROOT / "backend" / "app"


def i18n_source() -> str:
    return (FRONTEND / "i18n.js").read_text()


def app_js() -> str:
    """app.js with its comments removed.

    The comments explain the translation layer, so they quote `t("key")` — and a
    scan that reads them reports the word "key" as an undefined translation.
    """
    source = (FRONTEND / "app.js").read_text()
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"^\s*//.*$", "", source, flags=re.M)


def index_html() -> str:
    return (FRONTEND / "index.html").read_text()


def dict_block(name: str) -> str:
    """Slice one top-level object literal out of i18n.js."""
    source = i18n_source()
    start = source.index(f"const {name} = {{")
    depth = 0
    for i in range(start, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
    raise AssertionError(f"{name} is not a closed object literal")


def entries(name: str) -> dict[str, str]:
    """Every `key: { ar: ..., en: ... }` pair, as key -> its body.

    Scanned rather than matched with one expression: the values contain `{value}`
    placeholders, and a brace-counting regex treats those as nested objects. The
    first version of this parser did, which made it report eight fragments of
    prose as untranslated keys while silently skipping every entry that actually
    takes an interpolation — the parse failing open, in the direction that looks
    like a finding.
    """
    block = dict_block(name)
    body = block[block.index("{") + 1 : block.rindex("}")]

    found: dict[str, str] = {}
    i, n = 0, len(body)
    while i < n:
        match = re.compile(r'\s*(?:"([^"]+)"|([A-Za-z_][\w-]*))\s*:\s*\{').match(body, i)
        if not match:
            i += 1
            continue
        key = match.group(1) or match.group(2)
        depth, j, quote = 1, match.end(), None
        while j < n and depth:
            ch = body[j]
            if quote:
                if ch == "\\":
                    j += 1
                elif ch == quote:
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            j += 1
        found[key] = body[match.end() : j - 1]
        i = j
    return found


# --- the dictionary is complete in both languages ----------------------------


def test_every_interface_string_exists_in_both_languages():
    missing = [
        key for key, body in entries("DICT").items() if "ar:" not in body or "en:" not in body
    ]
    assert not missing, f"one-sided interface strings: {missing}"


def test_every_engine_term_exists_in_both_languages():
    missing = [
        key for key, body in entries("TERMS").items() if "ar:" not in body or "en:" not in body
    ]
    assert not missing, f"one-sided engine terms: {missing}"


def test_the_dictionary_is_not_trivially_small():
    """A parse that silently matched nothing would pass every test above while
    checking nothing at all."""
    assert len(entries("DICT")) > 150
    assert len(entries("TERMS")) > 50


# --- the markup and the code only ask for keys that exist --------------------


def test_every_key_the_markup_asks_for_is_defined():
    keys = set(re.findall(r'data-i18n(?:-title|-label)?="([^"]+)"', index_html()))
    assert keys, "no data-i18n attributes found; the scan is wrong"
    undefined = sorted(keys - set(entries("DICT")))
    assert not undefined, f"markup references undefined keys: {undefined}"


def test_every_key_the_script_asks_for_is_defined():
    known = set(entries("DICT"))
    used = set(re.findall(r'\bt\(\s*"([^"]+)"', app_js()))
    assert len(used) > 60, f"only found {len(used)} t() calls; the scan is wrong"
    undefined = sorted(used - known)
    assert not undefined, f"app.js references undefined keys: {undefined}"


def test_placeholders_match_between_the_two_languages():
    """`{value}` in one language and `{amount}` in the other renders a literal
    brace to whichever reader gets the mismatched one."""
    mismatched = []
    for key, body in entries("DICT").items():
        ar = re.search(r'ar:\s*"((?:[^"\\]|\\.)*)"', body)
        en = re.search(r'en:\s*"((?:[^"\\]|\\.)*)"', body)
        if not ar or not en:
            continue
        if set(re.findall(r"\{(\w+)\}", ar.group(1))) != set(re.findall(r"\{(\w+)\}", en.group(1))):
            mismatched.append(key)
    assert not mismatched, f"placeholders differ between languages: {mismatched}"


# --- the engine's vocabulary reaches the screen ------------------------------


def engine_tokens() -> set[str]:
    """Every literal reason slug the analyser can attach to a signal.

    Only the literals: `f"rsi-{n}"` and friends are generated with a value baked
    in and are handled by pattern in `term()`.
    """
    source = (APP / "signals" / "factors.py").read_text()
    tokens = set()
    for call in re.findall(r"reasons\.append\(([^)]*)\)", source):
        tokens.update(re.findall(r'(?<!f)"([a-z][a-z-]+)"', call))
    return tokens


def test_every_factor_the_analyser_can_report_has_a_word_on_screen():
    """The check that actually protects the Arabic screen over time.

    Adding a factor to the engine is a normal change; forgetting that the card
    now shows a raw `move-unsupported-by-participation` to an Arabic reader is
    the normal way it goes wrong.
    """
    known = set(entries("TERMS"))
    unnamed = sorted(engine_tokens() - known)
    assert not unnamed, f"the analyser emits factors with no translation: {unnamed}"


def test_the_factor_scan_finds_the_vocabulary_it_is_checking():
    tokens = engine_tokens()
    assert len(tokens) >= 10, f"only found {tokens}; the scan is wrong"
    assert "macd-bullish" in tokens


@pytest.mark.parametrize(
    "source, pattern",
    [
        ("app/risk/manager.py", r'[A-Z_]+ = "([a-z_]+)"'),
    ],
)
def test_every_refusal_reason_has_a_word_on_screen(source: str, pattern: str):
    reasons = set(re.findall(pattern, (ROOT / "backend" / source).read_text()))
    assert len(reasons) >= 8, f"only found {reasons}; the scan is wrong"
    unnamed = sorted(reasons - set(entries("TERMS")))
    assert not unnamed, f"refusal reasons with no translation: {unnamed}"


# --- the defaults ------------------------------------------------------------


def test_the_page_ships_arabic_and_right_to_left():
    """The stated product decision, asserted rather than assumed. A reader with
    nothing stored gets Arabic, and gets it in the markup rather than after a
    round trip through JavaScript."""
    html = index_html()
    assert '<html lang="ar" dir="rtl">' in html
    assert re.search(r"[؀-ۿ]", html), "no Arabic in the shipped markup"


def test_the_stored_language_is_applied_before_the_page_paints():
    """Applied in <head>, synchronously. Deferred to app.js it would run after
    first paint, and an English reader would watch the page render in Arabic and
    flip — layout included."""
    html = index_html()
    head = html[: html.index("</head>")]
    assert "alslmany.lang" in head, "the stored language is not read before paint"
    assert "document.documentElement.dir" in head


def test_digits_stay_western_in_the_engine_vocabulary():
    """Arabic-Indic numerals are correct Arabic and wrong on a trading screen:
    a price is copied and compared against a venue that prints 108,500.

    Checked on TERMS and on the interpolated values rather than on prose, since
    a heading like "أعلى ٢٤ س" is a label, not a number anyone transcribes.
    """
    # Written as codepoints: the literal digits are visually ambiguous with
    # punctuation, which is the lint's point and a fair one in a regex.
    arabic_indic = re.compile("[\u0660-\u0669]")
    offenders = [key for key, body in entries("TERMS").items() if arabic_indic.search(body)]
    assert not offenders, f"Arabic-Indic digits in engine terms: {offenders}"


def test_the_translator_is_not_shadowed_by_a_local_named_t():
    """`t` is the translator. A callback parameter also named `t` silently turns
    `t("key")` into calling a data object, and `t.label` into undefined — which
    is exactly how the market table and the backtest tiles broke while this
    layer was being written.
    """
    offenders = [
        line
        for line in app_js().splitlines()
        if re.search(r"(function\s+\w+\(t\)|\(\s*t\s*(,\s*\w+)?\s*\)\s*=>|const\s+t\s*=)", line)
    ]
    assert not offenders, f"the translator is shadowed on these lines: {offenders}"
