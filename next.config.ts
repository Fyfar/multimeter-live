import type { NextConfig } from "next";

// Base path for GitHub Pages project-site hosting (e.g. "/multimeter-live").
// Empty by default so `next dev` and root-hosted builds serve from "/".
// The deploy workflow sets PAGES_BASE_PATH to the repo subpath.
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Emit a fully static site to `out/` (no Node server) for GitHub Pages.
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
};

export default nextConfig;
