"""Wrap the broken legacy Khmer text in /ActualText, first N pages only.

The preserved original paints its glyphs with text-showing operators whose
/ToUnicode is wrong, so select-all returns garbage alongside the OCR text.
/ActualText overrides extraction for the content it wraps, leaving the glyphs
untouched.

This only inserts bytes around existing BT..ET regions; nothing inside the
original stream is rewritten, so rendering cannot change.
"""
import re
import sys
import pymupdf

SRC = r'C:\Users\Sovichea\AppData\Local\Temp\opencode\priority-plu.pdf'
OUT = r'C:\Users\Sovichea\AppData\Local\Temp\opencode\actualtext-p1-10.pdf'
PAGES = 10

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mmul(m, n):
    a1, b1, c1, d1, e1, f1 = m
    a2, b2, c2, d2, e2, f2 = n
    return (a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
            c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


DELIMS = b'()<>[]{}/%'


def tokenize(data):
    """Yield (start, end, kind, value) skipping comments and string bodies."""
    i, n = 0, len(data)
    while i < n:
        c = data[i:i + 1]
        if c in b' \t\r\n\f\x00':
            i += 1
            continue
        if c == b'%':
            j = data.find(b'\n', i)
            i = n if j < 0 else j + 1
            continue
        if c == b'(':
            depth, i, out = 1, i + 1, bytearray()
            while i < n and depth:
                ch = data[i:i + 1]
                if ch == b'\\':
                    i += 2
                    continue
                if ch == b'(':
                    depth += 1
                elif ch == b')':
                    depth -= 1
                if depth:
                    out += ch
                i += 1
            continue
        if c == b'<':
            j = data.find(b'>', i)
            i = n if j < 0 else j + 1
            continue
        if c == b'/':
            j = i + 1
            while j < n and data[j:j + 1] not in DELIMS and data[j:j + 1] not in b' \t\r\n\f\x00':
                j += 1
            yield i, j, 'name', data[i + 1:j].decode('latin-1')
            i = j
            continue
        if c in DELIMS:
            i += 1
            continue
        j = i
        while j < n and data[j:j + 1] not in DELIMS and data[j:j + 1] not in b' \t\r\n\f\x00':
            j += 1
        word = data[i:j]
        if word.startswith(b'/'):
            yield i, j, 'name', word[1:].decode('latin-1')
            i = j
            continue
        try:
            yield i, j, 'num', float(word)
            i = j
            continue
        except ValueError:
            pass
        yield i, j, 'op', word
        i = j


def bad_font_names(doc, page):
    """Resource names whose /ToUnicode is demonstrably wrong.

    Two failure shapes exist: glyphs mapped to U+FFFD, and glyphs mapped to
    printable Latin-1 / Latin-Extended characters, which is what turns a line
    into mojibake. Both mean the mapping cannot be trusted for extraction.
    """
    bad = set()
    entry_re = re.compile(rb'beginbfchar(.*?)endbfchar', re.S)
    pair_re = re.compile(rb'<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>')
    for entry in page.get_fonts(full=True):
        xref, refname = entry[0], entry[4]
        if 'TypsastraLogical' in refname:
            continue  # our own overlay font is correct by construction
        kind, val = doc.xref_get_key(xref, 'ToUnicode')
        if kind != 'xref':
            continue
        try:
            cmap = doc.xref_stream(int(val.split()[0]))
        except Exception:
            continue
        broken = False
        for block in entry_re.findall(cmap):
            for _, target in pair_re.findall(block):
                try:
                    value = int(target[:4], 16)
                except ValueError:
                    continue
                if value == 0xFFFD or 0x80 <= value <= 0x024F:
                    broken = True
                    break
            if broken:
                break
        if broken:
            bad.add(refname)
    return bad


def ocr_lines(page):
    """OCR overlay lines, with baselines flipped into PDF space (origin bottom)."""
    height = page.rect.height
    out = []
    d = page.get_text('rawdict')
    for block in d['blocks']:
        if 'lines' not in block:
            continue
        for line in block['lines']:
            for span in line['spans']:
                if not span.get('font', '').startswith('TypsastraLogical'):
                    continue
                text = ''.join(c['c'] for c in span.get('chars', []))
                if not text.strip():
                    continue
                out.append({'text': text,
                            'baseline': height - span['origin'][1],
                            'left': span['bbox'][0],
                            'right': span['bbox'][2]})
    return out


def analyse(page):
    """Return [(bt_start, et_end, font_xref_or_None, origin_x, origin_y)]."""
    page_obj = page
    fonts = {}
    for entry in page.get_fonts(full=True):
        fonts.setdefault(entry[3], entry[0])

    runs = []
    tm = tlm = IDENTITY
    ctm = IDENTITY
    stack = []
    font = None
    bt = None
    pending = []
    for start, end, kind, value in tokenize(page.read_contents()):
        if kind == 'num':
            pending.append((start, end, kind, value))
            continue
        if kind == 'name':
            pending.append((start, end, kind, value))
            continue
        op = value
        nums = [v for _, _, k, v in pending if k == 'num']
        if op == b'q':
            stack.append(ctm)
        elif op == b'Q':
            ctm = stack.pop() if stack else IDENTITY
        elif op == b'cm' and len(nums) >= 6:
            ctm = mmul(tuple(nums[-6:]), ctm)
        elif op == b'BT':
            tm = tlm = IDENTITY
            bt = start
        elif op == b'ET':
            if bt is not None:
                runs.append((bt, end, font, *apply(mmul(tm, ctm), 0, 0)))
            bt = None
        elif op == b'Tf':
            names = [v for _, _, k, v in pending if k == 'name']
            if names:
                font = names[-1]
        elif op == b'Tm' and len(nums) >= 6:
            tm = tuple(nums[-6:])
            tlm = tm
        elif op in (b'Td', b'TD') and len(nums) >= 2:
            tlm = mmul((1, 0, 0, 1, nums[-2], nums[-1]), tlm)
            tm = tlm
        elif op == b'T*' and nums:
            tlm = mmul((1, 0, 0, 1, 0, -nums[-1]), tlm)
            tm = tlm
        pending = []
    return runs


def wrap(data, runs, lines, bad_names):
    """Wrap matched legacy runs in /ActualText and drop the duplicate overlay.

    Wrapping alone is not enough: the invisible OCR overlay would still carry
    the same line, so select-all would report it twice. Where the legacy layer
    already draws the line, the overlay is removed instead of kept.
    """
    edits = []
    used = set()
    for bt, et, font, x, y in runs:
        if font not in bad_names:
            continue
        best = None
        for i, line in enumerate(lines):
            if i in used:
                continue
            if abs(line['baseline'] - y) > 3.0:
                continue
            if not (line['left'] - 12 <= x <= line['right'] + 12):
                continue
            best = i
            break
        if best is None:
            continue
        used.add(best)
        text = lines[best]['text']
        hexed = text.encode('utf-16-be').hex().upper()
        edits.append((et, b'\nEMC\n'))
        edits.append((bt, ('/Span << /ActualText <FEFF%s> >> BDC\n' % hexed).encode()))
    if not edits:
        return data, 0, 0

    # Drop the overlay runs that duplicated a wrapped legacy line.
    dropped = 0
    for bt, et, font, x, y in runs:
        if not font or not font.startswith('TypsastraLogical'):
            continue
        for i in used:
            line = lines[i]
            if abs(line['baseline'] - y) <= 3.0 and line['left'] - 12 <= x <= line['right'] + 12:
                edits.append((et, b''))
                edits.append((bt, b''))
                dropped += 1
                break

    out = bytearray()
    prev = 0
    for pos, payload in sorted(edits, key=lambda e: e[0]):
        if pos < prev:
            continue
        out += data[prev:pos]
        out += payload
        prev = pos
    out += data[prev:]
    return bytes(out), len(used), dropped


def main():
    doc = pymupdf.open(SRC)
    for index in range(PAGES):
        page = doc[index]
        bad = bad_font_names(doc, page)
        if not bad:
            continue
        runs = analyse(page)
        lines = ocr_lines(page)
        original = page.read_contents()
        if index < 3:
            print(f'page {index + 1}: bad_fonts={sorted(bad)} '
                  f'legacy_runs={len(runs)} ocr_lines={len(lines)}')
            for r in runs[:4]:
                print('   run font=%r x=%.1f y=%.1f' % (r[2], r[3], r[4]))
            for l in lines[:4]:
                print('   line baseline=%.1f left=%.1f right=%.1f %r'
                      % (l['baseline'], l['left'], l['right'], l['text'][:24]))
        rewritten, n, dropped = wrap(original, runs, lines, bad)
        if not n:
            continue
        xref = doc.get_new_xref()
        doc.update_object(xref, '<<>>')
        doc.update_stream(xref, rewritten, new=True)
        doc.xref_set_key(page.xref, 'Contents', f'{xref} 0 R')
        print(f'page {index + 1}: wrapped {n} legacy runs, dropped {dropped} overlay runs')
    doc.save(OUT)
    print('wrote', OUT)


main()