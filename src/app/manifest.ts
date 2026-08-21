import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Español Coach",
    short_name: "Español",
    description: "Entrenador personal de español mexicano B2→C1",
    start_url: "/",
    display: "standalone",
    background_color: "#f8f2e7",
    theme_color: "#f8f2e7",
    lang: "es-MX",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
