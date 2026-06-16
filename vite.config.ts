import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
    const isGitHubPages = mode === "github-pages";
    const base = isGitHubPages ? "/Lexora/" : "/";
    
    return {
        base,
        build: {
            outDir: "docs",
            emptyOutDir: true
        },
        plugins: [
            tailwindcss(),
            react(),
            VitePWA({
                registerType: "autoUpdate",
                includeAssets: ["lexora.svg"],
                manifest: {
                    name: "Lexora",
                    short_name: "Lexora",
                    description: "Offline-first vocabulary and phrase learning.",
                    theme_color: "#f8fafc",
                    background_color: "#f8fafc",
                    display: "standalone",
                    start_url: base,
                    icons: [
                        {
                            src: `${base}lexora.svg`,
                            sizes: "192x192",
                            type: "image/svg+xml",
                            purpose: "any maskable"
                        }
                    ]
                },
                workbox: {
                    globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"]
                }
            })
        ]
    }
});
