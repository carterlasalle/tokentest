import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The plugin enables the automatic JSX runtime; without it Vite's default
// classic transform emits React.createElement references and the bundle
// crashes with "React is not defined" (blank page).
export default defineConfig({
  plugins: [react()],
});
