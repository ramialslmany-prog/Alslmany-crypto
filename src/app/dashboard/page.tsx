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
      {/* your portfolio at a glance */}
      <KpiRow />

      {/* price you can trust */}
      <PriceIntegrity symbol="BTC" />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* chart + the live AI assistant, side by side */}
        <div className="xl:col-span-8">
          <ChartPanel />
        </div>
        <div className="min-h-[480px] xl:col-span-4">
          <AICopilot />
        </div>

        {/* market map + sentiment */}
        <div className="xl:col-span-8">
          <MarketHeatmap />
        </div>
        <div className="xl:col-span-4">
          <FearGreedGauge />
        </div>

        {/* flow + sample AI recommendations */}
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
