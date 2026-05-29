mod lsp;

use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tauri::{Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Definimos las estructuras de entrada.
// Tauri mapeará automáticamente el camelCase de JS a estas variables.
#[derive(Deserialize)]
struct SemgrepArgs {
    #[serde(rename = "yamlContent")]
    yaml_content: String,
    #[serde(rename = "testCode")]
    test_code: String,
    extension: String,
}
#[derive(Deserialize)]
struct ExportRulesArgs {
    #[serde(rename = "yamlContent")]
    yaml_content: String,
    path: String,
}

#[tauri::command]
async fn run_semgrep(args: SemgrepArgs) -> Result<String, String> {
    let mut yaml_file = tempfile::Builder::new()
        .suffix(".yaml")
        .tempfile()
        .map_err(|e| e.to_string())?;
    yaml_file
        .write_all(args.yaml_content.as_bytes())
        .map_err(|e| e.to_string())?;
    let yaml_path = yaml_file.path().to_str().unwrap().to_string();

    let suffix = format!(".{}", args.extension);
    let mut code_file = tempfile::Builder::new()
        .suffix(&suffix)
        .tempfile()
        .map_err(|e| e.to_string())?;
    code_file
        .write_all(args.test_code.as_bytes())
        .map_err(|e| e.to_string())?;
    let code_path = code_file.path().to_str().unwrap().to_string();

    let mut command = Command::new("semgrep");
    command
        .arg("--config")
        .arg(&yaml_path)
        .arg(&code_path)
        .arg("--json")
        .arg("--autofix");

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|e| format!("Failed to execute semgrep: {}", e))?;

    let stdout = String::from_utf8(output.stdout).unwrap_or_default();
    let fixed_code = std::fs::read_to_string(&code_path).unwrap_or_default();

    Ok(serde_json::json!({
        "json": stdout,
        "fixedCode": fixed_code
    })
    .to_string())
}

#[tauri::command]
async fn scan_semgrep(args: SemgrepArgs) -> Result<String, String> {
    let mut yaml_file = tempfile::Builder::new()
        .suffix(".yaml")
        .tempfile()
        .map_err(|e| e.to_string())?;
    yaml_file
        .write_all(args.yaml_content.as_bytes())
        .map_err(|e| e.to_string())?;
    let yaml_path = yaml_file.path().to_str().unwrap().to_string();

    let suffix = format!(".{}", args.extension);
    let mut code_file = tempfile::Builder::new()
        .suffix(&suffix)
        .tempfile()
        .map_err(|e| e.to_string())?;
    code_file
        .write_all(args.test_code.as_bytes())
        .map_err(|e| e.to_string())?;
    let code_path = code_file.path().to_str().unwrap().to_string();

    let mut command = Command::new("semgrep");
    command
        .arg("--config")
        .arg(&yaml_path)
        .arg(&code_path)
        .arg("--json")
        .arg("--quiet");

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|e| format!("Failed to execute semgrep: {}", e))?;

    Ok(String::from_utf8(output.stdout).unwrap_or_default())
}

#[tauri::command]
fn lsp_check(state: State<'_, Arc<lsp::LspManager>>, args: SemgrepArgs) -> Result<(), String> {
    state.check_code(&args.yaml_content, &args.test_code, &args.extension)
}
#[tauri::command]
fn export_rules(args: ExportRulesArgs) -> Result<String, String> {
    let path = PathBuf::from(args.path);

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Export directory does not exist: {}", parent.display()));
        }
    }

    std::fs::write(&path, args.yaml_content).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let lsp_manager = lsp::LspManager::new(app.handle().clone())
                .expect("Failed to initialize LSP manager");
            app.manage(lsp_manager);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_semgrep,
            scan_semgrep,
            lsp_check,
            export_rules
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
