import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Drop-down list with tick boxes for picking several values from a managed list (Lists & tags).
 * Type to filter, arrow keys to move, Enter or Space to tick, Escape to close.
 */
export function MultiSelect({ value, onChange, options, placeholder = 'Select...', label, disabled }: {
  value: string[];
  onChange: (v: string[]) => void;
  /** Undefined while the list is loading. */
  options?: string[];
  placeholder?: string;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optId = (i: number) => `${listId}-o${i}`;

  const sorted = useMemo(() => [...(options ?? [])].sort((a, b) => a.localeCompare(b)), [options]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? sorted.filter((o) => o.toLowerCase().includes(f)) : sorted;
  }, [sorted, filter]);
  // Values saved earlier that are no longer in Lists & tags stay visible so they can be removed.
  const unknown = options ? value.filter((v) => !options.includes(v)) : [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    search.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => { setActive(0); }, [filter]);
  useEffect(() => {
    if (open) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  const close = () => { setOpen(false); setFilter(''); };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' || (e.key === ' ' && !filter)) { e.preventDefault(); if (shown[active]) toggle(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close();
  };

  return (
    <div className={`ms${open ? ' open' : ''}`} ref={root}>
      <div className="ms-control">
        {value.map((v) => (
          <span key={v} className={`tag-pill${unknown.includes(v) ? ' tag-pill-warn' : ''}`} title={unknown.includes(v) ? 'Not in Lists & tags' : undefined}>
            {v}
            {!disabled && <button type="button" aria-label={`Remove ${v}`} onClick={() => toggle(v)}>×</button>}
          </span>
        ))}
        <button
          type="button"
          className="ms-toggle"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${label}: ${value.length ? `${value.length} selected` : 'none selected'}. Open list`}
          disabled={disabled || !options}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className="muted">{!options ? 'Loading...' : value.length ? 'Add or remove' : placeholder}</span>
          <span aria-hidden="true" className="ms-caret">▾</span>
        </button>
      </div>
      {open && options && (
        <div className="ms-panel">
          <input
            ref={search}
            type="search"
            className="ms-search"
            placeholder={`Filter ${sorted.length} ${label.toLowerCase()}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown.length ? optId(active) : undefined}
            aria-label={`Filter ${label.toLowerCase()}`}
          />
          <ul id={listId} role="listbox" aria-multiselectable="true" aria-label={label} className="ms-list">
            {shown.map((o, i) => {
              const on = value.includes(o);
              return (
                <li
                  key={o}
                  id={optId(i)}
                  role="option"
                  aria-selected={on}
                  className={`ms-opt${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(o)}
                >
                  <span className={`ms-box${on ? ' on' : ''}`} aria-hidden="true">{on ? '✓' : ''}</span>
                  {o}
                </li>
              );
            })}
            {!shown.length && <li className="ms-empty muted">{sorted.length ? 'No matches.' : 'The list is empty.'} Add items in <a href="/taxonomy" target="_blank" rel="noopener">Lists &amp; tags</a>.</li>}
          </ul>
          <div className="ms-foot">
            <span className="muted small">{value.length} selected</span>
            {value.length > 0 && <button type="button" className="btn btn-sm" onClick={() => onChange([])}>Clear</button>}
            <button type="button" className="btn btn-sm btn-primary" onClick={close}>Done</button>
          </div>
        </div>
      )}
      {unknown.length > 0 && <span className="hint warn">{unknown.map((u) => `"${u}"`).join(', ')} {unknown.length === 1 ? 'is' : 'are'} not in Lists &amp; tags. Remove {unknown.length === 1 ? 'it' : 'them'}, or ask an approver or administrator to add {unknown.length === 1 ? 'it' : 'them'}.</span>}
    </div>
  );
}
