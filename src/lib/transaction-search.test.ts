import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { apiQuery, exportPath, filterQuery, filtersOf, noSuchOf, parseExportSearch, parseTransactionSearch, rangeBackwards, searchProblem, sortOf, tidy } from './transaction-search'

describe('parseTransactionSearch', () => {
  it('reads every filter the page puts in the address', () => {
    expect(
      parseTransactionSearch({ account: 2, category: 7, from: '2026-01-01', to: '2026-03-31', q: 'cafe', sort: 'amount', dir: 'desc', page: 3 }),
    ).toEqual({ account: 2, category: 7, from: '2026-01-01', to: '2026-03-31', q: 'cafe', sort: 'amount', dir: 'desc', page: 3 })
  })

  it('reads Uncategorised', () => {
    expect(parseTransactionSearch({ category: 'uncategorised' })).toEqual({ category: 'uncategorised' })
  })

  it('reads the Transfers filter, and leaves out a value it does not know', () => {
    expect(parseTransactionSearch({ transfers: 'only' })).toEqual({ transfers: 'only' })
    expect(parseTransactionSearch({ transfers: 'exclude' })).toEqual({ transfers: 'exclude' })
    expect(parseTransactionSearch({ transfers: 'both' })).toEqual({})
    expect(parseTransactionSearch({ transfers: true })).toEqual({})
  })

  it('reads numbers the router left as text, and text it turned into numbers', () => {
    // The router parses ?q=2026 as the number 2026 and ?account=2 as 2.
    expect(parseTransactionSearch({ account: '2', page: '4', q: 2026 })).toEqual({ account: 2, page: 4, q: '2026' })
  })

  it('leaves out anything that is not valid rather than failing, so a bad address still shows the list', () => {
    expect(
      parseTransactionSearch({
        from: '2026-02-30',
        to: '1999-01-01',
        q: '   ',
        sort: 'bank_memo',
        dir: 'sideways',
        page: 0,
      }),
    ).toEqual({})
    expect(parseTransactionSearch({ page: 1.5, q: { text: 'x' }, from: 20260101 })).toEqual({})
  })

  it('makes an Account or Category that is named but is not valid one that does not exist, so the page says so and does not widen to all of them', () => {
    for (const named of ['abc', '0', 0, -1, '1234567890', { id: 1 }]) {
      expect(parseTransactionSearch({ account: named }).account, String(named)).toBe(0)
      expect(parseTransactionSearch({ category: named }).category, String(named)).toBe(0)
    }
    expect(parseTransactionSearch({ account: '', category: '' })).toEqual({})
  })

  // The router lays what a route validates over the address's own search, so a key that is left out brings back the address's text: every key is there, as undefined.
  it('keeps every key, as undefined when it is left out', () => {
    const none = { account: undefined, category: undefined, transfers: undefined, from: undefined, to: undefined, q: undefined, sort: undefined, dir: undefined, page: undefined }
    expect(parseTransactionSearch({})).toStrictEqual(none)
    expect(parseTransactionSearch({ account: '', from: '', q: ' ', sort: 'date', page: 1 })).toStrictEqual(none)
  })

  it("leaves none of the address's text in what the router gives the page", () => {
    const searchAt = (address: string) => {
      const root = createRootRoute()
      const route = createRoute({ getParentRoute: () => root, path: '/transactions', validateSearch: parseTransactionSearch })
      const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [address] }) })
      return router.matchRoutes(router.state.location).at(-1)!.search
    }
    expect(searchAt('/transactions?account=abc&category=abc')).toEqual({ account: 0, category: 0 })
    expect(searchAt('/transactions?account=&category=&transfers=both&from=&to=2026-13-01&q=&sort=x&dir=up&page=0')).toEqual({})
    expect(searchAt('/transactions?account=2&sort=date&dir=desc&page=1')).toEqual({ account: 2 })
  })

  it('drops the defaults, so the address stays short', () => {
    expect(parseTransactionSearch({ sort: 'date', dir: 'desc', page: 1 })).toEqual({})
    expect(parseTransactionSearch({ sort: 'description', dir: 'asc' })).toEqual({ sort: 'description' })
    expect(parseTransactionSearch({ sort: 'description', dir: 'desc' })).toEqual({ sort: 'description', dir: 'desc' })
  })

  it('trims the text and keeps it to the length the API accepts', () => {
    expect(parseTransactionSearch({ q: '  cafe  ' })).toEqual({ q: 'cafe' })
    expect(parseTransactionSearch({ q: 'x'.repeat(150) })).toEqual({ q: 'x'.repeat(100) })
  })

  it('keeps a range that runs backwards, for the page to explain', () => {
    expect(parseTransactionSearch({ from: '2026-10-09', to: '2026-10-08' })).toEqual({ from: '2026-10-09', to: '2026-10-08' })
  })
})

