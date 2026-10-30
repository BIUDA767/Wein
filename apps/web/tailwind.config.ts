import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Graphite and black surfaces.
        ink: { 950: "#05060a", 900: "#0a0c12", 850: "#0e1119", 800: "#131722", 700: "#1b2030", 600: "#242a3d" },
        // Restrained emerald accent.
        emerald: { 400: "#3ddc97", 500: "#10b981", 600: "#059669", 700: "#047857" },
        // Ruby accent for risk and sell.
        ruby: { 400: "#ff5c7a", 500: "#f43f5e", 600: "#e11d48" },
        // Champagne detailing.
        champagne: { 300: "#f4e4bc", 400: "#e8d5a3", 500: "#d4b878", 600: "#b89a5c" },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
        glow: "0 0 24px rgba(16,185,129,0.25)",
        rubyglow: "0 0 24px rgba(244,63,94,0.25)",
      },
      backdropBlur: { xs: "2px" },
      keyframes: {
        "fade-up": { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "slide-up": { "0%": { transform: "translateY(100%)" }, "100%": { transform: "translateY(0)" } },
        "pulse-soft": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.55" } },
        breathe: { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.035)" } },
        "ticker-flash": { "0%": { backgroundColor: "rgba(61,220,151,0.18)" }, "100%": { backgroundColor: "transparent" } },
      },
      animation: {
        "fade-up": "fade-up 0.32s cubic-bezier(0.22,1,0.36,1)",
        "slide-up": "slide-up 0.34s cubic-bezier(0.22,1,0.36,1)",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite",
        breathe: "breathe 4.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
