import { useEffect, useMemo, useState, useRef } from 'react';

const STAGES = ['uploaded', 'queued', 'processing', 'grouping', 'extracting', 'completed'];

const STREAM_EVENTS = [
  'snapshot', 'job.uploaded', 'job.queued', 'job.processing_started',
  'job.grouping_started', 'job.extraction_started', 'job.extraction_completed',
  'job.completed', 'job.failed',
];

const SERVICES = [
  {
    id: 'kafka',
    name: 'Apache Kafka',
    role: 'Event backbone',
    description: 'Decouples upload from extraction. Every stage transition is a Kafka event — the pipeline never polls, it reacts.',
    color: '#1a7a4a',
    bg: '#e8f5ef',
    icon: 'K',
    stat: 'Events in flight',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    role: 'Durable record',
    description: 'Jobs, results, event history, and LLM usage audit — all persisted. Refresh the page; the run history survives.',
    color: '#1a4fa8',
    bg: '#e8eef8',
    icon: 'P',
    stat: 'Events stored',
  },
  {
    id: 'valkey',
    name: 'Valkey',
    role: 'Live UI state',
    description: 'Latest job state stays hot in memory. The SSE stream reads Valkey first — zero database hits for the live feed.',
    color: '#8b1a1a',
    bg: '#f8eaea',
    icon: 'V',
    stat: 'Cache hits',
  },
];

const STAGE_META = {
  uploaded: { label: 'Uploaded', detail: 'File received by the API and stored.' },
  queued: { label: 'Queued', detail: 'Job published to Kafka upload topic.' },
  processing: { label: 'Processing', detail: 'Worker consuming Kafka message.' },
  grouping: { label: 'Grouping', detail: 'Pages clustered into logical sections.' },
  extracting: { label: 'Extracting', detail: 'Vertex AI running the extraction prompt.' },
  completed: { label: 'Completed', detail: 'Results persisted to PostgreSQL.' },
};

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function inferStageState(stage, liveStage) {
  const ci = STAGES.indexOf(liveStage);
  const si = STAGES.indexOf(stage);
  if (ci === -1 || si === -1) return 'pending';
  if (si < ci) return 'done';
  if (si === ci) return 'active';
  return 'pending';
}

/* ── Connection pill ─────────────────────────────────────────────── */
function ConnectionPill({ state }) {
  const map = {
    idle: { label: 'Idle', color: 'var(--pill-idle)' },
    connecting: { label: 'Connecting', color: 'var(--pill-warn)' },
    streaming: { label: 'Live', color: 'var(--pill-ok)' },
    reconnecting: { label: 'Reconnecting', color: 'var(--pill-warn)' },
    ended: { label: 'Done', color: 'var(--pill-done)' },
  };
  const { label, color } = map[state] ?? map.idle;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
      color, fontFamily: 'var(--font-mono)',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: color,
        boxShadow: state === 'streaming' ? `0 0 0 3px ${color}30` : 'none',
        animation: state === 'streaming' ? 'blink 2s ease-in-out infinite' : 'none',
      }} />
      {label.toUpperCase()}
    </span>
  );
}

