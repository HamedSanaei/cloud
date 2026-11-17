import { LandingPage } from '../pages/LandingPage'
import { HetznerPage } from '../pages/HetznerPage'
import type { PublicPath } from './metadata'
export function PublicPage({ path, initialTariffs }: { path: PublicPath; initialTariffs?: string }) {
  return path === '/hetzner' ? <HetznerPage initialTariffs={initialTariffs} /> : <LandingPage initialTariffs={initialTariffs} />
}
