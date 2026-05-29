use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tempfile::TempDir;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct LspManager {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Mutex<Option<Child>>,
    settings: Arc<Mutex<Value>>,
    app_handle: AppHandle,
    pub temp_dir_path: String,
    _inner_dir: TempDir,
    req_id: Mutex<u64>,
    document_version: Mutex<i32>,
    document_uri: Mutex<Option<String>>,
    document_ext: Mutex<Option<String>>,
    last_yaml: Mutex<Option<String>>,
    last_code: Mutex<Option<String>>,
}

impl LspManager {
    pub fn new(app_handle: AppHandle) -> Result<Arc<Self>, String> {
        let temp_dir = tempfile::Builder::new()
            .prefix("semgrep-lsp-")
            .tempdir()
            .map_err(|e| e.to_string())?;

        let rules_path = temp_dir.path().join(".semgrep.yml");
        std::fs::write(&rules_path, "rules: []\n")
            .map_err(|e| format!("Error creando regla inicial: {}", e))?;

        let manager = Arc::new(Self {
            stdin: Arc::new(Mutex::new(None)),
            child: Mutex::new(None),
            settings: Arc::new(Mutex::new(make_lsp_settings(&rules_path))),
            app_handle,
            temp_dir_path: temp_dir
                .path()
                .to_string_lossy()
                .to_string()
                .replace("\\", "/"),
            _inner_dir: temp_dir,
            req_id: Mutex::new(1),
            document_version: Mutex::new(0),
            document_uri: Mutex::new(None),
            document_ext: Mutex::new(None),
            last_yaml: Mutex::new(Some("rules: []\n".to_string())),
            last_code: Mutex::new(None),
        });

        manager.start_lsp()?;
        Ok(manager)
    }

    pub fn check_code(&self, yaml: &str, code: &str, ext: &str) -> Result<(), String> {
        let base_path = std::path::Path::new(&self.temp_dir_path);
        let rules_path = base_path.join(".semgrep.yml");
        let test_path = base_path.join(format!("test.{}", ext));
        let test_uri = path_to_uri(&test_path);
        let language_id = language_id_for_extension(ext);

        let rules_changed = {
            let mut last_yaml = self.last_yaml.lock().unwrap();
            if last_yaml.as_deref() == Some(yaml) {
                false
            } else {
                std::fs::write(&rules_path, yaml)
                    .map_err(|e| format!("Error escribiendo regla: {}", e))?;
                self.update_settings(&rules_path);
                *last_yaml = Some(yaml.to_string());
                true
            }
        };

        let should_reopen = {
            let document_uri = self.document_uri.lock().unwrap();
            let document_ext = self.document_ext.lock().unwrap();
            document_uri.as_deref() != Some(&test_uri) || document_ext.as_deref() != Some(ext)
        };

        let code_changed = {
            let mut last_code = self.last_code.lock().unwrap();
            if last_code.as_deref() == Some(code) && !rules_changed && !should_reopen {
                false
            } else {
                *last_code = Some(code.to_string());
                true
            }
        };

        emit_lsp_log(
            &self.app_handle,
            "info",
            "state",
            "check-code",
            json!({
                "rulesChanged": rules_changed,
                "reopen": should_reopen,
                "codeChanged": code_changed,
                "testUri": test_uri.clone(),
                "rulesPath": rules_path.to_string_lossy().to_string(),
                "yamlPreview": yaml.chars().take(500).collect::<String>(),
                "languageId": language_id,
                "codeBytes": code.as_bytes().len(),
                "yamlBytes": yaml.as_bytes().len()
            }),
        );

        if should_reopen || code_changed {
            std::fs::write(&test_path, code)
                .map_err(|e| format!("Error escribiendo codigo de prueba: {}", e))?;
        }

        if should_reopen {
            self.open_document(&test_uri, language_id, code, ext)?;
        } else if code_changed {
            self.change_document(&test_uri, code)?;
        }

        if rules_changed {
            self.send_refresh_rules()?;
        } else if code_changed {
            self.save_document(&test_uri)?;
        }

        Ok(())
    }

