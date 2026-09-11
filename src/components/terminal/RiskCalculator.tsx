"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { PageHeader } from "./PageHeader";
import { Num } from "@/components/ui/Num";
import { positionSize, DEFAULT_RISK } from "@/lib/engine/risk";
import { fmtPctPlain, fmtPrice, fmtUsd } from "@/lib/format";

/**
 * Position size from the stop distance.
 *
 * Reuses positionSize() from the engine rather than re-deriving the
 * arithmetic here, so the number a user calculates by hand is the same number
 * the bot would size with. Two implementations of one rule is one
 * implementation and one future contradiction.
 */
export function RiskCalculator() {
  const { t } = useI18n();
  const [account, setAccount] = useState("10000");
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState("100");
  const [stop, setStop] = useState("95");
  const [target, setTarget] = useState("115");

  const n = (v: string) => {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const accountValue = n(account);
  const risk = n(riskPct);
  const entryValue = n(entry);
  const stopValue = n(stop);
  const targetValue = n(target);

  const valid = entryValue > 0 && stopValue > 0 && stopValue < entryValue && risk > 0;

  const sizePct = valid
    ? positionSize(entryValue, stopValue, risk, DEFAULT_RISK.maxPositionPct)
    : 0;
  const notional = (accountValue * sizePct) / 100;
  const units = entryValue > 0 ? notional / entryValue : 0;
  const riskAmount = (accountValue * risk) / 100;
  const stopDistancePct = valid ? ((entryValue - stopValue) / entryValue) * 100 : 0;
  const rewardRisk =
    valid && targetValue > entryValue
      ? (targetValue - entryValue) / (entryValue - stopValue)
      : null;

  return (
    <>
      <PageHeader title={t("term.calc.title")} subtitle={t("term.calc.subtitle")} />

      <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-2">
        <section className="space-y-4 border border-rule p-5">
          <Input label={t("term.calc.account")} value={account} onChange={setAccount} prefix="$" />
          <Input label={t("term.calc.riskPct")} value={riskPct} onChange={setRiskPct} suffix="%" step="0.1" />
          <Input label={t("term.calc.entry")} value={entry} onChange={setEntry} prefix="$" />
          <Input label={t("term.calc.stop")} value={stop} onChange={setStop} prefix="$" />
          <Input label={t("term.calc.target")} value={target} onChange={setTarget} prefix="$" />
          {!valid && (
            <p className="border-s-2 border-bear/60 bg-bear-wash px-3 py-2 text-xs text-bear-soft">
              {t("term.calc.invalid")}
            </p>
          )}
        </section>

        <section className="space-y-px border border-rule bg-rule">
          <Result
            label={t("term.calc.positionSize")}
            value={valid ? fmtUsd(notional) : "—"}
            meta={valid ? `${sizePct}% ${t("term.position")}` : undefined}
            emphasis
          />
          <Result label={t("term.calc.units")} value={valid ? fmtPrice(units) : "—"} />
          <Result
            label={t("term.calc.riskAmount")}
            value={valid ? fmtUsd(riskAmount) : "—"}
            tone={-1}
            meta={`${risk}% ${t("term.calc.account")}`}
          />
          <Result
            label={t("term.calc.stopDistance")}
            value={valid ? fmtPctPlain(stopDistancePct, 2) : "—"}
          />
          <Result
            label={t("term.calc.rr")}
            value={rewardRisk === null ? "—" : `${rewardRisk.toFixed(2)}R`}
            tone={rewardRisk === null ? "none" : rewardRisk - DEFAULT_RISK.minRewardRisk}
            meta={`${t("term.rr")} ≥ ${DEFAULT_RISK.minRewardRisk}`}
          />

          <div className="bg-ground-950 px-5 py-4">
            <p className="text-xs leading-relaxed text-ink-faint">{t("term.calc.note")}</p>
          </div>
        </section>
      </div>
    </>
  );
}

function Input({
  label,
  value,
  onChange,
  prefix,
  suffix,
  step = "any",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="eyebrow mb-1.5 block">{label}</span>
      <span className="relative flex items-center">
        {prefix && (
          <span className="pointer-events-none absolute start-3 font-mono text-sm text-ink-faint">
            {prefix}
          </span>
        )}
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`num w-full rounded-md border border-rule-strong bg-ground-900 py-2 text-sm text-ink focus:border-amber focus:outline-none ${
            prefix ? "ps-7" : "ps-3"
          } ${suffix ? "pe-7" : "pe-3"}`}
        />
        {suffix && (
          <span className="pointer-events-none absolute end-3 font-mono text-sm text-ink-faint">
            {suffix}
          </span>
        )}
      </span>
    </label>
  );
}

function Result({
  label,
  value,
  meta,
  tone,
  emphasis = false,
}: {
  label: string;
  value: string;
  meta?: string;
  tone?: number | "none";
  emphasis?: boolean;
}) {
  return (
    <div className={emphasis ? "bg-ground-900 px-5 py-5" : "bg-ground-950 px-5 py-4"}>
      <p className="eyebrow mb-1.5">{label}</p>
      <Num size={emphasis ? "xl" : "lg"} tone={tone ?? "none"} className="block leading-none">
        {value}
      </Num>
      {meta && <p className="mt-1.5 font-mono text-2xs text-ink-faint">{meta}</p>}
    </div>
  );
}
