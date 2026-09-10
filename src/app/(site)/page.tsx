import { Hero } from "@/components/site/Hero";
import { RegimeStrip } from "@/components/site/RegimeStrip";
import { LiveSignals } from "@/components/site/LiveSignals";
import { MethodSection } from "@/components/site/MethodSection";
import { BotSection } from "@/components/site/BotSection";
import { TrackRecord } from "@/components/site/TrackRecord";
import { CallToAction } from "@/components/site/CallToAction";

export default function LandingPage() {
  return (
    <>
      <RegimeStrip />
      <Hero />
      <LiveSignals />
      <MethodSection />
      <BotSection />
      <TrackRecord />
      <CallToAction />
    </>
  );
}
