// Whether a newer version of this plugin is installed than the one a session runs, and the toast that says so.
//
// `claude plugin update` installs a new version into its own cache folder and records it in Claude Code's install
// registry, but a session already running keeps the code it loaded until the person types /reload-plugins, and Claude
// Code says nothing of it there. The session reads the registry now and then and says so, once a version.

/** How often a person's turn may read the registry: at most once in this many milliseconds. */
export const CHECK_MS = 5 * 60_000

/**
 * Where an installed plugin's registry is, its key there, and the version this session runs, from the plugin's root:
 * `<config>/plugins/cache/<marketplace>/<plugin>/<version>`. Null for a plugin loaded from a folder (--plugin-dir: no
 * cache path, or the marketplace `inline`) or a version folder that is not a version.
 */
export function cacheInstall(root: string, name: string): { registry: string; key: string; running: string } | null {
  const m = /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/][^\\/]+[\\/]([^\\/]+)[\\/]?$/.exec(root)
  if (!m || m[2] === 'inline' || !semver(m[3]!)) return null
  return { registry: `${m[1]}/plugins/installed_plugins.json`, key: `${name}@${m[2]}`, running: m[3]! }
}

type Version = { core: [number, number, number]; pre: string[] }
function semver(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null
}

/** a is a higher semver than b; false where either is no version. */
export function newer(a: string, b: string): boolean {
  const x = semver(a)
  const y = semver(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]!
  // A release is above its pre-releases.
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === undefined || q === undefined) return q === undefined
    if (p === q) continue
    const [n, k] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (n && k) return Number(p) > Number(q)
    if (n !== k) return k
    return p > q
  }
  return false
}

/**
 * The version the registry records for key, as it applies in this project: an install scoped to this project (its
 * projectPath the session's root or above it) over one for every project; the highest where several are. Null where the
 * registry is missing, unreadable or holds no entry.
 */
export function installedVersion(text: string | null, key: string, project: string): string | null {
  if (!text) return null
  let all: unknown
  try {
    all = (JSON.parse(text) as { plugins?: Record<string, unknown> } | null)?.plugins?.[key]
  } catch {
    return null
  }
  const entries = (Array.isArray(all) ? all : all ? [all] : []).filter(
    (e): e is { version: string; projectPath?: unknown } => !!e && typeof e === 'object' && typeof (e as { version?: unknown }).version === 'string' && !!semver((e as { version: string }).version),
  )
  const here = (p: unknown) => typeof p === 'string' && p !== '' && (project === p || project.startsWith(`${p.replace(/[\\/]+$/, '')}/`))
  const scoped = entries.filter(e => here(e.projectPath))
  const pool = scoped.length ? scoped : entries.filter(e => e.projectPath === undefined || e.projectPath === '')
  return pool.reduce<string | null>((top, e) => (top === null || newer(e.version, top) ? e.version : top), null)
}

/** The line a session that runs an older version than the one installed shows the person. */
export const staleLine = (installed: string, running: string) =>
  `Effort Pilot ${installed} is installed; this session still runs ${running}. Type /reload-plugins to use it.`

/**
 * A session's watch on the installed version: due() at most once every `every` ms, and line() the notice for a newer
 * installed version, once a version.
 */
export function versionWatch(every = CHECK_MS) {
  let last: number | null = null
  const told = new Set<string>()
  return {
    due(now: number) {
      if (last !== null && now - last < every) return false
      last = now
      return true
    },
    line(registry: string | null, key: string, running: string, project: string): string | null {
      const v = installedVersion(registry, key, project)
      if (!v || !newer(v, running) || told.has(v)) return null
      told.add(v)
      return staleLine(v, running)
    },
  }
}

/** What newerInstalled uses of the engine's `$`. */
export type Io = {
  plugin: { root: string; name: string }
  clock: { now(): Promise<number> }
  fs: { exists(path: string): Promise<boolean>; read(path: string): Promise<unknown> }
  session: { root(): Promise<string> }
  ui: { toast(text: string, options?: { timeoutMs?: number }): void }
}
/** How long the notice stays: long enough to read and type the command it names. */
export const NOTICE_MS = 15_000

/**
 * On a person's turn, at most once every few minutes: the version Claude Code's install registry holds for this plugin
 * against the one this session runs, and a toast where it is newer. A toast, not a notice row: a row is drawn only in
 * the verbose view. Nothing for a plugin loaded from a folder (--plugin-dir) or an unreadable registry; never throws.
 */
export async function newerInstalled($: Io, watch: ReturnType<typeof versionWatch>) {
  const at = cacheInstall($.plugin.root, $.plugin.name)
  if (!at || !watch.due(await $.clock.now())) return
  const exists = await $.fs.exists(at.registry).catch(() => false)
  const read = exists ? await $.fs.read(at.registry).catch(() => null) : null
  const line = watch.line(typeof read === 'string' ? read : null, at.key, at.running, await $.session.root().catch(() => ''))
  if (line) $.ui.toast(line, { timeoutMs: NOTICE_MS })
}
