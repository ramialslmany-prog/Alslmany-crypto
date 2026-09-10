import type { Config } from "tailwindcss";

/**
 * Alslmany design system — the single source of truth for tokens.
 *
 * Lane: financial broadsheet × trading terminal.
 * Ground is a warm near-black ("paper turned to night"), never navy.
 * Amber is the ONLY brand accent. Jade and crimson are reserved strictly for
 * market direction, so a colour on screen always carries meaning.
 * Radii stay small and rules stay hairline — instruments are not pillowy.
 */
const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Ground — warm neutral ramp, not blue-black
        ground: {
          950: "#08080A",
          900: "#0C0C0F",
          850: "#111116",
          800: "#16161C",
          750: "#1D1D25",
          700: "#26262F",
          600: "#33333E",
        },
        // Ink roles
        ink: {
          DEFAULT: "#EFEBE3",
          muted: "#A09B91",
          faint: "#6E6A62",
        },
        // The one brand accent
        amber: {
          DEFAULT: "#E8A33D",
          soft: "#FFCB7D",
          deep: "#8A5A14",
          wash: "rgba(232,163,61,0.10)",
        },
        // Direction only — never decorative
        bull: {
          DEFAULT: "#33D69F",
          soft: "#7CF0C4",
          deep: "#0E5F45",
          wash: "rgba(51,214,159,0.10)",
        },
        bear: {
          DEFAULT: "#FF4D6A",
          soft: "#FF93A5",
          deep: "#7A1526",
          wash: "rgba(255,77,106,0.10)",
        },
        rule: {
          DEFAULT: "rgba(239,235,227,0.10)",
          strong: "rgba(239,235,227,0.18)",
          faint: "rgba(239,235,227,0.055)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        // Body scale (~1.25) then a dramatic display jump (~1.333)
        "2xs": ["0.6875rem", { lineHeight: "1.35", letterSpacing: "0.04em" }],
        "display-sm": ["2.25rem", { lineHeight: "1.12", letterSpacing: "-0.015em" }],
        display: ["3.25rem", { lineHeight: "1.06", letterSpacing: "-0.02em" }],
        "display-lg": ["4.5rem", { lineHeight: "1.02", letterSpacing: "-0.025em" }],
        "display-xl": ["6rem", { lineHeight: "0.98", letterSpacing: "-0.03em" }],
      },
      borderRadius: {
        none: "0",
        sm: "2px",
        DEFAULT: "3px",
        md: "4px",
        lg: "6px",
        xl: "8px",
        "2xl": "12px",
      },
      boxShadow: {
        "elev-1": "0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -16px rgba(0,0,0,0.8)",
        "elev-2": "0 2px 4px rgba(0,0,0,0.45), 0 24px 60px -28px rgba(0,0,0,0.9)",
        "inset-hair": "inset 0 1px 0 0 rgba(239,235,227,0.06)",
        "amber-ring": "0 0 0 1px rgba(232,163,61,0.35), 0 10px 40px -20px rgba(232,163,61,0.6)",
      },
      backgroundImage: {
        "rule-grid":
          "linear-gradient(to right, rgba(239,235,227,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(239,235,227,0.035) 1px, transparent 1px)",
        "amber-bloom":
          "radial-gradient(60% 50% at 50% 0%, rgba(232,163,61,0.16), transparent 70%)",
        "ink-fade": "linear-gradient(180deg, rgba(239,235,227,0.06), transparent)",
      },
      backgroundSize: { grid: "64px 64px" },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        ticker: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "pulse-dot": {
          "0%,100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(0.82)" },
        },
        sweep: { "100%": { transform: "translateX(200%)" } },
        "bar-grow": {
          "0%": { transform: "scaleX(0)" },
          "100%": { transform: "scaleX(1)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s cubic-bezier(0.22,1,0.36,1) both",
        "fade-in": "fade-in 0.5s cubic-bezier(0.22,1,0.36,1) both",
        ticker: "ticker 60s linear infinite",
        "pulse-dot": "pulse-dot 2s cubic-bezier(0.22,1,0.36,1) infinite",
        sweep: "sweep 2.4s cubic-bezier(0.22,1,0.36,1) infinite",
        "bar-grow": "bar-grow 0.9s cubic-bezier(0.22,1,0.36,1) both",
      },
      transitionTimingFunction: {
        instrument: "cubic-bezier(0.22,1,0.36,1)",
      },
    },
  },
  plugins: [],
};

export default config;
