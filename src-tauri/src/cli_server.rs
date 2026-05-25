use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::{
    open_or_reuse, wait_for_window_ready, SelectionState, WindowContents, WindowFiles, WindowReady,
    WindowSelections,
};

// ── wire protocol ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Request {
    Ping,
    NewWindow,
    Insert {
        window_id: Option<String>,
        text: String,
    },
    /// List all open windows + their path / focus / dirty state.
    ListWindows,
    /// Read current selection snapshot for a window.
    Selection {
        window_id: Option<String>,
    },
    /// Read full markdown content for a window.
    Content {
        window_id: Option<String>,
    },
    /// Open / focus / reuse a window for an existing file path.
    OpenFile {
        path: String,
    },
    /// Save current window content to disk. If `path` is supplied, performs a
    /// save-as (and updates the window's tracked path + title).
    Save {
        window_id: Option<String>,
        path: Option<String>,
    },
    /// Close a window. `force=true` discards unsaved changes.
    Close {
        window_id: Option<String>,
        force: Option<bool>,
    },
    /// Bring a window to the front.
    Focus {
        window_id: Option<String>,
    },
}

#[derive(Serialize, Default)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,

    // Optional data fields — only the ones relevant per command get filled.
    #[serde(skip_serializing_if = "Option::is_none")]
    window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    was_already_open: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    windows: Option<Vec<WindowInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selection: Option<SelectionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

#[derive(Serialize, Clone)]
struct WindowInfo {
    window_id: String,
    path: Option<String>,
    name: String,
    is_focused: bool,
    has_unsaved_changes: bool,
}

#[derive(Serialize, Clone)]
struct InsertPayload {
    text: String,
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn err(code: &str, msg: impl Into<String>) -> Response {
    Response {
        ok: false,
        error_code: Some(code.to_string()),
        error: Some(msg.into()),
        ..Default::default()
    }
}

fn ok() -> Response {
    Response {
        ok: true,
        ..Default::default()
    }
}

/// Resolve a caller-supplied window id, falling back to the currently focused
/// window when None. Returns None if no matching window exists.
fn resolve_window(app: &AppHandle, window_id: Option<String>) -> Option<String> {
    match window_id {
        Some(id) => app.get_webview_window(&id).map(|_| id),
        None => app
            .webview_windows()
            .into_iter()
            .find(|(_, w)| w.is_focused().unwrap_or(false))
            .map(|(label, _)| label),
    }
}

fn socket_path(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let dir = home.join(".domd");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("cli.sock"))
}

// ── server loop ──────────────────────────────────────────────────────────────

pub async fn run(app: AppHandle) {
    let Some(path) = socket_path(&app) else {
        eprintln!("[cli_server] could not resolve socket path");
        return;
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[cli_server] bind {} failed: {}", path.display(), e);
            return;
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&path) {
            let mut perm = meta.permissions();
            perm.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perm);
        }
    }
    eprintln!("[cli_server] listening on {}", path.display());

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = handle_client(stream, app).await {
                        eprintln!("[cli_server] client error: {}", e);
                    }
                });
            }
            Err(e) => {
                eprintln!("[cli_server] accept failed: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle_client(stream: UnixStream, app: AppHandle) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(line) {
            Ok(req) => dispatch(&app, req).await,
            Err(e) => err("parse_error", format!("parse: {}", e)),
        };
        let mut json = serde_json::to_vec(&response).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
        json.push(b'\n');
        write.write_all(&json).await?;
        write.flush().await?;
    }
    Ok(())
}

// ── dispatch ─────────────────────────────────────────────────────────────────

async fn dispatch(app: &AppHandle, req: Request) -> Response {
    match req {
        Request::Ping => ok(),
        Request::NewWindow => handle_new_window(app).await,
        Request::Insert { window_id, text } => handle_insert(app, window_id, text).await,
        Request::ListWindows => handle_list(app),
        Request::Selection { window_id } => handle_selection(app, window_id).await,
        Request::Content { window_id } => handle_content(app, window_id).await,
        Request::OpenFile { path } => handle_open_file(app, path).await,
        Request::Save { window_id, path } => handle_save(app, window_id, path).await,
        Request::Close { window_id, force } => handle_close(app, window_id, force).await,
        Request::Focus { window_id } => handle_focus(app, window_id),
    }
}

