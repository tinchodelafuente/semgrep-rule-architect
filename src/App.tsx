import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CodeEditor } from "./components/CodeEditor";
import { RuleEditor } from "./components/RuleEditor";

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") {
      return new jsonWorker();
    }
    if (label === "css" || label === "less" || label === "scss") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

const INITIAL_YAML = `rules:
  - id: my-first-rule
    pattern: console.log(...)
    message: Use of console.log is discouraged
    severity: WARNING
    languages:
      - javascript
`;

const INITIAL_CODE = `function hello() {
  console.log("Hello world!");
}
`;

const extensionForLanguage = (language: string) => {
  if (language === "javascript") return "js";
  if (language === "typescript") return "ts";
  if (language === "python") return "py";
  if (language === "java") return "java";
  if (language === "go") return "go";
  if (language === "rust") return "rs";
  return "txt";
};

const summarizeLspLog = (payload: any) => {
  const data = payload?.data;
  const message = payload?.message;

  if (message === "check-code") {
    return `rulesChanged=${Boolean(data?.rulesChanged)} codeChanged=${Boolean(
      data?.codeChanged,
    )} reopen=${Boolean(data?.reopen)} lang=${data?.languageId || "?"}`;
  }

  if (message === "diagnostics-summary") {
    return `count=${data?.count ?? "?"} uri=${data?.uri || "?"}`;
  }

  if (message === "textDocument/publishDiagnostics") {
    return `count=${data?.params?.diagnostics?.length ?? "?"} uri=${
      data?.params?.uri || "?"
    }`;
  }

  if (message === "workspace-configuration-response") {
    return `items=${data?.items?.length ?? "?"}`;
  }

  if (message === "lsp-response") {
    return `id=${data?.id ?? "?"} hasResult=${Boolean(data?.hasResult)}`;
  }

  if (message === "semgrep-stderr") {
    return data?.line ? `line=${data.line}` : "";
  }

  return "";
};

const hasAutofix = (yamlContent: string) => /^\s*(fix|fix-regex)\s*:/m.test(yamlContent);

