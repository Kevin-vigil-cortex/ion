import { useEffect, useRef } from 'react'
import spaceBg from '../assets/space-bg.mp4'

/**
 * Looping video backdrop for the main content area only. Isolated on its own
 * compositor layer so chat re-renders don't decode frames on the UI thread.
 * Pauses when the window is hidden.
 */
export default function VideoBackground(): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const RATE = 0.9
    const sync = (): void => {
      v.playbackRate = RATE
      if (document.hidden) v.pause()
      else void v.play().then(() => { v.playbackRate = RATE }).catch(() => {})
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      <video
        ref={ref}
        src={spaceBg}
        autoPlay
        loop
        muted
        playsInline
        disablePictureInPicture
        preload="auto"
        className="h-full w-full object-cover [transform:translateZ(0)]"
      />
      <div className="absolute inset-0 bg-black/25" />
    </div>
  )
}
