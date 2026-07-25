/**
 * ProcessingOverlay — compact centered loading screen for heavy operations.
 * Matches the "loadingprocess" animation: smaller spinning icon with cycling
 * label text ("Processing", "Loading", "Please wait").
 *
 * Usage:
 *   <ProcessingOverlay visible={isSaving} message="Saving…" />
 *
 * When `visible` is false the overlay is not rendered at all.
 * Pass optional `messages` array to cycle through custom words instead.
 */

interface ProcessingOverlayProps {
  visible: boolean;
  /** Optional single message override; defaults to cycling "Processing / Loading / Please wait" */
  message?: string;
  /** If true, renders without the dark fullscreen backdrop — useful for inline use */
  inline?: boolean;
}

export function ProcessingOverlay({ visible, message, inline = false }: ProcessingOverlayProps) {
  if (!visible) return null;

  const cyclingMessages = message ? null : ['Processing', 'Loading', 'Please wait'];

  return (
    <div
      className="animate-fade-in"
      style={{
        position: inline ? 'absolute' : 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: inline ? 'rgba(10,6,20,0.75)' : 'rgba(10,6,20,0.82)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <style>{`
        @keyframes proc-breathe-l {
          0%, 100% { transform: translateX(0); }
          50%      { transform: translateX(-10px); }
        }
        @keyframes proc-breathe-r {
          0%, 100% { transform: translateX(0); }
          50%      { transform: translateX(10px); }
        }
        @keyframes proc-tick-pulse {
          0%, 100% { opacity: .4; }
          50%      { opacity: 1; }
        }
        @keyframes proc-churn {
          0%   { transform: rotate(0deg)   scale(1); }
          50%  { transform: rotate(180deg) scale(.86); }
          100% { transform: rotate(360deg) scale(1); }
        }
        @keyframes proc-dot {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(.55); }
        }
        @keyframes proc-word-cycle {
          0%       { opacity: 0; transform: translateY(4px); }
          8%, 25%  { opacity: 1; transform: translateY(0); }
          33%      { opacity: 0; transform: translateY(-4px); }
          100%     { opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .proc-anim * { animation: none !important; }
          .proc-word   { position: static !important; opacity: 1 !important; }
        }
      `}</style>

      <div className="proc-anim flex flex-col items-center gap-[22px]">

        {/* Icon */}
        <div style={{
          position: 'relative',
          width: 150, height: 150,
          filter: 'drop-shadow(0 16px 34px rgba(90,50,200,0.3))',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: '26.5%',
            background: 'radial-gradient(120% 120% at 20% 10%, #2a1852 0%, #150c26 60%)',
          }} />

          <svg viewBox="0 0 400 400" style={{ position: 'relative', width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
            <defs>
              <linearGradient id="procSquareGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#9a7cf5" />
                <stop offset="100%" stopColor="#5c3fe0" />
              </linearGradient>
            </defs>

            {/* Ticks */}
            <line x1="98" y1="148" x2="98" y2="176" stroke="#4a3c78" strokeWidth="13" strokeLinecap="round"
              style={{ animation: 'proc-tick-pulse 1.1s ease-in-out infinite' }} />
            <line x1="98" y1="224" x2="98" y2="252" stroke="#4a3c78" strokeWidth="13" strokeLinecap="round"
              style={{ animation: 'proc-tick-pulse 1.1s ease-in-out 0.1s infinite' }} />
            <line x1="302" y1="148" x2="302" y2="176" stroke="#4a3c78" strokeWidth="13" strokeLinecap="round"
              style={{ animation: 'proc-tick-pulse 1.1s ease-in-out 0.2s infinite' }} />
            <line x1="302" y1="224" x2="302" y2="252" stroke="#4a3c78" strokeWidth="13" strokeLinecap="round"
              style={{ animation: 'proc-tick-pulse 1.1s ease-in-out 0.3s infinite' }} />

            {/* Brackets */}
            <path d="M148,108 L88,200 L148,292" stroke="#f1eef9" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'proc-breathe-l 1.1s cubic-bezier(.45,0,.2,1) infinite' }} />
            <path d="M252,108 L312,200 L252,292" stroke="#f1eef9" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'proc-breathe-r 1.1s cubic-bezier(.45,0,.2,1) infinite' }} />

            {/* Center spinning square */}
            <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'proc-churn 1.1s cubic-bezier(.6,0,.4,1) infinite' }}>
              <rect x="174" y="174" width="52" height="52" rx="14" fill="url(#procSquareGrad)" />
              <circle cx="200" cy="200" r="11" fill="#0f0a1e"
                style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'proc-dot 1.1s steps(4) infinite' }} />
            </g>
          </svg>
        </div>

        {/* Label */}
        <div style={{ position: 'relative', height: 20, width: 170, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {message ? (
            <span style={{ color: '#cfc4ee', fontSize: 14, letterSpacing: '.4px', fontWeight: 500 }}>{message}</span>
          ) : cyclingMessages!.map((word, i) => (
            <span
              key={word}
              className="proc-word"
              style={{
                position: 'absolute',
                left: 0, right: 0,
                textAlign: 'center',
                opacity: 0,
                transform: 'translateY(4px)',
                color: '#cfc4ee',
                fontSize: 14,
                letterSpacing: '.4px',
                fontWeight: 500,
                animation: `proc-word-cycle 9s ease-in-out ${i * 3}s infinite`,
              }}
            >
              {word}
            </span>
          ))}
        </div>

      </div>
    </div>
  );
}
