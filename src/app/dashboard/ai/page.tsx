import { DeepAnalysis } from "@/components/dashboard/DeepAnalysis";
import { AIBrief } from "@/components/dashboard/AIBrief";
import { AICopilot } from "@/components/dashboard/AICopilot";

export default function AISignalsPage() {
  return (
    <div className="space-y-4">
      {/* deep per-coin AI analysis + recommendation */}
      <DeepAnalysis />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <AIBrief />
        </div>
        <div className="min-h-[540px] xl:col-span-5">
          <AICopilot />
        </div>
      </div>
    </div>
  );
}
