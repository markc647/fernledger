/** One Transaction row from a bank CSV. Dates are ISO `YYYY-MM-DD` NZ dates; money is integer NZD cents. */
export interface BankCsvRow {
  date: string
  /** The bank's own unique ID for the row. */
  uniqueId: string
  tranType: string
  chequeNumber: string | null
  payee: string
  memo: string
  amountCents: number
}

/** A row that could not be parsed. `line` is 1-based in the original file text. */
export interface BankCsvRowError {
  line: number
  message: string
}

export interface BankCsvResult {
  /** Id of the adapter that parsed the file. */
  bank: string
  /** Normalised `BB-bbbb-AAAAAAA-SS`. */
  accountNumber: string
  ledgerBalance: { cents: number; date: string }
  /** The date range the file covers. */
  dateRange: { from: string; to: string }
  rows: BankCsvRow[]
  errors: BankCsvRowError[]
}

/** The file as a whole is unusable: unknown format or a damaged header. */
export class BankCsvError extends Error {
  readonly line?: number
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `Line ${line}: ${message}`)
    this.name = 'BankCsvError'
    this.line = line
  }
}

export interface BankCsvAdapter {
  id: string
  name: string
  /** True if the file text looks like this bank's export. Must not throw. */
  detect(text: string): boolean
  /** Throws `BankCsvError` if the header is unusable; bad rows go in `errors`. */
  parse(text: string): BankCsvResult
}
