import type { Metadata } from "next";
import { CoinAnalysis } from "@/components/dashboard/CoinAnalysis";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  const sym = symbol.toUpperCase();
  return {
    title: `${sym} analysis`,
    description: `Live ${sym} candlestick chart, multi-timeframe indicators, support/resistance, the rule-based trade plan and an AI deep read.`,
  };
}

export default async function CoinPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <CoinAnalysis symbol={symbol.toUpperCase()} />;
}
