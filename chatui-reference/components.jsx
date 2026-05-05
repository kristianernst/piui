/* eslint-disable */
const { useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } = React;

// ---------------- Chart ----------------
function smoothPath(points) {
  if (points.length < 2) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const xm = (x0 + x1) / 2;
    d += ` C ${xm} ${y0}, ${xm} ${y1}, ${x1} ${y1}`;
  }
  return d;
}

function Chart({ data, height = 160, yLabels = ['10K','5K','0K'], xLabels, animate = true, animationKey = 0 }) {
  const W = 680, H = height;
  const padL = 36, padR = 12, padT = 14, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...data);
  const points = data.map((v, i) => [
    padL + (i / (data.length - 1)) * innerW,
    padT + innerH - (v / max) * innerH * 0.92
  ]);
  const linePath = smoothPath(points);
  const areaPath = linePath + ` L ${padL + innerW} ${padT + innerH} L ${padL} ${padT + innerH} Z`;

  const pathRef = useRef(null);
  const [len, setLen] = useState(0);

  useLayoutEffect(() => {
    if (pathRef.current) setLen(pathRef.current.getTotalLength());
  }, [animationKey]);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" key={animationKey}>
      {[0, 0.5, 1].map(t => (
        <line key={t} className="grid"
          x1={padL} x2={W - padR}
          y1={padT + innerH * t} y2={padT + innerH * t} />
      ))}
      {yLabels.map((l, i) => (
        <text key={l} className="axis" x={padL - 8} y={padT + innerH * (i / (yLabels.length - 1)) + 3}
              textAnchor="end">{l}</text>
      ))}
      {xLabels && xLabels.map((l, i) => {
        const x = padL + (i / (xLabels.length - 1)) * innerW;
        const anchor = i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle';
        return <text key={i} className="axis" x={x} y={H - 8} textAnchor={anchor}>{l}</text>;
      })}
      <path className="area" d={areaPath}
            style={animate ? { opacity: 0, animation: 'fadeIn 0.7s 0.5s var(--ease) forwards' } : {}} />
      <path ref={pathRef} className="line" d={linePath}
            style={animate && len ? {
              strokeDasharray: len,
              strokeDashoffset: len,
              animation: 'drawLine 1.3s var(--ease) forwards'
            } : {}} />
    </svg>
  );
}

(function injectChartKeyframes(){
  if (document.getElementById('chart-kf')) return;
  const s = document.createElement('style');
  s.id = 'chart-kf';
  s.textContent = `@keyframes drawLine { to { stroke-dashoffset: 0; } }`;
  document.head.appendChild(s);
})();

