import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeBudgetEngine } from './domain/engine'
import { App, StorageBoundary } from './ui/App'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

async function openBudget() {
  root.render(<main className="loading-screen" aria-busy="true"><p>Открываем бюджет…</p></main>)
  try {
    await initializeBudgetEngine()
    root.render(<StrictMode><StorageBoundary><App/></StorageBoundary></StrictMode>)
  } catch (error) {
    console.error('Не удалось запустить финансовое ядро.', error)
    root.render(<main className="loading-screen" role="alert">
      <h1>Не удалось загрузить финансовое ядро</h1>
      <button className="primary" type="button" onClick={() => void openBudget()}>Попробовать снова</button>
    </main>)
  }
}

void openBudget()
