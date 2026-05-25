import type { Metadata } from "next";
import "./globals.css";
import "./prism-themes.css";

export const metadata: Metadata = {
    title: "DOMD",
    description: "Markdown editor",
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
                {children}
            </body>
        </html>
    );
}
