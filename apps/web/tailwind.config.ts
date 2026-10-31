import type { Config } from "tailwindcss";

/**
 * WEIN design system. Dark only, by specification.
 *
 * The token names predate this palette (ink/emerald/ruby/champagne) and are kept so
 * existing markup keeps working; the values are the specified WEIN colours.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Black and graphite surfaces. Background runs #0A0A0B -> #121214.
        ink: {
          950: "#0A0A0B", // app background
          900: "#0E0E10", // elevated background
          850: "#121214", // background light end / sheets
          800: "#1C1C1F", // cards
          700: "#252528", // inputs
          600: "#2E2E33", // hairlines, hover
        },
        // Emerald trading accent -> specified green.
        emerald: { 400: "#34D96A", 500: "#00C853", 600: "#00A344", 700: "#008036" },
        // Ruby accent for sell and loss -> specified red.
        ruby: { 400: "#FF6B62", 500: "#FF3B30", 600: "#D92B21" },
        // Gold detailing -> specified gold.
        champagne: { 300: "#E8CE7A", 400: "#DFC25A", 500: "#D4AF37", 600: "#A98A2B" },
        // Metallic silver: structural detailing, edges and the crystal emblem.
        silver: { 100: "#F2F5F8", 200: "#DDE3E9", 300: "#C3CBD4", 400: "#A6AFBA", 500: "#8A939F", 600: "#6C7481" },
        // Restrained cyan for PHIRST2 only.
        cyan: { 300: "#7FF0FF", 400: "#3DDCFF", 500: "#00C2E0", 600: "#0092AA" },
        muted: "#A0A0A5",
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        card: "14px", // cards 12-16px
        pill: "30px", // large buttons 28-32px
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
        glow: "0 0 24px rgba(0,200,83,0.25)",
        rubyglow: "0 0 24px rgba(255,59,48,0.25)",
        cyanglow: "0 0 22px rgba(61,220,255,0.35)",
        goldglow: "0 0 22px rgba(212,175,55,0.28)",
        silverglow: "0 0 20px rgba(198,208,219,0.18)",
        // Metallic top edge: a thin specular line that reads as brushed metal.
        edge: "inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(0,0,0,0.35)",
      },
      backgroundImage: {
        "metal-sheen":
          "linear-gradient(180deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.012) 38%, rgba(0,0,0,0.10) 100%)",
      },
      backdropBlur: { xs: "2px" },
      keyframes: {
        "fade-up": { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "slide-up": { "0%": { transform: "translateY(100%)" }, "100%": { transform: "translateY(0)" } },
        "pulse-soft": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.55" } },
        breathe: { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.035)" } },
        "ticker-flash": { "0%": { backgroundColor: "rgba(0,200,83,0.18)" }, "100%": { backgroundColor: "transparent" } },
        "wave-bar": { "0%,100%": { transform: "scaleY(0.32)" }, "50%": { transform: "scaleY(1)" } },
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
