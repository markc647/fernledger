import { useEffect, useRef } from 'react'

/**
 * A ref for a `<details>` that is open while the page is printed, and as it was before: what is in it is part of the page on paper, and a closed disclosure
 * would print as one line. The browser tells the page when it is about to print and when it has finished.
 */
export function useOpenForPrint() {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    let wasOpen = false
    const open = () => {
      if (!ref.current) return
      wasOpen = ref.current.open
      ref.current.open = true
    }
    const restore = () => {
      if (ref.current) ref.current.open = wasOpen
    }
    window.addEventListener('beforeprint', open)
    window.addEventListener('afterprint', restore)
    return () => {
      window.removeEventListener('beforeprint', open)
      window.removeEventListener('afterprint', restore)
    }
  }, [])
  return ref
}
