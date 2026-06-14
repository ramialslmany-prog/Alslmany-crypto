import Link from "next/link";
import { cn } from "@/lib/utils";

type Variant = "primary" | "ghost" | "outline";

type Props = {
  href?: string;
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

const base =
  "group relative inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold tracking-tight transition-all duration-300 ease-out-quint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base-950 disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary:
    "text-base-950 bg-cyan-violet shadow-[0_8px_30px_-8px_rgba(0,212,255,0.6)] hover:shadow-[0_12px_44px_-8px_rgba(124,77,255,0.75)] hover:-translate-y-0.5",
  outline:
    "text-ink border border-white/15 bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/25 hover:-translate-y-0.5",
  ghost: "text-ink-muted hover:text-ink",
};

export function GlowButton({ href, variant = "primary", className, children, ...rest }: Props) {
  const cls = cn(base, variants[variant], className);
  const inner = (
    <>
      {variant === "primary" && (
        <span className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100 [background:radial-gradient(120px_60px_at_50%_120%,rgba(255,255,255,0.35),transparent)]" />
      )}
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button className={cls} {...rest}>
      {inner}
    </button>
  );
}
