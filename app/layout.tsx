import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { I18nProvider } from "@/common/i18n/provider";
import "./globals.css";
import "./prism-themes.css";

const SITE_URL = "https://www.domd.app";

export const metadata: Metadata = {
    metadataBase: new URL(SITE_URL),
    title: "DOMD — WYSIWYG Markdown editor",
    description:
        "A WYSIWYG Markdown editor powered by a 20 KB, from-scratch, Markdown-native engine. Built for fast human editing, huge files, and real-time AI streaming.",
    applicationName: "DOMD",
    authors: [{ name: "DOMD" }],
    creator: "DOMD",
    publisher: "DOMD",
    keywords: [
        "Markdown editor",
        "WYSIWYG Markdown",
        "Markdown WYSIWYG editor",
        "Markdown editor for Mac",
        "macOS Markdown app",
        "local-first Markdown",
        "AI streaming Markdown",
        "Markdown rendering engine",
        "Typora alternative",
        "MarkEdit alternative",
    ],
    robots: {
        index: true,
        follow: true,
        googleBot: {
            index: true,
            follow: true,
            "max-image-preview": "large",
            "max-snippet": -1,
            "max-video-preview": -1,
        },
    },
    openGraph: {
        type: "website",
        siteName: "DOMD",
        locale: "en_US",
        url: SITE_URL,
        title: "DOMD — WYSIWYG Markdown editor",
        description:
            "A WYSIWYG Markdown editor powered by a 20 KB, from-scratch, Markdown-native engine. Built for fast human editing, huge files, and real-time AI streaming.",
    },
    twitter: {
        card: "summary_large_image",
        title: "DOMD — WYSIWYG Markdown editor",
        description:
            "A WYSIWYG Markdown editor powered by a 20 KB, from-scratch, Markdown-native engine. Built for fast human editing, huge files, and real-time AI streaming.",
    },
};

/**
 * Runs synchronously before React hydrates so `data-theme` is set on the
 * first paint (no FOUC). localStorage wins over OS; if the user hasn't
 * opted-in, we follow `prefers-color-scheme` and stay subscribed to OS flips.
 */
const themeInitScript = `
(function () {
  var read = function () {
    try { return localStorage.getItem("theme"); } catch (_) { return null; }
  };
  var osDark = function () {
    return matchMedia("(prefers-color-scheme: dark)").matches;
  };
  document.documentElement.dataset.theme = read() || (osDark() ? "dark" : "light");
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
    if (read()) return;
    document.documentElement.dataset.theme = e.matches ? "dark" : "light";
  });
})();
`;

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className="h-full" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
            </head>
            <body className="h-full bg-base-100 text-base-content">
                <I18nProvider>{children}</I18nProvider>
                <Analytics />
            </body>
        </html>
    );
}
