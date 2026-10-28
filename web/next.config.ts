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
    // Uploads reach the backend through the /api/v1 rewrite, and Next cuts proxied bodies at 10 MB
    // by default (the request dies with "socket hang up"). The backend takes slides up to 20 MB and
    // audio up to 25 MB, so allow that plus multipart overhead.
    proxyClientMaxBodySize: "26mb",
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
