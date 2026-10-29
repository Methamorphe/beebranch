import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/open-sans/latin-400.css'
import '@fontsource/open-sans/latin-600.css'
import '@fontsource/open-sans/latin-700.css'
import '@fontsource-variable/geist-mono'
import App from './App.tsx'
import { call } from './ipc/client'
import './styles/tokens.css'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The main window is created hidden so the splash window (crates/app/src/splash.rs)
// can play its boot animation first. A hidden WebView never runs
// requestAnimationFrame (verified on macOS: the callback never fires), so
// readiness is signalled on a timer instead: React flushes its first commit
// before timers run, and the backend reveals the window right after, so the
// user never sees a blank one.
setTimeout(() => {
  void call('app_ready').catch(() => {})
}, 0)

