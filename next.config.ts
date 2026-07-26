import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    output: "export",
    images: { unoptimized: true },
    // 127.0.0.1 doubles as a second isolated origin (separate IndexedDB) for
    // testing collaboration host + guest on one machine.
    allowedDevOrigins: ["home3000.domd.app", "127.0.0.1"],
};

export default nextConfig;
