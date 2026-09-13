"""Signal endpoints: what the engine sees, and why."""

from __future__ import annotations

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query

from app.analysis.series import to_series
from app.api.deps import get_market_service, settings_dep
from app.config import Settings
from app.core.errors import MarketDataError
from app.market_data.timeframes import parse_timeframe
from app.services.market_service import MarketService
from app.signals.analyzer import analyse, build_signal

router = APIRouter(prefix="/signals", tags=["signals"])

SymbolPath = Annotated[str, Path(min_length=3, max_length=32)]


async def _signal_for(
    market: MarketService, settings: Settings, symbol: str, timeframe: str
) -> dict[str, Any]:
    tf = parse_timeframe(timeframe)
    sourced = await market.get_candles(symbol, tf, limit=300)

    analysis = analyse(to_series(sourced.data), symbol, tf.value)
    if analysis is None:
        return {
            "symbol": symbol,
            "timeframe": tf.value,
            "signal": "NO_TRADE",
            "decision": "NO_TRADE",
            "reason": "Insufficient history for a reliable read.",
            "confidence": 0,
        }

    signal = build_signal(
        analysis,
        balance=settings.initial_balance_usdt,
        risk_pct=settings.risk_per_trade_pct,
    )
    payload = signal.to_dict()
    payload["meta"] = {
        "source": sourced.provenance.provider,
        "stale": sourced.provenance.stale,
        "bars": analysis.bars,
    }
    return payload


@router.get("/{symbol}")
async def signal(
    symbol: SymbolPath,
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    timeframe: Annotated[str, Query()] = "1h",
) -> dict[str, Any]:
    return await _signal_for(market, settings, symbol, timeframe)


@router.get("")
async def all_signals(
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    timeframe: Annotated[str, Query()] = "1h",
) -> dict[str, Any]:
    """Every tracked symbol, scanned concurrently.

    A symbol that cannot be read appears under `failures` rather than being
    dropped: a missing row and a NO_TRADE row mean different things, and a
    screen that cannot tell them apart is lying by omission.
    """
    symbols = settings.symbol_list
    results = await asyncio.gather(
        *(_signal_for(market, settings, s, timeframe) for s in symbols),
        return_exceptions=True,
    )

    signals: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for symbol, result in zip(symbols, results, strict=True):
        if isinstance(result, MarketDataError):
            failures.append({"symbol": symbol, "code": result.code})
        elif isinstance(result, BaseException):
            failures.append({"symbol": symbol, "code": "internal_error"})
        else:
            signals.append(result)

    tradeable = [s for s in signals if s.get("decision") == "TRADE"]
    return {
        "data": signals,
        "failures": failures,
        "summary": {
            "scanned": len(symbols),
            "returned": len(signals),
            "tradeable": len(tradeable),
            "failed": len(failures),
        },
    }


@router.get("/{symbol}/analysis")
async def full_analysis(
    symbol: SymbolPath,
    settings: Annotated[Settings, Depends(settings_dep)],
    market: Annotated[MarketService, Depends(get_market_service)],
    timeframe: Annotated[str, Query()] = "1h",
) -> dict[str, Any]:
    """Every indicator reading behind a signal, for the analysis screen."""
    tf = parse_timeframe(timeframe)
    sourced = await market.get_candles(symbol, tf, limit=300)
    analysis = analyse(to_series(sourced.data), symbol, tf.value)

    if analysis is None:
        return {"symbol": symbol, "timeframe": tf.value, "available": False}

    t, v, vol, st = analysis.trend, analysis.volatility, analysis.volume, analysis.structure
    return {
        "symbol": symbol,
        "timeframe": tf.value,
        "available": True,
        "price": analysis.price,
        "bars": analysis.bars,
        "trend": {
            "state": t.trend.value,
            "ema20": t.ema20,
            "ema50": t.ema50,
            "ema200": t.ema200,
            "price_vs_ema200_pct": t.price_vs_ema200_pct,
            "evidence": list(t.evidence),
        },
        "momentum": {
            "rsi": analysis.rsi,
            "macd": (
                {
                    "macd": analysis.macd.macd,
                    "signal": analysis.macd.signal,
                    "histogram": analysis.macd.histogram,
                    "bullish": analysis.macd.is_bullish,
                }
                if analysis.macd
                else None
            ),
            "stochastic": (
                {"k": analysis.stochastic.k, "d": analysis.stochastic.d}
                if analysis.stochastic
                else None
            ),
        },
        "volatility": {
            "regime": v.regime.value,
            "atr": v.atr,
            "atr_pct": v.atr_pct,
            "percentile": v.percentile,
            "tradeable": v.is_tradeable,
        },
        "bollinger": (
            {
                "upper": analysis.bollinger.upper,
                "middle": analysis.bollinger.middle,
                "lower": analysis.bollinger.lower,
                "width_pct": analysis.bollinger.width_pct,
                "percent_b": analysis.bollinger.percent_b,
                "squeezed": analysis.bollinger.is_squeezed,
            }
            if analysis.bollinger
            else None
        ),
        "volume": {
            "state": vol.state.value,
            "relative": vol.relative,
            "vwap": vol.vwap,
            "price_vs_vwap_pct": vol.price_vs_vwap_pct,
            "obv_rising": vol.obv_rising,
            "confirms": vol.confirms_move,
        },
        "structure": {
            "state": st.state.value,
            # The manifest: what was actually detected, so absence is visible.
            "detected": list(st.detected),
            "last_break": (
                {
                    "kind": st.last_break.kind.value,
                    "direction": st.last_break.direction,
                    "price": st.last_break.price,
                }
                if st.last_break
                else None
            ),
            "fair_value_gaps": [
                {"direction": g.direction, "top": g.top, "bottom": g.bottom}
                for g in st.fair_value_gaps
            ],
            "order_blocks": [
                {"direction": b.direction, "top": b.top, "bottom": b.bottom}
                for b in st.order_blocks
            ],
            "sweeps": [{"direction": s.direction, "level": s.level} for s in st.sweeps],
            "premium_discount": (
                {
                    "zone": st.premium_discount.zone,
                    "position_pct": st.premium_discount.position_pct,
                    "high": st.premium_discount.high,
                    "low": st.premium_discount.low,
                }
                if st.premium_discount
                else None
            ),
        },
        "levels": {
            "support": [
                {"price": lv.price, "touches": lv.touches, "strength": lv.strength}
                for lv in analysis.levels.support
            ],
            "resistance": [
                {"price": lv.price, "touches": lv.touches, "strength": lv.strength}
                for lv in analysis.levels.resistance
            ],
        },
        "meta": {"source": sourced.provenance.provider, "stale": sourced.provenance.stale},
    }
