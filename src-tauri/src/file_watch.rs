//! External-change watcher for open documents.
//!
//! A single background task polls every open document once per second and
//! emits `file-changed` (payload: the path) to the owning webview when the
//! file's mtime or size moves. "Open" means the union of each window's
//! assigned file (WindowFiles) and every path in its tab strip (WindowTabs):
//! a background tab has no mounted editor, but its document is still open and
//! must not be silently overwritten when it returns to the foreground. Polling
//! over a
//! notify-based watcher on purpose: editors save via atomic rename (new
//! inode), cloud sync tools touch files in bursts, and a 1 Hz stat of a
//! handful of files is effectively free — no watcher lifecycle to manage.
//!
//! The frontend discards its own autosave echoes (it registers every write
//! it makes) and reconciles genuine external edits into the live document
//! via the kernel's batch replace primitive.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::{WindowFiles, WindowTabs};

#[derive(Clone, PartialEq)]
struct Fingerprint {
    mtime: SystemTime,
    len: u64,
}

pub async fn run(app: AppHandle) {
    // (window label, path) -> last observed fingerprint. Keyed by the pair,
    // not by the window: one window watches every document in its tab strip.
    // First sighting of a pair records a baseline WITHOUT emitting, so
    // opening a file does not fire a spurious change event.
    let mut seen: HashMap<(String, String), Fingerprint> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;

        let mut entries: Vec<(String, String)> = {
            let files = app.state::<WindowFiles>();
            let guard = files.0.lock().unwrap();
            guard
                .iter()
                .map(|(label, path)| (label.clone(), path.clone()))
                .collect()
        };
        // Tabs are the bigger set in practice; the window's assigned file is
        // usually among them, so dedupe rather than stat the same file twice.
        entries.extend(app.state::<WindowTabs>().entries());
        entries.sort();
        entries.dedup();

        seen.retain(|key, _| entries.contains(key));

        for key in entries {
            let (label, path) = (&key.0, &key.1);
            let Ok(meta) = std::fs::metadata(path) else {
                // Unreadable / deleted — drop the baseline so a reappearing
                // file is re-primed instead of compared against stale state.
                seen.remove(&key);
                continue;
            };
            let fingerprint = Fingerprint {
                mtime: meta.modified().unwrap_or(UNIX_EPOCH),
                len: meta.len(),
            };
            match seen.get(&key) {
                Some(prev) => {
                    if *prev != fingerprint {
                        let _ = app.emit_to(label.as_str(), "file-changed", path);
                        seen.insert(key, fingerprint);
                    }
                }
                None => {
                    // New window, new tab, or a window that switched
                    // documents — baseline without emitting.
                    seen.insert(key, fingerprint);
                }
            }
        }
    }
}