function App() {
  const [yaml, setYaml] = useState(INITIAL_YAML);
  const [code, setCode] = useState(INITIAL_CODE);
  const [language, setLanguage] = useState("javascript");

  const [lspDiagnostics, setLspDiagnostics] = useState<any[]>([]);
  const [cliMatches, setCliMatches] = useState<any[]>([]);
  const [fixedCode, setFixedCode] = useState<string | null>(null);
  const [isFixing, setIsFixing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const checkRunRef = useRef(0);

  useEffect(() => {
    const unlistenPromise = listen("semgrep-diagnostics", (event) => {
      const params: any = event.payload;
      setLspDiagnostics(params.diagnostics || []);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("semgrep-lsp-event", (event) => {
      console.warn("Semgrep LSP event:", event.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("semgrep-lsp-log", (event) => {
      const payload: any = event.payload;
      const summary = summarizeLspLog(payload);
      const logArgs = [
        `[semgrep-lsp:${payload?.direction || "?"}] ${
          payload?.message || ""
        }${summary ? ` ${summary}` : ""}`,
        payload?.data,
      ];

      if (payload?.level === "error") {
        console.error(...logArgs);
      } else if (payload?.level === "warn") {
        console.warn(...logArgs);
      } else {
        console.log(...logArgs);
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const runId = ++checkRunRef.current;

    if (!yaml.trim() || !code.trim()) {
      setLspDiagnostics([]);
      setCliMatches([]);
      setFixedCode(null);
      setShowDiff(false);
      setIsFixing(false);
      return;
    }

    const ext = extensionForLanguage(language);

    setLspDiagnostics([]);
    setCliMatches([]);

    invoke("lsp_check", {
      args: { yamlContent: yaml, testCode: code, extension: ext },
    }).catch((err) => console.error("Error al ejecutar lsp_check:", err));

    const scanHandler = setTimeout(async () => {
      const startedAt = performance.now();
      try {
        const result = await invoke<string>("scan_semgrep", {
          args: { yamlContent: yaml, testCode: code, extension: ext },
        });

        if (runId !== checkRunRef.current) return;

        const semgrepJson = result ? JSON.parse(result) : {};
        const results = semgrepJson.results || [];
        console.log("[semgrep-cli:scan]", {
          matches: results.length,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        setCliMatches(results);
      } catch (error) {
        if (runId !== checkRunRef.current) return;

        console.error("Semgrep scan failed:", error);
        setCliMatches([]);
      }
    }, 1500);

    const canAutofix = hasAutofix(yaml);
    setIsFixing(canAutofix);
    const fixHandler = canAutofix ? setTimeout(async () => {
      const startedAt = performance.now();
      try {
        const result = await invoke<string>("run_semgrep", {
          args: { yamlContent: yaml, testCode: code, extension: ext },
        });

        if (runId !== checkRunRef.current) return;

        const parsed = JSON.parse(result);
        const semgrepJson = parsed.json ? JSON.parse(parsed.json) : {};
        const results = semgrepJson.results || [];
        console.log("[semgrep-cli:autofix]", {
          matches: results.length,
          elapsedMs: Math.round(performance.now() - startedAt),
          changedCode: Boolean(parsed.fixedCode && parsed.fixedCode !== code),
        });
        setCliMatches(results);

        const cleanOriginal = code.replace(/\r/g, "").trim();
        const cleanFixed = parsed.fixedCode
          ? parsed.fixedCode.replace(/\r/g, "").trim()
          : "";

        if (cleanFixed && cleanFixed !== cleanOriginal) {
          setFixedCode(parsed.fixedCode);
          setShowDiff(true);
        } else {
          setFixedCode(null);
          setShowDiff(false);
        }
      } catch (error) {
        if (runId !== checkRunRef.current) return;

        console.error("Semgrep CLI failed:", error);
        setCliMatches([]);
        setFixedCode(null);
        setShowDiff(false);
      } finally {
        if (runId === checkRunRef.current) {
          setIsFixing(false);
        }
      }
    }, 2000) : undefined;

    return () => {
      clearTimeout(scanHandler);
      if (fixHandler) {
        clearTimeout(fixHandler);
      }
    };
  }, [yaml, code, language]);

  const handleExport = () => {
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rules.yaml";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-gray-900 text-gray-100 overflow-hidden">
      <header className="h-12 bg-gray-950 border-b border-gray-800 flex items-center px-4 shrink-0 shadow-sm z-20">
        <div className="flex items-center text-blue-500 mr-3 font-mono font-bold text-xl">
          &gt;_
        </div>
        <h1 className="text-lg font-bold tracking-wide">Semgrep Rule Architect</h1>

        {isFixing && (
          <div className="ml-4 flex items-center text-xs text-gray-400">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-500 mr-2"></div>
            Checking autofixes...
          </div>
        )}
      </header>

      <main className="flex-1 flex overflow-hidden relative">
        <div className="w-1/2 border-r border-gray-800 flex flex-col shadow-lg z-10">
          <RuleEditor
            yamlContent={yaml}
            onChange={setYaml}
            onExport={handleExport}
          />
        </div>

        <div className="w-1/2 flex flex-col relative z-0">
          <div className="absolute top-2 right-4 z-10">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-gray-800 text-white text-xs px-3 py-1.5 rounded-md border border-gray-600 outline-none shadow-sm cursor-pointer hover:bg-gray-700 transition-colors"
            >
              <option value="javascript">JavaScript</option>
              <option value="typescript">TypeScript</option>
              <option value="python">Python</option>
              <option value="java">Java</option>
              <option value="go">Go</option>
              <option value="rust">Rust</option>
            </select>
          </div>
          <CodeEditor
            code={code}
            language={language}
            onChange={(val) => setCode(val || "")}
            matches={cliMatches}
            fixedCode={showDiff ? fixedCode : null}
            lspDiagnostics={lspDiagnostics}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
