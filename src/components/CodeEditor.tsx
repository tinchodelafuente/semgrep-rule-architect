import { useRef, useEffect } from 'react';
import Editor, { DiffEditor, useMonaco } from '@monaco-editor/react';

interface CodeEditorProps {
  code: string;
  language: string;
  onChange: (value: string | undefined) => void;
  matches: any[];
  fixedCode: string | null;
  lspDiagnostics: any[];
}

export function CodeEditor({ code, language, onChange, matches, fixedCode, lspDiagnostics }: CodeEditorProps) {
  const monaco = useMonaco();
  const editorRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);

  function handleEditorDidMount(editor: any) {
    editorRef.current = editor;
  }

  // Generate a distinct color per rule ID
  const getColorForRule = (ruleId: string) => {
    let hash = 0;
    for (let i = 0; i < ruleId.length; i++) {
      hash = ruleId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = [
        'semgrep-highlight-red',
        'semgrep-highlight-blue',
        'semgrep-highlight-green',
        'semgrep-highlight-yellow',
        'semgrep-highlight-purple',
        'semgrep-highlight-pink',
      ];
    return colors[Math.abs(hash) % colors.length];
  };

  useEffect(() => {
    if (!monaco || !editorRef.current) return;

    // Use LSP diagnostics for instant highlight if available, else fallback to matches
    const items = lspDiagnostics.length > 0 ? lspDiagnostics : matches;

    const newDecorations = items.map((match: any) => {
      // Handle both Semgrep JSON output format and LSP Diagnostic format
      let startLine, startCol, endLine, endCol, message, checkId;
      
      if (match.range) {
        // LSP Format
        startLine = match.range.start.line + 1;
        startCol = match.range.start.character + 1;
        endLine = match.range.end.line + 1;
        endCol = match.range.end.character + 1;
        message = match.message;
        checkId = match.code || "unknown-rule";
      } else {
        // Semgrep CLI JSON Format
        startLine = match.start.line;
        startCol = match.start.col;
        endLine = match.end.line;
        endCol = match.end.col;
        message = match.extra?.message;
        checkId = match.check_id;
      }

      const colorClass = getColorForRule(checkId);

      return {
        range: new monaco.Range(startLine, startCol, endLine, endCol),
        options: {
          isWholeLine: false,
          className: colorClass,
          hoverMessage: { value: `**${checkId}**\n\n${message}` }
        }
      };
    });

    const currentEditor = editorRef.current;
    if (currentEditor) {
      let targetEditor: any = null;

      // Si es un DiffEditor, tiene ambos métodos. 
      // Elegimos getOriginalEditor() para pintar el error sobre el código viejo (izq).
      if (currentEditor.getOriginalEditor && currentEditor.getModifiedEditor) {
        targetEditor = currentEditor.getOriginalEditor();
      } else {
        // Si es el editor común de edición
        targetEditor = currentEditor;
      }
      
      if (targetEditor && typeof targetEditor.deltaDecorations === 'function') {
          decorationsRef.current = targetEditor.deltaDecorations(
            decorationsRef.current,
            newDecorations
          );
      }
    }
  }, [matches, lspDiagnostics, monaco]);

  const hasFix = fixedCode && fixedCode !== code;

return (
    <div className="h-full w-full flex flex-col">
      <div className="bg-gray-900 text-white p-2 text-sm font-semibold border-b border-gray-700 flex justify-between items-center">
        <span>
          Test Code 
          {fixedCode && <span className="ml-2 text-xs bg-green-600/30 text-green-400 px-2 py-0.5 rounded border border-green-600/50">Fix Disponible abajo</span>}
        </span>
      </div>
      
      {/* Contenedor principal dividido en dos de forma fija si hay un fix, o pantalla completa si no */}
      <div className="flex-1 flex flex-col md:flex-row relative h-full">
        
        {/* PANEL 1: El editor de código activo. NUNCA se desmonta, por ende las decoraciones no se rompen */}
        <div className={`h-full relative ${fixedCode ? 'w-full md:w-1/2 border-r border-gray-700' : 'w-full'}`}>
          <Editor
            height="100%"
            language={language}
            theme="vs-dark"
            value={code}
            onChange={onChange}
            onMount={handleEditorDidMount}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              padding: { top: 16 }
            }}
          />
        </div>

        {/* PANEL 2: Si hay un fix generado por Semgrep, mostramos el visor estático al lado para comparar */}
        {fixedCode && (
          <div className="h-full w-full md:w-1/2 bg-gray-950">
            <div className="bg-gray-950 text-gray-400 p-1 text-xs border-b border-gray-800 px-3">
              Previsualización de Corrección Automática
            </div>
            <Editor
              height="calc(100% - 24px)"
              language={language}
              theme="vs-dark"
              value={fixedCode}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                padding: { top: 16 },
                readOnly: true // Este panel es solo para mirar
              }}
            />
          </div>
        )}

      </div>
    </div>
  );
}
