import { describe, expect, it } from 'vitest'
import { apiQuery, filterQuery, filtersOf, parseTransactionSearch, sortOf, tidy } from './transaction-search'

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
        account: 'abc',
        category: 'everything',
        from: '2026-02-30',
        to: '1999-01-01',
        q: '   ',
        sort: 'bank_memo',
        dir: 'sideways',
        page: 0,
      }),
    ).toEqual({})
    expect(parseTransactionSearch({ account: -1, page: 1.5, category: 0 })).toEqual({})
    expect(parseTransactionSearch({ account: { id: 1 }, q: { text: 'x' }, from: 20260101 })).toEqual({})
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
