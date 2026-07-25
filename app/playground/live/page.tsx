import type { Metadata } from "next";
import { LivePlaygroundApp } from "@/features/playground/components/live/live-playground-app";

export const metadata: Metadata = {
    title: "DOMD Live Collaboration Playground — realtime op replay",
    description:
        "Multiple clients editing the same document in realtime: span-level op replay (O(change) rendering), remote colored carets, conflict-free merge. Every new tab joins as one more collaborator.",
    robots: { index: false },
};

export default function LivePlaygroundPage() {
    return <LivePlaygroundApp />;
}
