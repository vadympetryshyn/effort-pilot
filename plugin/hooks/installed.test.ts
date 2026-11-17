import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'

import { cacheInstall, installedVersion, newer, newerInstalled, staleLine, versionWatch } from './installed'

// A session keeps the plugin code it loaded until /reload-plugins; a newer version installed meanwhile is said once.

const CONFIG = '/home/someone/.claude'
const ROOT = `${CONFIG}/plugins/cache/acme/effort-pilot/1.15.0`
const KEY = 'effort-pilot@acme'
const PROJECT = '/home/someone/code/shop'
const registry = (...entries: object[]) => JSON.stringify({ version: 2, plugins: { [KEY]: entries, 'other@acme': [{ scope: 'user', version: '9.0.0' }] } })
const user = (version: string) => ({ scope: 'user', installPath: `${CONFIG}/plugins/cache/acme/effort-pilot/${version}`, version })

describe('where the session reads the installed version', () => {
  test('an installed plugin reads its registry under the config folder, keyed by name and marketplace', () => {
    expect(cacheInstall(ROOT, 'effort-pilot')).toEqual({ registry: `${CONFIG}/plugins/installed_plugins.json`, key: KEY, running: '1.15.0' })
  })

  test('a config folder set elsewhere is followed', () => {
    expect(cacheInstall('/opt/cc/plugins/cache/acme/effort-pilot/2.0.1', 'effort-pilot')?.registry).toBe('/opt/cc/plugins/installed_plugins.json')
  })

  test('a plugin loaded from a folder reads nothing', () => {
    expect(cacheInstall('/home/someone/code/effort-pilot/plugin', 'effort-pilot')).toBeNull()
    expect(cacheInstall(`${CONFIG}/plugins/cache/inline/effort-pilot/1.15.0`, 'effort-pilot')).toBeNull()
  })

  test('a version folder that is no version reads nothing', () => {
    expect(cacheInstall(`${CONFIG}/plugins/cache/acme/effort-pilot/abc123`, 'effort-pilot')).toBeNull()
  })
})

describe('which version is installed', () => {
  test('the user install\'s version', () => {
    expect(installedVersion(registry(user('1.16.0')), KEY, PROJECT)).toBe('1.16.0')
  })

  test('an install scoped to this project wins over the user one', () => {
    const local = { scope: 'local', projectPath: PROJECT, version: '1.14.0' }
    expect(installedVersion(registry(user('1.16.0'), local), KEY, `${PROJECT}/src`)).toBe('1.14.0')
  })

  test('an install scoped to another project is not this one\'s', () => {
    const other = { scope: 'local', projectPath: '/home/someone/code/blog', version: '3.0.0' }
    expect(installedVersion(registry(user('1.16.0'), other), KEY, PROJECT)).toBe('1.16.0')
  })

  test('a missing, corrupt or empty registry, or no entry, reads as none', () => {
    expect(installedVersion(null, KEY, PROJECT)).toBeNull()
    expect(installedVersion('', KEY, PROJECT)).toBeNull()
    expect(installedVersion('{"plugins": [', KEY, PROJECT)).toBeNull()
    expect(installedVersion('null', KEY, PROJECT)).toBeNull()
    expect(installedVersion(JSON.stringify({ plugins: {} }), KEY, PROJECT)).toBeNull()
    expect(installedVersion(registry({ scope: 'user', version: 42 }), KEY, PROJECT)).toBeNull()
  })

  test('an older registry\'s single entry is read too', () => {
    expect(installedVersion(JSON.stringify({ plugins: { [KEY]: { version: '1.16.0' } } }), KEY, PROJECT)).toBe('1.16.0')
  })
})

describe('semver order', () => {
  test('a higher major, minor or patch is newer, numerically', () => {
    expect(newer('1.16.0', '1.15.0')).toBe(true)
    expect(newer('1.10.0', '1.9.9')).toBe(true)
    expect(newer('2.0.0', '1.99.99')).toBe(true)
    expect(newer('1.15.1', '1.15.0')).toBe(true)
  })

  test('the same or a lower version is not newer', () => {
    expect(newer('1.15.0', '1.15.0')).toBe(false)
    expect(newer('1.14.9', '1.15.0')).toBe(false)
    expect(newer('1.9.0', '1.10.0')).toBe(false)
  })

  test('a release is newer than its pre-release, not the other way', () => {
    expect(newer('1.16.0', '1.16.0-beta.2')).toBe(true)
    expect(newer('1.16.0-beta.2', '1.16.0')).toBe(false)
    expect(newer('1.16.0-beta.10', '1.16.0-beta.2')).toBe(true)
  })

  test('what is no version is never newer', () => {
    expect(newer('latest', '1.15.0')).toBe(false)
    expect(newer('1.16.0', 'abc')).toBe(false)
  })
})

