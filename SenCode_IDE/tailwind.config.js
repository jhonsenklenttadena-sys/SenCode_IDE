/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Surface ramp — all driven by CSS variables set per-theme
        surface: {
          0: 'var(--s0)',
          1: 'var(--s1)',
          2: 'var(--s2)',
          3: 'var(--s3)',
          4: 'var(--s4)',
        },
        // Text
        ink: {
          high: 'var(--ink-high)',
          mid:  'var(--ink-mid)',
          low:  'var(--ink-low)',
        },
        // Primary action color
        primary: {
          300: 'var(--accent)',
          400: 'var(--accent)',
          500: 'var(--primary)',
          600: 'var(--primary)',
          700: 'var(--primary-hover)',
          900: 'var(--primary-dim)',
        },
        // Accent (same slot as primary for compatibility)
        accent: {
          400: 'var(--accent)',
          500: 'var(--primary)',
          600: 'var(--primary-hover)',
        },
        // Status
        success: { 400: 'var(--success)', 500: 'var(--success)', 600: 'var(--success)' },
        warning: { 400: 'var(--warning)', 500: 'var(--warning)', 600: 'var(--warning)' },
        error:   { 400: 'var(--error)',   500: 'var(--error)',   600: 'var(--error)'   },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      animation: {
        'fade-in':    'fadeIn 0.2s ease-out',
        'slide-up':   'slideUp 0.25s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'blink':      'blink 1s step-end infinite',
      },
      keyframes: {
        fadeIn:    { from: { opacity: '0' },                              to: { opacity: '1' } },
        slideUp:   { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.5' } },
        blink:     { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0' } },
      },
    },
  },
  plugins: [],
};
