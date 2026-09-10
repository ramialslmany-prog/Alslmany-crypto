import type { Metadata } from "next";
import { Disclosure } from "@/components/site/Disclosure";

export const metadata: Metadata = {
  title: "إفصاح المخاطر",
  description:
    "هذا الموقع أداة تعليمية وليس نصيحة مالية. اقرأ حدود ما نقدّمه ومخاطر تداول العملات الرقمية قبل أي قرار.",
};

export default function DisclosurePage() {
  return <Disclosure />;
}
