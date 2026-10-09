// Applies the saved theme before first paint so dark-mode users don't see a white flash.
// An external file because the CSP forbids inline scripts. Mirrors src/lib/theme.ts;
// scripts/theme-init.test.mjs keeps the two in step.
;(function () {
  var saved = null
  try {
    saved = localStorage.getItem('fernledger-theme')
  } catch {
    // Storage blocked: follow the device.
  }
  var dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
})()
