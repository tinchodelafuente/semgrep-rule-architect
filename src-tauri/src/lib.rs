mod lsp;

use std::process::Command;
use std::io::Write;
use std::sync::Arc;
use tauri::{Manager, State};
use serde::Deserialize;

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

#[tauri::command]
async fn run_semgrep(args: SemgrepArgs) -> Result<String, String> {
    let mut yaml_file = tempfile::Builder::new().suffix(".yaml").tempfile().map_err(|e| e.to_string())?;
    yaml_file.write_all(args.yaml_content.as_bytes()).map_err(|e| e.to_string())?;
    let yaml_path = yaml_file.path().to_str().unwrap().to_string();

    let suffix = format!(".{}", args.extension);
    let mut code_file = tempfile::Builder::new().suffix(&suffix).tempfile().map_err(|e| e.to_string())?;
    code_file.write_all(args.test_code.as_bytes()).map_err(|e| e.to_string())?;
    let code_path = code_file.path().to_str().unwrap().to_string();

    let output = Command::new("semgrep")
        .arg("--config")
        .arg(&yaml_path)
        .arg(&code_path)
        .arg("--json")
        .arg("--autofix")
        .output()
        .map_err(|e| format!("Failed to execute semgrep: {}", e))?;

    let stdout = String::from_utf8(output.stdout).unwrap_or_default();
    let fixed_code = std::fs::read_to_string(&code_path).unwrap_or_default();
    
    Ok(serde_json::json!({
        "json": stdout,
        "fixedCode": fixed_code
    }).to_string())
}

#[tauri::command]
fn lsp_check(state: State<'_, Arc<lsp::LspManager>>, args: SemgrepArgs) -> Result<(), String> {
    state.check_code(&args.yaml_content, &args.test_code, &args.extension)
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
        .invoke_handler(tauri::generate_handler![run_semgrep, lsp_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}