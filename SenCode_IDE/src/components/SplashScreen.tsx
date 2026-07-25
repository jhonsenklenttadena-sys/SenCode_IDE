/**
 * SplashScreen — full-screen loading shown on first app open,
 * and also for the post-extension-install "applying" reload screen.
 *
 * When `countdown` is provided, shows a progress bar counting down
 * and a subtitle explaining what's happening.
 */

interface SplashScreenProps {
  message?: string;
  /** When set, shows a countdown progress bar (seconds remaining) */
  countdown?: number | null;
  /** Total seconds for the countdown — used to compute progress bar width */
  countdownTotal?: number;
  /** Subtitle shown below the main message during countdown */
  subtitle?: string;
}

export function SplashScreen({
  message = 'Loading',
  countdown = null,
  countdownTotal = 10,
  subtitle,
}: SplashScreenProps) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center animate-fade-in"
      style={{ background: '#0a0614' }}
    >
      <style>{`
        @keyframes sheen-sweep {
          0%   { left: -60%; }
          55%  { left: 120%; }
          100% { left: 120%; }
        }
        @keyframes splash-breathe-l {
          0%, 100% { transform: translateX(0); }
          50%      { transform: translateX(-9px); }
        }
        @keyframes splash-breathe-r {
          0%, 100% { transform: translateX(0); }
          50%      { transform: translateX(9px); }
        }
        @keyframes splash-tick-pulse {
          0%, 100% { opacity: .45; }
          50%      { opacity: 1; }
        }
        @keyframes splash-ch-v {
          0%, 100% { transform: scaleY(1); opacity: .85; }
          50%      { transform: scaleY(1.35); opacity: 1; }
        }
        @keyframes splash-ch-h {
          0%, 100% { transform: scaleX(1); opacity: .85; }
          50%      { transform: scaleX(1.35); opacity: 1; }
        }
        @keyframes splash-ping {
          0%   { transform: scale(.4); opacity: .65; }
          75%  { transform: scale(2.1); opacity: 0; }
          100% { transform: scale(2.1); opacity: 0; }
        }
        @keyframes splash-square {
          0%, 100% { transform: scale(1) rotate(0deg); }
          50%      { transform: scale(1.14) rotate(6deg); }
        }
        @keyframes splash-dot {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(.72); }
        }
        @keyframes splash-dots-blink {
          0%, 80%, 100% { opacity: .2; transform: translateY(0); }
          40%           { opacity: 1;  transform: translateY(-3px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .splash-anim * { animation: none !important; }
        }
      `}</style>

      <div className="splash-anim flex flex-col items-center gap-7">

        {/* Icon */}
        <div
          style={{
            position: 'relative',
            width: 220,
            height: 220,
            filter: 'drop-shadow(0 20px 45px rgba(90,50,200,0.35))',
          }}
        >
          {/* Background */}
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: '26.5%',
            background: 'radial-gradient(120% 120% at 20% 10%, #2a1852 0%, #150c26 60%)',
            overflow: 'hidden',
          }}>
            {/* Sheen sweep */}
            <div style={{
              position: 'absolute',
              top: '-50%', left: '-60%',
              width: '60%', height: '200%',
              background: 'linear-gradient(100deg,rgba(255,255,255,0) 0%,rgba(255,255,255,0.07) 45%,rgba(255,255,255,0.14) 50%,rgba(255,255,255,0.07) 55%,rgba(255,255,255,0) 100%)',
              transform: 'rotate(8deg)',
              animation: 'sheen-sweep 2.8s ease-in-out 0.4s infinite',
            }} />
          </div>

          <svg viewBox="0 0 400 400" style={{ position: 'relative', width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
            <defs>
              <linearGradient id="splashSquareGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#9a7cf5" />
                <stop offset="100%" stopColor="#5c3fe0" />
              </linearGradient>
            </defs>

            {/* Ping rings */}
            <circle cx="200" cy="200" r="34" fill="none" stroke="#8b6ef5" strokeWidth="6"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', opacity: 0, animation: 'splash-ping 2.2s cubic-bezier(0,.6,.4,1) infinite' }} />
            <circle cx="200" cy="200" r="34" fill="none" stroke="#8b6ef5" strokeWidth="6"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', opacity: 0, animation: 'splash-ping 2.2s cubic-bezier(0,.6,.4,1) 1.1s infinite' }} />

            {/* Ticks */}
            <line x1="98" y1="148" x2="98" y2="176" stroke="#4a3c78" strokeWidth="14" strokeLinecap="round"
              style={{ animation: 'splash-tick-pulse 2.2s ease-in-out infinite' }} />
            <line x1="98" y1="224" x2="98" y2="252" stroke="#4a3c78" strokeWidth="14" strokeLinecap="round"
              style={{ animation: 'splash-tick-pulse 2.2s ease-in-out 0.15s infinite' }} />
            <line x1="302" y1="148" x2="302" y2="176" stroke="#4a3c78" strokeWidth="14" strokeLinecap="round"
              style={{ animation: 'splash-tick-pulse 2.2s ease-in-out 0.3s infinite' }} />
            <line x1="302" y1="224" x2="302" y2="252" stroke="#4a3c78" strokeWidth="14" strokeLinecap="round"
              style={{ animation: 'splash-tick-pulse 2.2s ease-in-out 0.45s infinite' }} />

            {/* Brackets */}
            <path d="M148,108 L88,200 L148,292" stroke="#f1eef9" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="34"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'splash-breathe-l 2.2s cubic-bezier(.45,0,.2,1) infinite' }} />
            <path d="M252,108 L312,200 L252,292" stroke="#f1eef9" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="34"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'splash-breathe-r 2.2s cubic-bezier(.45,0,.2,1) infinite' }} />

            {/* Crosshair */}
            <line x1="200" y1="150" x2="200" y2="250" stroke="#8f7cc9" strokeWidth="9" strokeLinecap="round"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'splash-ch-v 2.2s cubic-bezier(.45,0,.2,1) infinite' }} />
            <line x1="150" y1="200" x2="250" y2="200" stroke="#8f7cc9" strokeWidth="9" strokeLinecap="round"
              style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'splash-ch-h 2.2s cubic-bezier(.45,0,.2,1) infinite' }} />

            {/* Center square */}
            <g style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'splash-square 2.2s cubic-bezier(.45,0,.2,1) infinite' }}>
              <rect x="174" y="174" width="52" height="52" rx="14" fill="url(#splashSquareGrad)" />
              <circle cx="200" cy="200" r="11" fill="#0f0a1e"
                style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'splash-dot 2.2s cubic-bezier(.45,0,.2,1) infinite' }} />
            </g>
          </svg>
        </div>

        {/* Label with bouncing dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#cfc4ee', fontSize: 15, letterSpacing: '.4px', fontWeight: 500 }}>
          {message}
          <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {[0, 0.2, 0.4].map((delay, i) => (
              <span key={i} style={{
                display: 'inline-block',
                width: 5, height: 5,
                borderRadius: '50%',
                background: '#8b6ef5',
                animation: `splash-dots-blink 1.4s ease-in-out ${delay}s infinite`,
              }} />
            ))}
          </span>
        </div>

        {/* Countdown bar — shown during extension reload */}
        {countdown !== null && (
          <div style={{ width: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            {/* Progress bar */}
            <div style={{
              width: '100%', height: 3, borderRadius: 2,
              background: 'rgba(139,110,245,0.2)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                borderRadius: 2,
                background: 'linear-gradient(90deg, #5c3fe0, #8b6ef5)',
                width: `${((countdownTotal - countdown) / countdownTotal) * 100}%`,
                transition: 'width 1s linear',
              }} />
            </div>
            {/* Subtitle */}
            {subtitle && (
              <div style={{ color: '#7a67b8', fontSize: 11, letterSpacing: '.3px', textAlign: 'center' }}>
                {subtitle}
              </div>
            )}
            {/* Seconds remaining */}
            <div style={{ color: '#4a3c78', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              {countdown}s
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
