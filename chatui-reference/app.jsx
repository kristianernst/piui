/* eslint-disable */
const { useState, useEffect, useRef, useCallback } = React;

// --------- Mock data generators ---------
const salesSeries = [4200, 5800, 7800, 8900, 6400, 5100, 7200, 8400, 6900, 5800, 4200, 6200, 8100, 9000, 7600, 6900, 5200, 6400, 8000, 9100, 8400];
const retentionSeries = [62, 64, 66, 65, 68, 71, 73, 72, 74, 76, 77, 78, 76, 79, 81];

const SAMPLE_QUERIES = [
  "Analyze our 2025 sales and outline a plan for 2026",
  "Why is repeat purchase rate dropping in the Northeast?",
  "Draft a launch brief for the spring collection",
  "Summarize last week's customer support tickets"
];

// --------- Pre-built turn: the demo conversation ---------
function buildDemoTurn(setStreaming) {
  // Returns the structured response Aria gives to the first user prompt.
  // Phases:
  // 1. show "Thinking…" reasoning
  // 2. progressively reveal reasoning steps with tool calls + chart
  // 3. finalize reasoning => "Thought for Ns"
  // 4. stream final answer

  const reasoningSteps = [
    { type: 'text', text: "The user wants a 2026 plan grounded in 2025 performance. I should pull overall revenue, identify the strongest months, then look at retention to see what's defensible vs. what needs work." },
    { type: 'tool', icon: 'chart', label: 'Collection performance in 2025', expandable: true,
      children: (
        <div className="card">
          <div className="card-head">
            <span className="icon"><IconChart /></span>
            <span className="title">Overall sales performance</span>
            <span className="badge">2025</span>
          </div>
          <Chart data={salesSeries} yLabels={['10K','5K','0K']} xLabels={['Jun 6','Jun 14','Jun 22','Jul 6']} />
        </div>
      )
    },
    { type: 'text', text: "To assess customer retention, I should look at repeat purchase behavior rather than just total customers. I'll calculate metrics like repeat customer rate and purchase frequency to give the user actionable insights into loyalty." },
    { type: 'tool', icon: 'db', label: 'cohorts.retention —window=90d', expandable: true,
      children: (
        <div className="card">
          <div className="card-head">
            <span className="icon"><IconDb /></span>
            <span className="title">Repeat customer rate</span>
            <span className="badge">90d rolling</span>
          </div>
          <Chart data={retentionSeries} yLabels={['100%','50%','0%']} xLabels={['Jan','Apr','Jul','Oct','Dec']} />
        </div>
      )
    },
    { type: 'tool', icon: 'doc', label: 'sources (3 files)', expandable: true,
      children: (
        <div className="source-row">
          {[
            { label: 'cohorts_q4.csv', num: '24 rows', color: 'oklch(0.65 0.16 200)' },
            { label: 'returns_log.csv', num: '1.2k rows', color: 'oklch(0.65 0.16 30)' },
            { label: 'campaigns.json', num: '18 keys', color: 'oklch(0.65 0.16 140)' },
          ].map((s, i) => (
            <div key={i} className="source-pill">
              <span className="fav" style={{ background: s.color }} />
              <span>{s.label}</span>
              <span className="num">{s.num}</span>
            </div>
          ))}
        </div>
      )
    },
    { type: 'text', text: "Cross-checking the dip in May against the campaign calendar — looks correlated with the paused Meta spend. Worth flagging in the plan." },
  ];

  const finalAnswer =
`I looked at the historical data for 2025, and looking at your overall sales performance, I have a plan for how to take on 2026.

**The headline:** revenue grew **+18% YoY**, but the gains are concentrated in three peak weeks. The other 80% of the year is flat. The opportunity isn't a bigger peak — it's a thicker middle.

Three moves I'd prioritize:

**1. Smooth the trough.** The May–June dip closely tracks your paused Meta spend. Reinstating a baseline of \`$8k/week\` in evergreen creative should recover ~\`$140k\` in lost orders.

**2. Double down on the **\`Coastal\`** collection.** It accounted for 34% of revenue on 12% of SKUs. Expand the line, then test a higher-priced anchor SKU.

**3. Build retention before acquisition.** Repeat purchase rate sits at **41%** — healthy, but flat for two quarters. A win-back flow at day 60 could lift it to ~48%, worth roughly **+\`$420k\`** at current AOV.

Want me to draft the campaign calendar and brief for move #1?`;

  return { reasoningSteps, finalAnswer };
}

