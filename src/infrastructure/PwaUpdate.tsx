import { useEffect, useRef, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'

export function PwaUpdate() {
  const [waiting, setWaiting] = useState(false)
  const [applying, setApplying] = useState(false)
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const updateRequested = useRef(false)

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    const serviceWorker = navigator.serviceWorker
    let disposed = false
    let installing: ServiceWorker | null = null
    const installed = () => {
      if (!disposed && installing?.state === 'installed' && serviceWorker.controller) setWaiting(true)
    }
    const watchInstall = () => {
      installing?.removeEventListener('statechange', installed)
      installing = registration.current?.installing ?? null
      installing?.addEventListener('statechange', installed)
      installed()
    }
    const changed = () => {
      if (updateRequested.current) window.location.reload()
      else setWaiting(false)
    }
    serviceWorker.addEventListener('controllerchange', changed)
    const script = import.meta.env.BASE_URL + 'sw.js'
    void serviceWorker.register(script, { updateViaCache: 'none' }).then(result => {
      if (disposed) return
      registration.current = result
      if (result.waiting) setWaiting(true)
      result.addEventListener('updatefound', watchInstall)
      watchInstall()
    }).catch(() => {
      // The interface remains available when the browser blocks registration.
    })
    return () => {
      disposed = true
      serviceWorker.removeEventListener('controllerchange', changed)
      registration.current?.removeEventListener('updatefound', watchInstall)
      installing?.removeEventListener('statechange', installed)
    }
  }, [])

  function apply() {
    const worker = registration.current?.waiting
    if (!worker) { window.location.reload(); return }
    updateRequested.current = true
    setApplying(true)
    worker.postMessage({ type: 'SKIP_WAITING' })
  }

  if (!waiting) return null
  return <aside className="pwa-update" aria-label="Доступно обновление">
    <button className="secondary" type="button" onClick={apply} disabled={applying}><RefreshCw size={16}/> {applying ? 'Обновляем…' : 'Обновить приложение'}</button>
    <button className="icon-button" type="button" onClick={() => setWaiting(false)} disabled={applying} aria-label="Скрыть обновление"><X size={17}/></button>
  </aside>
}