    fn start_lsp(&self) -> Result<(), String> {
        let base_path = std::path::Path::new(&self.temp_dir_path);
        let rules_path = base_path.join(".semgrep.yml");

        let mut command = Command::new("semgrep");
        command
            .arg("lsp")
            .arg("--quiet")
            .current_dir(base_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        emit_lsp_log(
            &self.app_handle,
            "info",
            "state",
            "start-lsp",
            json!({
                "cwd": self.temp_dir_path,
                "config": rules_path.to_string_lossy().to_string()
            }),
        );

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn semgrep lsp: {}", e))?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        {
            let mut stdin_slot = self.stdin.lock().unwrap();
            *stdin_slot = Some(stdin);
        }

        {
            let mut child_slot = self.child.lock().unwrap();
            *child_slot = Some(child);
        }

        let stdout_handle = self.app_handle.clone();
        let stdout_stdin = Arc::clone(&self.stdin);
        let stdout_settings = Arc::clone(&self.settings);
        std::thread::spawn(move || {
            read_lsp_stdout(stdout, stdout_handle, stdout_stdin, stdout_settings);
        });

        let stderr_handle = self.app_handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if !line.trim().is_empty() {
                            emit_lsp_log(
                                &stderr_handle,
                                "warn",
                                "stderr",
                                "semgrep-stderr",
                                json!({ "line": line }),
                            );
                        }
                    }
                    Err(error) => {
                        emit_lsp_log(
                            &stderr_handle,
                            "error",
                            "stderr",
                            "read-stderr-failed",
                            json!({ "error": error.to_string() }),
                        );
                        break;
                    }
                }
            }
        });

        self.initialize_lsp()
    }

    fn initialize_lsp(&self) -> Result<(), String> {
        let base_path = std::path::Path::new(&self.temp_dir_path);
        let root_uri = path_to_uri(base_path);
        let id = self.next_request_id();
        let settings = self.settings.lock().unwrap().clone();

        let init_msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootPath": self.temp_dir_path,
                "rootUri": root_uri.clone(),
                "workspaceFolders": [
                    {
                        "uri": root_uri,
                        "name": "semgrep-rule-architect"
                    }
                ],
                "capabilities": {
                    "workspace": {
                        "configuration": true,
                        "didChangeConfiguration": {
                            "dynamicRegistration": false
                        }
                    },
                    "textDocument": {
                        "synchronization": {
                            "dynamicRegistration": false,
                            "willSave": false,
                            "willSaveWaitUntil": false,
                            "didSave": false
                        }
                    }
                },
                "initializationOptions": settings
            }
        });
        self.send_msg(&init_msg)?;

        let initialized_msg = json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        });
        self.send_msg(&initialized_msg)?;

        Ok(())
    }

    fn open_document(
        &self,
        test_uri: &str,
        language_id: &str,
        code: &str,
        ext: &str,
    ) -> Result<(), String> {
        let previous_uri = self.document_uri.lock().unwrap().clone();
        if let Some(previous_uri) = previous_uri {
            let did_close = json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didClose",
                "params": {
                    "textDocument": {
                        "uri": previous_uri
                    }
                }
            });
            let _ = self.send_msg(&did_close);
        }

        let version = self.next_document_version();
        let did_open = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": test_uri,
                    "languageId": language_id,
                    "version": version,
                    "text": code
                }
            }
        });
        self.send_msg(&did_open)?;

        *self.document_uri.lock().unwrap() = Some(test_uri.to_string());
        *self.document_ext.lock().unwrap() = Some(ext.to_string());

        Ok(())
    }

    fn change_document(&self, test_uri: &str, code: &str) -> Result<(), String> {
        let version = self.next_document_version();
        let did_change = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": {
                    "uri": test_uri,
                    "version": version
                },
                "contentChanges": [
                    {
                        "text": code
                    }
                ]
            }
        });
        self.send_msg(&did_change)
    }

    fn save_document(&self, test_uri: &str) -> Result<(), String> {
        let did_save = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didSave",
            "params": {
                "textDocument": {
                    "uri": test_uri
                }
            }
        });
        self.send_msg(&did_save)
    }

    fn send_refresh_rules(&self) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "semgrep/refreshRules"
        });
        self.send_msg(&msg)
    }

    fn send_msg(&self, msg: &Value) -> Result<(), String> {
        let method = msg["method"].as_str().unwrap_or("response");
        emit_lsp_log(&self.app_handle, "debug", "out", method, msg.clone());

        let body = serde_json::to_string(msg).unwrap();
        let payload = format!("Content-Length: {}\r\n\r\n{}", body.as_bytes().len(), body);
        send_payload_to_stdin(&self.stdin, &payload)
    }

    fn next_request_id(&self) -> u64 {
        let mut req_id = self.req_id.lock().unwrap();
        let current = *req_id;
        *req_id += 1;
        current
    }

    fn next_document_version(&self) -> i32 {
        let mut version = self.document_version.lock().unwrap();
        *version += 1;
        *version
    }

    fn update_settings(&self, rules_path: &std::path::Path) {
        let mut settings = self.settings.lock().unwrap();
        *settings = make_lsp_settings(rules_path);
    }
}