// ---------------- Smooth height transition ----------------
// Transitions an element from collapsed to natural height using grid-template-rows trick
function Collapsible({ open, children, duration = 380 }) {
  return (
    <div className="collapsible" data-open={open ? 'true' : 'false'}
         style={{ '--dur': `${duration}ms` }}>
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}

// ---------------- Expandable Tool Pill ----------------
// Click toggles open/closed (accordion). Hover provides subtle styling only.
function ToolPill({ icon = 'search', label, expandable = false, locked: lockedProp, onLockChange, children, status = 'done' }) {
  const Ico = { search: IconSearch, db: IconDb, web: IconWeb, doc: IconDoc, code: IconCode, chart: IconChart }[icon] || IconSearch;
  const [internalLocked, setInternalLocked] = useState(false);
  const locked = lockedProp !== undefined ? lockedProp : internalLocked;
  const open = expandable && locked;

  const toggle = () => {
    if (!expandable) return;
    const next = !locked;
    if (lockedProp !== undefined) onLockChange?.(next);
    else setInternalLocked(next);
  };

  const onKey = (e) => {
    if (!expandable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      className={`tool-pill-wrap ${expandable ? 'is-expandable' : ''} ${open ? 'is-open' : ''} ${status === 'running' ? 'is-running' : ''}`}
    >
      <button
        type="button"
        className="tool-pill"
        onClick={toggle}
        onKeyDown={onKey}
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? open : undefined}
      >
        <Ico className="ico" />
        <span className="label">{label}</span>
        {expandable && <IconChev className="chev" />}
        {status === 'running' && <span className="pulse" />}
      </button>
      {expandable && (
        <Collapsible open={open} duration={460}>
          <div className="tool-content">
            {children}
          </div>
        </Collapsible>
      )}
    </div>
  );
}

// ---------------- Reasoning ----------------
function Reasoning({ steps, durationSec, defaultOpen = true, status = 'done' }) {
  const [open, setOpen] = useState(defaultOpen);
  const isThinking = status === 'thinking';

  return (
    <div className={`reasoning ${open ? 'open' : ''} fade-up`}>
      <div className={`reasoning-header ${isThinking ? 'thinking' : 'done'}`} onClick={() => setOpen(o => !o)}>
        <span className="check">
          {!isThinking && <IconCheck size={10} stroke="currentColor" strokeWidth={2} />}
        </span>
        <span className="label">
          {isThinking ? 'Thinking…' : `Thought for ${durationSec}s`}
        </span>
        <IconChev className="chev" />
      </div>
      <Collapsible open={open} duration={500}>
        <div className="reasoning-content">
          {steps.map((step, i) => (
            <ReasoningStep key={i} step={step} index={i} active={isThinking && i === steps.length - 1} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

function ReasoningStep({ step, index, active }) {
  const delay = `${index * 0.08}s`;
  if (step.type === 'text') {
    return <div className={`rstep fade-up ${active ? 'active' : ''}`} style={{ animationDelay: delay }}>
      {step.text}
    </div>;
  }
  if (step.type === 'tool') {
    return <div className="fade-up rstep-tool" style={{ animationDelay: delay }}>
      <ToolPill {...step} />
    </div>;
  }
  return null;
}

// ---------------- Streaming text ----------------
function StreamText({ text, speed = 14, onDone, startDelay = 0 }) {
  const [shown, setShown] = useState(0);
  const [started, setStarted] = useState(startDelay === 0);

  useEffect(() => {
    if (startDelay > 0) {
      const t = setTimeout(() => setStarted(true), startDelay);
      return () => clearTimeout(t);
    }
  }, [startDelay]);

  useEffect(() => {
    if (!started) return;
    if (shown >= text.length) { onDone && onDone(); return; }
    const chunk = Math.max(1, Math.round(2 + Math.random() * 3));
    const t = setTimeout(() => setShown(s => Math.min(text.length, s + chunk)), speed + Math.random() * 25);
    return () => clearTimeout(t);
  }, [shown, started, text, speed]);

  const slice = text.slice(0, shown);
  const done = shown >= text.length;
  const paragraphs = slice.split(/\n\n/);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i}>
          {renderInline(p)}
          {!done && i === paragraphs.length - 1 && <span className="stream-cursor" />}
        </p>
      ))}
    </>
  );
}

function renderInline(s) {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

// ---------------- Composer ----------------
// Header: approval asks (sandbox approve / deny)
// Footer: context-length ring (hover to expand), model + reasoning effort
function ModeSwitch({ value = 'auto', onChange }) {
  const modes = [
    { id: 'yolo', label: 'yolo', Icon: IconYolo,
      desc: 'YOLO — no approvals, fully autonomous.' },
    { id: 'auto', label: 'auto', Icon: IconAuto,
      desc: 'Auto — handles routine tasks, asks before risky ones.' },
    { id: 'ask',  label: 'ask',  Icon: IconAsk,
      desc: 'Ask — pauses for approval before every tool call.' },
  ];
  const idx = Math.max(0, modes.findIndex(m => m.id === value));
  const active = modes[idx] || modes[1];
  const cycle = () => {
    const next = modes[(idx + 1) % modes.length];
    onChange?.(next.id);
  };
  return (
    <button
      type="button"
      className={`comp-mode comp-mode-${active.id}`}
      onClick={cycle}
      title={active.desc + ' (click to cycle)'}
      aria-label={`Permission mode: ${active.label}. Click to cycle.`}
    >
      <active.Icon size={11} strokeWidth={2.25} />
      <span className="comp-mode-label">{active.label}</span>
    </button>
  );
}

function Composer({
  onSend,
  disabled,
  onStop,
  isStreaming,
  approval,                  // { id, title, detail, kind } | null
  onApprovalDecision,        // (id, 'approve' | 'deny') => void
  contextUsed = 0.42,        // 0–1 portion of context consumed
  contextTokens = '52.3k',   // display label
  contextMax = '128k',
  model = 'aria 1.5',
  reasoningEffort = 'medium', // 'low' | 'medium' | 'high'
  mode = 'auto',              // 'yolo' | 'auto' | 'ask'
  onModeChange
}) {
  const [val, setVal] = useState('');
  const [ctxHover, setCtxHover] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(180, t.scrollHeight) + 'px';
  }, [val]);

  const submit = () => {
    if (!val.trim() || disabled) return;
    onSend(val.trim());
    setVal('');
  };

  const hasText = val.trim().length > 0;

  // ring geometry
  const R = 6;
  const C = 2 * Math.PI * R;
  const ringPct = Math.max(0, Math.min(1, contextUsed));
  const ringColor = ringPct > 0.85 ? 'oklch(0.65 0.18 30)'
                  : ringPct > 0.65 ? 'oklch(0.72 0.16 80)'
                  : 'var(--accent)';

  return (
    <div className="composer-wrap">
      {/* Single morphing shell — approval grows into the input */}
      <div className={`composer ${approval ? 'has-approval' : ''} ${isStreaming ? 'is-streaming' : ''}`}>
        <Collapsible open={!!approval} duration={480}>
          {approval && (
            <div className="comp-approval" key={approval.id}>
              <div className="comp-approval-body">
                <div className="comp-approval-head">
                  <span className="comp-approval-kind">{approval.kind || 'approval needed'}</span>
                  <span className="comp-approval-title">{approval.title}</span>
                </div>
                {approval.detail && (
                  <div className="comp-approval-detail">{approval.detail}</div>
                )}
              </div>
              <div className="comp-approval-actions">
                <button className="comp-approval-btn deny"
                        onClick={() => onApprovalDecision?.(approval.id, 'deny')}>Deny</button>
                <button className="comp-approval-btn approve"
                        onClick={() => onApprovalDecision?.(approval.id, 'approve')}>Approve</button>
              </div>
            </div>
          )}
        </Collapsible>

        <div className="comp-row">
          <button className="comp-add" title="Add" type="button">
            <IconPlus size={14} />
          </button>
          <textarea
            ref={ref}
            value={val}
            onChange={e => setVal(e.target.value)}
            placeholder="Ask anything…"
            rows={1}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="comp-action">
            {isStreaming ? (
              <button className="comp-btn comp-stop" onClick={onStop} title="Stop" key="stop">
                <IconStop size={11} />
              </button>
            ) : hasText ? (
              <button className="comp-btn comp-send" onClick={submit} title="Send" key="send">
                <IconArrowUp size={13} />
              </button>
            ) : (
              <button className="comp-btn comp-mic" title="Voice" key="mic">
                <IconMic size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* FOOTER — context ring + model meta */}
      <div className="comp-foot">
        <div
          className={`comp-ctx ${ctxHover ? 'is-hover' : ''}`}
          onMouseEnter={() => setCtxHover(true)}
          onMouseLeave={() => setCtxHover(false)}
        >
          <svg className="comp-ring" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r={R} fill="none"
                    stroke="var(--hairline-strong)" strokeWidth="1.5" />
            <circle cx="8" cy="8" r={R} fill="none"
                    stroke={ringColor} strokeWidth="1.5"
                    strokeDasharray={C}
                    strokeDashoffset={C * (1 - ringPct)}
                    strokeLinecap="round"
                    transform="rotate(-90 8 8)"
                    style={{ transition: 'stroke-dashoffset 0.5s var(--ease)' }} />
          </svg>
          <span className="comp-ctx-label">
            <span className="comp-ctx-pct">{Math.round(ringPct * 100)}%</span>
            <span className="comp-ctx-detail">
              <span className="comp-ctx-tokens">{contextTokens}</span>
              <span className="comp-ctx-of">/ {contextMax}</span>
            </span>
          </span>
        </div>

        <span className="comp-foot-sep" />

        <ModeSwitch value={mode} onChange={onModeChange} />

        <div className="comp-meta">
          <span className="comp-meta-pip" />
          <span className="comp-meta-model">{model}</span>
          <span className="comp-meta-dot">·</span>
          <span className={`comp-meta-effort comp-meta-effort-${reasoningEffort}`}>
            <span className="comp-meta-effort-bars" aria-hidden="true">
              <i /><i /><i />
            </span>
            <span>{reasoningEffort}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Chart, Reasoning, ToolPill, StreamText, Composer, smoothPath, Collapsible });
