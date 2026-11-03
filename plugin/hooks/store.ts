// Where turn records live and how their files stay bounded. Pure: register.tsx does the reading and writing.
//
// The engine's file system can read, write whole files and list, but not delete or append. So the records sit in a
// fixed ring of day files: a turn goes to the file of its day (day index mod KEEP_DAYS), and writing a day's file drops
// the records of any older day it still holds. At most KEEP_DAYS files exist, none above CAP, nothing older than
// KEEP_DAYS days is read, and a file not written for KEEP_DAYS days is emptied.

export const DAY = 86_400_000
/** How many days of records are kept. */
export const KEEP_DAYS = 90
/** A records file's largest size in bytes: under the 4 MiB one read may take. */
export const CAP = 3 * 1024 * 1024

/**
 * The plugin's persistent data folder: the one `claude plugin uninstall` removes (unless --keep-data). Its id is
 * `<plugin>-<marketplace>`; an installed plugin's root is `<config>/plugins/cache/<marketplace>/<plugin>/<version>`,
 * and a plugin loaded from a folder (--plugin-dir) has the marketplace `inline`. Null when neither the root nor the
 * home folder places it.
 */
export function dataDir(root: string, name: string, home: string | null | undefined): string | null {
  const id = (market: string) => `${name}-${market}`.replace(/[^A-Za-z0-9_-]/g, '-')
  const m = /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]/.exec(root)
  if (m) return `${m[1]}/plugins/data/${id(m[2]!)}`
  return home ? `${home}/.claude/plugins/data/${id('inline')}` : null
}

/** Where version 1.0 kept its records, one file a session. */
export const legacyDir = (home: string | null | undefined) => (home ? `${home}/.claude/effort-pilot/turns` : null)

const dayOf = (t: number) => Math.floor(t / DAY)
/** The file a record made at t goes to: one per day, reused every KEEP_DAYS days. */
export const slotFile = (t: number) => `day-${String(((dayOf(t) % KEEP_DAYS) + KEEP_DAYS) % KEEP_DAYS).padStart(2, '0')}.jsonl`

/** A record line's time, or null for a line that is not a record. */
function stamp(line: string): number | null {
  try {
    const v: unknown = JSON.parse(line)
    const t = v && typeof v === 'object' ? (v as { t?: unknown }).t : undefined
    return typeof t === 'number' && Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

/** UTF-8 length of a string. */
function bytes(s: string) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3
  }
  return n
}

/**
 * A day file's new content from its lines: only the newest day's records, each once, oldest first, and the oldest
 * dropped while the file is over cap bytes. Lines that are not records go.
 */
export function pack(text: string, cap = CAP): string {
  const seen = new Set<string>()
  const rows: { line: string; t: number }[] = []
  for (const line of text.split('\n')) {
    if (seen.has(line)) continue
    seen.add(line)
    const t = stamp(line)
    if (t !== null) rows.push({ line, t })
  }
  if (!rows.length) return ''
  const day = rows.reduce((d, r) => Math.max(d, dayOf(r.t)), -Infinity)
  const kept = rows.filter(r => dayOf(r.t) === day).sort((a, b) => a.t - b.t)
  let size = kept.reduce((n, r) => n + bytes(r.line) + 1, 0)
  let from = 0
  while (size > cap && from < kept.length) size -= bytes(kept[from++]!.line) + 1
  return kept.slice(from).map(r => `${r.line}\n`).join('')
}

/** Old records' lines grouped by the day file each goes to; records older than KEEP_DAYS days are left out. */
export function bySlot(text: string, now: number): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const t = stamp(line)
    if (t === null || !fresh(t, now)) continue
    const f = slotFile(t)
    out.set(f, `${out.get(f) ?? ''}${line}\n`)
  }
  return out
}

/** A record made at t is still kept at now. */
export const fresh = (t: number, now: number) => t > now - KEEP_DAYS * DAY

/** A file last written KEEP_DAYS days ago or more holds only expired records: it is emptied. */
export const stale = (f: { kind: string; size: number; mtimeMs: number }, now: number) =>
  f.kind === 'file' && f.size > 0 && !fresh(f.mtimeMs, now)
