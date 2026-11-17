import { App } from './App'
import { ToastProvider } from './components/ui/Toast'
export default function PrivateEntry() { return <ToastProvider><App /></ToastProvider> }
