import type { NextConfig } from "next";

const backend = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The browser calls /api/v1 on this app and Next forwards it to the FastAPI backend, so a deployed
  // site reaches the API without that host allowing our origin (CORS).
  async rewrites() {
    if (!backend) return [];
    return [{ source: "/api/v1/:path*", destination: `${backend}/api/v1/:path*` }];
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
