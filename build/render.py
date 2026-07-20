#!/usr/bin/env python3
"""Render a Markdown file to a clean, print-ready PDF.

Pure-Python pipeline (no Chromium, no LaTeX, no system libs):
    markdown (+pygments) -> styled HTML -> xhtml2pdf (pisa) -> PDF

Usage: python3 render.py INPUT.md OUTPUT.pdf "Document Title"
"""
import sys
import markdown
from xhtml2pdf import pisa

CSS = """
@page {
  size: a4 portrait;
  margin: 2.0cm 1.7cm 2.0cm 1.7cm;
  @frame footer_frame {
    -pdf-frame-content: footerContent;
    bottom: 1.0cm; margin-left: 1.7cm; margin-right: 1.7cm; height: 1cm;
  }
}
body { font-family: Helvetica, sans-serif; font-size: 9.6pt; line-height: 1.42; color: #1a1a1a; }
h1 { font-size: 19pt; color: #0b3d2e; page-break-before: always; border-bottom: 2pt solid #0b3d2e;
     padding-bottom: 4pt; margin: 0 0 10pt 0; -pdf-outline: true; -pdf-outline-level: 0; }
h1.nobreak, h1#cover { page-break-before: avoid; border-bottom: none; }
h2 { font-size: 13.5pt; color: #0b3d2e; margin: 16pt 0 5pt 0; -pdf-outline: true; -pdf-outline-level: 1; -pdf-keep-with-next: true; }
h3 { font-size: 11pt; color: #205072; margin: 12pt 0 4pt 0; -pdf-outline: true; -pdf-outline-level: 2; -pdf-keep-with-next: true; }
h4 { font-size: 9.8pt; color: #205072; margin: 9pt 0 3pt 0; -pdf-keep-with-next: true; }
p  { margin: 0 0 6pt 0; }
a  { color: #205072; text-decoration: none; }
ul, ol { margin: 0 0 6pt 0; padding-left: 16pt; }
li { margin: 0 0 2pt 0; }
strong { color: #111; }
code { font-family: Courier, monospace; font-size: 8.6pt; background-color: #f0f2f0; color: #b3005c; padding: 0 2pt; }
pre { background-color: #f6f8f6; border: 0.6pt solid #d2dcd6; border-left: 2.5pt solid #0b3d2e;
      padding: 6pt 8pt; margin: 4pt 0 8pt 0; font-family: Courier, monospace; font-size: 8.2pt;
      line-height: 1.28; page-break-inside: avoid; }
pre code { background-color: transparent; color: #1a1a1a; padding: 0; font-size: 8.2pt; }
.codehilite { background-color: #f6f8f6; border: 0.6pt solid #d2dcd6; border-left: 2.5pt solid #0b3d2e;
      padding: 6pt 8pt; margin: 4pt 0 8pt 0; page-break-inside: avoid; }
.codehilite pre { background-color: transparent; border: none; padding: 0; margin: 0; }
blockquote { margin: 4pt 0 8pt 0; padding: 3pt 9pt; background-color: #fff8e6;
      border-left: 2.5pt solid #d9a400; color: #3a3320; }
table { border-collapse: collapse; margin: 5pt 0 9pt 0; width: 100%; }
th { background-color: #0b3d2e; color: #ffffff; font-size: 8.4pt; padding: 4pt 5pt; text-align: left; }
td { border: 0.5pt solid #c8d2cc; font-size: 8.2pt; padding: 3pt 5pt; vertical-align: top; }
tr { -pdf-keep-with-next: false; }
hr { border: none; border-top: 0.5pt solid #c8d2cc; margin: 10pt 0; }
#footerContent { color: #8a8a8a; font-size: 7.5pt; text-align: center; }
/* cover */
#cover { font-size: 30pt; margin-top: 5cm; text-align: center; color: #0b3d2e; border: none; }
.subtitle { text-align: center; font-size: 12pt; color: #205072; margin-top: 6pt; }
.covermeta { text-align: center; font-size: 9pt; color: #777; margin-top: 28pt; }
.toc-title { page-break-before: always; }
"""

def main():
    src, out, title = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "Document")
    with open(src, "r", encoding="utf-8") as f:
        text = f.read()
    body = markdown.markdown(
        text,
        extensions=["extra", "fenced_code", "tables", "sane_lists", "toc",
                    "codehilite", "admonition"],
        extension_configs={"codehilite": {"noclasses": True, "pygments_style": "friendly",
                                          "guess_lang": False}},
    )
    html = (
        "<html><head><meta charset='utf-8'><style>" + CSS + "</style></head><body>"
        "<div id='footerContent'>" + title + " &middot; page <pdf:pagenumber> of <pdf:pagecount></div>"
        + body + "</body></html>"
    )
    with open(out, "w+b") as f:
        status = pisa.CreatePDF(html, dest=f, encoding="utf-8")
    if status.err:
        print("PDF generation had errors:", status.err); sys.exit(1)
    print("OK wrote", out)

if __name__ == "__main__":
    main()
