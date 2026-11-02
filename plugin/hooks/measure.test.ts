import { expect, test } from 'claude-code/testing'

/** Runs /effort-pilot <args> as the person would type it. */
const command = (args: string) => ({ command: 'effort-pilot', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

const good = JSON.stringify({ t: 1, s: 'a', arm: 'auto', phase: 'implement', hard: false, chosen: 'medium', base: 'high', sent: 'medium', model: 'claude-opus-5-5', steps: 2, out: 10, input: 1, cacheRead: 0, cacheWrite: 0, ms: 5, reason: 'answer' })

test('measuring is off by default: no report, no control turns', async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('measuring is off')
  const status = await $.command.run(command(''))
  expect(status.text).toBe('Effort Pilot: auto')
})

test('turned on, the report works and the control share is the setting\'s', { options: { measure: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/someone' }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('no turns recorded yet')
  expect(report.text).toContain('/home/someone/.claude/effort-pilot/turns')
  const status = await $.command.run(command(''))
  expect(status.text).toContain('measuring, 30% control turns')
})

test('a custom control share', { options: { measure: true, controlShare: 10 } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  const status = await $.command.run(command(''))
  expect(status.text).toContain('measuring, 10% control turns')
})

test('a corrupt line in a record file is skipped', { options: { measure: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('env.get', () => ({ value: '/home/someone' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'a.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: `${good}\n{"t":2,"s":"a","ar\n` }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('1 turns over')
})

test('with no home folder known, no records are read', { options: { measure: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('env.get', () => ({ value: undefined }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('no turns recorded yet')
  expect(report.text).toContain('records: none')
})
