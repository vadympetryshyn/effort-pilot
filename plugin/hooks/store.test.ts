import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'

import { bySlot, CAP, DAY, dataDir, fresh, KEEP_DAYS, legacyDir, pack, slotFile, stale } from './store'

const line = (t: number, extra = '') => JSON.stringify({ t, s: 'a', arm: 'auto', phase: 'chat', note: extra })

describe('where records live', () => {
  test('an installed plugin keeps them in its data folder, named plugin-marketplace', () => {
    expect(dataDir('/home/someone/.claude/plugins/cache/effort-pilot/effort-pilot/1.1.0', 'effort-pilot', '/home/someone'))
      .toBe('/home/someone/.claude/plugins/data/effort-pilot-effort-pilot')
  })
  test('the data folder follows the plugin\'s own config folder, not the home folder', () => {
    expect(dataDir('/elsewhere/claude/plugins/cache/my.market/effort-pilot/1.1.0', 'effort-pilot', '/home/someone'))
      .toBe('/elsewhere/claude/plugins/data/effort-pilot-my-market')
  })
  test('a plugin loaded from a folder uses the inline data folder under the home folder', () => {
    expect(dataDir('/home/someone/code/effort-pilot/plugin', 'effort-pilot', '/home/someone'))
      .toBe('/home/someone/.claude/plugins/data/effort-pilot-inline')
  })
  test('with no install path and no home folder, nowhere', () => {
    expect(dataDir('/code/plugin', 'effort-pilot', undefined)).toBe(null)
  })
  test('the old location is under the home folder', () => {
    expect(legacyDir('/home/someone')).toBe('/home/someone/.claude/effort-pilot/turns')
    expect(legacyDir(undefined)).toBe(null)
  })
})

describe('the day files', () => {
  test('one file a day, reused every KEEP_DAYS days: never more than KEEP_DAYS files', () => {
    const now = 20_000 * DAY + 5000
    expect(slotFile(now)).toBe(slotFile(now + KEEP_DAYS * DAY))
    expect(slotFile(now)).not.toBe(slotFile(now + DAY))
    const names = new Set(Array.from({ length: 400 }, (_, i) => slotFile(now + i * DAY)))
    expect(names.size).toBe(KEEP_DAYS)
  })
  test('writing a day file drops the records of an older day it still holds', () => {
    const old = 20_000 * DAY + 100
    const today = old + KEEP_DAYS * DAY
    expect(pack(`${line(old)}\n${line(today)}\n`)).toBe(`${line(today)}\n`)
  })
  test('records come out oldest first, each once, and lines that are not records go', () => {
    const t = 20_000 * DAY
    expect(pack(`${line(t + 2)}\n{"t":1,"s\n${line(t + 1)}\n${line(t + 2)}\n\n`)).toBe(`${line(t + 1)}\n${line(t + 2)}\n`)
  })
  test('a file over the cap drops its oldest records first', () => {
    const t = 20_000 * DAY
    const rows = [line(t + 1, 'x'.repeat(40)), line(t + 2, 'y'.repeat(40)), line(t + 3, 'z'.repeat(40))]
    const cap = 2 * (rows[0]!.length + 1)
    expect(pack(rows.join('\n'), cap)).toBe(`${rows[1]}\n${rows[2]}\n`)
  })
  test('the cap counts bytes, so text in any script stays under the read limit', () => {
    const t = 20_000 * DAY
    const rows = [line(t + 1, 'ж'.repeat(40)), line(t + 2, 'ж'.repeat(40))]
    expect(pack(rows.join('\n'), rows[1]!.length + 10)).toBe('')
    expect(CAP).toBeLessThan(4 * 1024 * 1024)
  })
  test('an empty or unreadable file packs to nothing', () => {
    expect(pack('')).toBe('')
    expect(pack('not json\n')).toBe('')
  })
})

describe('retention', () => {
  test('a record is kept for KEEP_DAYS days', () => {
    const now = 20_000 * DAY
    expect(fresh(now - KEEP_DAYS * DAY + 1, now)).toBe(true)
    expect(fresh(now - KEEP_DAYS * DAY, now)).toBe(false)
  })
  test('a file not written for KEEP_DAYS days is emptied; an empty one or a folder is left', () => {
    const now = 20_000 * DAY
    expect(stale({ kind: 'file', size: 10, mtimeMs: now - KEEP_DAYS * DAY }, now)).toBe(true)
    expect(stale({ kind: 'file', size: 10, mtimeMs: now - DAY }, now)).toBe(false)
    expect(stale({ kind: 'file', size: 0, mtimeMs: 0 }, now)).toBe(false)
    expect(stale({ kind: 'dir', size: 0, mtimeMs: 0 }, now)).toBe(false)
  })
  test('old records are grouped by their day file, and expired ones left out', () => {
    const now = 20_000 * DAY + 1000
    const groups = bySlot(`${line(now - DAY)}\n${line(now - 2 * DAY)}\n${line(now - KEEP_DAYS * DAY - 1)}\nbroken\n`, now)
    expect([...groups.keys()].sort()).toEqual([slotFile(now - DAY), slotFile(now - 2 * DAY)].sort())
    expect(groups.get(slotFile(now - DAY))).toBe(`${line(now - DAY)}\n`)
  })
})
