import type { Config } from "tailwindcss";

/**
 * Quantum design system — token source of truth.
 * Lane: dark-cinematic × technical-precise.
 * Color roles are named by intent, not hue, so theming stays trivial.
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
        // Backgrounds — deep space navy ramp
        base: {
          950: "#060816",
          900: "#0B1020",
          850: "#0E1424",
          800: "#101826",
          700: "#16203A",
          600: "#1E2A47",
        },
        // Text / ink roles
        ink: {
          DEFAULT: "#E8ECF6",
          muted: "#8A94B0",
          faint: "#566180",
        },
        // Accents
        cyan: { DEFAULT: "#00D4FF", soft: "#5BE7FF" },
        violet: { DEFAULT: "#7C4DFF", soft: "#A98BFF" },
        bull: { DEFAULT: "#00E676", soft: "#5BFFB0" },
        bear: { DEFAULT: "#FF4D6D", soft: "#FF8AA0" },
        gold: { DEFAULT: "#FFD166", soft: "#FFE3A3" },
        line: "rgba(255,255,255,0.08)",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        // Dramatic display scale (~1.333)
        "display-sm": ["2.6rem", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
        display: ["3.6rem", { lineHeight: "1.02", letterSpacing: "-0.025em" }],
        "display-lg": ["5rem", { lineHeight: "0.98", letterSpacing: "-0.03em" }],
        "display-xl": ["6.5rem", { lineHeight: "0.95", letterSpacing: "-0.035em" }],
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        "glow-cyan": "0 0 0 1px rgba(0,212,255,0.25), 0 8px 40px -8px rgba(0,212,255,0.45)",
        "glow-violet": "0 0 0 1px rgba(124,77,255,0.25), 0 8px 40px -8px rgba(124,77,255,0.5)",
        glass: "0 1px 0 0 rgba(255,255,255,0.06) inset, 0 20px 60px -20px rgba(0,0,0,0.7)",
        "elev-1": "0 10px 30px -12px rgba(0,0,0,0.6)",
        "elev-2": "0 30px 80px -24px rgba(0,0,0,0.75)",
      },
      backgroundImage: {
        "grid-faint":
          "linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px)",
        "radial-fade":
          "radial-gradient(circle at 50% 0%, rgba(124,77,255,0.18), transparent 60%)",
        "cyan-violet": "linear-gradient(135deg, #00D4FF 0%, #7C4DFF 100%)",
      },
      backgroundSize: {
        grid: "56px 56px",
      },
      keyframes: {
        float: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-14px)" },
        },
        "aurora-shift": {
          "0%,100%": { transform: "translate(0,0) scale(1)", opacity: "0.65" },
          "33%": { transform: "translate(6%,-4%) scale(1.12)", opacity: "0.85" },
          "66%": { transform: "translate(-5%,5%) scale(0.95)", opacity: "0.55" },
        },
        "pulse-glow": {
          "0%,100%": { opacity: "1", boxShadow: "0 0 0 0 rgba(0,212,255,0.45)" },
          "50%": { opacity: "0.85", boxShadow: "0 0 0 8px rgba(0,212,255,0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        float: "float 7s ease-in-out infinite",
        "aurora-1": "aurora-shift 18s ease-in-out infinite",
        "aurora-2": "aurora-shift 24s ease-in-out infinite reverse",
        "pulse-glow": "pulse-glow 2.4s cubic-bezier(0.22,1,0.36,1) infinite",
        shimmer: "shimmer 2.2s infinite",
        marquee: "marquee 38s linear infinite",
        "spin-slow": "spin-slow 22s linear infinite",
        "fade-up": "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) both",
      },
      transitionTimingFunction: {
        "out-quint": "cubic-bezier(0.22,1,0.36,1)",
      },
    },
  },
  plugins: [],
};

export default config;
