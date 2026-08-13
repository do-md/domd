"use client";

import { memo } from "react";

/**
 * Table glyph (filled-outline style, 1024 grid). Its stroke thickness
 * (~69 units on the 1024 grid) is the reference line weight for every icon
 * in features/icons — match new icons to it (see checklist-icon.tsx for the
 * stroke-compensation trick when a source path is thinner).
 */
function PlusIconBase({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5906"><path d="M474 152m8 0l60 0q8 0 8 8l0 704q0 8-8 8l-60 0q-8 0-8-8l0-704q0-8 8-8Z" fill="currentColor" p-id="5907"></path><path d="M168 474m8 0l672 0q8 0 8 8l0 60q0 8-8 8l-672 0q-8 0-8-8l0-60q0-8 8-8Z" fill="currentColor" p-id="5908"></path></svg>
    );
}

export const PlusIcon = memo(PlusIconBase);
