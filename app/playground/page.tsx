import type { Metadata } from "next";
import { PlaygroundApp } from "@/features/playground";

export const metadata: Metadata = {
    title: "DOMD Playground — AI-style Markdown streaming",
    description:
        "Stress-test a 20 KB WYSIWYG Markdown core with AI-style streaming: arbitrary chunks, broken syntax boundaries, and documents up to 20,000 lines — editable while streaming.",
};

export default function PlaygroundPage() {
    return <PlaygroundApp />;
}
