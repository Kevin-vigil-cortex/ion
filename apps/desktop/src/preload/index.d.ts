import type { IonApi } from '../shared/ipc'

declare global {
  interface Window {
    ion: IonApi
  }
}

export {}
