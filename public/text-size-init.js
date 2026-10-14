// Applies the saved text size before first paint so the page doesn't jump when it loads.
// An external file because the CSP forbids inline scripts. Mirrors src/lib/text-size.ts;
// scripts/text-size-init.test.mjs keeps the two in step.
;(function () {
  var size = 'medium'
  try {
    var saved = localStorage.getItem('fernledger-text-size')
    if (saved === 'small') size = 'small'
    // 'a-plus' and 'a-plus-plus' are what the first control (A / A+ / A++) saved; both are Large now. Its 'a' is Medium.
    else if (saved === 'large' || saved === 'a-plus' || saved === 'a-plus-plus') size = 'large'
  } catch {
    // Storage blocked: use the standard size.
  }
  document.documentElement.setAttribute('data-text-size', size)
})()
