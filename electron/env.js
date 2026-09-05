/**
 * Desktop configuration loading.
 *
 * The installed app has no project directory, so its `.env` lives in Electron's
 * per-user data directory. In development the project `.env` is loaded first so
 * it keeps winning over anything left in user-data. dotenv never overrides a
 * variable that is already set, which is also why the desktop defaults must be
 * applied *after* the files are read — otherwise a `DEFAULT_PROVIDER=` line in
 * `.env` would be silently ignored.
 */

import path from 'node:path'
import dotenv from 'dotenv'

/**
 * Load `.env` files in precedence order, then fill in the desktop defaults.
 * Returns the user-data `.env` path (also exported as PROMPTFIXER_ENV_FILE so
 * the server can name it in its "add a key" hints).
 */
export function loadDesktopEnv({ userDataDir, packaged = false, cwd = process.cwd() }) {
  const userEnvFile = path.join(userDataDir, '.env')
  const files = packaged ? [userEnvFile] : [path.join(cwd, '.env'), userEnvFile]
  for (const file of files) dotenv.config({ path: file })

  process.env.PROMPTFIXER_ENV_FILE = userEnvFile
  // Defaults for desktop mode; `.env` (loaded above) wins over these.
  process.env.PROMPTFIXER_PRELOAD ??= '1'
  process.env.DEFAULT_PROVIDER ??= 'local'
  return userEnvFile
}
