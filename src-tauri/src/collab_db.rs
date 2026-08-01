//! Global SQLite persistence for collaboration data.
//!
//! The web build keeps rooms + Y.Doc bytes in a browser-global IndexedDB;
//! the desktop twin is a single machine-global database at
//! `~/.domd/collab.db` (next to the existing assets dir and CLI socket).
//! Rooms are keyed by the document's frontmatter `domd-id`, which exists
//! from the moment a document is created — whether or not the file has ever
//! been saved to disk. Saving is orthogonal to collaboration.
//!
//! Commands are stateless: each call opens the database, runs one statement
//! and closes. Write cadence is a 500 ms debounce from the frontend, so
//! connection reuse is not worth the state management.

use base64::Engine;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRow {
    pub id: String,
    pub doc_id: String,
    pub role: String,
    pub client_id: String,
    pub display_name: String,
    pub color: String,
    pub exp: i64,
    pub link_secret: Option<String>,
    pub key_check: String,
    /// Raw AES-GCM key bytes, base64. Local-disk trust level — same as the
    /// documents themselves.
    pub key_raw: String,
    pub active: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".domd");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("collab.db")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            role TEXT NOT NULL,
            client_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            color TEXT NOT NULL,
            exp INTEGER NOT NULL,
            link_secret TEXT,
            key_check TEXT NOT NULL,
            key_raw TEXT NOT NULL,
            active INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rooms_doc ON rooms(doc_id, active);
        CREATE TABLE IF NOT EXISTS docs (
            room_id TEXT PRIMARY KEY,
            bytes BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn row_from_stmt(row: &rusqlite::Row) -> rusqlite::Result<RoomRow> {
    Ok(RoomRow {
        id: row.get(0)?,
        doc_id: row.get(1)?,
        role: row.get(2)?,
        client_id: row.get(3)?,
        display_name: row.get(4)?,
        color: row.get(5)?,
        exp: row.get(6)?,
        link_secret: row.get(7)?,
        key_check: row.get(8)?,
        key_raw: row.get(9)?,
        active: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const ROOM_COLUMNS: &str = "id, doc_id, role, client_id, display_name, color, exp, \
     link_secret, key_check, key_raw, active, created_at, updated_at";

#[tauri::command]
pub fn collab_put_room(app: AppHandle, room: RoomRow) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO rooms (id, doc_id, role, client_id, display_name, \
         color, exp, link_secret, key_check, key_raw, active, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            room.id,
            room.doc_id,
            room.role,
            room.client_id,
            room.display_name,
            room.color,
            room.exp,
            room.link_secret,
            room.key_check,
            room.key_raw,
            room.active,
            room.created_at,
            room.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn collab_get_room(app: AppHandle, id: String) -> Result<Option<RoomRow>, String> {
    let conn = open_db(&app)?;
    conn.query_row(
        &format!("SELECT {ROOM_COLUMNS} FROM rooms WHERE id = ?1"),
        params![id],
        row_from_stmt,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The active hosted room for a given document id, if any (at most one —
/// newest wins if legacy data ever holds several).
#[tauri::command]
pub fn collab_active_host_room(app: AppHandle, doc_id: String) -> Result<Option<RoomRow>, String> {
    let conn = open_db(&app)?;
    conn.query_row(
        &format!(
            "SELECT {ROOM_COLUMNS} FROM rooms \
             WHERE doc_id = ?1 AND role = 'host' AND active = 1 \
             ORDER BY updated_at DESC LIMIT 1"
        ),
        params![doc_id],
        row_from_stmt,
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn collab_deactivate_room(app: AppHandle, id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "UPDATE rooms SET active = 0, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn collab_delete_room(app: AppHandle, id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM rooms WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM docs WHERE room_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn collab_save_doc_bytes(
    app: AppHandle,
    room_id: String,
    bytes_b64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_b64)
        .map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO docs (room_id, bytes, updated_at) VALUES (?1, ?2, ?3)",
        params![room_id, bytes, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn collab_load_doc_bytes(app: AppHandle, room_id: String) -> Result<Option<String>, String> {
    let conn = open_db(&app)?;
    let bytes: Option<Vec<u8>> = conn
        .query_row(
            "SELECT bytes FROM docs WHERE room_id = ?1",
            params![room_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b)))
}
