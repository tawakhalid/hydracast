/**
 * Stacking-order check for the app shell, run in real Chromium.
 *
 * The shell's z-index rules have caused three separate bugs: a `:not()` chain
 * kept climbing in specificity, so plain-class overrides silently lost and the
 * settings overlay landed in the document flow while the layout menu opened
 * behind the panels. Specificity arithmetic is easy to get wrong by eye - this
 * measures what Chromium actually computes instead.
 *
 * Kept out of `npm test`: it needs a real window, which is flaky on headless CI.
 * Run it by hand with `npm run test:stacking` after touching shell CSS.
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
setTimeout(() => { console.log('RESULT timeout'); process.exit(2) }, 40000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false })
  await win.loadFile(path.join(__dirname, 'stacking-probe.html'))
  const r = await win.webContents.executeJavaScript('window.__probe()')
  console.log('PROBE ' + JSON.stringify(r, null, 2))

  let failures = 0
  const check = (label, pass, extra) => {
    if (!pass) failures++
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
  }
  check('the title bar outranks the workspace', Number(r.titlebarZ) > Number(r.bodyZ),
    `titlebar ${r.titlebarZ} vs body ${r.bodyZ}`)
  check('the layout menu is the topmost thing at its own centre',
    r.topmostAtPopover === 'pop', r.topmostAtPopover)
  check('the layout menu hangs below the title bar', r.popTop >= 40, `top ${r.popTop}`)
  check('toasts stay fixed to the viewport', r.toastsPos === 'fixed', r.toastsPos)

  console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
  app.exit(failures ? 1 : 0)
})
