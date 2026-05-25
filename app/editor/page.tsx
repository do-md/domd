"use client";
import { Suspense } from "react";
import { EditorApp } from "@/features/editor";

export default function EditorPage() {
    return (
        <Suspense fallback={<div className="fixed inset-0 bg-base-100" />}>
            <EditorApp />
        </Suspense>
    );
}