fn read_lsp_stdout<R: Read>(
    mut stdout: R,
    app_handle: AppHandle,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    settings: Arc<Mutex<Value>>,
) {
    let mut buffer = Vec::<u8>::new();
    let mut chunk = [0_u8; 8192];

    loop {
        let read_count = match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) => {
                emit_lsp_log(
                    &app_handle,
                    "error",
                    "in",
                    "read-stdout-failed",
                    json!({ "error": error.to_string() }),
                );
                break;
            }
        };

        buffer.extend_from_slice(&chunk[..read_count]);

        loop {
            let Some(header_start) = find_bytes(&buffer, b"Content-Length:") else {
                let keep_len = buffer.len().min(b"Content-Length:".len() - 1);
                let drop_len = buffer.len().saturating_sub(keep_len);

                if drop_len > 0 {
                    let dropped = String::from_utf8_lossy(&buffer[..drop_len]).to_string();
                    emit_lsp_log(
                        &app_handle,
                        "warn",
                        "in",
                        "dropped-bytes-before-header",
                        json!({ "bytes": drop_len, "text": dropped }),
                    );
                    buffer.drain(..drop_len);
                }
                break;
            };

            if header_start > 0 {
                let dropped = String::from_utf8_lossy(&buffer[..header_start]).to_string();
                emit_lsp_log(
                    &app_handle,
                    "warn",
                    "in",
                    "dropped-bytes-before-header",
                    json!({ "bytes": header_start, "text": dropped }),
                );
                buffer.drain(..header_start);
            }

            let Some(header_end) = find_bytes(&buffer, b"\r\n\r\n") else {
                break;
            };

            let header = String::from_utf8_lossy(&buffer[..header_end]).to_string();
            let Some(content_length) = parse_content_length(&header) else {
                emit_lsp_log(
                    &app_handle,
                    "warn",
                    "in",
                    "bad-content-length",
                    json!({ "header": header }),
                );
                buffer.drain(..header_end + 4);
                continue;
            };

            let body_start = header_end + 4;
            let body_end = body_start + content_length;
            if buffer.len() < body_end {
                break;
            }

            let body = buffer[body_start..body_end].to_vec();
            buffer.drain(..body_end);

            let Ok(body_str) = String::from_utf8(body) else {
                emit_lsp_log(
                    &app_handle,
                    "error",
                    "in",
                    "invalid-utf8",
                    json!({ "length": content_length }),
                );
                continue;
            };

            let Ok(message) = serde_json::from_str::<Value>(&body_str) else {
                emit_lsp_log(
                    &app_handle,
                    "error",
                    "in",
                    "invalid-json",
                    json!({ "body": body_str }),
                );
                continue;
            };

            handle_lsp_message(&app_handle, &stdin, &settings, message);
        }
    }

    emit_lsp_log(&app_handle, "warn", "in", "stdout-closed", json!({}));
}

