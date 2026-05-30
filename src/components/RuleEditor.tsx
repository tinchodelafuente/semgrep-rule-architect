import { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import yaml from 'js-yaml';
import { Plus, Trash2, Download, ChevronDown, ChevronRight, BookOpen, Wand2, ArrowLeft, ArrowRight, X } from 'lucide-react';

interface RuleEditorProps {
  yamlContent: string;
  onChange: (value: string) => void;
  onExport: () => void | Promise<void>;
  exportStatus?: string | null;
  isExporting?: boolean;
  testCode?: string;
  testLanguage?: string;
  onTestCodeChange?: (value: string) => void;
}

const PATTERN_TYPES = [
  'pattern',
  'pattern-either',
  'pattern-not',
  'pattern-inside',
  'pattern-not-inside',
  'pattern-regex'
];

const PATTERN_OUTPUT_ORDER = [
  'pattern-inside',
  'pattern-not-inside',
  'pattern-not',
  'pattern',
  'pattern-either',
  'pattern-regex',
];

const DEFAULT_CONDITION_VALUES: Record<string, any> = {
  pattern: '...',
  'pattern-either': [{ pattern: '...' }],
  'pattern-not': '...',
  'pattern-inside': `function $FUNC(...) {
  ...
}`,
  'pattern-not-inside': '...',
  'pattern-regex': '...',
};

type RegexPiece = {
  label: string;
  value: string;
  description: string;
};

type RegexPieceGroup = {
  name: string;
  pieces: RegexPiece[];
};

type RegexToken = RegexPiece & {
  id: string;
};

const REGEX_PIECE_GROUPS: RegexPieceGroup[] = [
  {
    name: 'Anchors',
    pieces: [
      { label: 'Line start', value: '^', description: 'Matches the start of a line.' },
      { label: 'Line end', value: '$', description: 'Matches the end of a line.' },
      { label: 'Word edge', value: '\\b', description: 'Matches the edge of a word.' },
    ],
  },
  {
    name: 'Characters',
    pieces: [
      { label: 'Any char', value: '.', description: 'Matches any single character except a newline.' },
      { label: 'Digit', value: '\\d', description: 'Matches one digit from 0 to 9.' },
      { label: 'Word char', value: '\\w', description: 'Matches letters, digits, or underscore.' },
      { label: 'Space', value: '\\s', description: 'Matches whitespace.' },
    ],
  },
  {
    name: 'Sets',
    pieces: [
      { label: 'A-Z', value: '[A-Z]', description: 'Matches one uppercase ASCII letter.' },
      { label: 'a-z', value: '[a-z]', description: 'Matches one lowercase ASCII letter.' },
      { label: '0-9', value: '[0-9]', description: 'Matches one digit.' },
      { label: 'A-Z a-z 0-9', value: '[A-Za-z0-9]', description: 'Matches one ASCII letter or digit.' },
      { label: 'Slug char', value: '[A-Za-z0-9_-]', description: 'Matches one letter, digit, underscore, or dash.' },
    ],
  },
  {
    name: 'Repeat',
    pieces: [
      { label: 'Optional', value: '?', description: 'Repeats the previous item zero or one time.' },
      { label: '0+', value: '*', description: 'Repeats the previous item zero or more times.' },
      { label: '1+', value: '+', description: 'Repeats the previous item one or more times.' },
      { label: '0 to 6', value: '{0,6}', description: 'Repeats the previous item from zero to six times.' },
    ],
  },
  {
    name: 'Logic',
    pieces: [
      { label: 'Or', value: '|', description: 'Matches the item on the left or the item on the right.' },
      { label: 'Open group', value: '(?:', description: 'Starts a non-capturing group.' },
      { label: 'Capture $MATCH', value: '(?P<MATCH>', description: 'Starts a Semgrep named capture group called $MATCH.' },
      { label: 'Close group', value: ')', description: 'Closes the current group.' },
    ],
  },
];

const makeRegexToken = (piece: RegexPiece): RegexToken => ({
  ...piece,
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
});

const escapeRegexLiteral = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const makePreviewRegex = (value: string) =>
  new RegExp(value.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, '(?<$1>'), 'gm');

