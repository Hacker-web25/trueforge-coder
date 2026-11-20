#!/usr/bin/env bash
# Regenerates writeup.docx and writeup.pdf from writeup.md (needs pandoc, python-docx, LibreOffice).
set -euo pipefail
cd "$(dirname "$0")"
pandoc writeup.md -o writeup.docx
python3 - <<'PY'
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
d = Document('writeup.docx')
for s in d.sections:
    s.left_margin = s.right_margin = Cm(1.8); s.top_margin = s.bottom_margin = Cm(1.5)
def setsz(name, size, bold=None, color=None):
    try:
        st = d.styles[name]; st.font.size = Pt(size); st.font.name = 'Calibri'
        if bold is not None: st.font.bold = bold
        if color: st.font.color.rgb = RGBColor(*color)
        st.paragraph_format.space_before = Pt(6); st.paragraph_format.space_after = Pt(2)
    except KeyError: pass
for n in ['Normal', 'Body Text', 'First Paragraph', 'Compact']: setsz(n, 9.5)
setsz('Heading 2', 12, True, (0x1f, 0x3a, 0x5f)); setsz('Title', 17, True, (0x1f, 0x3a, 0x5f)); setsz('Subtitle', 10.5)
widths = [Cm(3.9), Cm(2.0), Cm(11.5)]
for t in d.tables:
    tblPr = t._tbl.tblPr
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        el = OxmlElement(f'w:{edge}'); el.set(qn('w:val'), 'single'); el.set(qn('w:sz'), '4'); el.set(qn('w:color'), '999999'); borders.append(el)
    tblPr.append(borders)
    t.autofit = False
    grid = t._tbl.tblGrid
    for gc, w in zip(grid.findall(qn('w:gridCol')), widths):
        gc.set(qn('w:w'), str(int(w.twips)))
    tw = OxmlElement('w:tblW'); tw.set(qn('w:w'), str(int(sum(w.twips for w in widths)))); tw.set(qn('w:type'), 'dxa')
    for old in tblPr.findall(qn('w:tblW')): tblPr.remove(old)
    tblPr.append(tw)
    lay = OxmlElement('w:tblLayout'); lay.set(qn('w:type'), 'fixed'); tblPr.append(lay)
    for row in t.rows:
        for i, c in enumerate(row.cells):
            c.width = widths[i]
            for p in c.paragraphs:
                p.paragraph_format.space_after = Pt(1); p.paragraph_format.space_before = Pt(1)
                for r in p.runs: r.font.size = Pt(8.5)
    for c in t.rows[0].cells:
        for p in c.paragraphs:
            for r in p.runs: r.font.bold = True
d.save('writeup.docx')
PY
soffice --headless --convert-to pdf writeup.docx >/dev/null 2>&1
pdfinfo writeup.pdf | grep Pages
