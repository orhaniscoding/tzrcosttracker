/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: 'var(--primary-color, #2563EB)',
        secondary: 'var(--secondary-color, #1E40AF)',
      },
    },
  },
  plugins: [],
};
