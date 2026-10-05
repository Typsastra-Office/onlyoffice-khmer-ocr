"""Measure the 10-page ActualText artifact before handing it over."""
import pymupdf
import pypdfium2

BASE = r'C:\Users\Sovichea\AppData\Local\Temp\opencode\priority-plu.pdf'
NEW = r'C:\Users\Sovichea\AppData\Local\Temp\opencode\actualtext-p1-10.pdf'


def overlay_lines(path, index):
    doc = pymupdf.open(path)
    out = []
    for block in doc[index].get_text('rawdict')['blocks']:
        if 'lines' not in block:
            continue
        for line in block['lines']:
            for span in line['spans']:
                if span.get('font', '').startswith('TypsastraLogical'):
                    text = ''.join(c['c'] for c in span.get('chars', []))
                    if text.strip():
                        out.append(text)
    doc.close()
    return out


def selall(path, index):
    pdf = pypdfium2.PdfDocument(path)
    tp = pdf[index].get_textpage()
    text = tp.get_text_range(0, tp.count_chars())
    pdf.close()
    return text


src = pymupdf.open(BASE)
new = pymupdf.open(NEW)
for index in range(10):
    same = src[index].get_pixmap(matrix=pymupdf.Matrix(2, 2)).samples == \
        new[index].get_pixmap(matrix=pymupdf.Matrix(2, 2)).samples
    before, after = selall(BASE, index), selall(NEW, index)
    lines = overlay_lines(BASE, index)
    dupes = [t for t in lines if after.count(t) > 1]
    print(f'page {index + 1:2}: selall {len(before):5} -> {len(after):5}  '
          f'FFFD {before.count(chr(0xfffd)):4} -> {after.count(chr(0xfffd)):4}  '
          f'dup_lines {len(dupes):3}  pixels_identical={same}')
src.close()
new.close()