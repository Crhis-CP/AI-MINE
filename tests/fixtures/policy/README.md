# Synthetic policy PDF fixtures

Both files are generated locally from elementary PDF objects, Helvetica and the exact English test strings in their text streams. They contain no official document, production data or copied source material. `text.pdf` has two text pages; `empty-page.pdf` has a second page with no text layer. No OCR or semantic correctness is implied.

`scan.pdf`, `text-image.pdf` and `embedded-file.pdf` are made the same way, with a 2 × 2 grey image where a page needs one, for `tests/policy-pdf-text.test.ts` and `tests/policy-catalogue.test.ts`: `scan.pdf` has two scanned pages (an image over the whole page; the same image under the text "Page 2"); `text-image.pdf` has a text page with an image over 44% of it and a text page with a small seal; `embedded-file.pdf` has one text page and one embedded text file. `annex-unlisted.html` is a short synthetic notice whose body names 附件1 and 附件２ while its attachment list links only 附件2.
