/**
 * The API is proxied through Next so the browser sees a single origin.
 * That keeps session cookies first-party and removes any need for CORS.
 */
const API_BASE = process.env.PHIRST_API_INTERNAL ?? "http://localhost:12001";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_BASE}/api/:path*` }];
  },
};
export default nextConfig;
