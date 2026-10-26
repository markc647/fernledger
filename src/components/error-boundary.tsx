import { Component, type ReactNode } from 'react'

/**
 * Shows `fallback` in place of what is under it when that fails to render, or, under a `lazy`, to load (a tab left open across a deploy asks for a chunk that is no longer there).
 * Without one the failure takes the whole page with it. React has no hook for this, so it is the one class component the app has.
 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
