import { cn } from "@/lib/utils";

type GlassCardProps = React.HTMLAttributes<HTMLDivElement> & {
  glow?: boolean;
  as?: React.ElementType;
};

/** The workhorse surface: glassmorphic panel with optional hairline glow border. */
export function GlassCard({ className, glow = true, as: Tag = "div", children, ...props }: GlassCardProps) {
  return (
    <Tag
      className={cn(
        "glass rounded-2xl",
        glow && "glow-border",
        "transition-transform duration-500 ease-out-quint",
        className
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
