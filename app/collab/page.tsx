import type { Metadata } from "next";
import { Suspense } from "react";
import { CollabApp } from "@/features/collaboration";

export const metadata: Metadata = {
    title: "DOMD — Collaborative editing",
    description:
        "Join a DOMD collaborative editing session. Peer-to-peer over WebRTC — the document never touches a server.",
    robots: { index: false },
};

export default function CollabPage() {
    return (
        <Suspense fallback={<div className="fixed inset-0 bg-base-100" />}>
            <CollabApp />
        </Suspense>
    );
}
