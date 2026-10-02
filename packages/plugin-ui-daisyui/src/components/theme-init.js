(() => {
// Kept external for strict CSP: a dynamic stylesheet and inline script need no exceptions.
const settings = document.querySelector('meta[name="daisyui-themes"]');
const themes = { light: settings?.dataset.lightTheme || 'light', dark: settings?.dataset.darkTheme || 'dark' };
window.talismanThemes = themes;
const previousSheets = window.talismanThemeSheets || [];
document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !previousSheets.includes(sheet));
window.talismanThemeSheets = [];
const css = settings?.dataset.themeCss;
if (css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  window.talismanThemeSheets = [sheet];
}
if (!document.documentElement.hasAttribute('data-theme')) {
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('talisman-theme'); } catch {}
  const mode = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme :
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', themes[mode]);
  try { localStorage.setItem('talisman-theme', mode); } catch {}
}
})();
