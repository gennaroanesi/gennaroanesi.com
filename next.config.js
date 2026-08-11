/** @type {import('next').NextConfig} */

const { hostname } = require("os");

const nextConfig = {
  reactStrictMode: true,
  images: {
    formats: ["image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "picsum.photos",
      },
    ],
  },
  async redirects() {
    return [
      // The "Recurring" section became "Scheduled" (route renamed). Preserve old
      // bookmarks / deep links (?new=1 &c.) — query string is carried through.
      { source: "/finance/recurring", destination: "/finance/scheduled", permanent: true },
    ];
  },
};

module.exports = nextConfig;