fn handle_lsp_message(
    app_handle: &AppHandle,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    settings: &Arc<Mutex<Value>>,
    message: Value,
) {
    let method = message["method"].as_str().unwrap_or("response");
    emit_lsp_log(app_handle, "debug", "in", method, message.clone());

    if message.get("id").is_some() && message.get("method").is_none() {
        emit_lsp_log(
            app_handle,
            "info",
            "state",
            "lsp-response",
            json!({
                "id": message["id"].clone(),
                "hasResult": message.get("result").is_some(),
                "error": message.get("error").cloned().unwrap_or(Value::Null)
            }),
        );
    }

    if let (Some(id), Some(method)) = (message.get("id").cloned(), message["method"].as_str()) {
        match method {
            "workspace/configuration" => {
                let items = message["params"]["items"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![json!({ "section": "semgrep" })]);
                let setting = settings.lock().unwrap().clone();
                let result = Value::Array(
                    items
                        .iter()
                        .map(|item| {
                            let section = item["section"].as_str().unwrap_or("semgrep");
                            config_for_section(&setting, section)
                        })
                        .collect(),
                );
                emit_lsp_log(
                    app_handle,
                    "info",
                    "state",
                    "workspace-configuration-response",
                    json!({
                        "items": items,
                        "result": result
                    }),
                );
                let _ = send_lsp_response(stdin, id, result);
                return;
            }
            "window/workDoneProgress/create" | "client/registerCapability" => {
                let _ = send_lsp_response(stdin, id, Value::Null);
                return;
            }
            _ => {}
        }
    }

    match message["method"].as_str() {
        Some("textDocument/publishDiagnostics") => {
            let diagnostics = message["params"]["diagnostics"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let preview = diagnostics
                .iter()
                .take(5)
                .map(|diagnostic| {
                    json!({
                        "range": diagnostic["range"].clone(),
                        "message": diagnostic["message"].clone(),
                        "code": diagnostic["code"].clone()
                    })
                })
                .collect::<Vec<_>>();

            emit_lsp_log(
                app_handle,
                "info",
                "state",
                "diagnostics-summary",
                json!({
                    "uri": message["params"]["uri"].clone(),
                    "count": diagnostics.len(),
                    "preview": preview
                }),
            );
            let _ = app_handle.emit("semgrep-diagnostics", message["params"].clone());
        }
        Some("telemetry/event") => {
            let _ = app_handle.emit("semgrep-lsp-event", message["params"].clone());
        }
        Some("window/logMessage") | Some("window/showMessage") | Some("$/logTrace") => {
            emit_lsp_log(
                app_handle,
                "info",
                "state",
                "server-message",
                message["params"].clone(),
            );
        }
        Some("semgrep/rulesRefreshed") => {
            emit_lsp_log(app_handle, "info", "state", "rules-refreshed", json!({}));
        }
        _ => {}
    }
}

fn config_for_section(settings: &Value, section: &str) -> Value {
    let section = section.strip_prefix("semgrep.").unwrap_or(section);

    if section == "semgrep" || section.is_empty() {
        return settings.clone();
    }

    let mut current = settings;
    for part in section.split('.') {
        current = &current[part];
        if current.is_null() {
            return Value::Null;
        }
    }
    current.clone()
}

fn make_lsp_settings(rules_path: &std::path::Path) -> Value {
    json!({
        "scan": {
            "configuration": [rules_path.to_string_lossy().to_string().replace("\\", "/")],
            "exclude": [],
            "include": ["test.*"],
            "jobs": 1,
            "maxMemory": 0,
            "maxTargetBytes": 1000000,
            "timeout": 30,
            "timeoutThreshold": 3,
            "onlyGitDirty": false,
            "ci": false,
            "pro_intrafile": false,
        },
        "metrics": {
            "enabled": false
        },
        "doHover": false,
        "trace": {
            "server": "off"
        },
        "useExperimentalLS": false,
        "ignoreCliVersion": true,
        "path": "semgrep"
    })
}

fn parse_content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("Content-Length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn emit_lsp_log(app_handle: &AppHandle, level: &str, direction: &str, message: &str, data: Value) {
    let _ = app_handle.emit(
        "semgrep-lsp-log",
        json!({
            "level": level,
            "direction": direction,
            "message": message,
            "data": data
        }),
    );
}

fn send_msg_to_stdin(stdin: &Arc<Mutex<Option<ChildStdin>>>, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_string(msg).unwrap();
    let payload = format!("Content-Length: {}\r\n\r\n{}", body.as_bytes().len(), body);
    send_payload_to_stdin(stdin, &payload)
}

fn send_lsp_response(
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    let response = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    });
    send_msg_to_stdin(stdin, &response)
}

fn send_payload_to_stdin(
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    payload: &str,
) -> Result<(), String> {
    let mut stdin = stdin.lock().unwrap();
    let Some(stdin) = stdin.as_mut() else {
        return Err("Semgrep LSP stdin is not available".to_string());
    };

    stdin
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn path_to_uri(path: &std::path::Path) -> String {
    let mut path_str = path.to_string_lossy().into_owned().replace("\\", "/");
    if !path_str.starts_with('/') {
        path_str = format!("/{}", path_str);
    }
    if path_str.len() >= 4
        && path_str.as_bytes()[0] == b'/'
        && path_str.as_bytes()[2] == b':'
        && path_str.as_bytes()[3] == b'/'
    {
        let drive = path_str[1..2].to_ascii_uppercase();
        path_str = format!("/{drive}{}", &path_str[2..]);
    }
    format!("file://{}", path_str)
}

fn language_id_for_extension(ext: &str) -> &str {
    match ext {
        "js" => "javascript",
        "ts" => "typescript",
        "py" => "python",
        "rs" => "rust",
        other => other,
    }
}
