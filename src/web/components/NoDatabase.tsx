import { Empty } from "@/web/components/ui";

/**
 * Shown when the worker has never run.
 *
 * Naming the exact command is the difference between a dead page and a
 * working one — "no data" is true and useless.
 */
export function NoDatabase() {
  return (
    <Empty title="لا توجد قاعدة بيانات بعد">
      لم يُشغَّل العامل بعد، فلا يوجد ما يُعرض. هذا هو الوضع الصحيح لنسخة جديدة.
      <br /><br />
      ابدأ بفحص المصادر: <code>npm run doctor</code>
      <br />
      ثم ابنِ التاريخ: <code>npm run backfill -- --top 30 --timeframes 1h,4h,1d --years 2</code>
      <br /><br />
      كل صفحة هنا تقرأ من ملف SQLite واحد يكتبه العامل. لا طبقة وسيطة بينهما،
      ولا ذاكرة مؤقتة تتقادم.
    </Empty>
  );
}