const getRegexPreviewMatches = (regexValue: string, testCode: string) => {
  if (!regexValue || !testCode) return [];

  const regex = makePreviewRegex(regexValue);
  const matches: Array<{ value: string; index: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(testCode)) && matches.length < 20) {
    matches.push({ value: match[0], index: match.index });

    if (match[0] === '') {
      regex.lastIndex += 1;
    }
  }

  return matches;
};

const isEmptyConditionValue = (value: any) => {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const normalizeRuleForBasicMode = (rule: any) => {
  const normalized = { ...rule };

  if (Array.isArray(rule.patterns)) {
    for (const condition of rule.patterns) {
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
        continue;
      }

      for (const patternType of PATTERN_TYPES) {
        if (condition[patternType] !== undefined && normalized[patternType] === undefined) {
          normalized[patternType] = condition[patternType];
        }
      }
    }

    delete normalized.patterns;
  }

  return normalized;
};

const prepareRuleForYaml = (rule: any) => {
  const output: any = {};

  for (const [key, value] of Object.entries(rule)) {
    if (PATTERN_TYPES.includes(key)) continue;

    if (value !== undefined) {
      output[key] = value;
    }
  }

  const conditions = PATTERN_OUTPUT_ORDER
    .filter((field) => !isEmptyConditionValue(rule[field]))
    .map((field) => ({ field, value: rule[field] }));

  if (conditions.length === 1) {
    const condition = conditions[0];
    output[condition.field] = condition.value;
  } else if (conditions.length > 1) {
    output.patterns = conditions.map(({ field, value }) => ({ [field]: value }));
  }

  return output;
};

