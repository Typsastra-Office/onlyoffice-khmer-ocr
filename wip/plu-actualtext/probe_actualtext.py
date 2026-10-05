"""Per-character behaviour of /ActualText, with real glyphs inside the span.

The earlier attempt wrapped an empty text object, so nothing was emitted. Here
the span contains a genuine text-showing operator, and a substring in the middle
of the span is selected to see whether ActualText yields per-character text or
only a whole-span string.
"""
import pymupdf
import pypdfium2

LINE = 'ក្នុងរយៈពេលជាងពីរទសវត្សរ៍កន្លះក្រោយទទួលបានសុខសន្តិភាពពេញលេញ'
utf16 = LINE.encode('utf-16-be').hex().upper()

doc = pymupdf.open()
page = doc.new_page(width=700, height=200)
page.insert_text((40, 120), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', fontsize=14)
xrefs = page.get_contents()
body = b''.join(doc.xref_stream(x) for x in xrefs)
print('original stream contains Tj:', b'Tj' in body)

wrapped = (b'/Span << /ActualText <FEFF' + utf16.encode('ascii') + b'> >> BDC\n'
           + body + b'\nEMC\n')
newref = doc.get_new_xref()
doc.update_object(newref, '<<>>')
doc.update_stream(newref, wrapped, new=True)
doc.xref_set_key(page.xref, 'Contents', f'{newref} 0 R')

out = r'C:\Users\Sovichea\AppData\Local\Temp\opencode\at-real.pdf'
doc.save(out)

pdf = pypdfium2.PdfDocument(out)
tp = pdf[0].get_textpage()
total = tp.count_chars()
full = tp.get_text_range(0, total)
print('ActualText span with real glyphs')
print(f'   select-all length -> {total}')
print(f'   select-all        -> {full[:44]!r}')
print(f'   substring [+12:+10] -> {tp.get_text_range(12, 10)!r}')
hit = tp.search('ទសវត្សរ៍').get_next()
print(f'   search inside line  -> {"found at " + str(hit) if hit else "NOT FOUND"}')
pdf.close()