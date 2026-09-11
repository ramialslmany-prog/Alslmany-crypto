import { notFound } from "next/navigation";
import { AssetView } from "@/components/terminal/AssetView";
import { lookupSymbol } from "@/lib/market/universe";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const entry = lookupSymbol(symbol);
  return { title: entry ? `${entry.symbol} — ${entry.nameAr}` : symbol.toUpperCase() };
}

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const entry = lookupSymbol(symbol);
  if (!entry) notFound();
  return <AssetView symbol={entry.symbol} />;
}
