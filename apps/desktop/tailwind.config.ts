import type { Config } from 'tailwindcss';

export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#111210',
        sidebar: '#181916',
        surface: '#1d1e1b',
        raised: '#262723',
        ink: '#ecebe5',
        muted: '#96958e',
        line: '#343530',
        accent: '#67a9e9',
        attention: '#e6bd45',
        danger: '#d8756f',
      },
    },
  },
  plugins: [],
} satisfies Config;
