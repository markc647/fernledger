import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** One run of text on a PDF page: where it sits (points from the page's bottom-left corner) and the size of its type in points. */
export type PdfText = { str: string; x: number; y: number; size: number }
export type PdfPage = { width: number; height: number; text: PdfText[] }

/**
 * A PDF (as `page.pdf()` makes it) read back as the text on each page, so a test can check what a printout really says:
 * page numbers and other words in the page margins, headings repeated on every page, and the size of the type. The page
 * count alone (as e2e/member-pages.spec.ts counts it) says nothing about what is on the pages.
 */
export async function readPdf(pdf: Buffer): Promise<PdfPage[]> {
  const doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise
  const pages: PdfPage[] = []
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number)
    const [, , width, height] = page.view as [number, number, number, number]
    const { items } = await page.getTextContent()
    const text = items.flatMap((item) => ('str' in item && item.str.trim() !== '' ? [{ str: item.str, x: item.transform[4] as number, y: item.transform[5] as number, size: item.height }] : []))
    pages.push({ width, height, text })
  }
  await doc.destroy()
  return pages
}

/** A page's text as one line, runs joined by a space and runs of space collapsed, for "contains" checks. */
export const textOf = (page: PdfPage) => page.text.map((t) => t.str).join(' ').replace(/\s+/g, ' ')
