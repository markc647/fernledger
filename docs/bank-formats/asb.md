# ASB CSV export

This is the layout of ASB's internet-banking CSV export, which the `asb` adapter parses. Every value below is made up and uses bank code 99. Never copy a real export into this repo.

```text
Created date / time : 2 October 2026 / 18:55:26
Bank 99; Branch 9999; Account 9999999-99 (Savings Example)
From date 20191002
To date 20261002
Avail Bal : 5593.97 as of 20260930
Ledger Balance : 5593.97 as of 20261002
Date,Unique Id,Tran Type,Cheque Number,Payee,Memo,Amount

2019/10/31,2019103101,INT,,"ASB BANK - INTEREST","CR.INT TO 31/10/2019 ",1.20
2019/10/04,2019100401,EFTPOS,,"EXAMPLE CAFE TOWN","EFTPOS",-8.20
2019/10/02,2019100201,TFR IN,,"","ROUND UP",0.92
```

## Header lines

| Line | Content | Used for |
|---|---|---|
| 1 | Export timestamp | Ignored |
| 2 | Bank, branch, account number and suffix, then the account's name in brackets | Matching the Account |
| 3–4 | From / To dates (`YYYYMMDD`) | The file's date range. The To date is the default Cutover Date |
| 5 | Available balance | Ignored |
| 6 | **Ledger balance** and its date | Balance history and the Balance Check |
| 7 | Column header | Format detection |
| 8 | Blank | |

## Rows
- `Date` is `YYYY/MM/DD`. There's no time of day, so a Bank Time is never set from this file.
- `Unique Id` is the date plus a 2-digit daily sequence. It's unique within an Account, and Import uses it to recognise rows already held and to carry Overrides and Notes over when imported history is replaced. A day the bank numbers differently in a later export can match a different Transaction, so the Import counts the carried Overrides and Notes that went to a Transaction with a different amount ([README](../../README.md#how-it-works)).
- `Payee` and `Memo` are quoted, may be empty (`""`), and may have trailing spaces.
- `Amount` is a signed decimal with no thousands separator. Money out is negative.
- Transfers between the holder's own ASB accounts appear as `TFR OUT` on one Account and `TFR IN` on the other, on the same date.
