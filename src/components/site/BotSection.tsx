"use client";

import Link from "next/link";
import { Check, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Reveal } from "@/components/ui/Reveal";

const DOES = ["1", "2", "3", "4", "5"] as const;

/**
 * What the bot does, set directly against what it will never do.
 *
 * The refusals are given equal visual weight to the capabilities. For anything
 * that touches money, the boundaries are the more important half of the
 * description, and burying them under a feature list would be a choice.
 */
export function BotSection() {
  const { t } = useI18n();

  return (
    <section id="bot" className="border-b border-rule bg-ground-900/40">
      <div className="px-[var(--gutter)] py-[var(--section-y)]">
        <div className="max-w-2xl">
          <p className="eyebrow mb-2">{t("site.bot.eyebrow")}</p>
          <h2 className="font-display text-display-sm text-ink sm:text-display">
            {t("site.bot.title")}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-muted">{t("site.bot.lede")}</p>
        </div>

        <div className="mt-12 grid gap-px border border-rule bg-rule md:grid-cols-2">
          <Column
            title={t("site.bot.does")}
            tone="bull"
            items={DOES.map((n) => t(`site.bot.do.${n}`))}
          />
          <Column
            title={t("site.bot.never")}
            tone="bear"
            items={DOES.map((n) => t(`site.bot.dont.${n}`))}
          />
        </div>

        <p className="mt-6">
          <Link href="/performance" className="btn">
            {t("nav.performance")}
          </Link>
        </p>
      </div>
    </section>
  );
}

function Column({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "bull" | "bear";
  items: string[];
}) {
  const Icon = tone === "bull" ? Check : X;
  return (
    <div className="bg-ground-950 p-6 sm:p-8">
      <p className={tone === "bull" ? "eyebrow mb-5 text-bull" : "eyebrow mb-5 text-bear"}>
        {title}
      </p>
      <ul className="space-y-3.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3">
            <Icon
              className={
                tone === "bull"
                  ? "mt-0.5 h-4 w-4 shrink-0 text-bull"
                  : "mt-0.5 h-4 w-4 shrink-0 text-bear"
              }
              aria-hidden
            />
            <span className="text-sm leading-relaxed text-ink-muted">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