async fn handle_new_window(app: &AppHandle) -> Response {
    let label = crate::new_empty_window(app);
    let ready = app.state::<WindowReady>();
    let ready_ok = wait_for_window_ready(&ready, &label, Duration::from_secs(10)).await;
    Response {
        ok: ready_ok,
        window_id: Some(label),
        error_code: if ready_ok {
            None
        } else {
            Some("not_ready".into())
        },
        error: if ready_ok {
            None
        } else {
            Some("window opened but did not become ready in time".into())
        },
        ..Default::default()
    }
}

async fn handle_insert(app: &AppHandle, window_id: Option<String>, text: String) -> Response {
    let Some(label) = resolve_window(app, window_id) else {
        return err("window_not_found", "no target window");
    };
    let ready = app.state::<WindowReady>();
    if !wait_for_window_ready(&ready, &label, Duration::from_secs(5)).await {
        return err("not_ready", format!("window {} not ready", label));
    }
    match app.emit_to(label.as_str(), "cli-insert", InsertPayload { text }) {
        Ok(()) => ok(),
        Err(e) => err("emit_failed", e.to_string()),
    }
}

fn handle_list(app: &AppHandle) -> Response {
    let files = app.state::<WindowFiles>().0.lock().unwrap().clone();
    let contents = app.state::<WindowContents>();

    let mut windows: Vec<WindowInfo> = app
        .webview_windows()
        .into_iter()
        .map(|(label, w)| {
            let path = files.get(&label).cloned();
            let name = path
                .as_deref()
                .and_then(|p| std::path::Path::new(p).file_name().and_then(|s| s.to_str()))
                .unwrap_or("Untitled")
                .to_string();
            let is_focused = w.is_focused().unwrap_or(false);
            let has_unsaved_changes = contents
                .get(&label)
                .map(|c| c.is_dirty)
                .unwrap_or(false);
            WindowInfo {
                window_id: label,
                path,
                name,
                is_focused,
                has_unsaved_changes,
            }
        })
        .collect();

    // Sort by label (creation order: w0, w1, ...) so output is stable.
    windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));

    Response {
        ok: true,
        windows: Some(windows),
        ..Default::default()
    }
}

async fn handle_selection(app: &AppHandle, window_id: Option<String>) -> Response {
    let Some(label) = resolve_window(app, window_id) else {
        return err("window_not_found", "no target window");
    };
    let ready = app.state::<WindowReady>();
    if !wait_for_window_ready(&ready, &label, Duration::from_secs(5)).await {
        return err("not_ready", format!("window {} not ready", label));
    }
    let sel = app
        .state::<WindowSelections>()
        .get(&label)
        .unwrap_or_default();
    Response {
        ok: true,
        selection: Some(sel),
        ..Default::default()
    }
}

async fn handle_content(app: &AppHandle, window_id: Option<String>) -> Response {
    let Some(label) = resolve_window(app, window_id) else {
        return err("window_not_found", "no target window");
    };
    let ready = app.state::<WindowReady>();
    if !wait_for_window_ready(&ready, &label, Duration::from_secs(5)).await {
        return err("not_ready", format!("window {} not ready", label));
    }
    let content = app
        .state::<WindowContents>()
        .get(&label)
        .map(|c| c.content)
        .unwrap_or_default();
    Response {
        ok: true,
        content: Some(content),
        ..Default::default()
    }
}

