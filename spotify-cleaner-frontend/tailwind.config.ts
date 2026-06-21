import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    // Restrict fontSize to the exact 8-value type scale
    fontSize: {
      xs:    "12px",
      sm:    "14px",
      base:  "16px",
      xl:    "20px",
      "2xl": "24px",
      "3xl": "32px",
      "5xl": "48px",
      "7xl": "64px",
    },
    extend: {
      colors: {
        // Background tokens
        "bg-base":         "var(--color-bg-base)",
        "bg-surface":      "var(--color-bg-surface)",
        "bg-surface-hover":"var(--color-bg-surface-hover)",
        // Accent tokens
        brand:   "var(--color-brand)",
        danger:  "var(--color-danger)",
        // Text tokens
        primary: "var(--color-text-primary)",
        muted:   "var(--color-text-muted)",
      },
      boxShadow: {
        elevated: "var(--shadow-elevated)",
        "glass-panel": "var(--shadow-glass-panel)",
      },
      borderRadius: {
        card: "var(--radius-card)",
        pill: "var(--radius-pill)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
