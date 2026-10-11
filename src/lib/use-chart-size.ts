import { useEffect, useRef, useState } from 'react'

// What a chart needs to know about its surroundings that CSS cannot tell it: Recharts takes pixel sizes (the width of the labels beside the bars), and
// the pixels of a rem change with the text size (src/lib/text-size.ts) and the width of the window.

/** The pixel size of 1rem: the root's font size, which the A / A+ / A++ control changes by setting `data-text-size` on the page. */
export function useRem() {
  const [rem, setRem] = useState(16)
  useEffect(() => {
    const read = () => setRem(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-text-size'] })
    return () => observer.disconnect()
  }, [])
  return rem
}

/** A ref for an element, and its width in pixels as it changes (0 until it has one). */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(Math.round(element.getBoundingClientRect().width))
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]!.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}
