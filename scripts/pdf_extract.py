"""Read immutable PDFs; persist page text and rendered pages, never claim OCR or visual review."""
import json
import os
import sys
from pathlib import Path
from xml.sax.saxutils import escape


def extract(source, out_dir):
    try:
        import pdfplumber
        import pypdfium2
    except ImportError as exc:
        raise RuntimeError("PDF extraction requires pdfplumber and pypdfium2 in the configured Python runtime") from exc
    out = Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    pages, warnings = [], []
    with pdfplumber.open(source) as document:
        if len(document.pages) > 1000:
            raise ValueError("PDF exceeds the 1000 page extraction limit")
        renderer = pypdfium2.PdfDocument(source)
        for index, page in enumerate(document.pages):
            text = page.extract_text() or ""
            if not text.strip():
                warnings.append(f"Page {index + 1} has no extractable text; OCR is required")
            image_path = out / f"page-{index + 1}.png"
            # 110 DPI is adequate for source inspection and bounds intermediate file size.
            if page.width * page.height * (110 / 72) ** 2 > 30_000_000:
                raise ValueError(f"PDF page {index + 1} exceeds image size limit")
            if not image_path.exists():
                rendered_page = renderer[index]
                bitmap = rendered_page.render(scale=110 / 72)
                bitmap.to_pil().save(str(image_path))
                bitmap.close()
                rendered_page.close()
            pages.append({"page": index + 1, "text": text, "image": str(image_path)})
        renderer.close()
    result = {"pages": pages, "warnings": warnings}
    (out / "extraction.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True))


def render_report(input_path, output_path, font_path):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    if not Path(font_path).is_file():
        raise ValueError("Configured CJK font does not exist")
    try:
        pdfmetrics.registerFont(TTFont("ReportCJK", font_path, subfontIndex=0))
    except Exception as exc:
        raise ValueError("Unable to load configured CJK TrueType font: " + str(exc)) from exc
    styles = {
        "title": ParagraphStyle("Title", fontName="ReportCJK", fontSize=20, leading=28, spaceAfter=20, keepWithNext=True, textColor=colors.black, wordWrap="CJK"),
        "heading": ParagraphStyle("Heading", fontName="ReportCJK", fontSize=14, leading=20, spaceBefore=16, spaceAfter=10, keepWithNext=True, textColor=colors.black, wordWrap="CJK"),
        "paragraph": ParagraphStyle("Body", fontName="ReportCJK", fontSize=10.5, leading=17, spaceAfter=9, wordWrap="CJK"),
        "cell": ParagraphStyle("Cell", fontName="ReportCJK", fontSize=9, leading=14, wordWrap="CJK"),
    }
    story = []
    blocks = json.loads(Path(input_path).read_text(encoding="utf-8"))
    for block in blocks:
        if block["kind"] == "table":
            rows = [[Paragraph(escape(str(cell)).replace("\n", "<br/>"), styles["cell"]) for cell in row] for row in block["rows"]]
            table = Table(rows, colWidths=[105, 85, 325], repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D9D9D9")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF5")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ]))
            story.extend([table, Spacer(1, 12)])
        else:
            story.append(Paragraph(escape(block.get("text", "")).replace("\n", "<br/>"), styles[block["kind"]]))
    doc = SimpleDocTemplate(output_path, pagesize=A4, leftMargin=40, rightMargin=40, topMargin=44, bottomMargin=44, title=blocks[0].get("text", "Literature report"), author="Pi Literature System")
    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont("ReportCJK", 8)
        canvas.drawRightString(A4[0] - 40, 23, str(document.page))
        canvas.restoreState()
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(json.dumps({"output": output_path, "font": font_path}))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 5 and sys.argv[1] == "--report":
            render_report(sys.argv[2], sys.argv[3], sys.argv[4])
        elif len(sys.argv) == 3:
            extract(sys.argv[1], sys.argv[2])
        else:
            raise ValueError("Usage: pdf_extract.py source.pdf output_directory OR --report blocks.json report.pdf font.ttf")
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
