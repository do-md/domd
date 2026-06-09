import type { MetadataRoute } from "next";

const SITE_URL = "https://www.domd.app";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
    return [
        {
            url: `${SITE_URL}/`,
            changeFrequency: "weekly",
            priority: 1,
        },
        {
            url: `${SITE_URL}/editor`,
            changeFrequency: "monthly",
            priority: 0.9,
        },
        {
            url: `${SITE_URL}/playground`,
            changeFrequency: "monthly",
            priority: 0.7,
        },
        {
            url: `${SITE_URL}/chat`,
            changeFrequency: "monthly",
            priority: 0.7,
        },
    ];
}
