/**
 * Window and app event handlers, kept free of Electron imports so they can be
 * unit-tested with plain fakes.
 */

/**
 * `will-navigate` guard. Chromium's default for a file or link dropped onto a
 * page that does not handle the drop is to navigate the top-level document to
 * it; with no navigation UI that strands the user on a raw text file or an
 * external site. Only same-origin navigation (our own server) is allowed;
 * http(s) links go to the system browser, everything else is dropped.
 */
export function willNavigateGuard(origin, shell) {
  return (event, url) => {
    if (url === origin || url.startsWith(origin + '/')) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  }
}

/**
 * Deterministic shutdown. Electron does not await an async `before-quit`
 * listener, so `await unload()` there just races process teardown. Instead:
 * cancel the first quit, unload (bounded by `timeoutMs` so a wedged dispose
 * cannot keep the app alive), then quit for real — the second `before-quit`
 * passes straight through.
 */
export function installQuitHandler(app, loadLocal, { timeoutMs = 2000 } = {}) {
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()

    let timer
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    Promise.race([Promise.resolve().then(loadLocal).then((local) => local.unload()), deadline])
      .catch(() => {
        /* nothing loaded, or dispose failed — quit regardless */
      })
      .finally(() => {
        clearTimeout(timer)
        app.quit()
      })
  })
}
