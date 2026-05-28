use std::process::{Command, Stdio, ChildStdin};
use std::io::{Write, Read, BufReader, BufRead};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};
use tempfile::TempDir;
use tauri::{AppHandle, Manager, Emitter};

pub struct LspManager {
    stdin: Mutex<ChildStdin>,
    pub temp_dir: String,
    req_id: Mutex<u64>,
}

impl LspManager {
    pub fn new(app_handle: AppHandle) -> Result<Arc<Self>, String> {
        let temp_dir = tempfile::Builder::new().prefix("semgrep-lsp-").tempdir().map_err(|e| e.to_string())?;
        let temp_dir_path = temp_dir.path().to_string_lossy().to_string().replace("\\", "/");
        
        let temp_dir_path_clone = temp_dir_path.clone();

        let mut child = Command::new("semgrep")
            .arg("lsp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn semgrep lsp: {}", e))?;
            
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        
        // CLONAMOS el app_handle explícitamente para el hilo secundario
        let thread_handle = app_handle.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 { break; }
                
                if line.starts_with("Content-Length: ") {
                    let len_str = line.trim_start_matches("Content-Length: ").trim();
                    if let Ok(len) = len_str.parse::<usize>() {
                        let mut empty = String::new();
                        let _ = reader.read_line(&mut empty);
                        
                        let mut body = vec![0; len];
                        if reader.read_exact(&mut body).is_ok() {
                            if let Ok(body_str) = String::from_utf8(body) {
                                if let Ok(json) = serde_json::from_str::<Value>(&body_str) {
                                    if json["method"] == "textDocument/publishDiagnostics" {
                                        // Usamos el clon del handle asignado al hilo
                                        let _ = thread_handle.emit("semgrep-diagnostics", json["params"].clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        
        // Creamos la instancia de la estructura
        let manager_instance = Self {
            stdin: Mutex::new(stdin),
            temp_dir: temp_dir_path,
            req_id: Mutex::new(1),
        };
        
        let manager = Arc::new(manager_instance);
        
        // Enviar initialize de forma segura
        let root_uri = format!("file:///{}", temp_dir_path_clone);
        let id = {
            let mut req_id = manager.req_id.lock().unwrap();
            let current = *req_id;
            *req_id += 1;
            current
        };
        
        let init_msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": root_uri,
                "capabilities": {}
            }
        });
        manager.send_msg(&init_msg)?;

        Ok(manager)
    }

    pub fn send_msg(&self, msg: &Value) -> Result<(), String> {
        let body = serde_json::to_string(msg).unwrap();
        let payload = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let mut stdin = self.stdin.lock().unwrap();
        stdin.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn check_code(&self, yaml: &str, code: &str, ext: &str) -> Result<(), String> {
        // 1. Usar PathBuf nativo de Rust para evitar problemas de barras (\ vs /) en Windows
        let base_path = std::path::Path::new(&self.temp_dir);
        let rules_path = base_path.join(".semgrep.yml");
        let test_path = base_path.join(format!("test.{}", ext));
        
        // Asegurarnos de que el directorio temporal realmente exista antes de escribir
        if !base_path.exists() {
            std::fs::create_dir_all(base_path).map_err(|e| format!("No se pudo crear el directorio temporal: {}", e))?;
        }
        
        // 2. Escribir los archivos forzando un flush limpio en el disco de Windows
        std::fs::write(&rules_path, yaml).map_err(|e| format!("Error escribiendo regla: {}", e))?;
        std::fs::write(&test_path, code).map_err(|e| format!("Error escribiendo codigo de prueba: {}", e))?;
        
        let mut req_id = self.req_id.lock().unwrap();
        let id = *req_id;
        *req_id += 1;

        // 3. Formatear la URI correctamente para Windows de acuerdo al protocolo LSP
        // Ej: de "C:\Temp" a "file:///C:/Temp"
        let mut path_str = test_path.to_string_lossy().into_owned();
        path_str = path_str.replace("\\", "/");
        if !path_str.starts_with('/') {
            path_str = format!("/{}", path_str);
        }
        let test_uri = format!("file://{}", path_str);

        // 4. Armar los JSON para el Servidor Semgrep
        let did_open = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": test_uri,
                    "languageId": ext,
                    "version": id,
                    "text": code
                }
            }
        });
        
        let did_change = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": {
                    "uri": test_uri,
                    "version": id + 1
                },
                "contentChanges": [{ "text": code }]
            }
        });

        // 5. Enviar los mensajes al proceso vivo de Semgrep
        self.send_msg(&did_open)?;
        self.send_msg(&did_change)?;
        
        Ok(())
    }
}