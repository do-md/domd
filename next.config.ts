import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "export",
    images: { unoptimized: true },
    allowedDevOrigins: ["home3000.domd.app"],
};

export default nextConfig;
