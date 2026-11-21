import { TrendingUp } from 'lucide-react'
import { engine, money } from '../domain/engine'
import type { BudgetPeriod, Day, Transaction } from '../domain/models'
import { MoneyText } from './shared'

function readForecast(rows: Transaction[], period: BudgetPeriod, today: Day, limit: number) {
  try {
    return engine.forecast(rows, period, today, limit)
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

export function ForecastCard({ rows, period, today, limit }: {
  rows: Transaction[]; period: BudgetPeriod; today: Day; limit: number
}) {
  const forecast = readForecast(rows, period, today, limit)
  const title = period.kind === 'week' ? 'Прогноз на неделю' : 'Прогноз на месяц'
  const insufficient = forecast?.confidence === 'insufficient'
  const overLimit = forecast?.risk === 'over_limit'
  return <section className="panel analysis-panel forecast-card" aria-label={title}>
    <h2><TrendingUp size={18} aria-hidden="true"/> {title}</h2>
    {!forecast ? <p>Не удалось рассчитать прогноз.</p> : <>
      {(forecast.projectedSpent > 0 || !insufficient) && <dl className="forecast-values">
        <div><dt>{insufficient ? 'Известные расходы' : 'Расходы к концу периода'}</dt>
          <dd><MoneyText text={money(forecast.projectedSpent)} label={money(forecast.projectedSpent)}/></dd></div>
        {(!insufficient || overLimit) && <div>
          <dt>{overLimit ? insufficient ? 'Известный перерасход' : 'Риск перерасхода' : 'Ожидаемый остаток'}</dt>
          <dd className={overLimit ? 'negative' : undefined}>
            <MoneyText text={money(Math.abs(forecast.remaining))} label={money(Math.abs(forecast.remaining))}/>
          </dd>
        </div>}
      </dl>}
      {forecast.futureSpent > 0 && <p>Будущие расходы в бюджете · {money(forecast.futureSpent)}</p>}
      {insufficient && <p>Пока мало данных, чтобы оценить темп расходов.</p>}
      {forecast.confidence === 'low' && <p>Мало данных, прогноз может заметно измениться.</p>}
    </>}
  </section>
}