async fn handle_open_file(app: &AppHandle, path: String) -> Response {
    let abs = match std::fs::canonicalize(&path) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => {
            return err("file_not_found", format!("no such file: {}", path));
        }
    };
    let outcome = open_or_reuse(app, abs.clone());
    let ready = app.state::<WindowReady>();
    let ready_ok = wait_for_window_ready(&ready, &outcome.window_id, Duration::from_secs(10)).await;
    if !ready_ok {
        return Response {
            ok: false,
            window_id: Some(outcome.window_id),
            was_already_open: Some(outcome.was_already_open),
            error_code: Some("not_ready".into()),
            error: Some("window did not become ready in time".into()),
            ..Default::default()
        };
    }
    Response {
        ok: true,
        window_id: Some(outcome.window_id),
        was_already_open: Some(outcome.was_already_open),
        path: Some(abs),
        ..Default::default()
    }
}

async fn handle_save(
    app: &AppHandle,
    window_id: Option<String>,
    path_arg: Option<String>,
) -> Response {
    let Some(label) = resolve_window(app, window_id) else {
        return err("window_not_found", "no target window");
    };
    let ready = app.state::<WindowReady>();
    if !wait_for_window_ready(&ready, &label, Duration::from_secs(5)).await {
        return err("not_ready", format!("window {} not ready", label));
    }

    // Resolve the target path: explicit arg wins, else look up the window's
    // existing path.
    let existing_path = app
        .state::<WindowFiles>()
        .0
        .lock()
        .unwrap()
        .get(&label)
        .cloned();
    let target_path: String = match path_arg.or(existing_path) {
        Some(p) => p,
        None => {
            return err(
                "no_path",
                "window has no associated file; pass a path to save-as",
            );
        }
    };

    // Need parent dir to exist — do not auto-create, surfaces user error.
    let parent_ok = std::path::Path::new(&target_path)
        .parent()
        .map(|p| p.as_os_str().is_empty() || p.exists())
        .unwrap_or(true);
    if !parent_ok {
        return err(
            "no_parent_dir",
            format!("parent directory does not exist for {}", target_path),
        );
    }

    let content = app
        .state::<WindowContents>()
        .get(&label)
        .map(|c| c.content)
        .unwrap_or_default();

    if let Err(e) = std::fs::write(&target_path, &content) {
        return err("write_failed", e.to_string());
    }

    // Update tracked path + title for the window. set_window_path also pushes
    // the new title to the UI, so this doubles as a "this window now maps to
    // this file" announcement.
    if let Some(win) = app.webview_windows().get(&label) {
        let filename = std::path::Path::new(&target_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("DOMD")
            .to_string();
        let _ = win.set_title(&filename);
    }
    app.state::<WindowFiles>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), target_path.clone());

    // Tell the FE the doc is now clean so its dirty indicator + WindowContents
    // dirty bit get cleared. FE listens for `saved-by-cli` and rewrites its
    // lastSavedMd marker.
    app.state::<WindowContents>().mark_clean(&label);
    let _ = app.emit_to(label.as_str(), "saved-by-cli", target_path.clone());

    Response {
        ok: true,
        path: Some(target_path),
        ..Default::default()
    }
}

async fn handle_close(
    app: &AppHandle,
    window_id: Option<String>,
    force: Option<bool>,
) -> Response {
    let Some(label) = resolve_window(app, window_id) else {
        return err("window_not_found", "no target window");
    };
    let force = force.unwrap_or(false);
    if !force {
        let dirty = app
            .state::<WindowContents>()
            .get(&label)
            .map(|c| c.is_dirty)
            .unwrap_or(false);
        if dirty {
            return err(
                "unsaved_changes",
                format!("window {} has unsaved changes; pass force=true to discard", label),
            );
        }
    }
    if let Some(win) = app.webview_windows().get(&label) {
        // destroy() bypasses the CloseRequested confirm prompt — the AI has
        // already decided (force=true or dirty=false above).
        let _ = win.destroy();
        ok()
    } else {
        err("window_not_found", format!("no such window: {}", label))
    }
}

fn handle_focus(app: &AppHandle, window_id: Option<String>) -> Response {
    let Some(label) = resolve_window(app, window_id) else {
        return err("window_not_found", "no target window");
    };
    if let Some(win) = app.webview_windows().get(&label) {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.set_focus();
        ok()
    } else {
        err("window_not_found", format!("no such window: {}", label))
    }
}