describe('parseExportSearch', () => {
  it('reads the filters and nothing else, so an address with a sort or a page keeps neither on the Export page, which has no list', () => {
    const filters = { account: 2, category: 'uncategorised', transfers: 'only', from: '2026-01-01', to: '2026-03-31', q: 'cafe' }
    expect(parseExportSearch({ ...filters, sort: 'amount', dir: 'desc', page: 3 })).toStrictEqual({ ...filters, sort: undefined, dir: undefined, page: undefined })
  })

  it('is forgiving as the Transactions page is: a named Account that is not an ID is one that does not exist, and a bad date is left out', () => {
    expect(parseExportSearch({ account: 'abc', from: '2026-02-30' })).toMatchObject({ account: 0, from: undefined })
  })
})

describe('sortOf', () => {
  it('is newest first by default', () => {
    expect(sortOf({})).toEqual({ sort: 'date', dir: 'desc' })
  })

  it('sorts a column A to Z unless the direction says otherwise', () => {
    expect(sortOf({ sort: 'description' })).toEqual({ sort: 'description', dir: 'asc' })
    expect(sortOf({ sort: 'description', dir: 'desc' })).toEqual({ sort: 'description', dir: 'desc' })
    expect(sortOf({ dir: 'asc' })).toEqual({ sort: 'date', dir: 'asc' })
  })
})

describe('tidy', () => {
  it('leaves out the defaults and the empty, whatever order they were set in', () => {
    expect(tidy({ account: undefined, category: 'uncategorised', q: '', sort: 'date', dir: 'desc', page: 1 })).toEqual({ category: 'uncategorised' })
    expect(tidy({ sort: 'amount', dir: 'asc', page: 2 })).toEqual({ sort: 'amount', page: 2 })
    expect(tidy({ sort: 'date', dir: 'asc' })).toEqual({ dir: 'asc' })
  })
})

describe('noSuchOf', () => {
  const accounts = [{ id: 2 }, { id: 3 }]
  const categories = [{ id: 7 }]

  it('names an Account or Category of 0 whether or not its list has arrived, and a missing one once it has', () => {
    expect(noSuchOf({ account: 0 }, undefined, undefined)).toBe('Account')
    expect(noSuchOf({ category: 0 }, undefined, undefined)).toBe('Category')
    expect(noSuchOf({ account: 9 }, accounts, categories)).toBe('Account')
    expect(noSuchOf({ category: 9 }, accounts, categories)).toBe('Category')
    expect(noSuchOf({ account: 9, category: 9 }, accounts, categories)).toBe('Account')
  })

  it('names nothing that exists, is left out, is Uncategorised, or whose list has not arrived', () => {
    expect(noSuchOf({ account: 2, category: 7 }, accounts, categories)).toBeNull()
    expect(noSuchOf({}, accounts, categories)).toBeNull()
    expect(noSuchOf({ category: 'uncategorised' }, accounts, [])).toBeNull()
    expect(noSuchOf({ account: 9, category: 9 }, undefined, undefined)).toBeNull()
  })
})

describe('rangeBackwards', () => {
  it('is true only when both dates are there and From is after To', () => {
    expect(rangeBackwards({ from: '2026-10-09', to: '2026-10-08' })).toBe(true)
    expect(rangeBackwards({ from: '2026-10-08', to: '2026-10-08' })).toBe(false)
    expect(rangeBackwards({ from: '2026-10-08', to: '2026-10-09' })).toBe(false)
    expect(rangeBackwards({ from: '2026-10-09' })).toBe(false)
    expect(rangeBackwards({ to: '2026-10-08' })).toBe(false)
    expect(rangeBackwards({ from: '', to: '2026-10-08' })).toBe(false) // a form's field with no date
  })
})

