export { CollabBridge, type CollabControl } from "./components/collab-bridge";
export { collabImageLoader } from "./lib/collab-image-loader";
export { ShareModal } from "./components/share-modal";
export { VersioningPanel } from "./components/versioning-panel";
export { CollabApp } from "./components/collab-app";
export { clearDraft, loadDraft, saveDraft } from "./lib/collab-db";
export {
    deactivateRoom,
    deleteRoomData,
    getActiveHostRoom,
    loadRoomDocBytes,
} from "./lib/collab-store";
export { clearCollabDocId, setCollabDocId } from "./lib/collab-db-tauri";
export type { RoomRecord } from "./lib/types";
