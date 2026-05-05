/* eslint-disable */
const { useState: _u1, useEffect: _u2, useRef: _u3 } = React;

// ---------------- Sidebar Toggle Button ----------------
function SidebarToggle({ side, open, onClick }) {
  const Ico = side === 'left' ? IconSidebarL : IconSidebarR;
  return (
    <button
      className={`sb-toggle sb-toggle-${side} ${open ? 'is-open' : ''}`}
      onClick={onClick}
      title={`${open ? 'Hide' : 'Show'} ${side} sidebar`}
      aria-label={`Toggle ${side} sidebar`}
    >
      <Ico />
    </button>
  );
}

// ---------------- Left Sidebar (Projects) ----------------
const PROJECTS = [
  { id: 'p1', name: 'Q1 Strategy', conversations: [
    { id: 'c1', title: 'Analyze 2025 sales and outline a plan for 2026', time: '2m ago' },
    { id: 'c2', title: 'Northeast retention deep-dive', time: '1h ago' },
    { id: 'c3', title: 'Campaign calendar v3 review', time: 'Yesterday' },
  ]},
  { id: 'p2', name: 'Coastal Launch', conversations: [
    { id: 'c4', title: 'Spring collection launch brief', time: '3d ago' },
    { id: 'c5', title: 'Anchor SKU pricing exploration', time: '5d ago' },
    { id: 'c6', title: 'Lookbook concepts', time: 'Last week' },
  ]},
  { id: 'p3', name: 'Customer Insights', conversations: [
    { id: 'c7', title: 'Support ticket patterns', time: 'Last week' },
    { id: 'c8', title: 'NPS verbatims, Q4', time: 'Mar 2' },
  ]},
];

function LeftSidebar({ open, onToggle, activeChat, onPickChat }) {
  const [openProjects, setOpenProjects] = _u1(() => new Set(['p1']));
  const toggleProject = (id) => setOpenProjects(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <aside className={`sidebar sidebar-left ${open ? 'is-open' : 'is-closed'}`} aria-hidden={!open}>
      <div className="sb-inner">
        <div className="sb-head">
          <div className="brand">
            <span className="dot" />
            <span>Aria</span>
          </div>
          <SidebarToggle side="left" open={open} onClick={onToggle} />
        </div>

        <button className="sb-new">
          <IconPlus size={13} />
          <span>New chat</span>
          <span className="kbd">⌘K</span>
        </button>

        <div className="sb-search">
          <IconSearch size={12} />
          <input placeholder="Search chats" />
        </div>

        <div className="sb-scroll">
          <div className="sb-section-label">Projects</div>
          {/* (label rendered in normal case via CSS) */}
          {PROJECTS.map((p, pi) => {
            const isOpen = openProjects.has(p.id);
            return (
              <div key={p.id} className={`sb-project ${isOpen ? 'is-open' : ''}`}
                   style={{ '--i': pi }}>
                <button className="sb-project-head" onClick={() => toggleProject(p.id)}>
                  <IconChev className="sb-chev" size={11} />
                  <IconFolder size={13} />
                  <span className="sb-project-name">{p.name}</span>
                  <span className="sb-count">{p.conversations.length}</span>
                </button>
                <div className="sb-collapsible" data-open={isOpen}>
                  <div className="sb-collapsible-inner">
                    <div className="sb-convs">
                      {p.conversations.map((c, ci) => (
                        <button key={c.id}
                          className={`sb-conv ${activeChat === c.id ? 'is-active' : ''}`}
                          onClick={() => onPickChat(c.id)}
                          style={{ '--ci': ci }}
                        >
                          <span className="sb-conv-title">{c.title}</span>
                          <span className="sb-conv-time">{c.time}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="sb-foot">
          <button className="sb-foot-btn">
            <IconSettings size={14} strokeWidth={2} />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

// ---------------- Right Sidebar (Artifacts) ----------------
function RightSidebar({ open, onToggle, artifacts }) {
  const [activeTab, setActiveTab] = _u1('files');
  return (
    <aside className={`sidebar sidebar-right ${open ? 'is-open' : 'is-closed'}`} aria-hidden={!open}>
      <div className="sb-inner">
        <div className="sb-head sb-head-right">
          <div className="sb-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={activeTab === 'files'}
              className={`sb-tab ${activeTab === 'files' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('files')}
            >
              Files
              <span className="sb-tab-count">{artifacts.length}</span>
            </button>
            <button className="sb-tab-add" title="New tab" type="button">
              <IconPlus size={12} strokeWidth={2.25} />
            </button>
          </div>
          <div className="sb-head-actions">
            <button className="sb-head-icon" title="Maximize" type="button">
              <IconMaximize size={13} strokeWidth={2} />
            </button>
            <SidebarToggle side="right" open={open} onClick={onToggle} />
          </div>
        </div>

        <div className="sb-scroll">
          {artifacts.length === 0 ? (
            <div className="sb-empty">
              <div className="sb-empty-glyph"><IconBolt size={18} /></div>
              <div className="sb-empty-title">No artifacts yet</div>
              <div className="sb-empty-sub">Charts, drafts and files Aria creates will appear here.</div>
            </div>
          ) : (
            <div className="sb-artifacts">
              {artifacts.map((a, i) => (
                <ArtifactItem key={a.id} artifact={a} index={i} />
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function ArtifactItem({ artifact, index }) {
  const Ico = {
    chart: IconChartArt, doc: IconFile, image: IconImage, code: IconCode, file: IconFile
  }[artifact.kind] || IconFile;

  return (
    <button className={`sb-artifact sb-artifact-${artifact.state || 'done'} fade-up-sm`}
            style={{ '--i': index }}
            title={artifact.title}>
      <span className="sb-artifact-ico"><Ico size={14} strokeWidth={2} /></span>
      <span className="sb-artifact-title">{artifact.title}</span>
    </button>
  );
}

Object.assign(window, { LeftSidebar, RightSidebar, SidebarToggle });
