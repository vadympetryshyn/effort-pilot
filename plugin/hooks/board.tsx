import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { ArmRead, Effort, MeasureRead, PhaseRead, ReportData } from '../types'
import { EFFORTS, ENOUGH, fmt, groupTitle, VERDICT } from './route'

// The report pane: the measurement's read drawn as bars, pilot against control, from the same data as the text report.

/** The elements the pane draws with: the three every surface carries. */
export type Ui = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

export const PANE = 'effort-pilot-report'
export const PANE_TITLE = 'Effort Pilot report'

const LABEL = 10
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
/** A gain that rounds to nothing reads as 0, not as −0. */
const signed = (show: (x: number) => string) => (x: number) => (Math.round(x * 100) === 0 ? show(0).replace(/^[−+]/, '') : show(x))
/** A bar of `value` against `top`, `width` cells at the most; a value above 0 shows at least one cell. */
export function bar(value: number, top: number, width: number) {
  if (!(value > 0) || !(top > 0)) return ''
  return '█'.repeat(Math.max(1, Math.round((Math.min(value, top) / top) * width)))
}

const SENT: Record<Effort | 'none', string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', none: 'unset' }

/** The pane's tree for a read, `columns` wide; `refresh` reads the records again. */
export function board(ui: Ui, read: { data: ReportData; where: string } | null, columns: number, refresh: () => void): RenderElement {
  const { Box, Text, Button } = ui
  const width = Math.max(6, Math.min(40, columns - LABEL - 14))
  const top = (
    <Box gap={1}>
      <Text bold>Effort Pilot report</Text>
      <Button key="refresh" hotkey="r" label="Refresh" dimColor onPress={refresh} />
    </Box>
  )
  if (!read) return <Box flexDirection="column">{top}<Text dimColor>Not read yet: press Refresh.</Text></Box>
  const d = read.data
  if (!d.turns) {
    return (
      <Box flexDirection="column" gap={1}>
        {top}
        <Text>No turns recorded yet.</Text>
        <Text dimColor>{read.where}</Text>
      </Box>
    )
  }

  /** One labelled bar row: the label, the bar, its value in words. */
  const row = (label: string, value: number, max: number, shown: string, color: string, dim: boolean) => (
    <Box>
      <Box width={LABEL} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Text color={color} dimColor={dim}>{bar(value, max, width)}</Text>
      <Text dimColor={dim}> {shown}</Text>
    </Box>
  )

  /** A measure: pilot and control bars on one scale, then the range and the verdict once compared. */
  const measure = (name: string, p: PhaseRead, pick: (a: ArmRead) => number, show: (x: number) => string, m: MeasureRead | undefined, unit: (x: number) => string, whole?: number) => {
    const a = pick(p.pilot!)
    const c = pick(p.control!)
    const max = whole ?? Math.max(a, c)
    const dim = !m
    const say = signed(unit)
    return (
      <Box flexDirection="column">
        <Text>{name}</Text>
        {row('  pilot', a, max, show(a), 'claude', dim)}
        {row('  control', c, max, show(c), 'inactive', dim)}
        {m ? (
          <Text>
            {'  '}{say(m.share)} <Text dimColor>(90% range {say(m.high)} … {say(m.low)})</Text>{' → '}
            <Text color={m.verdict === 'better' ? 'success' : m.verdict === 'worse' ? 'error' : undefined} bold={m.verdict !== 'unclear'}>{VERDICT[m.verdict]}</Text>
            {m.more ? <Text dimColor>: about {m.more.pilot} more pilot and {m.more.control} more control turns if the gap holds</Text> : null}
          </Text>
        ) : null}
      </Box>
    )
  }

  /** One arm in words, where the other has no turn to set a bar against. */
  const arm = (name: string, x: ArmRead | null) => (
    <Text dimColor>
      {`  ${name}`.padEnd(LABEL)}{x ? `${plural(x.turns, 'turn')} · ${fmt.usd(x.cost)} a turn · ${fmt.sec(x.time)} median · fell short ${Math.round(x.short * 100)}%` : 'no turns yet'}
    </Text>
  )

  const compared = d.phases.filter(p => p.pilot || p.control)
  const none = d.phases.filter(p => !p.pilot && !p.control)
  const sentMax = Math.max(0, ...Object.values(d.sent).map(n => n ?? 0))
  const levels = [...EFFORTS, 'none' as const].filter(l => l !== 'none' || d.sent.none)
  const c = d.classifier
  const n = d.net

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {top}
        <Text dimColor>
          {plural(d.turns, 'turn')} over {d.days.toFixed(1)} days, {plural(d.sessions, 'session')}{d.left ? ` (${d.left} test or failed turns left out)` : ''} · as read when opened · costs at API prices
        </Text>
        {n ? null : <Text color="warning">No phase has {ENOUGH}+ comparable turns on each arm yet: the bars below are too few to judge.</Text>}
      </Box>

      <Box flexDirection="column">
        <Text bold>Turns by effort sent</Text>
        {levels.map(l => row(`  ${SENT[l]}`, d.sent[l] ?? 0, sentMax, String(d.sent[l] ?? 0), 'claude', false))}
      </Box>

      {compared.map(p => (
        <Box flexDirection="column">
          <Text bold>
            {groupTitle(p.who)} · {p.phase}{' · '}
            <Text dimColor>
              pilot {p.efforts.join('/') || '—'} vs high · {p.pilot?.turns ?? 0} pilot, {plural(p.control?.turns ?? 0, 'control turn')}{p.same ? `, ${p.same} not compared` : ''}
            </Text>
          </Text>
          {p.measures ? null : (
            <Text color="warning">too few turns to compare: {p.need.pilot} pilot and {p.need.control} control to go ({ENOUGH}+ in each)</Text>
          )}
          {p.pilot && p.control ? (
            <Box flexDirection="column">
              {measure('cost a turn', p, x => x.cost, fmt.usd, p.measures?.cost, fmt.percent)}
              {measure('model time (median)', p, x => x.time, fmt.sec, p.measures?.time, fmt.percent)}
              {measure('fell short', p, x => x.short, x => `${Math.round(x * 100)}%`, p.measures?.short, fmt.points, 1)}
            </Box>
          ) : (
            <Box flexDirection="column">
              {arm('pilot', p.pilot)}
              {arm('control', p.control)}
            </Box>
          )}
        </Box>
      ))}

      {none.length ? (
        <Box flexDirection="column">
          <Text bold>Not compared</Text>
          {none.map(p => (
            <Text dimColor>  {groupTitle(p.who)} · {p.phase}: {plural(p.same, 'turn')} (high either way, another own effort, an asked one, or held over)</Text>
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column">
        <Text bold>Classifier (Haiku)</Text>
        {c ? (
          <Box flexDirection="column">
            <Text>  {fmt.usd(c.perTurn)} a turn <Text dimColor>({fmt.usd(c.cost)} over {c.turns} turns, {c.calls} calls, {fmt.kTok(c.input)} in / {fmt.kTok(c.out)} out tokens)</Text></Text>
            <Text>  waits {c.wait.toFixed(1)}s before a prompt{c.missing ? <Text dimColor> · {plural(c.missing, 'turn')} without a classifier cost</Text> : null}</Text>
          </Box>
        ) : <Text dimColor>  not recorded yet</Text>}
      </Box>

      <Box flexDirection="column">
        <Text bold>Net</Text>
        {n ? (
          <Box flexDirection="column">
            <Text>
              {'  '}cost {fmt.usd(n.saved)} a turn saved − classifier {fmt.usd(n.perTurn)} = <Text bold>{fmt.usd(n.saved - n.perTurn)}</Text>
              {' → '}{n.saved - n.perTurn > 0 ? 'Effort Pilot pays for itself' : 'Effort Pilot costs more than it saves'}
            </Text>
            <Text>  model time {fmt.sec(Math.abs(n.faster))} a turn {n.faster >= 0 ? 'faster' : 'slower'} <Text dimColor>· over {plural(n.phases, 'compared phase')}, {plural(n.turns, 'pilot turn')}; quality: fell short per phase</Text></Text>
          </Box>
        ) : <Text dimColor>  not known yet: no phase has {ENOUGH}+ turns on each arm</Text>}
      </Box>

      <Text dimColor>{read.where}</Text>
    </Box>
  )
}
