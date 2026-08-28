/// <reference types="vite/client" />

import type { HydracastApi } from '../../preload'

declare global {
  interface Window {
    hydracast: HydracastApi
  }
}

export {}
