use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Parser)]
#[command(
    name = "domd-cli",
    about = "Drive DOMD windows from the command line.\n\
             Streaming is just repeated `insert` calls — there's no separate stream mode.\n\n\
             Output convention: single-value commands print plain text;\n\
             structured commands print JSON. Errors → exit nonzero + JSON on stderr."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Open a new empty window. Prints its window id.
    New,
    /// Open or focus a window for a file path. Prints its window id.
    Open {
        /// Path to a markdown file (absolute or `~`-expanded).
        path: String,
    },
    /// List open windows as a JSON array.
    List,
    /// Print current selection snapshot as JSON.
    Selection {
        #[arg(long)]
        window: Option<String>,
    },
    /// Print full markdown content of a window.
    Content {
        #[arg(long)]
        window: Option<String>,
    },
    /// Insert text into a window. Call repeatedly for streaming.
    Insert {
        #[arg(long)]
        window: Option<String>,
        text: String,
    },
    /// Save a window to disk. With <path>, performs save-as.
    Save {
        #[arg(long)]
        window: Option<String>,
        path: Option<String>,
    },
    /// Close a window. With --force, discards unsaved changes.
    Close {
        #[arg(long)]
        window: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Bring a window to the front.
    Focus {
        #[arg(long)]
        window: Option<String>,
    },
}

// ── wire protocol (mirrors Rust side) ────────────────────────────────────────

#[derive(Serialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Request {
    #[allow(dead_code)]
    Ping,
    NewWindow,
    Insert {
        window_id: Option<String>,
        text: String,
    },
    ListWindows,
    Selection {
        window_id: Option<String>,
    },
    Content {
        window_id: Option<String>,
    },
    OpenFile {
        path: String,
    },
    Save {
        window_id: Option<String>,
        path: Option<String>,
    },
    Close {
        window_id: Option<String>,
        force: Option<bool>,
    },
    Focus {
        window_id: Option<String>,
    },
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)] // forward-compat: server fills more than we currently print
struct Response {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    window_id: Option<String>,
    #[serde(default)]
    was_already_open: Option<bool>,
    #[serde(default)]
    windows: Option<Value>,
    #[serde(default)]
    selection: Option<Value>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

// ── socket plumbing ──────────────────────────────────────────────────────────

fn socket_path() -> PathBuf {
    let home = env::var_os("HOME").expect("HOME env var must be set");
    PathBuf::from(home).join(".domd").join("cli.sock")
}

fn try_launch_domd() {
    #[cfg(target_os = "macos")]
    {
        // Prefer launching the .app bundle we live inside — avoids LaunchServices
        // picking some other app named "DOMD". current_exe() resolves through
        // symlinks (e.g. /usr/local/bin/domd-cli) to the real binary inside
        // Contents/MacOS, so walking up 3 parents lands on the .app.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(app_path) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                if app_path.extension().and_then(|s| s.to_str()) == Some("app") {
                    let _ = Command::new("open").arg(app_path).spawn();
                    return;
                }
            }
        }
        let _ = Command::new("open").args(["-b", "com.domd.desktop"]).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("domd").spawn();
    }
}

fn connect_with_bootstrap() -> io::Result<UnixStream> {
    let path = socket_path();
    if let Ok(s) = UnixStream::connect(&path) {
        return Ok(s);
    }
    try_launch_domd();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(100));
        if let Ok(s) = UnixStream::connect(&path) {
            return Ok(s);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
            "could not reach DOMD socket at {} — is DOMD installed and runnable?",
            path.display()
        ),
    ))
}

struct Conn {
    write: UnixStream,
    read: BufReader<UnixStream>,
}

impl Conn {
    fn open() -> io::Result<Self> {
        let stream = connect_with_bootstrap()?;
        let write = stream.try_clone()?;
        Ok(Conn {
            write,
            read: BufReader::new(stream),
        })
    }

    fn send(&mut self, req: &Request) -> io::Result<Response> {
        let mut buf = serde_json::to_vec(req)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        buf.push(b'\n');
        self.write.write_all(&buf)?;
        self.write.flush()?;
        let mut line = String::new();
        let n = self.read.read_line(&mut line)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "DOMD closed the connection",
            ));
        }
        serde_json::from_str(line.trim())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

