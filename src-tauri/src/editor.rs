use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const SOURCE_EXTS: &[&str] = &["ts", "py", "cpp", "c", "h", "hpp", "js", "json", "md", "txt"];

/// Like assert_in_builds() in commands.rs, but for the editor: the page may only
/// touch files and folders the user picked in a native dialog (plus the folder
/// remembered from last time). A compromised page can't read or write anywhere else.
#[derive(Default)]
pub struct EditorState {
    allowed: Mutex<Vec<PathBuf>>,
}

impl EditorState {
    fn allow(&self, p: &Path) {
        if let Ok(c) = p.canonicalize() {
            let mut list = self.allowed.lock().unwrap();
            if !list.contains(&c) {
                list.push(c);
            }
        }
    }

    fn forget(&self, p: &Path) {
        if let Ok(c) = p.canonicalize() {
            self.allowed.lock().unwrap().retain(|a| a != &c);
        }
    }

    /// Checks `p` is inside an allowed root. Works for files that don't exist yet
    /// (new file / save as) by resolving their parent folder instead.
    fn check(&self, p: &str) -> Result<(), String> {
        let path = Path::new(p);
        let canon = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                let parent = path
                    .parent()
                    .ok_or("Invalid path.")?
                    .canonicalize()
                    .map_err(|_| "That folder does not exist.".to_string())?;
                parent.join(path.file_name().ok_or("Invalid path.")?)
            }
        };
        if self.allowed.lock().unwrap().iter().any(|a| canon.starts_with(a)) {
            Ok(())
        } else {
            Err("That path has not been opened in the editor.".to_string())
        }
    }
}

#[derive(Serialize)]
pub struct OpenedFile {
    path: String,
    name: String,
    content: String,
}

#[derive(Serialize)]
pub struct EditorEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn to_string(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn read_text(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("This file is too large to open in the editor (over 5 MB).".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 text, so it can't be opened in the editor.".to_string())
}

fn last_dir_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("editor_last_dir.txt"))
}

/// File picker. Returns None if the user cancels.
#[tauri::command]
pub async fn editor_open(app: AppHandle, state: State<'_, EditorState>) -> Result<Option<OpenedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Source Files", SOURCE_EXTS)
        .pick_file(move |f| {
            let _ = tx.send(f);
        });
    let Some(path) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    state.allow(&path);
    let content = read_text(&path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(Some(OpenedFile { path: to_string(&path), name, content }))
}

/// Folder picker. Returns None if the user cancels.
#[tauri::command]
pub async fn editor_open_dir(app: AppHandle, state: State<'_, EditorState>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    state.allow(&path);
    if let Some(file) = last_dir_file(&app) {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(file, to_string(&path)).ok();
    }
    Ok(Some(to_string(&path)))
}

/// The folder opened last time, if it still exists. Re-approves it for this session.
#[tauri::command]
pub fn editor_last_dir(app: AppHandle, state: State<'_, EditorState>) -> Option<String> {
    let saved = std::fs::read_to_string(last_dir_file(&app)?).ok()?;
    let path = PathBuf::from(saved.trim());
    if !path.is_dir() {
        return None;
    }
    state.allow(&path);
    Some(to_string(&path))
}

/// Closes the folder: revokes its access and stops reopening it at startup.
#[tauri::command]
pub fn editor_close_dir(app: AppHandle, state: State<'_, EditorState>, path: String) {
    state.forget(Path::new(&path));
    if let Some(file) = last_dir_file(&app) {
        std::fs::remove_file(file).ok();
    }
}

#[tauri::command]
pub fn editor_read_dir(state: State<'_, EditorState>, path: String) -> Result<Vec<EditorEntry>, String> {
    state.check(&path)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        out.push(EditorEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: to_string(&entry.path()),
            is_dir,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn editor_read_file(state: State<'_, EditorState>, path: String) -> Result<String, String> {
    state.check(&path)?;
    // Approve the file itself, so a tab stays saveable after its folder is closed.
    state.allow(Path::new(&path));
    read_text(Path::new(&path))
}

#[tauri::command]
pub fn editor_save(state: State<'_, EditorState>, path: String, content: String) -> Result<(), String> {
    state.check(&path)?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Save dialog, then writes the file. Returns the chosen path, or None if cancelled.
#[tauri::command]
pub async fn editor_save_as(
    app: AppHandle,
    state: State<'_, EditorState>,
    suggested: String,
    content: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Source Files", SOURCE_EXTS)
        .set_file_name(suggested)
        .save_file(move |f| {
            let _ = tx.send(f);
        });
    let Some(path) = rx.await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    state.allow(&path);
    Ok(Some(to_string(&path)))
}

/// Creates an empty file; fails if it already exists so nothing gets overwritten.
#[tauri::command]
pub fn editor_create_file(state: State<'_, EditorState>, path: String) -> Result<(), String> {
    state.check(&path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}