import type { Metadata } from "next";
import { MethodSection } from "@/components/site/MethodSection";
import { Limits } from "@/components/site/Limits";
import { CallToAction } from "@/components/site/CallToAction";

export const metadata: Metadata = {
  title: "المنهجية",
  description:
    "كيف تُبنى كل توصية: ثلاث منصات للتحقق من السعر، أربعة أطر زمنية، خمس زوايا تحليل مستقلة، وحالة سوق تحكم حجم المخاطرة.",
};

export default function MethodPage() {
  return (
    <>
      <MethodSection />
      <Limits />
      <CallToAction />
    </>
  );
}
