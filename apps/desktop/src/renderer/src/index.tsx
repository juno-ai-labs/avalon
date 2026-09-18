import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import { installTheme } from '../lib/theme';
import '@rally/ui/styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Rally renderer root is missing');

// Before the first render, not from an effect: an effect runs after the first
// paint, so every launch would show a frame of the default theme.
installTheme();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
