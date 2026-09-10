import type { Metadata } from "next";
import { TrackRecord } from "@/components/site/TrackRecord";

export const metadata: Metadata = {
  title: "السجل",
  description:
    "أداء الروبوت كما هو: كل الأرقام مشتقّة من الصفقات المغلقة، والخسائر معروضة بنفس وضوح الأرباح.",
};

export default function PerformancePage() {
  return <TrackRecord full />;
}
