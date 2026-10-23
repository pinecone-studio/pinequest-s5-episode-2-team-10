import type { NextConfig } from "next";

const backend = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  /* config options here */
  // The dev server can be opened from another computer, by IP or a .local name.
  allowedDevOrigins: ["*.*.*.*", "**.local"],
  cacheComponents: true,
  partialPrefetching: true,
  // The browser calls /api/v1 on this app and Next forwards it to the FastAPI backend, so a deployed
  // site reaches the API without that host allowing our origin (CORS).
  async rewrites() {
    if (!backend) return [];
    return [{ source: "/api/v1/:path*", destination: `${backend}/api/v1/:path*` }];
  },
  experimental: {
    // Don't reuse `next dev` output across restarts (.next/dev/cache). CSS through the Tailwind
    // loader could stay stale after a git pull or branch switch, and restarting kept serving it.
    turbopackFileSystemCacheForDev: false,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
