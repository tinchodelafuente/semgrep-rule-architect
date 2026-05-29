import { useEffect, useRef, useState } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';

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
  const [editorReady, setEditorReady] = useState(false);

  function handleEditorDidMount(editor: any) {
    editorRef.current = editor;
    setEditorReady(true);
  }

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

  const getDiagnosticCode = (match: any) => {
    if (typeof match.code === 'string' || typeof match.code === 'number') {
      return String(match.code);
    }

    if (match.code?.value) {
      return String(match.code.value);
    }

    return 'unknown-rule';
  };

  useEffect(() => {
    if (!monaco || !editorRef.current || !editorReady) return;

    const items = lspDiagnostics.length > 0 ? lspDiagnostics : matches;

    const newDecorations = items.flatMap((match: any) => {
      let startLine: number;
      let startCol: number;
      let endLine: number;
      let endCol: number;
      let message: string | undefined;
      let checkId: string;

      if (match.range) {
        startLine = match.range.start.line + 1;
        startCol = match.range.start.character + 1;
        endLine = match.range.end.line + 1;
        endCol = match.range.end.character + 1;
        message = match.message;
        checkId = getDiagnosticCode(match);
      } else if (match.start && match.end) {
        startLine = match.start.line;
        startCol = match.start.col;
        endLine = match.end.line;
        endCol = match.end.col;
        message = match.extra?.message;
        checkId = match.check_id || 'unknown-rule';
      } else {
        return [];
      }

      if (!startLine || !startCol || !endLine || !endCol) {
        return [];
      }

      if (startLine === endLine && endCol <= startCol) {
        endCol = startCol + 1;
      }

      const colorClass = getColorForRule(checkId);

      return [{
        range: new monaco.Range(startLine, startCol, endLine, endCol),
        options: {
          isWholeLine: false,
          className: colorClass,
          inlineClassName: colorClass,
          hoverMessage: { value: `**${checkId}**\n\n${message || ''}` },
        },
      }];
    });

    decorationsRef.current = editorRef.current.deltaDecorations(
      decorationsRef.current,
      newDecorations
    );
  }, [matches, lspDiagnostics, monaco, editorReady, code]);

  return (
    <div className="h-full w-full flex flex-col">
      <div className="bg-gray-900 text-white p-2 text-sm font-semibold border-b border-gray-700 flex justify-between items-center">
        <span>
          Test Code
          {fixedCode && <span className="ml-2 text-xs bg-green-600/30 text-green-400 px-2 py-0.5 rounded border border-green-600/50">Fix Disponible abajo</span>}
        </span>
      </div>

      <div className="flex-1 flex flex-col md:flex-row relative h-full">
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
              padding: { top: 16 },
            }}
          />
        </div>

        {fixedCode && (
          <div className="h-full w-full md:w-1/2 bg-gray-950">
            <div className="bg-gray-950 text-gray-400 p-1 text-xs border-b border-gray-800 px-3">
              Previsualizacion de Correccion Automatica
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
                readOnly: true,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
