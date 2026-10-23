import { isGeneratedKey } from '@/lib/account-key'

/**
 * An Account's heading in a Report: its name, and the bank's number beside it. An Account whose key Fernledger generated, because
 * its bank prints no number, is its name alone: the key is not a number the bank issued and is never shown as one (ADR 0017).
 */
export function AccountHeading({ id, name, accountNumber }: { id: string; name: string; accountNumber: string }) {
  return (
    <h2 id={id} className="text-xl font-semibold print:text-[15pt]">
      {isGeneratedKey(accountNumber) ? (
        name
      ) : (
        <>
          {name} <span className="font-normal">({accountNumber})</span>
        </>
      )}
    </h2>
  )
}
