// Applies the saved text size before first paint so the page doesn't jump when it loads.
// An external file because the CSP forbids inline scripts. Mirrors src/lib/text-size.ts;
// scripts/text-size-init.test.mjs keeps the two in step.
;(function () {
  // Small with a mouse, Medium on a touch screen, where Small would make a 44px target about 38px.
  var size = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'medium' : 'small'
  try {
    var saved = localStorage.getItem('fernledger-text-size-v2')
    var earlier = localStorage.getItem('fernledger-text-size')
    if (saved === 'small' || saved === 'medium' || saved === 'large' || saved === 'xlarge') size = saved
    // Nothing is saved by the four-size control, so use what an earlier control saved: Small and Medium are the same sizes, and Large (20px) is Xtra Large now.
    // 'a-plus' and 'a-plus-plus' are what the first control (A / A+ / A++) saved; both were 20px by then. Its 'a' is Medium.
    else if (earlier === 'small') size = 'small'
    else if (earlier === 'medium' || earlier === 'a') size = 'medium'
    else if (earlier === 'large' || earlier === 'a-plus' || earlier === 'a-plus-plus') size = 'xlarge'
  } catch {
    // Storage blocked: use the default size.
  }
  document.documentElement.setAttribute('data-text-size', size)
})()
