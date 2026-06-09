import type { Metadata } from "next";
import { ChatApp } from "@/features/chat";

export const metadata: Metadata = {
    title: "DOMD Playground — Markdown-native AI chat",
    description:
        "Use DOMD as both the input and output surface for AI chat: write prompts with live Markdown editing and stream Markdown back into a rendered, editable response. Mock streaming works with no API key; bring your own key for real models.",
};

export default function ChatPlaygroundPage() {
    return <ChatApp />;
}
