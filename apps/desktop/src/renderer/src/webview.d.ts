import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/**
 * Minimal typing for the Electron <webview> tag used by the agent browser
 * panel (React 19 moved IntrinsicElements under the `react` module's JSX
 * namespace, hence the module augmentation).
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
      }
    }
  }
}