function RegexBuilder({
  value,
  testCode,
  testLanguage,
  onTestCodeChange,
  onApply,
  onClose,
}: {
  value: string;
  testCode: string;
  testLanguage: string;
  onTestCodeChange: (value: string) => void;
  onApply: (value: string) => void;
  onClose: () => void;
}) {
  const [tokens, setTokens] = useState<RegexToken[]>(() =>
    value ? [makeRegexToken({ label: 'Custom regex', value, description: 'Existing regex expression.' })] : [],
  );
  const [literal, setLiteral] = useState('');
  const regexValue = tokens.map((token) => token.value).join('');

  let previewMatches: Array<{ value: string; index: number }> = [];
  let previewError: string | null = null;

  try {
    previewMatches = getRegexPreviewMatches(regexValue, testCode);
  } catch (error: any) {
    previewError = error?.message || 'Invalid regex';
  }

  const addPiece = (piece: RegexPiece) => {
    setTokens((current) => [...current, makeRegexToken(piece)]);
  };

  const moveToken = (index: number, direction: -1 | 1) => {
    setTokens((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const removeToken = (index: number) => {
    setTokens((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const addLiteral = () => {
    if (!literal) return;

    addPiece({
      label: literal,
      value: escapeRegexLiteral(literal),
      description: 'Literal text escaped for regex.',
    });
    setLiteral('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-md border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Regex Builder</h3>
            <p className="text-xs text-gray-400">Build a pattern-regex from small pieces and test it against your code.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[calc(92vh-120px)] overflow-y-auto">
          <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
          <div className="space-y-4 p-4">
            <div>
              <label className="mb-2 block text-xs font-medium text-gray-400">Pieces</label>
              <div className="flex min-h-12 flex-wrap gap-2 rounded border border-gray-700 bg-gray-950 p-2">
                {tokens.length === 0 && (
                  <span className="px-2 py-1 text-xs text-gray-500">Choose pieces below</span>
                )}
                {tokens.map((token, index) => (
                  <div
                    key={token.id}
                    className="flex items-center rounded border border-blue-500/40 bg-blue-600/20 text-xs text-blue-100"
                    title={`${token.value} - ${token.description}`}
                  >
                    <span className="border-r border-blue-500/30 px-2 py-1 font-mono">{token.label}</span>
                    <button
                      type="button"
                      onClick={() => moveToken(index, -1)}
                      className="px-1 py-1 text-blue-200 hover:text-white disabled:opacity-30"
                      disabled={index === 0}
                      title="Move left"
                    >
                      <ArrowLeft size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveToken(index, 1)}
                      className="px-1 py-1 text-blue-200 hover:text-white disabled:opacity-30"
                      disabled={index === tokens.length - 1}
                      title="Move right"
                    >
                      <ArrowRight size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeToken(index)}
                      className="px-1.5 py-1 text-blue-200 hover:text-red-200"
                      title="Remove"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium text-gray-400">Regex</label>
              <textarea
                value={regexValue}
                onChange={(event) =>
                  setTokens(
                    event.target.value
                      ? [
                          makeRegexToken({
                            label: 'Custom regex',
                            value: event.target.value,
                            description: 'Custom regex expression.',
                          }),
                        ]
                      : [],
                  )
                }
                className="h-20 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium text-gray-400">Literal</label>
              <div className="flex gap-2">
                <input
                  value={literal}
                  onChange={(event) => setLiteral(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={addLiteral}
                  className="rounded bg-gray-700 px-3 py-2 text-sm text-white hover:bg-gray-600"
                >
                  Add
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {REGEX_PIECE_GROUPS.map((group) => (
                <div key={group.name}>
                  <h4 className="mb-2 text-xs font-semibold uppercase text-gray-500">{group.name}</h4>
                  <div className="flex flex-wrap gap-2">
                    {group.pieces.map((piece) => (
                      <button
                        key={`${group.name}-${piece.value}-${piece.label}`}
                        type="button"
                        onClick={() => addPiece(piece)}
                        className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:border-blue-500 hover:bg-gray-700"
                        title={`${piece.value} - ${piece.description}`}
                      >
                        <span className="font-mono">{piece.value}</span>
                        <span className="ml-1 text-gray-400">{piece.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-[420px] border-t border-gray-700 bg-gray-950 md:border-l md:border-t-0">
            <div className="border-b border-gray-800 px-4 py-3">
              <h4 className="text-xs font-semibold uppercase text-gray-500">Test Code</h4>
            </div>
            <Editor
              height="380px"
              language={testLanguage}
              theme="vs-dark"
              value={testCode}
              onChange={(nextValue) => onTestCodeChange(nextValue || '')}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                padding: { top: 12 },
                wordWrap: 'on',
              }}
            />
          </div>
          </div>

          <div className="border-t border-gray-700 bg-gray-950 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase text-gray-500">Matches</h4>
              {!previewError && <span className="text-xs text-gray-400">{previewMatches.length} matches</span>}
            </div>
            {previewError ? (
              <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
                {previewError}
              </div>
            ) : (
              <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto md:grid-cols-2 lg:grid-cols-3">
                {previewMatches.map((match, index) => (
                  <div key={`${match.index}-${index}`} className="rounded border border-gray-800 bg-gray-900 p-2">
                    <div className="mb-1 text-[10px] uppercase text-gray-500">Index {match.index}</div>
                    <code className="break-all text-xs text-green-300">{match.value || '(empty match)'}</code>
                  </div>
                ))}
                {regexValue && previewMatches.length === 0 && (
                  <div className="text-xs text-gray-500">No matches in test code.</div>
                )}
                {!regexValue && (
                  <div className="text-xs text-gray-500">No regex yet.</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-700 px-4 py-3">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(regexValue);
              onClose();
            }}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleCard({ rule, index, onChange, onDelete, testCode, testLanguage, onTestCodeChange }: any) {
  const [expanded, setExpanded] = useState(true);
  const [isRegexBuilderOpen, setIsRegexBuilderOpen] = useState(false);

  // Helper to ensure pattern-either is handled as array of objects in UI
  // For simplicity, we just represent the raw YAML values as text area
  const renderField = (field: string, label: string, isTextarea = true) => {
    let value = rule[field] || '';
    if (typeof value === 'object') {
      value = yaml.dump(value).trim();
    }
    
    const handleChange = (e: any) => {
      let newVal: any = e.target.value;
      if (field === 'pattern-either' || field === 'metadata') {
         try {
           newVal = yaml.load(newVal);
         } catch(err) {
           // allow malformed temporary input, but it might break yaml dump
         }
      }
      onChange(field, newVal);
    };

    return (
      <div key={field} className="mb-3 relative group">
        <label className="block text-xs font-medium text-gray-400 mb-1 capitalize">{label}</label>
        <div className="flex">
          {isTextarea ? (
            <textarea 
              value={typeof value === 'string' ? value : yaml.dump(value)}
              onChange={handleChange}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono h-16"
            />
          ) : (
            <input 
              type="text" 
              value={value}
              onChange={handleChange}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          )}
          {field === 'pattern-regex' && (
            <button
              type="button"
              onClick={() => setIsRegexBuilderOpen(true)}
              className="ml-2 text-gray-500 hover:text-blue-400"
              title="Build regex"
            >
              <Wand2 size={16} />
            </button>
          )}
          {field.startsWith('pattern') || field === 'fix' || field === 'metadata' ? (
             <button type="button" onClick={() => onChange(field, undefined)} className="ml-2 text-gray-500 hover:text-red-400" title="Remove field">
               <Trash2 size={16}/>
             </button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md mb-4 overflow-hidden shadow-sm">
      <div 
        className="bg-gray-700 px-4 py-3 flex justify-between items-center cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center space-x-2">
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <span className="font-semibold text-gray-200">{rule.id || `Rule #${index + 1}`}</span>
        </div>
        <button 
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-gray-400 hover:text-red-400 transition-colors"
        >
          <Trash2 size={18} />
        </button>
      </div>
      
      {expanded && (
        <div className="p-4">
          <div className="grid grid-cols-2 gap-4 mb-3">
             {renderField('id', 'ID', false)}
             <div className="mb-3">
              <label className="block text-xs font-medium text-gray-400 mb-1">Severity</label>
              <select 
                value={rule.severity || 'WARNING'}
                onChange={(e) => onChange('severity', e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="ERROR">ERROR</option>
              </select>
            </div>
          </div>
          
          {renderField('message', 'Message', true)}

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-400 mb-1 border-b border-gray-600 pb-1">Conditions</label>
            {PATTERN_TYPES.map(pt => rule[pt] !== undefined && renderField(pt, pt, true))}
            
            <div className="mt-2">
               <select 
                  className="bg-gray-700 text-xs text-white p-1 rounded border border-gray-600"
                  onChange={(e) => {
                     if (e.target.value) {
                        onChange(e.target.value, DEFAULT_CONDITION_VALUES[e.target.value] ?? '...');
                        e.target.value = "";
                     }
                  }}
                  defaultValue=""
               >
                  <option value="" disabled>+ Add Condition</option>
                  {PATTERN_TYPES.filter(pt => rule[pt] === undefined).map(pt => (
                     <option key={pt} value={pt}>{pt}</option>
                  ))}
               </select>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-400 mb-1 border-b border-gray-600 pb-1">Fix & Metadata</label>
            {rule.fix !== undefined && renderField('fix', 'Fix', true)}
            {rule.metadata !== undefined && renderField('metadata', 'Metadata', true)}
            <div className="mt-2 flex space-x-2">
               {rule.fix === undefined && (
                   <button onClick={() => onChange('fix', '...')} className="bg-gray-700 hover:bg-gray-600 text-xs text-white px-2 py-1 rounded border border-gray-600">
                     + Add Fix
                   </button>
               )}
               {rule.metadata === undefined && (
                   <button onClick={() => onChange('metadata', { source: "custom" })} className="bg-gray-700 hover:bg-gray-600 text-xs text-white px-2 py-1 rounded border border-gray-600">
                     + Add Metadata
                   </button>
               )}
            </div>
          </div>

          <div>
             <label className="block text-xs font-medium text-gray-400 mb-1">Languages (comma separated)</label>
             <input 
               type="text" 
               value={(rule.languages || []).join(', ')}
               onChange={(e) => {
                 const langs = e.target.value.split(',').map((l: string) => l.trim()).filter(Boolean);
                 onChange('languages', langs);
               }}
               className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
             />
          </div>
        </div>
      )}
      {isRegexBuilderOpen && (
        <RegexBuilder
          value={typeof rule['pattern-regex'] === 'string' ? rule['pattern-regex'] : ''}
          testCode={testCode || ''}
          testLanguage={testLanguage || 'javascript'}
          onTestCodeChange={onTestCodeChange || (() => {})}
          onApply={(regexValue) => onChange('pattern-regex', regexValue)}
          onClose={() => setIsRegexBuilderOpen(false)}
        />
      )}
    </div>
  );
}

function Guide() {
  return (
    <div className="p-6 text-gray-300 text-sm overflow-y-auto h-full custom-scrollbar leading-relaxed">
      <h2 className="text-xl font-bold text-white mb-4 flex items-center"><BookOpen className="mr-2"/> Semgrep Quick Guide</h2>
      
      <h3 className="text-blue-400 font-semibold mt-4 mb-2">Metavariables ($VAR)</h3>
      <p className="mb-2">A metavariable like <code className="bg-gray-800 px-1 rounded text-pink-300">$X</code> matches any valid code expression, variable, or statement. It acts as a variable that can be reused. E.g. <code className="bg-gray-800 px-1 rounded text-green-300">$X == $X</code> finds useless comparisons.</p>
      
      <h3 className="text-blue-400 font-semibold mt-4 mb-2">Ellipsis (...)</h3>
      <p className="mb-2">The ellipsis matches a sequence of 0 or more statements, arguments, or characters. E.g. <code className="bg-gray-800 px-1 rounded text-green-300">foo(...)</code> matches calls to <code>foo</code> with any arguments.</p>
      
      <h3 className="text-blue-400 font-semibold mt-4 mb-2">Conditions</h3>
      <ul className="list-disc pl-5 space-y-1 mb-4">
         <li><b>pattern:</b> Matches the code exactly or using metavariables.</li>
         <li><b>pattern-either:</b> Matches if any of the sub-patterns match.</li>
         <li><b>pattern-not:</b> Filters out code that matches this pattern.</li>
         <li><b>pattern-inside:</b> Only match inside the context of this pattern.</li>
         <li><b>pattern-regex:</b> Fallback to regular expression matching.</li>
      </ul>

      <h3 className="text-blue-400 font-semibold mt-4 mb-2">Autofix (fix)</h3>
      <p className="mb-2">You can provide a replacement string using matched metavariables. Example:</p>
      <pre className="bg-gray-800 p-3 rounded text-xs text-gray-200 overflow-x-auto mb-4">
{`pattern: setTimeout($FUNC, $TIME)
fix: setInterval($FUNC, $TIME)`}
      </pre>
      <p>In this app, adding a <code>fix</code> will show a side-by-side preview without replacing your test code permanently!</p>
    </div>
  );
}

export function RuleEditor({
  yamlContent,
  onChange,
  onExport,
  exportStatus,
  isExporting = false,
  testCode = '',
  testLanguage = 'javascript',
  onTestCodeChange = () => {},
}: RuleEditorProps) {
  const [mode, setMode] = useState<'basic' | 'advanced' | 'guide'>('basic');
  const [rules, setRules] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'basic') {
      try {
        const parsed = yaml.load(yamlContent) as any;
        if (parsed && parsed.rules && Array.isArray(parsed.rules)) {
          setRules(parsed.rules.map(normalizeRuleForBasicMode));
        } else {
          setRules([]);
        }
        setError(null);
      } catch (e: any) {
        setError("Invalid YAML structure. Cannot switch to Basic mode without valid YAML containing a 'rules' array.");
      }
    }
  }, [yamlContent, mode]);

  const updateRulesYaml = (newRules: any[]) => {
    try {
      // Remove undefined fields
      const cleaned = JSON.parse(JSON.stringify(newRules));
      const rulesForYaml = cleaned.map(prepareRuleForYaml);
      const newYaml = yaml.dump({ rules: rulesForYaml }, { noRefs: true });
      onChange(newYaml);
      setRules(cleaned);
    } catch (e) {
      console.error(e);
    }
  };

  const handleRuleChange = (index: number, field: string, value: any) => {
    const newRules = [...rules];
    if (value === undefined) {
       delete newRules[index][field];
    } else {
       newRules[index] = { ...newRules[index], [field]: value };
    }
    updateRulesYaml(newRules);
  };

  const handleAddRule = () => {
    const newRule = {
      id: `new-rule-${Date.now()}`,
      pattern: '...',
      message: 'Found something',
      severity: 'WARNING',
      languages: ['javascript']
    };
    updateRulesYaml([...rules, newRule]);
  };

  return (
    <div className="h-full w-full flex flex-col bg-gray-900">
      <div className="bg-gray-900 text-white p-2 border-b border-gray-700 flex justify-between items-center">
        <div className="flex space-x-1 bg-gray-800 p-1 rounded-md">
          <button
            className={`px-3 py-1 text-sm rounded-sm font-medium transition-colors ${mode === 'basic' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
            onClick={() => setMode('basic')}
          >
            Basic
          </button>
          <button
            className={`px-3 py-1 text-sm rounded-sm font-medium transition-colors ${mode === 'advanced' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
            onClick={() => setMode('advanced')}
          >
            Advanced
          </button>
          <button
            className={`px-3 py-1 text-sm rounded-sm font-medium transition-colors ${mode === 'guide' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
            onClick={() => setMode('guide')}
          >
            Guide
          </button>
        </div>
        <div className="flex min-w-0 items-center space-x-3">
          {exportStatus && (
            <span className="max-w-72 truncate text-xs text-gray-300" title={exportStatus}>
              {exportStatus}
            </span>
          )}
          <button
            type="button"
            onClick={onExport}
            disabled={isExporting}
            className={`flex items-center space-x-2 text-sm bg-gray-700 text-white px-3 py-1.5 rounded transition-colors ${isExporting ? 'cursor-wait opacity-70' : 'hover:bg-gray-600'}`}
          >
            <Download size={16} />
            <span>{isExporting ? 'Exporting' : 'Export'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {mode === 'basic' && (
          <div className="h-full overflow-y-auto p-4 custom-scrollbar">
            {error && (
              <div className="bg-red-500/20 border border-red-500/50 text-red-200 p-3 rounded mb-4 text-sm">
                {error}
              </div>
            )}
            {!error && rules.map((rule, idx) => (
              <RuleCard 
                key={rule.id || idx}
                rule={rule} 
                index={idx} 
                testCode={testCode}
                testLanguage={testLanguage}
                onTestCodeChange={onTestCodeChange}
                onChange={(field: string, val: any) => handleRuleChange(idx, field, val)}
                onDelete={() => {
                  const newRules = rules.filter((_, i) => i !== idx);
                  updateRulesYaml(newRules);
                }}
              />
            ))}
            {!error && (
              <button 
                onClick={handleAddRule}
                className="w-full flex items-center justify-center space-x-2 border-2 border-dashed border-gray-600 hover:border-gray-500 text-gray-400 hover:text-gray-300 rounded-md py-4 transition-colors"
              >
                <Plus size={20} />
                <span className="font-semibold">Add Rule</span>
              </button>
            )}
          </div>
        )}
        
        {mode === 'advanced' && (
          <Editor
            height="100%"
            language="yaml"
            theme="vs-dark"
            value={yamlContent}
            onChange={(val) => onChange(val || '')}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              padding: { top: 16 }
            }}
          />
        )}

        {mode === 'guide' && <Guide />}
      </div>
    </div>
  );
}
