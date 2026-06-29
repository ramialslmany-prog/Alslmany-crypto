import { CoinAnalysis } from "@/components/dashboard/CoinAnalysis";

export default async function CoinPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <CoinAnalysis symbol={symbol.toUpperCase()} />;
}
