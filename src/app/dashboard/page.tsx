import { MarketPulse } from "@/components/dashboard/MarketPulse";
import { KpiRow } from "@/components/dashboard/KpiRow";
import { PriceIntegrity } from "@/components/dashboard/PriceIntegrity";
import { ChartPanel } from "@/components/dashboard/ChartPanel";
import { RecommendationStack } from "@/components/dashboard/RecommendationStack";
import { MarketHeatmap } from "@/components/dashboard/MarketHeatmap";
import { FearGreedGauge } from "@/components/dashboard/FearGreedGauge";
import { WhaleFeed } from "@/components/dashboard/WhaleFeed";
import { AICopilot } from "@/components/dashboard/AICopilot";

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      {/* signature hero — the focal point */}
      <MarketPulse />

      {/* your portfolio at a glance */}
      <KpiRow />

      {/* the trade desk: chart leads, live AI assistant alongside */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <ChartPanel />
          <PriceIntegrity symbol="BTC" />
          <MarketHeatmap />
        </div>
        <div className="space-y-4 xl:col-span-4">
          <AICopilot />
          <FearGreedGauge />
        </div>

        {/* flow + AI recommendations across the foot */}
        <div className="xl:col-span-5">
          <WhaleFeed />
        </div>
        <div className="xl:col-span-7">
          <RecommendationStack />
        </div>
      </div>
    </div>
  );
}
