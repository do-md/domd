import type { Metadata } from "next";
import { CrdtPlaygroundApp } from "@/features/playground/components/crdt/crdt-playground-app";

export const metadata: Metadata = {
    title: "DOMD CRDT Merge Playground — conflict-free two-client sync",
    description:
        "Split-screen two-client simulation of DOMD's span-level CRDT sync: edit independently, merge in either direction via yjs, converge without losing text.",
    robots: { index: false },
};

export default function CrdtPlaygroundPage() {
    return <CrdtPlaygroundApp />;
}