// --------- App ---------
function App() {
  const initialTweaks = /*EDITMODE-BEGIN*/{
    "dark": false,
    "accent": "#5B5BD6",
    "streamSpeed": 14,
    "density": "comfortable",
    "showSuggestions": true,
    "leftOpen": true,
    "rightOpen": true,
    "model": "aria 1.5",
    "reasoningEffort": "medium",
    "mode": "auto"
  }/*EDITMODE-END*/;

  const [tweaks, setTweak] = useTweaks(initialTweaks);
  const [turns, setTurns] = useState([]); // each turn: { id, user, phase, ... }
  const [phase, setPhase] = useState('idle'); // 'idle' | 'thinking' | 'streaming'
  const [activeChat, setActiveChat] = useState('c1');
  const [artifacts, setArtifacts] = useState([
    { id: 'a1', title: 'Q1 2026 plan — exec brief', kind: 'doc', state: 'done', time: '2m' },
    { id: 'a2', title: 'Repeat customer rate · 90d', kind: 'chart', state: 'done', time: '4m' },
  ]);
  const [approval, setApproval] = useState(null);
  const [contextUsed, setContextUsed] = useState(0.41);
  const threadRef = useRef(null);
  const stopRef = useRef(false);

  useEffect(() => {
    document.body.classList.toggle('dark', !!tweaks.dark);
    document.documentElement.style.setProperty('--accent', tweaks.accent);
    document.documentElement.style.setProperty('--chart', tweaks.accent);
    document.documentElement.style.setProperty('--chart-fill',
      `color-mix(in oklch, ${tweaks.accent} 8%, transparent)`);
  }, [tweaks.dark, tweaks.accent]);

  // gentle auto-scroll — uses ResizeObserver so streaming + collapsibles trigger it
  const userScrolledUpRef = useRef(false);
  const animatingRef = useRef(false);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      if (animatingRef.current) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUpRef.current = distFromBottom > 140;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const smoothScrollToBottom = useCallback(() => {
    const el = threadRef.current;
    if (!el || userScrolledUpRef.current) return;
    const from = el.scrollTop;
    const to = el.scrollHeight - el.clientHeight;
    if (Math.abs(to - from) < 2) return;
    animatingRef.current = true;
    let start;
    const dur = 480;
    const ease = t => 1 - Math.pow(1 - t, 3);
    const tick = (ts) => {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / dur);
      const target = el.scrollHeight - el.clientHeight; // re-read; content may grow mid-anim
      el.scrollTop = from + (target - from) * ease(t);
      if (t < 1) requestAnimationFrame(tick);
      else animatingRef.current = false;
    };
    requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    let scheduled = false;
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; smoothScrollToBottom(); });
    });
    // observe inner children so scrollHeight changes are caught
    Array.from(el.children).forEach(c => ro.observe(c));
    const mo = new MutationObserver(() => {
      Array.from(el.children).forEach(c => { try { ro.observe(c); } catch(e){} });
    });
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [smoothScrollToBottom]);

  const send = useCallback((text) => {
    const id = Date.now();
    const { reasoningSteps, finalAnswer } = buildDemoTurn();
    const turn = {
      id,
      user: text,
      reasoningSteps,
      visibleSteps: 0,
      reasoningStatus: 'thinking',
      duration: 0,
      finalAnswer,
      showAnswer: false,
      streamDone: false,
    };
    setTurns(t => [...t, turn]);
    setPhase('thinking');
    stopRef.current = false;
    // Each turn nudges the context ring up
    setContextUsed(c => Math.min(0.96, c + 0.07 + Math.random() * 0.04));
    // Mid-flow, surface an approval ask the user can resolve.
    setTimeout(() => {
      if (stopRef.current) return;
      if ((tweaks.mode || 'auto') !== 'yolo') {
        setApproval({
          id: 'apr-' + id,
          kind: 'tool · production data',
          title: 'Run query against the live orders database?',
          detail: 'Aria wants to read 1,240 rows from `orders.q4_2025` — read-only, no PII columns.'
        });
      }
    }, 1800);

    // Reveal reasoning steps progressively + drop artifacts
    let i = 0;
    const startedAt = Date.now();

    // queue an artifact creation
    const newArtifactId = 'a' + id;
    setArtifacts(a => [{ id: newArtifactId, title: 'Sales performance · 2025', kind: 'chart', state: 'creating', time: 'now' }, ...a]);

    const reveal = () => {
      if (stopRef.current) return;
      i++;
      setTurns(prev => prev.map(t => t.id === id ? { ...t, visibleSteps: i } : t));
      // mid-flow: add a doc artifact
      if (i === Math.ceil(reasoningSteps.length / 2)) {
        setArtifacts(a => [
          { id: newArtifactId + '-doc', title: '2026 strategic plan — draft', kind: 'doc', state: 'creating', time: 'now' },
          ...a
        ]);
      }
      if (i < reasoningSteps.length) {
        const delay = reasoningSteps[i]?.type === 'card' ? 900 :
                      reasoningSteps[i]?.type === 'tool' ? 600 : 800;
        setTimeout(reveal, delay);
      } else {
        const dur = Math.max(8, Math.round((Date.now() - startedAt) / 1000) + 14);
        setTimeout(() => {
          if (stopRef.current) return;
          setTurns(prev => prev.map(t => t.id === id
            ? { ...t, reasoningStatus: 'done', duration: dur, showAnswer: true }
            : t));
          setPhase('streaming');
          // mark first artifact done, set second to updated
          setArtifacts(a => a.map(x =>
            x.id === newArtifactId ? { ...x, state: 'updated' } :
            x.id === newArtifactId + '-doc' ? { ...x, state: 'updated' } : x));
        }, 600);
      }
    };
    setTimeout(reveal, 400);
  }, []);

  const stop = useCallback(() => {
    stopRef.current = true;
    setPhase('idle');
    setTurns(prev => prev.map((t, i) => i === prev.length - 1
      ? { ...t, reasoningStatus: 'done', showAnswer: true, streamDone: true } : t));
  }, []);

  const onAnswerDone = (id) => {
    setTurns(prev => prev.map(t => t.id === id ? { ...t, streamDone: true } : t));
    setPhase('idle');
  };

  const isEmpty = turns.length === 0;

  return (
    <div className="shell">
      <LeftSidebar
        open={tweaks.leftOpen}
        onToggle={() => setTweak('leftOpen', !tweaks.leftOpen)}
        activeChat={activeChat}
        onPickChat={setActiveChat}
      />

      <div className="app">
        <div className="topbar">
          <div className="topbar-left">
            {!tweaks.leftOpen && (
              <button className="floating-toggle" onClick={() => setTweak('leftOpen', true)}
                      title="Show sidebar"><IconSidebarL /></button>
            )}
          </div>
          <div className="topbar-title">
            {turns.length > 0 ? turns[0].user.slice(0, 60) : 'New conversation'}
          </div>
          <div className="topbar-right">
            <span className="topbar-date">
              {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
            {!tweaks.rightOpen && (
              <button className="floating-toggle" onClick={() => setTweak('rightOpen', true)}
                      title="Show artifacts"><IconSidebarR /></button>
            )}
          </div>
        </div>

        <div className="thread thread-mask" ref={threadRef}>
          {isEmpty ? (
            <div className="empty fade-up">
              <h1>Good evening.</h1>
              <p>Ask anything about your business — I can pull from your data and the web.</p>
              <div className="suggest-row">
                {SAMPLE_QUERIES.map((q, i) => (
                  <button key={i} className="suggest fade-up"
                          style={{ animationDelay: `${0.1 + i * 0.06}s` }}
                          onClick={() => send(q)}>{q}</button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn, ti) => (
              <Turn key={turn.id} turn={turn} streamSpeed={tweaks.streamSpeed}
                    onAnswerDone={() => onAnswerDone(turn.id)} />
            ))
          )}
        </div>

        <Composer
          onSend={send}
          disabled={phase !== 'idle'}
          isStreaming={phase !== 'idle'}
          onStop={stop}
          approval={approval}
          onApprovalDecision={(id, decision) => setApproval(null)}
          contextUsed={contextUsed}
          contextTokens={`${(contextUsed * 128).toFixed(1)}k`}
          contextMax="128k"
          model={tweaks.model || 'aria 1.5'}
          reasoningEffort={tweaks.reasoningEffort || 'medium'}
          mode={tweaks.mode || 'auto'}
          onModeChange={v => setTweak('mode', v)}
        />
      </div>

      <RightSidebar
        open={tweaks.rightOpen}
        onToggle={() => setTweak('rightOpen', !tweaks.rightOpen)}
        artifacts={artifacts}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme">
          <TweakToggle label="Dark mode" value={tweaks.dark} onChange={v => setTweak('dark', v)} />
          <TweakColor label="Accent" value={tweaks.accent} onChange={v => setTweak('accent', v)} />
        </TweakSection>
        <TweakSection label="Layout">
          <TweakToggle label="Left sidebar" value={tweaks.leftOpen} onChange={v => setTweak('leftOpen', v)} />
          <TweakToggle label="Right sidebar" value={tweaks.rightOpen} onChange={v => setTweak('rightOpen', v)} />
        </TweakSection>
        <TweakSection label="Motion">
          <TweakSlider label="Stream speed (ms)" value={tweaks.streamSpeed} min={4} max={60} step={1}
                       onChange={v => setTweak('streamSpeed', v)} />
        </TweakSection>
        <TweakSection label="Model">
          <TweakSelect label="Model" value={tweaks.model || 'aria 1.5'}
                       options={['aria 1.5', 'aria 1.5 pro', 'aria opus', 'aria mini']}
                       onChange={v => setTweak('model', v)} />
          <TweakRadio label="Reasoning effort" value={tweaks.reasoningEffort || 'medium'}
                      options={['low', 'medium', 'high']}
                      onChange={v => setTweak('reasoningEffort', v)} />
          <TweakRadio label="Permission mode" value={tweaks.mode || 'auto'}
                      options={['yolo', 'auto', 'ask']}
                      onChange={v => setTweak('mode', v)} />
        </TweakSection>
        <TweakSection label="Try a prompt">
          {SAMPLE_QUERIES.map((q, i) => (
            <TweakButton key={i} label={q} onClick={() => phase === 'idle' && send(q)} />
          ))}
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

function Turn({ turn, streamSpeed, onAnswerDone }) {
  const visibleSteps = turn.reasoningSteps.slice(0, turn.visibleSteps);
  return (
    <>
      <div className="msg user fade-up">
        <div className="bubble">{turn.user}</div>
      </div>
      <div className="msg assistant">
        {visibleSteps.length > 0 && (
          <Reasoning
            steps={visibleSteps}
            durationSec={turn.duration}
            status={turn.reasoningStatus}
            defaultOpen={true}
          />
        )}
        {turn.showAnswer && (
          <div className="fade-up">
            <StreamText text={turn.finalAnswer} speed={streamSpeed} onDone={onAnswerDone} />
          </div>
        )}
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
