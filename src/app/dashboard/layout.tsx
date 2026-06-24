import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { MobileNav } from "@/components/dashboard/MobileNav";
import { JournalWatcher } from "@/components/dashboard/JournalWatcher";
import { PageShell } from "@/components/dashboard/PageShell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* live pick monitoring + Telegram alerts, active on every dashboard page */}
      <JournalWatcher />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* extra bottom padding on mobile so content clears the tab bar */}
        <main className="flex-1 p-3 pb-24 sm:p-5 lg:pb-5">
          <PageShell>{children}</PageShell>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
