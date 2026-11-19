import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, StorageBoundary } from './ui/App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><StorageBoundary><App/></StorageBoundary></StrictMode>)
