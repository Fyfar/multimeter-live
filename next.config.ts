import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Base path for GitHub Pages project-site hosting (e.g. "/multimeter-live").
// Empty by default so `next dev` and root-hosted builds serve from "/".
// The deploy workflow sets PAGES_BASE_PATH to the repo subpath.
const basePath = process.env.PAGES_BASE_PATH ?? "";

// Deterministic, content-derived build id.
//
// Next's default buildId is random per build. It is stamped into index.html and
// the `_next/static/<buildId>/` path, both of which the PWA precaches and feeds
// into the service worker's content-version hash. A random id therefore makes the
// SW version change on EVERY build — even a rebuild with zero source changes (a
// docs-only commit, a CI re-run) — so every client gets a spurious "A new version
// is available — Reload" prompt with nothing actually to update.
//
// Hashing the inputs that determine build output instead makes the id (and thus
// the whole build) reproducible: stable when source is unchanged, different when
// the app genuinely changes. Unlike a constant id this stays safe for online
// (non-PWA) users — changed content yields a new `_next/static/<id>/` folder, so
// a stable URL never serves stale-but-differing bytes through the CDN cache.
// Docs files (README, AGENTS.md, …) are intentionally NOT in the input set, so a
// docs-only deploy produces a byte-identical build and prompts no one.
const BUILD_INPUTS = [
  "app",
  "components",
  "lib",
  "public",
  "types",
  "next.config.ts",
  "postcss.config.mjs",
  "tsconfig.json",
  "package.json",
  "package-lock.json", // dependency/toolchain bumps change emitted bundles
];

function hashPath(path: string, hash: ReturnType<typeof createHash>) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return; // missing optional input — ignore
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      hashPath(join(path, entry), hash);
    }
  } else {
    hash.update(path);
    hash.update(readFileSync(path));
  }
}

function contentBuildId(): string {
  const hash = createHash("sha256");
  for (const input of BUILD_INPUTS) hashPath(input, hash);
  return hash.digest("hex").slice(0, 20);
}

const nextConfig: NextConfig = {
  // Emit a fully static site to `out/` (no Node server) for GitHub Pages.
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
  generateBuildId: contentBuildId,
};

export default nextConfig;