describe('the notice', () => {
  test('a newer installed version is said once', () => {
    const w = versionWatch()
    const text = registry(user('1.16.0'))
    expect(w.line(text, KEY, '1.15.0', PROJECT)).toBe('Effort Pilot 1.16.0 is installed; this session still runs 1.15.0. Type /reload-plugins to use it.')
    expect(w.line(text, KEY, '1.15.0', PROJECT)).toBeNull()
  })

  test('a still newer version installed later is said too', () => {
    const w = versionWatch()
    expect(w.line(registry(user('1.16.0')), KEY, '1.15.0', PROJECT)).toBe(staleLine('1.16.0', '1.15.0'))
    expect(w.line(registry(user('1.17.0')), KEY, '1.15.0', PROJECT)).toBe(staleLine('1.17.0', '1.15.0'))
  })

  test('the same, an older, a missing or a corrupt install says nothing', () => {
    const w = versionWatch()
    expect(w.line(registry(user('1.15.0')), KEY, '1.15.0', PROJECT)).toBeNull()
    expect(w.line(registry(user('1.14.0')), KEY, '1.15.0', PROJECT)).toBeNull()
    expect(w.line(null, KEY, '1.15.0', PROJECT)).toBeNull()
    expect(w.line('{not json', KEY, '1.15.0', PROJECT)).toBeNull()
  })

  test('the registry is read at most once every few minutes', () => {
    const w = versionWatch(300_000)
    expect(w.due(1_000)).toBe(true)
    expect(w.due(2_000)).toBe(false)
    expect(w.due(300_999)).toBe(false)
    expect(w.due(301_000)).toBe(true)
  })
})

describe('the toast a person\'s turn shows', () => {
  /** A stand-in for the engine: the registry at its path, the clock, and the toasts shown. */
  const io = (root: string, files: Record<string, string | Error>, now = { t: 0 }) => {
    const toasts: string[] = []
    return {
      toasts, now,
      plugin: { root, name: 'effort-pilot' },
      clock: { now: async () => now.t },
      fs: {
        exists: async (p: string) => p in files,
        read: async (p: string) => {
          const v = files[p]
          if (v === undefined || v instanceof Error) throw v ?? new Error('missing')
          return v
        },
      },
      session: { root: async () => PROJECT },
      ui: { toast: (text: string) => void toasts.push(text) },
    }
  }
  const REGISTRY = `${CONFIG}/plugins/installed_plugins.json`

  test('a newer installed version shows one toast, once', async () => {
    const $ = io(ROOT, { [REGISTRY]: registry(user('1.16.0')) })
    const w = versionWatch(300_000)
    await newerInstalled($, w)
    $.now.t = 400_000
    await newerInstalled($, w)
    expect($.toasts).toEqual([staleLine('1.16.0', '1.15.0')])
  })

  test('the same, an older, a missing or an unreadable registry shows none', async () => {
    const cases: Record<string, string | Error>[] = [{ [REGISTRY]: registry(user('1.15.0')) }, { [REGISTRY]: registry(user('1.14.0')) }, {}, { [REGISTRY]: new Error('denied') }, { [REGISTRY]: '{oops' }]
    for (const files of cases) {
      const $ = io(ROOT, files)
      await newerInstalled($, versionWatch())
      expect($.toasts).toEqual([])
    }
  })

  test('a plugin loaded from a folder reads no registry and shows none', async () => {
    let read = false
    const $ = io('/home/someone/code/effort-pilot/plugin', {})
    $.fs.exists = async () => {
      read = true
      return true
    }
    await newerInstalled($, versionWatch())
    expect(read).toBe(false)
    expect($.toasts).toEqual([])
  })

  test('a turn within the few minutes after a read reads nothing', async () => {
    const $ = io(ROOT, { [REGISTRY]: registry(user('1.15.0')) })
    const w = versionWatch(300_000)
    await newerInstalled($, w)
    $.fs.read = async () => registry(user('1.16.0'))
    $.now.t = 60_000
    await newerInstalled($, w)
    expect($.toasts).toEqual([])
    $.now.t = 300_000
    await newerInstalled($, w)
    expect($.toasts).toEqual([staleLine('1.16.0', '1.15.0')])
  })
})