describe('searchProblem', () => {
  const accounts = [{ id: 2 }]

  it('says a range that runs backwards cannot be searched, in the words of what the reader is doing', () => {
    const backwards = { from: '2026-10-09', to: '2026-10-08' }
    expect(searchProblem(backwards, accounts, [], 'see')).toBe('The “To” date is before the “From” date. Change one of them to see Transactions.')
    expect(searchProblem(backwards, accounts, [], 'save')).toBe('The “To” date is before the “From” date. Change one of them to save Transactions.')
  })

  it('says there is no such Account or Category, and sends the reader to the form', () => {
    expect(searchProblem({ account: 9 }, accounts, [], 'see')).toBe('There is no such Account. Choose one in the form above.')
    expect(searchProblem({ category: 0 }, undefined, undefined, 'save')).toBe('There is no such Category. Choose one in the form above.')
  })

  it('says the range first when both are wrong, and nothing of a search that can be run', () => {
    expect(searchProblem({ account: 9, from: '2026-10-09', to: '2026-10-08' }, accounts, [], 'see')).toContain('before the “From” date')
    expect(searchProblem({ account: 2, from: '2026-10-08', to: '2026-10-09' }, accounts, [], 'see')).toBeNull()
    expect(searchProblem({}, undefined, undefined, 'save')).toBeNull()
  })
})

describe('apiQuery', () => {
  it('asks for nothing but the page when nothing is filtered', () => {
    expect(apiQuery({}, 50)).toEqual({ limit: '50', offset: '0' })
  })

  it('turns each filter into the API parameter for it', () => {
    expect(apiQuery({ account: 2, category: 7, from: '2026-01-01', to: '2026-03-31', q: 'cafe', sort: 'amount', dir: 'asc', page: 3 }, 50)).toEqual({
      accountId: '2',
      categoryId: '7',
      from: '2026-01-01',
      to: '2026-03-31',
      text: 'cafe',
      sort: 'amount',
      dir: 'asc',
      limit: '50',
      offset: '100',
    })
  })

  it('asks for Uncategorised with uncategorised=true, never as a Category', () => {
    expect(apiQuery({ category: 'uncategorised' }, 50)).toEqual({ uncategorised: 'true', limit: '50', offset: '0' })
  })

  it('asks for only Transfers, or for the spending, with transfers=only and transfers=exclude', () => {
    expect(apiQuery({ transfers: 'only' }, 50)).toEqual({ transfers: 'only', limit: '50', offset: '0' })
    expect(apiQuery({ transfers: 'exclude' }, 50)).toEqual({ transfers: 'exclude', limit: '50', offset: '0' })
  })

  it('always says which way to sort when it sorts', () => {
    expect(apiQuery({ sort: 'description' }, 50)).toMatchObject({ sort: 'description', dir: 'asc' })
    expect(apiQuery({}, 50)).not.toHaveProperty('sort')
  })
})

describe('filtersOf and filterQuery', () => {
  it('keep the filters and leave out the sort and the page, so every page and order of a search shares one count', () => {
    const search = { account: 2, category: 7, from: '2026-01-01', to: '2026-03-31', q: 'cafe' } as const
    expect(filtersOf({ ...search, sort: 'amount', dir: 'asc', page: 3 })).toEqual(search)
    expect(filtersOf({ sort: 'amount', page: 2 })).toEqual({})
    expect(filtersOf({ transfers: 'exclude', page: 2 })).toEqual({ transfers: 'exclude' })
    expect(filterQuery({ transfers: 'only' })).toEqual({ transfers: 'only' })
    expect(filterQuery({ ...search, sort: 'amount', page: 3 })).toEqual({ accountId: '2', categoryId: '7', from: '2026-01-01', to: '2026-03-31', text: 'cafe' })
  })
})

describe('exportPath', () => {
  it('carries the filters and leaves out the sort and the page, which the export does not take', () => {
    const path = exportPath({ account: 2, category: 'uncategorised', from: '2026-01-01', to: '2026-03-31', q: 'cafe & bar', sort: 'amount', dir: 'asc', page: 3 })
    const url = new URL(path, 'http://localhost')
    expect(url.pathname).toBe('/api/transactions/export.csv')
    expect(Object.fromEntries(url.searchParams)).toEqual({ accountId: '2', uncategorised: 'true', from: '2026-01-01', to: '2026-03-31', text: 'cafe & bar' })
  })

  it('has no query string when nothing is filtered', () => {
    expect(exportPath({ sort: 'amount', page: 2 })).toBe('/api/transactions/export.csv')
  })

  it('carries the Transfers filter, so the file holds what the list shows', () => {
    expect(exportPath({ transfers: 'only' })).toBe('/api/transactions/export.csv?transfers=only')
    expect(exportPath({ q: 'cafe', transfers: 'exclude', page: 3, sort: 'amount' })).toBe('/api/transactions/export.csv?transfers=exclude&text=cafe')
  })
})
