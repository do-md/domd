"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isTauri } from "@/common/lib/platform";

// Tiny client island. The Tauri webview should never see the marketing page;
// redirect it to /editor on mount. Renders nothing.
export function TauriRedirect() {
    const router = useRouter();
    useEffect(() => {
        if (isTauri()) router.replace("/editor");
    }, [router]);
    return null;
}
