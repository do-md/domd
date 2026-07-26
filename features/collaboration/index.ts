export { CollabBridge, type CollabControl } from "./components/collab-bridge";
export { collabImageLoader } from "./lib/collab-image-loader";
export { ShareModal } from "./components/share-modal";
export { CollabApp } from "./components/collab-app";
export {
    clearDraft,
    deactivateRoom,
    deleteRoomData,
    getActiveHostRoom,
    loadDraft,
    loadRoomDocBytes,
    saveDraft,
} from "./lib/collab-db";
export type { RoomRecord } from "./lib/types";
