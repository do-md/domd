"use client";

import { memo } from "react";

/**
 * Table glyph (filled-outline style, 1024 grid). Its stroke thickness
 * (~69 units on the 1024 grid) is the reference line weight for every icon
 * in features/icons — match new icons to it (see checklist-icon.tsx for the
 * stroke-compensation trick when a source path is thinner).
 */
function TableIconBase({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 1024 1024"
            fill="currentColor"
            className={className}
            aria-hidden="true"
        >
            <path d="M141.074286 906.496h741.851428c89.581714 0 134.582857-44.562286 134.582857-132.845714V250.331429c0-88.283429-45.001143-132.845714-134.582857-132.845715H141.074286C51.931429 117.504 6.491429 161.645714 6.491429 250.331429V773.668571c0 88.704 45.44 132.845714 134.582857 132.845715zM75.501714 253.805714c0-44.580571 23.990857-67.291429 66.852572-67.291428h339.437714v176.566857H75.483429z m466.706286 109.275429V186.514286h339.437714c42.422857 0 66.852571 22.710857 66.852572 67.291428v109.275429z m0 237.44v-177.005714h406.290286v177.005714z m-60.416-177.005714v177.005714H75.483429v-177.005714zM881.645714 837.485714H542.208v-176.548571h406.290286v109.275428c0 44.580571-24.429714 67.291429-66.852572 67.291429z m-739.291428 0c-42.861714 0-66.852571-22.692571-66.852572-67.273143v-109.293714h406.290286v176.585143z" />
        </svg>
    );
}

export const TableIcon = memo(TableIconBase);
