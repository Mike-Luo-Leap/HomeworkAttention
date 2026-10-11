use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

fn window_position_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to locate the application config directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the application config directory: {error}"))?;
    Ok(directory.join("WindowPosition.json"))
}

#[tauri::command]
fn restore_window_position(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let path = window_position_file_path(&app)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Unable to read the saved window position: {error}")),
    };
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid saved window position: {error}"))?;
    let x = value
        .get("x")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| "Invalid saved window position x coordinate".to_string())?;
    let y = value
        .get("y")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| "Invalid saved window position y coordinate".to_string())?;
    let saved_width = value.get("width").and_then(serde_json::Value::as_u64);
    let saved_height = value.get("height").and_then(serde_json::Value::as_u64);
    if value.get("width").is_some() && saved_width.is_none()
        || value.get("height").is_some() && saved_height.is_none()
    {
        return Err("Invalid saved window size".to_string());
    }

    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Unable to detect available monitors: {error}"))?;
    let primary_monitor = window
        .primary_monitor()
        .map_err(|error| format!("Unable to detect the primary monitor: {error}"))?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            let x = i64::from(x);
            let y = i64::from(y);
            x >= i64::from(area.position.x)
                && y >= i64::from(area.position.y)
                && x < i64::from(area.position.x) + i64::from(area.size.width)
                && y < i64::from(area.position.y) + i64::from(area.size.height)
        })
        .or(primary_monitor.as_ref())
        .or_else(|| monitors.first());
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let area = monitor.work_area();
    let current_size = window
        .inner_size()
        .map_err(|error| format!("Unable to determine the window size: {error}"))?;
    let min_width = (390.0 * monitor.scale_factor()).ceil() as u32;
    let min_height = (280.0 * monitor.scale_factor()).ceil() as u32;
    let width = saved_width
        .and_then(|size| u32::try_from(size).ok())
        .unwrap_or(current_size.width)
        .clamp(min_width.min(area.size.width), area.size.width);
    let height = saved_height
        .and_then(|size| u32::try_from(size).ok())
        .unwrap_or(current_size.height)
        .clamp(min_height.min(area.size.height), area.size.height);
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| format!("Unable to restore the window size: {error}"))?;

    let min_x = i64::from(area.position.x);
    let min_y = i64::from(area.position.y);
    let max_x = (min_x + i64::from(area.size.width) - i64::from(width)).max(min_x);
    let max_y = (min_y + i64::from(area.size.height) - i64::from(height)).max(min_y);
    let position = PhysicalPosition::new(
        i64::from(x).clamp(min_x, max_x) as i32,
        i64::from(y).clamp(min_y, max_y) as i32,
    );
    window
        .set_position(position)
        .map_err(|error| format!("Unable to restore the window position: {error}"))
}

#[tauri::command]
fn save_window_position(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let path = window_position_file_path(&app)?;
    let content = serde_json::to_string(&serde_json::json!({
        "x": x,
        "y": y,
        "width": width,
        "height": height
    }))
        .map_err(|error| format!("Unable to serialize the window position: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Unable to save the window position: {error}"))
}

fn reveal_board(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show() {
            eprintln!("Unable to show the homework board: {error}");
        }
        if let Err(error) = window.unminimize() {
            eprintln!("Unable to restore the homework board: {error}");
        }
        if let Err(error) = window.set_always_on_bottom(true) {
            eprintln!("Unable to pin the homework board to the desktop: {error}");
        }
    }
}

fn data_file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !matches!(name, "Settings.json" | "Homework.json") {
        return Err("Unsupported data file".to_string());
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Unable to locate the application folder: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "Unable to locate the application folder".to_string())?;
    let path = directory.join(name);

    if !path.exists() {
        let legacy_directory = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("Unable to locate the legacy config directory: {error}"))?;
        let legacy_path = legacy_directory.join(name);
        if legacy_path.exists() {
            fs::copy(&legacy_path, &path).map_err(|error| {
                format!("Unable to migrate {name} to the application folder: {error}")
            })?;
        }
    }

    Ok(path)
}

#[tauri::command]
fn read_data_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = data_file_path(&app, &name)?;
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Unable to read {name}: {error}")),
    }
}

#[tauri::command]
fn write_data_file(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let path = data_file_path(&app, &name)?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("Invalid JSON for {name}: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Unable to write {name}: {error}"))
}

#[tauri::command]
fn exit_application(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn open_popup_window(
    app: AppHandle,
    view: String,
    subject_id: Option<String>,
    expired_only: Option<bool>,
) -> Result<(), String> {
    let (label, title, url, width, height) = match view.as_str() {
        "settings" => (
            "settings".to_string(),
            "应用设置",
            "index.html?view=settings".to_string(),
            1000.0,
            720.0,
        ),
        "editor" => {
            let subject_id = subject_id.ok_or_else(|| "Missing homework subject id".to_string())?;
            let expired_only = expired_only.unwrap_or(false);
            if subject_id.len() != 36
                || !subject_id
                    .chars()
                    .all(|character| character.is_ascii_hexdigit() || character == '-')
            {
                return Err("Invalid homework subject id".to_string());
            }
            (
                if expired_only {
                    format!("editor-{subject_id}-expired")
                } else {
                    format!("editor-{subject_id}")
                },
                "布置作业",
                format!("index.html?view=editor&subjectId={subject_id}&expiredOnly={expired_only}"),
                900.0,
                620.0,
            )
        }
        _ => return Err("Unsupported popup window".to_string()),
    };

    if let Some(window) = app.get_webview_window(&label) {
        window
            .show()
            .map_err(|error| format!("Unable to show the popup window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Unable to focus the popup window: {error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(520.0, 420.0)
        .resizable(true)
        .decorations(true)
        .skip_taskbar(true)
        .build()
        .map_err(|error| format!("Unable to open the popup window: {error}"))?;
    Ok(())
}

#[tauri::command]
fn save_export_image(
    app: AppHandle,
    directory: Option<String>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The exported image is not a valid PNG file".to_string());
    }

    let folder = match directory
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => PathBuf::from(path),
        None => app
            .path()
            .picture_dir()
            .map_err(|error| format!("Unable to locate the Pictures directory: {error}"))?,
    };
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Unable to create the export directory: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Unable to determine the current time: {error}"))?
        .as_millis();
    let path = folder.join(format!("作业板-{timestamp}.png"));
    fs::write(&path, bytes)
        .map_err(|error| format!("Unable to save the exported image: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "显示作业板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = app.default_window_icon().cloned().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "The configured application icon is unavailable",
                )
            })?;

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("作业板")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => reveal_board(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Unable to hide the homework board: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_data_file,
            write_data_file,
            exit_application,
            open_popup_window,
            save_export_image,
            restore_window_position,
            save_window_position
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