// ── path normalization ──────────────────────────────────────────────────────

/// Expand `~` and resolve to an absolute path. Doesn't require existence
/// (for `save` to a not-yet-created file), but rejects empty input.
fn normalize_path(input: &str) -> io::Result<String> {
    if input.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty path"));
    }
    let expanded = if let Some(rest) = input.strip_prefix("~/") {
        let home = env::var_os("HOME").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "HOME not set")
        })?;
        PathBuf::from(home).join(rest)
    } else if input == "~" {
        PathBuf::from(env::var_os("HOME").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "HOME not set")
        })?)
    } else {
        PathBuf::from(input)
    };
    let abs = if expanded.is_absolute() {
        expanded
    } else {
        env::current_dir()?.join(expanded)
    };
    Ok(abs.to_string_lossy().into_owned())
}

// ── output ───────────────────────────────────────────────────────────────────

/// Print a structured error to stderr as JSON and return a nonzero exit code.
fn report_error(resp: &Response) -> ExitCode {
    let payload = serde_json::json!({
        "error_code": resp.error_code.as_deref().unwrap_or("unknown"),
        "error": resp.error.as_deref().unwrap_or("unknown error"),
    });
    eprintln!("{}", payload);
    ExitCode::from(1)
}

fn report_io_error(e: io::Error) -> ExitCode {
    let payload = serde_json::json!({
        "error_code": "io_error",
        "error": e.to_string(),
    });
    eprintln!("{}", payload);
    ExitCode::from(1)
}

// ── main ─────────────────────────────────────────────────────────────────────

fn main() -> ExitCode {
    let cli = Cli::parse();
    let mut conn = match Conn::open() {
        Ok(c) => c,
        Err(e) => return report_io_error(e),
    };

    let resp = match build_request(&cli.cmd) {
        Ok(req) => match conn.send(&req) {
            Ok(r) => r,
            Err(e) => return report_io_error(e),
        },
        Err(code) => return code,
    };

    if !resp.ok {
        return report_error(&resp);
    }

    // Per-command stdout formatting.
    match cli.cmd {
        Cmd::New => {
            if let Some(id) = resp.window_id {
                println!("{}", id);
            }
        }
        Cmd::Open { .. } => {
            if let Some(id) = resp.window_id {
                println!("{}", id);
            }
        }
        Cmd::List => {
            let arr = resp.windows.unwrap_or(Value::Array(vec![]));
            println!("{}", arr);
        }
        Cmd::Selection { .. } => {
            let obj = resp.selection.unwrap_or(Value::Null);
            println!("{}", obj);
        }
        Cmd::Content { .. } => {
            if let Some(c) = resp.content {
                // No trailing newline — content is the raw markdown.
                print!("{}", c);
                io::stdout().flush().ok();
            }
        }
        Cmd::Save { .. } => {
            if let Some(p) = resp.path {
                println!("{}", p);
            }
        }
        Cmd::Insert { .. } | Cmd::Close { .. } | Cmd::Focus { .. } => {
            // Silent on success.
        }
    }
    ExitCode::from(0)
}

/// Translate the parsed CLI command into a wire-protocol Request.
fn build_request(cmd: &Cmd) -> Result<Request, ExitCode> {
    Ok(match cmd {
        Cmd::New => Request::NewWindow,
        Cmd::Open { path } => Request::OpenFile {
            path: normalize_path(path).map_err(report_io_error)?,
        },
        Cmd::List => Request::ListWindows,
        Cmd::Selection { window } => Request::Selection {
            window_id: window.clone(),
        },
        Cmd::Content { window } => Request::Content {
            window_id: window.clone(),
        },
        Cmd::Insert { window, text } => Request::Insert {
            window_id: window.clone(),
            text: text.clone(),
        },
        Cmd::Save { window, path } => Request::Save {
            window_id: window.clone(),
            path: path
                .as_deref()
                .map(normalize_path)
                .transpose()
                .map_err(report_io_error)?,
        },
        Cmd::Close { window, force } => Request::Close {
            window_id: window.clone(),
            force: Some(*force),
        },
        Cmd::Focus { window } => Request::Focus {
            window_id: window.clone(),
        },
    })
}
