import { useId, useState } from 'react'
import { motion } from 'motion/react'
import { money } from '../domain/engine'

export interface Point { label: string; amount: number }
const width = 600
const height = 112
const margin = 11

function smooth(points: { x: number; y: number }[]) {
  const [first, ...rest] = points
  return rest.reduce((path, point, i) => {
    const prior = points[i]
    const mid = (prior.x + point.x) / 2
    return `${path} C ${mid},${prior.y} ${mid},${point.y} ${point.x},${point.y}`
  }, `M ${first.x},${first.y}`)
}

export function Trend({ values, label, interactive = true }: { values: Point[]; label: string; interactive?: boolean }) {
  const id = useId()
  const [index, setIndex] = useState<number | null>(null)
  const selected = Math.min(index ?? values.length - 1, values.length - 1)
  const max = Math.max(1, ...values.map(p => p.amount)) * 1.18
  const points = values.map((p, i) => ({
    x: margin + i * (width - 2 * margin) / Math.max(values.length - 1, 1),
    y: height - margin - p.amount / max * (height - 2 * margin),
  }))
  if (!points.length) return null
  const line = smooth(points)
  const area = `${line} L ${points.at(-1)?.x},${height} L ${margin},${height} Z`
  return <div className="trend">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <title>{label}</title>
      <desc>{values.map(value => value.label + ' ' + money(value.amount)).join(', ')}</desc>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--accent)" stopOpacity=".17"/><stop offset="1" stopColor="var(--accent)" stopOpacity="0"/></linearGradient></defs>
      {[50, 106].map(y => <path key={y} d={`M 0 ${y} H ${width}`} className="chart-grid"/>)}
      <motion.path d={area} fill={`url(#${id})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .45 }}/>
      <motion.path d={line} fill="none" stroke="var(--chart-line)" strokeWidth="2.8" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .52 }}/>
      <path d={`M ${points[selected].x} ${points[selected].y} V ${height}`} className="chart-marker"/>
      <path d={`M ${points[selected].x} ${points[selected].y} h .01`} className="chart-point-halo" strokeWidth="13" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      <path d={`M ${points[selected].x} ${points[selected].y} h .01`} className="chart-point" strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
    </svg>
    {interactive ? <div className="trend-labels">
      {values.map((value, i) => <button key={i} type="button" className={i === selected ? 'selected' : ''} aria-pressed={i === selected}
        title={money(value.amount)} aria-label={value.label + ', ' + money(value.amount)} onClick={() => setIndex(i)}>{value.label}</button>)}
    </div> : <div className="trend-labels">{values.map((value, i) => <span key={i}>{value.label}</span>)}</div>}
    {index !== null && <output className="trend-tooltip">{values[selected].label} · {money(values[selected].amount)}</output>}
  </div>
}
