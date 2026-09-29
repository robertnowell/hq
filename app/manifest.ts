import type { MetadataRoute } from "next";

/**
 * Installable. "Add to Home Screen" on the phone and "Install app" in Chrome
 * both read this; the hub then opens as its own window with its own icon,
 * which is the one-tab shape Robert asked for on 10 Sep.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tranquility Knowledge Base",
    short_name: "Knowledge Base",
    description: "Everything your agents have written, in one place.",
    start_url: "/",
    display: "standalone",
    background_color: "#fcfbf8",
    theme_color: "#1f1e1c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
