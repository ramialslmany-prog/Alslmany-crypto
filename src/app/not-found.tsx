import Link from "next/link";
import { Topbar } from "@/web/components/Topbar";

export default function NotFound() {
  return (
    <>
      <Topbar title="غير موجود" />
      <div className="content">
        <div className="empty">
          <strong>هذه الصفحة غير موجودة.</strong>
          إن كنت تبحث عن توصية، فقد تكون لم تُولَّد بعد أو أن المعرّف خاطئ.
          <br /><br />
          <Link href="/" className="btn">لوحة القيادة</Link>
        </div>
      </div>
    </>
  );
}
