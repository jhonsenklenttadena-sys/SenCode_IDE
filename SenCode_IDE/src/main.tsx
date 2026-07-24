import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/** Catches React render errors and shows them instead of a black screen */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err: Error) {
    return { error: err?.message ?? String(err) };
  }
  componentDidCatch(err: Error, info: { componentStack: string }) {
    console.error('[SenCode] React crash:', err, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', color: '#f87171', background: '#0b0e14', minHeight: '100vh' }}>
          <h2 style={{ color: '#e2e8f0', marginBottom: 12 }}>SenCode — Startup Error</h2>
          <p style={{ marginBottom: 16, color: '#9aa4b8', fontSize: 13 }}>
            A React render error occurred. Please report this or clear app data and restart.
          </p>
          <pre style={{ background: '#161b27', padding: 16, borderRadius: 8, fontSize: 12, overflowX: 'auto', border: '1px solid #1e2433' }}>
            {this.state.error}
          </pre>
          <p style={{ marginTop: 16, fontSize: 12, color: '#5b6577' }}>
            Open DevTools (Ctrl+Shift+I) → Console for full stack trace.
          </p>
          <button
            onClick={() => {
              try { localStorage.clear(); } catch {}
              window.location.reload();
            }}
            style={{ marginTop: 16, padding: '8px 16px', background: '#7a5af8', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
          >
            Clear data &amp; restart
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
