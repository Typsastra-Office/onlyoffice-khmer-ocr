"""What does the reader actually get from select-all, before and after?

U+FFFD is only part of the damage: a broken ToUnicode can also map glyphs to
printable Latin-1 characters, which is what makes the clipboard read as mojibake.
Count Khmer, mojibake and Latin separately, and check that Khmer search and
crisp rendering survive.
"""
import re
import sys
import pymupdf
import pypdfium2

MOJIBAKE = re.compile(r'[ÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿĀāĂăĄąĆćĈĉĊċČčĎďĐđ]')
KHMER = re.compile(r'[\u1780-\u17ff]')


def report(path, label):
    doc = pymupdf.open(path)
    khmer = latin = moji = 0
    for page in doc:
        text = page.get_text()
        khmer += len(KHMER.findall(text))
        latin += len(re.findall(r'[A-Za-z]', text))
        moji += len(MOJIBAKE.findall(text))
    doc.close()

    pdf = pypdfium2.PdfDocument(path)
    sel_all = 0
    fffd = 0
    searchable = 0
    for i in range(len(pdf)):
        tp = pdf[i].get_textpage()
        text = tp.get_text_range(0, tp.count_chars())
        sel_all += len(text)
        fffd += text.count('\ufffd')
        if tp.search('\u1780\u17c1\u1793\u17d4\u17c2\u1798\u179a').get_next():
            searchable += 1
    hit = pdf[4].get_textpage().search(
        '\u1780\u17c1\u1793\u17d4\u17c2\u1798\u179a').get_next()
    pdf.close()

    print(f'{label:14} mupdf_khmer={khmer:6} latin={latin:6} mojibake={moji:6} | '
          f'pdfium_selall={sel_all:7} fffd={fffd:6} searchable_pages={searchable:3} '
          f'page5_khmer_hit={"yes" if hit else "NO"}')


for path, label in ((sys.argv[1], sys.argv[2]), (sys.argv[3], sys.argv[4])):
    report(path, label)