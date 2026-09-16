"use client";

import { Topbar } from "@/web/components/Topbar";

/**
 * The error boundary states what failed rather than apologising. An operator
 * needs the reason; "something went wrong" is not one.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <Topbar title="خطأ" />
      <div className="content">
        <div className="empty">
          <strong>تعذّر عرض هذه الصفحة.</strong>
          <span className="num" style={{ display: "block", color: "var(--loss)", margin: "8px 0" }}>
            {error.message}
          </span>
          السبب الأغلب أن العامل لم يُنشئ الجداول بعد، أو أن قاعدة البيانات قيد الكتابة.
          <br /><br />
          <button className="btn" onClick={reset}>إعادة المحاولة</button>
        </div>
      </div>
    </>
  );
}
