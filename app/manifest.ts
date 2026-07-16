import type { MetadataRoute } from "next";

// Minimal PWA manifest so the app installs cleanly on Home Screen / Dock.
// Icons: /icon.svg (scalable) is auto-wired by Next from app/icon.svg; the
// 512 PNG lives under public/ for Android/PWA installers that need a raster.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vidi",
    short_name: "Vidi",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#FF6D4D",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
}
