//! Per-window "ready" signal.
//!
//! The editor calls this command from a useEffect chained behind two
//! requestAnimationFrame ticks — i.e. after React has committed and the
//! window has actually painted. We use it for two things:
//!
//! 1. **Cold-start telemetry**: write a one-shot file the first time *any*
//!    window goes ready, so an external benchmark harness can measure
//!    process-launch → first-meaningful-paint.
//! 2. **CLI readiness gate**: record which specific window is ready so
//!    `domd-cli insert` issued right after `new` waits for the listener
//!    to be subscribed before the event is emitted.

use std::fs;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{State, Window};

use crate::WindowReady;

const SIGNAL_PATH: &str = "/tmp/domd-benchmark-ready.signal";
static FIRED: OnceLock<()> = OnceLock::new();

#[tauri::command]
pub fn benchmark_mark_ready(window: Window, state: State<WindowReady>) {
    state.mark(window.label());

    if FIRED.set(()).is_ok() {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|_| String::from("0"));
        let _ = fs::write(SIGNAL_PATH, millis);
    }
}
