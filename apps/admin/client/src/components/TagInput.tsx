import { useId, useState } from 'react';

/** Multi-value input with suggestions from the managed lists. */
export function TagInput({ value, onChange, options = [], placeholder, allowNew = true }: {
  value: string[];
  onChange: (v: string[]) => void;
  options?: string[];
  placeholder?: string;
  allowNew?: boolean;
}) {
  const [text, setText] = useState('');
  const [warn, setWarn] = useState<string>();
  const listId = useId();
  const hintId = useId();
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const match = options.find((o) => o.toLowerCase() === t.toLowerCase());
    const val = match ?? (allowNew ? t : undefined);
    if (!val) {
      // Keep what was typed so it is not lost, and say why it was not added.
      setWarn(`"${t}" is not in Lists & tags yet. An approver or administrator can add it there; then pick it here.`);
      return;
    }
    setWarn(undefined);
    if (!value.includes(val)) onChange([...value, val]);
    setText('');
  };
  return (
    <>
    <div className="tags">
      {value.map((v) => (
        <span key={v} className="tag-pill">
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        placeholder={value.length ? '' : placeholder}
        aria-describedby={warn ? hintId : undefined}
        aria-invalid={warn ? true : undefined}
        onChange={(e) => {
          const t = e.target.value;
          setWarn(undefined);
          // Picking from the datalist fires a change with an exact option value.
          if (options.includes(t)) add(t); else setText(t);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); }
          if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => add(text)}
      />
      <datalist id={listId}>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o} />)}</datalist>
    </div>
    {warn && <span id={hintId} className="hint warn" role="status">{warn} <a href="/taxonomy" target="_blank" rel="noopener">Open Lists &amp; tags in a new tab</a></span>}
    </>
  );
}
