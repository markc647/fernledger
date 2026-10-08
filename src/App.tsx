import { useEffect, useState } from 'react'

type Me = { email: string; role: 'admin' | 'member' }

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setMe)
      .catch(() => setError(true))
  }, [])

  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="text-2xl font-semibold">Fernledger</h1>
      <p className="mt-2">
        {me && `Signed in as ${me.email} (${me.role === 'admin' ? 'Admin' : 'read-only'})`}
        {error && 'Not signed in.'}
      </p>
    </main>
  )
}
