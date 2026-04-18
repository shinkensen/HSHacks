import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