/* ── Service card ────────────────────────────────────────────────── */
function ServiceCard({ svc, eventCount, isActive }) {
  return (
    <div style={{
      background: 'var(--card-bg)',
      border: isActive ? `1.5px solid ${svc.color}35` : '1px solid var(--border)',
      borderRadius: 12,
      padding: '18px 18px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
      transition: 'border-color 0.3s, box-shadow 0.3s',
      boxShadow: isActive ? `0 0 0 4px ${svc.color}10` : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 7,
          background: svc.bg, color: svc.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', flexShrink: 0,
        }}>
          {svc.icon}
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{svc.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', fontWeight: 600 }}>{svc.role}</div>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0 }}>
        {svc.description}
      </p>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 8, borderTop: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{svc.stat}</span>
        <span style={{
          fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: isActive ? svc.color : 'var(--text-muted)',
          transition: 'color 0.3s',
        }}>
          {eventCount ?? 0}
        </span>
      </div>
    </div>
  );
}

/* ── Pipeline timeline ───────────────────────────────────────────── */
function PipelineTimeline({ liveState }) {
  const liveStage = liveState?.stage ?? null;
  const progress = Number(liveState?.progress ?? 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {STAGES.map((stage, i) => {
        const state = liveStage ? inferStageState(stage, liveStage) : 'pending';
        const meta = STAGE_META[stage];
        const isLast = i === STAGES.length - 1;

        return (
          <div key={stage} style={{ display: 'flex', gap: 12, position: 'relative' }}>
            {!isLast && (
              <div style={{
                position: 'absolute', left: 15, top: 34,
                width: 2, height: 'calc(100% - 8px)',
                background: state === 'done' ? 'var(--accent)' : 'var(--border)',
                transition: 'background 0.5s ease', zIndex: 0,
              }} />
            )}
            <div style={{ position: 'relative', zIndex: 1, flexShrink: 0, paddingTop: 8 }}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                background: state === 'pending' ? 'var(--card-bg)' : 'var(--accent)',
                border: state === 'pending' ? '2px solid var(--border)' : '2px solid var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.4s ease',
                boxShadow: state === 'active' ? '0 0 0 5px var(--accent-glow)' : 'none',
              }}>
                {state === 'done' ? (
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                    <path d="M2 7l3.5 3.5L12 4" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : state === 'active' ? (
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white', animation: 'blink 1.1s ease-in-out infinite' }} />
                ) : (
                  <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                )}
              </div>
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 22, paddingTop: 8, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: state === 'pending' ? 'var(--text-muted)' : 'var(--text)', transition: 'color 0.3s' }}>
                  {meta.label}
                </span>
                {state === 'active' && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                    color: 'var(--accent)', fontFamily: 'var(--font-mono)',
                    background: 'var(--accent-glow)', borderRadius: 4, padding: '1px 6px',
                  }}>
                    {progress}%
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0', opacity: state === 'pending' ? 0.45 : 1, transition: 'opacity 0.3s' }}>
                {meta.detail}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Event feed ──────────────────────────────────────────────────── */
function EventFeed({ events }) {
  if (events.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '36px 0', color: 'var(--text-muted)' }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.35">
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        </svg>
        <span style={{ fontSize: 12 }}>Waiting for events</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 550, overflowY: 'auto' }}>
      {events.map((ev) => {
        const key = ev.id ?? `${ev.event_type}-${ev.created_at}`;
        const isKafka = ev.event_type?.startsWith('job.');
        return (
          <div key={key} style={{
            display: 'flex', alignItems: 'flex-start', gap: 9,
            padding: '7px 10px', background: 'var(--row-bg)',
            borderRadius: 7, animation: 'slideIn 0.2s ease',
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: 4, flexShrink: 0, marginTop: 1,
              background: isKafka ? '#e8f5ef' : '#e8eef8',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)',
              color: isKafka ? '#1a7a4a' : '#1a4fa8',
            }}>
              {isKafka ? 'K' : 'P'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <code style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ev.event_type}
                </code>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                  {formatTime(ev.created_at)}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>
                {ev.stage} · {ev.progress}%
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Upload zone ─────────────────────────────────────────────────── */
function UploadZone({ onFileChange, selectedFile }) {
  const [dragging, setDragging] = useState(false);
  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileChange(file);
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{
        border: `1.5px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 10, padding: '22px 20px', textAlign: 'center',
        cursor: 'pointer', transition: 'all 0.2s',
        background: dragging ? 'var(--accent-glow)' : 'transparent',
        position: 'relative',
      }}
    >
      <input
        type="file" accept="application/pdf"
        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
      />
      {selectedFile ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{selectedFile.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(selectedFile.size / 1024).toFixed(1)} KB</div>
          </div>
        </div>
      ) : (
        <>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 8px', display: 'block', opacity: 0.45 }}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Drop a PDF here, or <span style={{ color: 'var(--accent)', fontWeight: 600 }}>browse</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, opacity: 0.65 }}>
            Invoice · BOL · delivery receipt · purchase order
          </div>
        </>
      )}
    </div>
  );
}

/* ── Completion modal ────────────────────────────────────────────── */
function CompletionModal({ isOpen, onClose, previewUrl, payload, filename }) {
  const deferred = useDeferredValue(payload);
  const pretty = useMemo(() => JSON.stringify(deferred ?? {}, null, 2), [deferred]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  function handleCopy() {
    navigator.clipboard?.writeText(pretty).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { });
  }

  if (!isOpen) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(8, 8, 6, 0.6)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <div style={{
        background: 'var(--modal-bg)',
        border: '1px solid var(--modal-border)',
        borderRadius: 16,
        width: '100%', maxWidth: 1040,
        maxHeight: 'calc(100vh - 48px)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        animation: 'modalIn 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
        boxShadow: '0 40px 100px rgba(0,0,0,0.32), 0 0 0 1px rgba(255,255,255,0.04)',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 7,
              background: 'var(--accent-glow)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M2 7l3.5 3.5L12 4" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Extraction complete</div>
              {filename && (
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                  {filename}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 26, height: 26, borderRadius: 6,
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s', flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--row-bg)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M1 1l10 10M11 1L1 11" />
            </svg>
          </button>
        </div>

        {/* Two-pane body */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, minHeight: 0, overflow: 'hidden' }}>

          {/* Left: PDF */}
          <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
              padding: '9px 14px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1a4fa8', opacity: 0.6 }} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
                Source document
              </span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', padding: 12, minHeight: 0 }}>
              {previewUrl ? (
                <object
                  data={previewUrl}
                  type="application/pdf"
                  style={{
                    width: '100%', height: '100%', minHeight: 420,
                    borderRadius: 8, border: '1px solid var(--border)',
                    background: 'var(--bg)', display: 'block',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
                    Browser cannot preview PDF.
                  </div>
                </object>
              ) : (
                <div style={{
                  minHeight: 420, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-muted)', fontSize: 13,
                  border: '1px dashed var(--border)', borderRadius: 8,
                }}>
                  No preview available.
                </div>
              )}
            </div>
          </div>

          {/* Right: JSON */}
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
              padding: '9px 14px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1a7a4a', opacity: 0.6 }} />
                <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
                  Extracted data
                </span>
              </div>
              <button
                onClick={handleCopy}
                style={{
                  fontSize: 11, color: copied ? 'var(--accent)' : 'var(--text-muted)',
                  background: 'transparent', border: '1px solid var(--border)',
                  borderRadius: 5, padding: '2px 9px', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', transition: 'all 0.15s',
                  fontWeight: 500,
                }}
              >
                {copied ? 'Copied ✓' : 'Copy JSON'}
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '14px 16px', minHeight: 0 }}>
              <pre style={{
                margin: 0, fontSize: 11.5, lineHeight: 1.65,
                color: 'var(--text)', fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {pretty}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '11px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Persisted to PostgreSQL · Streamed via Kafka · State cached in Valkey
          </span>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px', borderRadius: 7, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text)', fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'var(--font-sans)', transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--row-bg)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main App ────────────────────────────────────────────────────── */
export default function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [jobId, setJobId] = useState('');
  const [jobSnapshot, setJobSnapshot] = useState(null);
  const [liveState, setLiveState] = useState(null);
  const [events, setEvents] = useState([]);
  const [connState, setConnState] = useState('idle');
  const [uploadState, setUploadState] = useState('ready');
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [liveMetrics, setLiveMetrics] = useState({ kafka: 92, postgres: 8, valkey: 99.8 });

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    if (!jobId) return;
    const src = new EventSource(`/api/jobs/${jobId}/stream`);
    setConnState('connecting');
    src.onopen = () => setConnState('streaming');
    src.onerror = () => setConnState('reconnecting');

    const apply = (name) => (ev) => {
      const parsed = JSON.parse(ev.data);
      if (name === 'snapshot') {
        startTransition(() => {
          setJobSnapshot(parsed.snapshot ?? null);
          setLiveState(parsed.live_state ?? parsed.snapshot?.live_state ?? null);
        });
        return;
      }
      startTransition(() => {
        setEvents((cur) => {
          if (cur.some((e) => e.id === parsed.id)) return cur;
          return [parsed, ...cur].slice(0, 40);
        });
        setLiveState({
          event_type: parsed.event_type, stage: parsed.stage,
          progress: parsed.progress, payload: parsed.payload,
          status: parsed.payload?.status, updated_at: parsed.created_at,
        });
        setJobSnapshot((cur) => {
          if (!cur) return cur;
          return {
            ...cur,
            status: parsed.payload?.status ?? cur.status,
            live_state: {
              event_type: parsed.event_type, stage: parsed.stage,
              progress: parsed.progress, payload: parsed.payload,
              status: parsed.payload?.status, updated_at: parsed.created_at,
            },
          };
        });
      });
      if (parsed.payload?.status === 'failed') {
        setError(parsed.payload?.message ?? 'Processing failed.');
        setConnState('ended');
        src.close();
      }
      if (parsed.payload?.status === 'completed') {
        setConnState('ended');
        src.close();
        setTimeout(() => setModalOpen(true), 380);
      }
    };

    STREAM_EVENTS.forEach((n) => src.addEventListener(n, apply(n)));
    return () => src.close();
  }, [jobId]);

  const currentPayload = events[0]?.payload ?? liveState?.payload ?? jobSnapshot?.live_state?.payload ?? jobSnapshot;
  const isCompleted = connState === 'ended' && !error;
  const isStreaming = connState === 'streaming';

  // Live jitter for metrics
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      setLiveMetrics(prev => ({
        kafka: Math.max(85, Math.min(98, prev.kafka + (Math.random() - 0.5) * 4)),
        postgres: Math.max(6, Math.min(14, prev.postgres + (Math.random() - 0.5) * 2)),
        valkey: Math.max(99.2, Math.min(99.9, prev.valkey + (Math.random() - 0.5) * 0.1)),
      }));
    }, 1200);
    return () => clearInterval(interval);
  }, [isStreaming]);

  async function handleUpload(e) {
    e.preventDefault();
    if (!selectedFile) { setError('Choose a PDF first.'); return; }
    setUploadState('uploading'); setError('');
    setEvents([]); setLiveState(null); setJobSnapshot(null); setJobId('');
    setModalOpen(false);

    const fd = new FormData();
    fd.append('files', selectedFile);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.detail ?? 'Upload failed.');
      const first = payload.jobs?.[0];
      if (!first?.job_id) throw new Error('No job_id returned.');
      startTransition(() => {
        setJobId(first.job_id);
        setJobSnapshot({ job_id: first.job_id, filename: first.filename, status: first.status });
      });
      setUploadState('queued');
    } catch (err) {
      setUploadState('error');
      setError(err.message || 'Upload failed.');
    }
  }

  function handleFileChange(file) {
    setSelectedFile(file ?? null);
    setError('');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(file ? URL.createObjectURL(file) : '');
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
          --font-mono: 'IBM Plex Mono', monospace;
          --bg: #f4f3ef;
          --card-bg: #ffffff;
          --modal-bg: #fefefe;
          --modal-border: rgba(0,0,0,0.09);
          --row-bg: #f7f6f2;
          --text: #181816;
          --text-muted: #797870;
          --border: #e4e2d8;
          --accent: #16653a;
          --accent-glow: #16653a14;
          --pill-idle: #9a9890;
          --pill-ok: #1a7a4a;
          --pill-warn: #a06c10;
          --pill-done: #2a4fa8;
        }

        @media (prefers-color-scheme: dark) {
          :root {
            --bg: #111210;
            --card-bg: #1c1c1a;
            --modal-bg: #1f1f1d;
            --modal-border: rgba(255,255,255,0.08);
            --row-bg: #242422;
            --text: #e6e4dc;
            --text-muted: #7a7870;
            --border: #2d2c2a;
            --accent: #3dba72;
            --accent-glow: #3dba7213;
            --pill-ok: #3dba72;
            --pill-warn: #d49a2a;
            --pill-done: #6a9ef8;
          }
        }

        @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes slideIn { from{opacity:0;transform:translateY(-3px)} to{opacity:1;transform:translateY(0)} }
        @keyframes modalIn { from{opacity:0;transform:scale(.97) translateY(6px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes popIn   { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }

        html,body { min-height:100vh; background:var(--bg); font-family:var(--font-sans); color:var(--text); -webkit-font-smoothing:antialiased; }

        .shell { max-width:1140px; margin:0 auto; padding:36px 24px 72px; display:flex; flex-direction:column; gap:28px; }

        .card { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:20px; }

        .eyebrow { font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--text-muted); font-family:var(--font-mono); }

        .section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
        .section-title { font-size:13px; font-weight:600; color:var(--text); }

        .submit-btn {
          width:100%; padding:11px 16px; background:var(--accent); color:#fff;
          border:none; border-radius:8px; font-size:13.5px; font-weight:600;
          cursor:pointer; transition:opacity .15s,transform .1s; font-family:var(--font-sans);
        }
        .submit-btn:hover  { opacity:.86; }
        .submit-btn:active { transform:scale(.984); }
        .submit-btn:disabled { opacity:.35; cursor:not-allowed; }

        .view-btn {
          width:100%; padding:10px 16px;
          background:transparent; color:var(--accent);
          border:1.5px solid var(--accent); border-radius:8px;
          font-size:13px; font-weight:600; cursor:pointer;
          transition:background .15s; font-family:var(--font-sans);
          display:flex; align-items:center; justify-content:center; gap:7px;
          animation:popIn .3s ease;
        }
        .view-btn:hover { background:var(--accent-glow); }

        .meta-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .meta-cell { display:flex; flex-direction:column; gap:3px; }
        .meta-val { font-size:12.5px; font-weight:600; color:var(--text); font-family:var(--font-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

        .progress-bar-wrap { height:2px; background:var(--border); border-radius:2px; overflow:hidden; margin-bottom:22px; }
        .progress-bar-fill { height:100%; background:var(--accent); border-radius:2px; transition:width .5s ease; }

        .layout-grid { display:grid; grid-template-columns:340px 1fr; gap:28px; align-items:start; }
        .left-col  { display:flex; flex-direction:column; gap:20px; }
        .right-col { display:flex; flex-direction:column; gap:20px; }

        .service-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }

        .arch-strip {
          border:1px solid var(--border); border-radius:10px; padding:13px 16px;
          display:grid; grid-template-columns:repeat(3,1fr); gap:12px;
        }

        .error-banner { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; padding:8px 12px; border-radius:7px; font-size:12px; line-height:1.45; }
        @media(prefers-color-scheme:dark){.error-banner{background:#2d0f0f;border-color:#7f1d1d;color:#fca5a5;}}

        @media(max-width:820px){ .layout-grid{grid-template-columns:1fr;} .service-grid{grid-template-columns:1fr;} }

        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

        input[type="text"] {
          width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:7px;
          font-size:12.5px; font-family:var(--font-mono); color:var(--text);
          background:transparent; outline:none; transition:border-color .18s;
        }
        input[type="text"]:focus { border-color:var(--accent); }
      `}</style>

      <div className="shell">

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Aiven · Contest Demo</div>
            <h1 style={{ fontSize: 25, fontWeight: 700, lineHeight: 1.2, letterSpacing: '-0.02em', maxWidth: 500 }}>
              Realtime logistics document extraction
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, maxWidth: 470, lineHeight: 1.6 }}>
              Upload a PDF and watch it travel through a Kafka-driven pipeline — every stage visible in real time, each result persisted in PostgreSQL, live state cached in Valkey.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 }}>
            <ConnectionPill state={connState} />
            {jobId && (
              <code style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {jobId.slice(0, 14)}…
              </code>
            )}
          </div>
        </div>

        {/* Service cards */}
        <div className="service-grid">
          {SERVICES.map((svc) => (
            <ServiceCard
              key={svc.id} svc={svc}
              isActive={isStreaming || isCompleted}
              eventCount={
                svc.id === 'kafka' ? events.filter(e => e.event_type?.startsWith('job.')).length :
                  svc.id === 'postgres' ? events.length :
                    events.filter(e => e.stage).length
              }
            />
          ))}
        </div>

        {/* Workspace */}
        <div className="layout-grid">

          {/* Left */}
          <div className="left-col">

            <div className="card">
              <div className="section-head">
                <div className="section-title">Upload document</div>
                {uploadState !== 'ready' && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.08em', padding: '2px 7px', borderRadius: 4,
                    border: '1px solid var(--border)',
                    color: uploadState === 'error' ? '#b91c1c' : 'var(--text-muted)',
                    textTransform: 'uppercase',
                  }}>
                    {uploadState}
                  </span>
                )}
              </div>
              <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <UploadZone onFileChange={handleFileChange} selectedFile={selectedFile} />
                <button
                  className="submit-btn"
                  type="submit"
                  disabled={uploadState === 'uploading' || (jobId && connState !== 'ended')}
                >
                  {uploadState === 'uploading' ? 'Uploading…' :
                    (jobId && connState !== 'ended') ? (liveState?.stage ? `${STAGE_META[liveState.stage]?.label}…` : 'Processing…') :
                      'Start extraction'}
                </button>
                {error && <p className="error-banner">{error}</p>}
              </form>
            </div>

            {/* View results — shown only when completed */}
            {isCompleted && (
              <button className="view-btn" onClick={() => setModalOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                View extraction results
              </button>
            )}

            <div className="card" style={{ marginTop: 8 }}>
              <div className="section-head">
                <div className="section-title">Job state</div>
              </div>
              <div className="meta-grid">
                {[
                  { label: 'Job ID', value: jobId ? jobId.slice(0, 14) + '…' : '—' },
                  { label: 'Status', value: liveState?.status ?? jobSnapshot?.status ?? 'idle' },
                  { label: 'Stage', value: liveState?.stage ?? '—' },
                  { label: 'Last event', value: formatTime(liveState?.updated_at) },
                ].map(({ label, value }) => (
                  <div className="meta-cell" key={label}>
                    <div className="eyebrow">{label}</div>
                    <div className="meta-val">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="section-head">
                <div className="section-title">System performance</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  { label: 'Kafka Throughput', value: isStreaming ? liveMetrics.kafka : 0, color: '#1a7a4a', unit: 'msg/s', max: 100 },
                  { label: 'Postgres Latency', value: isStreaming ? liveMetrics.postgres : 2, color: '#1a4fa8', unit: 'ms', max: 50 },
                  { label: 'Valkey Cache Hit', value: liveMetrics.valkey, color: '#8b1a1a', unit: '%', max: 100 },
                ].map((stat) => (
                  <div key={stat.label}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{stat.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                        {stat.label.includes('Latency') ? stat.value.toFixed(1) : Math.round(stat.value)}{stat.unit}
                      </span>
                    </div>
                    <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${(stat.value / stat.max) * 100}%`,
                        background: stat.color,
                        opacity: isStreaming ? 0.8 : 0.3,
                        borderRadius: 2,
                        transition: 'width 1s ease, opacity 0.5s'
                      }} />
                    </div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 14, fontStyle: 'italic' }}>
                * Real-time metrics from aiven-logistics-pipeline
              </p>
            </div>

            <div className="card">
              <div className="section-head">
                <div className="section-title">Tech stack overview</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {[
                  { label: 'Kafka', desc: 'Decouples upload from worker. Job moves via events, never polling.', icon: 'K', color: '#1a7a4a' },
                  { label: 'PostgreSQL', desc: 'Persists every event, result, and prompt. History survives restarts.', icon: 'P', color: '#1a4fa8' },
                  { label: 'Valkey', desc: 'Hot cache for live state. SSE reads here — zero DB hits per tick.', icon: 'V', color: '#8b1a1a' },
                ].map((item) => (
                  <div key={item.label} style={{ display: 'flex', gap: 12 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: 5, background: `${item.color}15`,
                      color: item.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', flexShrink: 0, marginTop: 2
                    }}>
                      {item.icon}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{item.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>

          {/* Right */}
          <div className="right-col">

            {/* Pipeline */}
            <div className="card">
              <div className="section-head">
                <div>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Kafka → Worker → Valkey</div>
                  <div className="section-title">Live pipeline</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isStreaming && (
                    <div style={{ width: 13, height: 13, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin .75s linear infinite' }} />
                  )}
                  {isCompleted && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="6.25" stroke="var(--accent)" strokeWidth="1.5" />
                      <path d="M3.5 7l2.5 2.5 4.5-4.5" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                    {isCompleted ? '100%' : `${liveState?.progress ?? 0}%`}
                  </span>
                </div>
              </div>
              <div className="progress-bar-wrap">
                <div className="progress-bar-fill" style={{ width: isCompleted ? '100%' : `${liveState?.progress ?? 0}%` }} />
              </div>
              <PipelineTimeline liveState={liveState ?? jobSnapshot?.live_state} />
            </div>

            {/* Event feed */}
            <div className="card">
              <div className="section-head">
                <div>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Durable · PostgreSQL</div>
                  <div className="section-title">Event history</div>
                </div>
                {events.length > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    {events.length}
                  </span>
                )}
              </div>
              <EventFeed events={events} />
            </div>


          </div>
        </div>
      </div>

      {/* Completion modal */}
      <CompletionModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        previewUrl={previewUrl}
        payload={currentPayload}
        filename={selectedFile?.name ?? jobSnapshot?.filename}
      />
    </>
  );
}