import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "export",
    images: { unoptimized: true },
    allowedDevOrigins: ["*"],
};

export default nextConfig;
