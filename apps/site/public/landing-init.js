/* global document, URLSearchParams, window */

(() => {
  const themes = ['runway', 'valley', 'proof', 'afterlight'];
  const root = document.documentElement;
  const requestedTheme = new URLSearchParams(window.location.search).get('theme');
  const theme = themes.includes(requestedTheme)
    ? requestedTheme
    : themes[Math.floor(Math.random() * themes.length)] ?? 'runway';

  root.classList.add('js');
  root.dataset.theme = theme;
  root.dataset.themeReady = '';
})();
