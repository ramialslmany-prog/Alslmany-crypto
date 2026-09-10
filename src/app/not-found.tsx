import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="num text-display-sm text-amber">404</p>
      <h1 className="font-display text-2xl text-ink">الصفحة غير موجودة · Page not found</h1>
      <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
        الرابط الذي فتحته لا يقود إلى شيء. — This link does not lead anywhere.
      </p>
      <Link href="/" className="btn btn-primary">
        الرئيسية · Home
      </Link>
    </main>
  );
}
