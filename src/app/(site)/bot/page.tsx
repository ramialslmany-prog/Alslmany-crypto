import type { Metadata } from "next";
import { BotSection } from "@/components/site/BotSection";
import { TrackRecord } from "@/components/site/TrackRecord";

export const metadata: Metadata = {
  title: "الروبوت",
  description:
    "روبوت تداول ورقي يعمل على مدار الساعة: دخول منضبط، جني أرباح مرحلي، وقف متحرك، وسجل عام لكل صفقة — دون لمس أي أموال حقيقية.",
};

export default function BotPage() {
  return (
    <>
      <BotSection />
      <TrackRecord />
    </>
  );
}
