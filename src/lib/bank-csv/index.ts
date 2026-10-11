import { asbAdapter } from './asb'
import { BankCsvError, type BankCsvAdapter, type BankCsvResult } from './types'

export * from './types'

/** Add a bank by writing an adapter and listing it here. */
export const adapters: readonly BankCsvAdapter[] = [asbAdapter]

/** Picks the adapter by detecting the file's header, then parses. Throws `BankCsvError` for unknown or damaged files. */
export function parseBankCsv(text: string, registry: readonly BankCsvAdapter[] = adapters): BankCsvResult {
  const adapter = registry.find((a) => a.detect(text))
  if (!adapter) {
    const known = registry.map((a) => a.name).join(', ')
    throw new BankCsvError(`Unrecognised bank file format. Supported formats: ${known}.`)
  }
  return adapter.parse(text)
}
