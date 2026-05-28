import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CodeEditor } from "./components/CodeEditor";
import { RuleEditor } from "./components/RuleEditor";

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

function App() {
  const [yaml, setYaml] = useState(INITIAL_YAML);
  const [code, setCode] = useState(INITIAL_CODE);
  const [language, setLanguage] = useState("javascript");
  
  const [lspDiagnostics, setLspDiagnostics] = useState<any[]>([]);
  const [fixedCode, setFixedCode] = useState<string | null>(null);
  const [isFixing, setIsFixing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    const unlistenPromise = listen('semgrep-diagnostics', (event) => {
       console.log("¡LLEGÓ EVENTO LSP!", event);
       const params: any = event.payload;
       console.log("Diagnostics contenidos:", params?.diagnostics);
       setLspDiagnostics(params.diagnostics || []);
    });
    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!yaml.trim() || !code.trim()) {
      setLspDiagnostics([]);
      setFixedCode(null);
      return;
    }

    const ext = language === 'javascript' ? 'js' : 
                language === 'typescript' ? 'ts' : 
                language === 'python' ? 'py' : 
                language === 'java' ? 'java' :
                language === 'go' ? 'go' : 
                language === 'rust' ? 'rs' : 'txt';
    
    // Instant LSP check
    invoke('lsp_check', {args: { yamlContent: yaml, testCode: code, extension: ext }}).catch(console.error);

    // Debounced Autofix Generation
    setIsFixing(true);
    const handler = setTimeout(async () => {
      try {
        const result = await invoke<string>("run_semgrep", {
          args: { yamlContent: yaml, testCode: code, extension: ext }
        });
        const parsed = JSON.parse(result);
        
        // Limpiamos los retornos de carro de Windows (\r) para hacer una comparación de texto limpia
        const cleanOriginal = code.replace(/\r/g, "").trim();
        const cleanFixed = parsed.fixedCode ? parsed.fixedCode.replace(/\r/g, "").trim() : "";

        // Solo activamos el Diff si el código corregido es distinto al original Y no está vacío
        if (cleanFixed && cleanFixed !== cleanOriginal) {
          setFixedCode(parsed.fixedCode);
          setShowDiff(true); // Hay un fix real modificado por Semgrep
        } else {
          setFixedCode(null);
          setShowDiff(false); // Es el mismo código, nos quedamos en el editor común
        }
      } catch (error) {
        console.error("Semgrep CLI failed:", error);
        setFixedCode(null);
        setShowDiff(false);
      } finally {
        setIsFixing(false);
      }
    }, 800);

    return () => clearTimeout(handler);
  }, [yaml, code, language]);

  const handleExport = () => {
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rules.yaml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-gray-900 text-gray-100 overflow-hidden">
      {/* Header */}
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

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Left Pane: Rule Editor */}
        <div className="w-1/2 border-r border-gray-800 flex flex-col shadow-lg z-10">
          <RuleEditor 
            yamlContent={yaml} 
            onChange={setYaml} 
            onExport={handleExport}
          />
        </div>

        {/* Right Pane: Code Editor */}
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
            onChange={(val) => setCode(val || '')} 
            matches={[]} 
            fixedCode={showDiff ? fixedCode : null}
            lspDiagnostics={lspDiagnostics}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
