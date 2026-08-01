//! External-change watcher for open documents.
//!
//! A single background task polls every window's assigned file (WindowFiles)
//! once per second and emits `file-changed` (payload: the path) to the
//! owning webview when the file's mtime or size moves. Polling over a
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

use crate::WindowFiles;

#[derive(Clone, PartialEq)]
struct Fingerprint {
    path: String,
    mtime: SystemTime,
    len: u64,
}

pub async fn run(app: AppHandle) {
    // label -> last observed fingerprint. First sighting of a (label, path)
    // pair records a baseline WITHOUT emitting, so opening a file does not
    // fire a spurious change event.
    let mut seen: HashMap<String, Fingerprint> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;

        let entries: Vec<(String, String)> = {
            let files = app.state::<WindowFiles>();
            let guard = files.0.lock().unwrap();
            guard
                .iter()
                .map(|(label, path)| (label.clone(), path.clone()))
                .collect()
        };

        seen.retain(|label, _| entries.iter().any(|(l, _)| l == label));

        for (label, path) in entries {
            let Ok(meta) = std::fs::metadata(&path) else {
                // Unreadable / deleted — drop the baseline so a reappearing
                // file is re-primed instead of compared against stale state.
                seen.remove(&label);
                continue;
            };
            let fingerprint = Fingerprint {
                path: path.clone(),
                mtime: meta.modified().unwrap_or(UNIX_EPOCH),
                len: meta.len(),
            };
            match seen.get(&label) {
                Some(prev) if prev.path == path => {
                    if *prev != fingerprint {
                        seen.insert(label.clone(), fingerprint);
                        let _ = app.emit_to(label.as_str(), "file-changed", path);
                    }
                }
                _ => {
                    // New window or the window switched documents — baseline.
                    seen.insert(label.clone(), fingerprint);
                }
            }
        }
    }
}
