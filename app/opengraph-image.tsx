import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const alt = "DOMD — A WYSIWYG Markdown editor powered by a 20 KB engine";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BRAND = "rgb(60, 124, 171)";

export default function OpengraphImage() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    background: "#ffffff",
                    padding: "80px",
                    fontFamily: "sans-serif",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
                    <div
                        style={{
                            width: 72,
                            height: 72,
                            borderRadius: 18,
                            background: BRAND,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#ffffff",
                            fontSize: 40,
                            fontWeight: 700,
                        }}
                    >
                        M
                    </div>
                    <div style={{ fontSize: 44, fontWeight: 700, color: "#111827", letterSpacing: -1 }}>
                        DOMD
                    </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                    <div
                        style={{
                            fontSize: 68,
                            fontWeight: 800,
                            color: "#111827",
                            lineHeight: 1.1,
                            letterSpacing: -2,
                        }}
                    >
                        A clean WYSIWYG Markdown editor
                    </div>
                    <div style={{ fontSize: 34, color: "#4b5563", lineHeight: 1.35 }}>
                        Powered by a 20 KB, from-scratch, Markdown-native engine. Built for fast
                        editing, huge files, and real-time AI streaming.
                    </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ height: 6, width: 64, borderRadius: 3, background: BRAND }} />
                    <div style={{ fontSize: 28, color: BRAND, fontWeight: 600 }}>www.domd.app</div>
                </div>
            </div>
        ),
        size
    );
}
