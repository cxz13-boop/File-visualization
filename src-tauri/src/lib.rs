mod scan;

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::path::{Path, PathBuf};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{
        MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
    },
    AppHandle, Emitter, Manager, WindowEvent,
};

pub struct AppState {
    pub scan_generation: AtomicU64,
    pub startup_notice: Mutex<Option<String>>,
    pub current_scan: Mutex<Option<scan::ScanGraph>>,
    pub pending_launch: Mutex<Option<String>>,
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn make_tray_icon() -> tauri::image::Image<'static> {
    const WIDTH: u32 = 32;
    const HEIGHT: u32 = 32;
    let mut rgba = Vec::with_capacity((WIDTH * HEIGHT * 4) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let in_tab = x >= 4 && x <= 15 && y >= 7 && y <= 10;
            let in_body = x >= 4 && x <= 27 && y >= 10 && y <= 25;
            if in_tab || in_body {
                if y > 17 && x > 6 && x < 25 {
                    rgba.extend_from_slice(&[18, 128, 120, 255]);
                } else {
                    rgba.extend_from_slice(&[28, 170, 158, 255]);
                }
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    tauri::image::Image::new_owned(rgba, WIDTH, HEIGHT)
}

#[tauri::command]
fn scan_path(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    refresh: Option<bool>,
    default_depth: Option<usize>,
    excludes: Option<Vec<String>>,
) -> Result<(), String> {
    let root = std::path::PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let path_string = path.clone();
    let refresh = refresh.unwrap_or(false);
    let default_depth = default_depth.unwrap_or(3).clamp(1, 8);
    let excludes = excludes.unwrap_or_default();
    let generation = state.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut current) = state.current_scan.lock() {
        *current = None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(message) = scan::scan_directory(
            &app,
            &root,
            generation,
            refresh,
            default_depth,
            &excludes,
        ) {
            let _ = app.emit(
                "scan://error",
                scan::ScanError {
                    path: path_string,
                    message,
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.scan_generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn generate_stress_scan(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    default_depth: Option<usize>,
) -> Result<(), String> {
    let default_depth = default_depth.unwrap_or(3).clamp(1, 8);
    let generation = state.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut current) = state.current_scan.lock() {
        *current = None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(message) =
            scan::generate_stress_scan(&app, generation, default_depth)
        {
            let _ = app.emit(
                "scan://error",
                scan::ScanError {
                    path: "stress://100000".to_string(),
                    message,
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
fn startup_notice(state: tauri::State<'_, AppState>) -> Option<String> {
    state
        .startup_notice
        .lock()
        .ok()
        .and_then(|mut notice| notice.take())
}

#[tauri::command]
fn expand_nodes(
    state: tauri::State<'_, AppState>,
    node_ids: Vec<String>,
) -> Result<Vec<scan::NodeDto>, String> {
    let guard = state
        .current_scan
        .lock()
        .map_err(|_| "扫描会话不可用".to_string())?;
    let graph = guard
        .as_ref()
        .ok_or_else(|| "尚未完成扫描".to_string())?;
    let mut result = Vec::new();
    for node_id in node_ids {
        result.extend(graph.children(&node_id)?);
    }
    Ok(result)
}

#[tauri::command]
fn search_nodes(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<scan::SearchHit>, String> {
    let guard = state
        .current_scan
        .lock()
        .map_err(|_| "扫描会话不可用".to_string())?;
    let graph = guard
        .as_ref()
        .ok_or_else(|| "尚未完成扫描".to_string())?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    Ok(graph.search(&query, limit))
}

fn valid_file_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("名称无效".to_string());
    }
    if name.chars().any(|character| {
        matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        )
    }) {
        return Err("名称包含非法字符".to_string());
    }
    Ok(())
}

#[tauri::command]
fn rename_node(path: String, new_name: String) -> Result<String, String> {
    valid_file_name(&new_name)?;
    let old_path = PathBuf::from(&path);
    let parent = old_path
        .parent()
        .ok_or_else(|| "无法确定父目录".to_string())?;
    let new_path = parent.join(new_name.trim());
    if new_path.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }
    std::fs::rename(&old_path, &new_path).map_err(|error| error.to_string())?;
    Ok(new_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_node(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn move_node(path: String, target_dir: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let target = PathBuf::from(&target_dir);
    if !target.is_dir() {
        return Err("目标目录不存在".to_string());
    }
    let source_abs = std::fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
    let target_abs = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    if source_abs.starts_with(&target_abs) || target_abs.starts_with(&source_abs) {
        return Err("不能移动到自身或子目录内".to_string());
    }
    let name = source
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| "无法获取文件名".to_string())?;
    let destination = target.join(name);
    if destination.exists() {
        return Err("目标位置已存在同名文件".to_string());
    }
    std::fs::rename(&source, &destination).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().into_owned())
}

fn copy_recursive(source: &Path, destination: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(source, destination)?;
    }
    Ok(())
}

#[tauri::command]
fn copy_node(path: String, target_dir: String) -> Result<(), String> {
    let source = PathBuf::from(&path);
    let target = PathBuf::from(&target_dir);
    if !target.is_dir() {
        return Err("目标目录不存在".to_string());
    }
    let name = source
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| "无法获取文件名".to_string())?;
    let destination = target.join(name);
    if destination.exists() {
        return Err("目标位置已存在同名文件".to_string());
    }
    copy_recursive(&source, &destination).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_node(
    state: tauri::State<'_, AppState>,
    parent_dir: String,
    kind: String,
    name: String,
) -> Result<scan::CreateResult, String> {
    valid_file_name(&name)?;
    let kind = match kind.as_str() {
        "file" => "file",
        "dir" => "dir",
        _ => return Err("类型无效".to_string()),
    };
    let parent_path = PathBuf::from(&parent_dir);
    if !parent_path.is_dir() {
        return Err("父目录不存在".to_string());
    }
    let target = parent_path.join(name.trim());
    if target.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }

    if kind == "file" {
        std::fs::write(&target, "").map_err(|error| error.to_string())?;
    } else {
        std::fs::create_dir(&target).map_err(|error| error.to_string())?;
    }

    let metadata = std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    let mut guard = state
        .current_scan
        .lock()
        .map_err(|_| "扫描会话不可用".to_string())?;
    let graph = guard
        .as_mut()
        .ok_or_else(|| "尚未完成扫描".to_string())?;
    let node = graph.create_child(
        &parent_dir,
        name.trim(),
        kind,
        &target.to_string_lossy(),
        metadata.len(),
        modified_at,
    )?;
    let parent = graph.parent_dto(&parent_dir)?;
    Ok(scan::CreateResult { node, parent })
}

#[tauri::command]
fn invalidate_scan(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut current) = state.current_scan.lock() {
        *current = None;
    }
    Ok(())
}

#[tauri::command]
fn clear_cache(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("cache");
    if dir.exists() {
        for entry in std::fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn open_node(path: String) -> Result<(), String> {
    open::that(&path).map_err(|error| error.to_string())
}

fn shell_command_line() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(format!("\"{}\" \"%1\"", exe.to_string_lossy()))
}

fn register_shell_entries() -> Result<(), String> {
    let command = shell_command_line()?;
    let log_path = std::env::temp_dir().join("fv-shell.log");
    let _ = std::fs::write(&log_path, format!("command={command}\n"));
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for root in [
        "Software\\Classes\\*\\shell\\FileVisualizer",
        "Software\\Classes\\Directory\\shell\\FileVisualizer",
    ] {
        let _ = std::fs::write(&log_path, format!("creating {root}\n"));
        let (shell_key, _) = hkcu.create_subkey(root).map_err(|error| error.to_string())?;
        let _ = std::fs::write(&log_path, format!("created {root}\n"));
        shell_key
            .set_value("", &"用 FileVisualizer 打开")
            .map_err(|error| error.to_string())?;
        let _ = std::fs::write(&log_path, "set display\n");
        let (command_key, _) = shell_key
            .create_subkey("command")
            .map_err(|error| error.to_string())?;
        let _ = std::fs::write(&log_path, "created command\n");
        command_key
            .set_value("", &command)
            .map_err(|error| error.to_string())?;
        let _ = std::fs::write(&log_path, "set command\n");
    }
    let _ = std::fs::write(&log_path, "done\n");
    Ok(())
}

fn unregister_shell_entries() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for root in [
        "Software\\Classes\\*\\shell\\FileVisualizer",
        "Software\\Classes\\Directory\\shell\\FileVisualizer",
    ] {
        let _ = hkcu.delete_subkey_all(root);
    }
    Ok(())
}

#[tauri::command]
fn register_shell() -> Result<(), String> {
    register_shell_entries()
}

#[tauri::command]
fn unregister_shell() -> Result<(), String> {
    unregister_shell_entries()
}

#[tauri::command]
fn take_launch_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state
        .pending_launch
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .manage(AppState {
            scan_generation: AtomicU64::new(0),
            startup_notice: Mutex::new(None),
            current_scan: Mutex::new(None),
            pending_launch: Mutex::new(None),
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = args
                .iter()
                .skip(1)
                .find(|arg| PathBuf::from(arg).exists())
            {
                if let Ok(mut pending) = app.state::<AppState>().pending_launch.lock() {
                    *pending = Some(path.clone());
                }
                let _ = app.emit("launch://path", path.clone());
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let hotkey_app = app.handle().clone();
            std::thread::spawn(move || {
                use device_query::{DeviceQuery, DeviceState, Keycode};
                let device_state = DeviceState::new();
                let mut combo_down = false;
                loop {
                    let keys = device_state.get_keys();
                    let combo = keys.contains(&Keycode::Z)
                        && keys.contains(&Keycode::X)
                        && keys.contains(&Keycode::C);
                    if combo && !combo_down {
                        combo_down = true;
                        toggle_main_window(&hotkey_app);
                    } else if !combo {
                        combo_down = false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            if let Some(path) = std::env::args()
                .skip(1)
                .find(|arg| PathBuf::from(arg).exists())
            {
                *app.state::<AppState>()
                    .pending_launch
                    .lock()
                    .expect("pending launch lock poisoned") = Some(path);
            }
            let show = MenuItem::with_id(app, "show", "显示 / 隐藏", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(make_tray_icon())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_path,
            cancel_scan,
            generate_stress_scan,
            startup_notice,
            expand_nodes,
            search_nodes,
            rename_node,
            delete_node,
            move_node,
            copy_node,
            create_node,
            invalidate_scan,
            clear_cache,
            open_node,
            register_shell,
            unregister_shell,
            take_launch_path
        ])
        .run(tauri::generate_context!())
        .map_err(Into::into)
}
