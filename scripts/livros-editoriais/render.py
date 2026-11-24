#!/usr/bin/env python3
"""Diagrama um PDF existente, com conferência de texto e paginação."""
import argparse
from collections import Counter
from html import escape
from itertools import groupby
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata

import pymupdf
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ICONS = {
    "listening": '<path d="M3 14v-3a9 9 0 0 1 18 0v3M3 13h2a2 2 0 0 1 2 2v4H5a2 2 0 0 1-2-2zm18 0h-2a2 2 0 0 0-2 2v4h2a2 2 0 0 0 2-2z"/>',
    "reading": '<path d="M12 6v14m0-14c-3-3-7-3-10-2v14c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2z"/>',
    "writing": '<path d="m4 16-1 5 5-1L21 7l-4-4zm10-10 4 4"/>',
    "speaking": '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 0 1 7-13h2a8 8 0 0 1 8 8zM8 11h.01m4 0h.01m4 0h.01"/>',
    "practice": '<path d="M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4"/>',
}


def icon(label):
    skill = "practice"
    for pattern, name in [
        (r"escuta|listening|pronúncia", "listening"),
        (r"leitura|reading|vocabul|vocab", "reading"),
        (r"fala|speak", "speaking"),
        (r"escrita|writing|project|projeto", "writing"),
    ]:
        if re.search(pattern, label.lower()):
            skill = name
            break
    return ('<svg class="skill" aria-hidden="true" viewBox="0 0 24 24" '
            'fill="none" stroke="currentColor" stroke-width="1.6" '
            f'stroke-linecap="round" stroke-linejoin="round">{ICONS[skill]}</svg>')


def span_html(span):
    value = escape(span["text"])
    if span["flags"] & 16:
        value = f"<strong>{value}</strong>"
    if span["flags"] & 2:
        value = f"<em>{value}</em>"
    return value


def blocks(page, book_title):
    groups = []
    numbers = []
    for block in page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)["blocks"]:
        lines = [line for line in block["lines"] if any(s["text"].strip() for s in line["spans"])]
        if not lines:
            continue
        label = plain(lines)
        # Printed navigation is replaced by this edition's running header and folio.
        if block["bbox"][0] < 17 and block["bbox"][1] < 24 and label == book_title:
            continue
        if block["bbox"][1] > page.rect.height - 28 and (
            label.startswith("Uso em aula pelo professor assinante")
            or label == str(page.number + 1)
        ):
            continue
        if len(lines) == 1 and re.fullmatch(r"\d+[.)]", label):
            numbers.append(lines[0])
        else:
            groups.append(lines)
    for number in numbers:
        y = number["spans"][0]["origin"][1]
        for group in groups:
            for index, line in enumerate(group):
                x1 = number["bbox"][2]
                x2 = line["bbox"][0]
                if -2 < x2 - x1 < 32 and abs(line["spans"][0]["origin"][1] - y) < 2:
                    gap = dict(number["spans"][-1], text=" ")
                    group[index] = dict(line, spans=number["spans"] + [gap] + line["spans"])
                    break
            else:
                continue
            break
        else:
            groups.append([number])
    for index in range(len(groups) - 1, 0, -1):
        previous, current = groups[index - 1:index + 1]
        a, b = previous[-1], current[0]
        x, y = a["spans"][0]["origin"]
        next_x, next_y = b["spans"][0]["origin"]
        size = a["spans"][0]["size"]
        if (
            len(current) == 1 and 0 < next_y - y <= size * 1.65
            and abs(next_x - x) < 1 and abs(b["spans"][0]["size"] - size) < .2
            and not re.match(r"^(?:\d+[.)]|[a-z][.)])(?:\s|$)", plain(current), re.I)
            and not plain(previous).endswith((".", "?", "!", ":", ";"))
        ):
            previous.extend(current)
            groups.pop(index)
    yield from groups


def plain(lines):
    return " ".join("".join(span["text"] for span in line["spans"]).strip() for line in lines)


def line_html(line):
    return "".join(span_html(span) for span in line["spans"])


def as_rows(lines):
    # A vocabulary row may contain several horizontally aligned text runs.
    batches = []
    for line in lines:
        if batches and abs(line["spans"][0]["origin"][1] - batches[-1][-1]["spans"][0]["origin"][1]) < 3:
            batches[-1].append(line)
        else:
            batches.append([line])
    return batches


def content_html(lines, body_size, vocabulary):
    if len(lines) > 1 and any(re.fullmatch(r"\d+[.)]", plain([line])) for line in lines):
        ordered = sorted(lines, key=lambda line: line["spans"][0]["origin"][1])
        groups = as_rows(ordered)
        entries = [
            " ".join(line_html(line) for line in sorted(group, key=lambda line: line["bbox"][0]))
            for group in groups
        ]
        return '<div class="block list-lines">' + "<br>".join(entries) + "</div>"
    rows = as_rows(lines)
    if len(rows[0]) > 1 and all(min(abs(line["bbox"][0] - cell["bbox"][0]) for cell in rows[0]) < 5 for row in rows[1:] for line in row):
        cells = [[line] for line in sorted(rows[0], key=lambda line: line["bbox"][0])]
        for line in (line for row in rows[1:] for line in row):
            cell = min(cells, key=lambda group: abs(group[0]["bbox"][0] - line["bbox"][0]))
            cell.append(line)
        number = re.fullmatch(r"\d+[.)]", plain(cells[0]))
        modifier = " numbered" if number else " vocabulary" if vocabulary else ""
        inner = "".join(f'<span>{" ".join(map(line_html, cell))}</span>' for cell in cells)
        return f'<div class="block row{modifier}">{inner}</div>'
    first = lines[0]["spans"][0]
    text = plain(lines)
    heading = len(text) <= 145 and first["size"] > 1.14 * body_size and bool(first["flags"] & 16)
    exercise = (heading or len(text) <= 130) and bool(
        re.match(r"(exercício|exercise|atividade|activity|task)\s+\d", text, re.I)
    )
    css = " section exercise" if exercise else " section" if heading else ""
    return f'<div class="block{css}">{" ".join(map(line_html, lines))}</div>'


def split_title(lines):
    groups = [
        (size, list(members))
        for size, members in groupby(lines, key=lambda line: round(line["spans"][0]["size"], 1))
    ]
    return plain(groups[0][1]), [plain(members) for _, members in groups[1:]]


def source_title(source):
    cover_title = next(blocks(source[0], ""))
    return split_title(cover_title)[0]


def art(path, position):
    return f'<img class="art" alt="" src="{escape(path.as_uri())}" style="object-position:{position}">'


def create_html(source, theme, inputs, openers, contexts):
    school = theme == "school"
    mark_path = HERE.parents[1] / "public/assets/brand/wise-wolf-mark-trim-20261028.png"
    mark = f'<img alt="Wise Wolf" src="{mark_path.as_uri()}">' if school else ""
    imprint = "Wise Wolf Language" if school else "Uso em aula pelo professor assinante"
    count = len(source)
    css = (HERE / "editorial.css").read_text()
    pages = []
    book_title = source_title(source)
    for number, page in enumerate(source, 1):
        is_cover = number == 1
        is_opener = number in openers
        title_block, *body = blocks(page, book_title)
        title, subtitles = split_title(title_block)
        subtitle = "".join(f'<div class="subheading">{escape(t)}</div>' for t in subtitles)
        size = Counter(round(line["spans"][0]["size"], 1) for group in body for line in group).most_common(1)[0][0]
        vocabulary = bool(re.search("vocabul|vocab", title + subtitle, re.I))
        rendered = [content_html(lines, size, vocabulary) for lines in body]
        content = []
        index = 0
        while index < len(rendered):
            block = rendered[index]
            if block.startswith('<div class="block section') and index + 1 < len(rendered) and len(rendered[index + 1]) < 210:
                content.append(f'<div class="section-start">{block}{rendered[index + 1]}</div>')
                index += 2
            else:
                content.append(block)
                index += 1
        content = "".join(content)
        if number == 1:
            top = f'<div class="cover-brand">{mark}<span>{imprint}</span></div>'
            image = art(inputs / "capa.webp", "center")
            heading = f'<div class="heading"><div><h1>{escape(title)}</h1>{subtitle}</div></div>'
            style = "cover"
        else:
            top = f'<div class="top"><span>{escape(book_title)}</span>{mark}</div>'
            image = art(inputs / openers[number], "center") if is_opener else (
                art(inputs / contexts[number], "center") if number in contexts else ""
            )
            heading = f'<div class="heading">{icon(title + subtitle)}<div><h1>{escape(title)}</h1>{subtitle}</div></div>'
            style = "opener" if is_opener else ""
        if re.search(r"gabarito|answer key", title, re.I):
            style += " key"
        leading = image + heading if is_cover else heading + image
        pages.append(
            f'<section class="sheet {style}">{top}{leading}<div class="columns">{content}</div>'
            f'<footer><span>{imprint}</span><span class="folio">{number:02d} / {count:02d}</span></footer></section>'
        )
    adjust = """<script>
window.fitEditorialPages = () => {
  const overflow = [];
  for (const [index, sheet] of [...document.querySelectorAll('.sheet')].entries()) {
    const content = sheet.querySelector('.columns');
    const bottom = sheet.getBoundingClientRect().bottom - 32;
    const minimum = sheet.classList.contains("key") ? 8.75 : 9.75;
    for (let size = 15; size >= minimum; size -= .25) {
      content.style.fontSize = size + 'px';
      if (sheet.querySelector('footer').getBoundingClientRect().bottom <= bottom) break;
    }
    if (sheet.querySelector('footer').getBoundingClientRect().bottom > bottom) overflow.push([index + 1, Math.round(content.getBoundingClientRect().height), Math.round(sheet.getBoundingClientRect().height), Math.round(sheet.querySelector("footer").getBoundingClientRect().bottom - bottom)]);
  }
  return overflow;
};
</script>"""
    return (
        f'<!doctype html><html lang="en"><meta charset="utf-8"><title>{escape(book_title)}</title>'
        f'<style>{css}</style><body class="{theme}">{"".join(pages)}{adjust}</body></html>'
    )


def characters(value):
    # Work across line wrapping, typographic ligatures, and PDF emoji presentation selectors.
    return Counter(c for c in unicodedata.normalize("NFKC", value) if not c.isspace() and c not in "\ufe0e\ufe0f")


def verify(source, rendered):
    if len(source) != len(rendered):
        raise ValueError(f"Paginação divergente: {len(source)} → {len(rendered)}.")
    book_title = source_title(source)
    for number, (old, new) in enumerate(zip(source, rendered), 1):
        if new.rect.width <= new.rect.height:
            raise ValueError(f"Página {number} em retrato.")
        actual = new.get_text()
        expected = " ".join(plain(block) for block in blocks(old, book_title))
        missing = characters(expected) - characters(actual)
        missing_words = Counter(re.findall(r"[^\W_]+", expected)) - Counter(re.findall(r"[^\W_]+", actual))
        outside = [w[4] for w in new.get_text("words")
                   if w[0] < 15 or w[1] < 10 or w[2] > new.rect.width - 15 or w[3] > new.rect.height - 12]
        if missing or missing_words or outside:
            raise ValueError(
                f"Página {number}: caracteres ausentes {dict(missing)}, "
                f"palavras ausentes {dict(missing_words)}, texto fora da área {outside[:12]}."
            )


def previews(doc, folder):
    scale = 0.41
    columns = 3
    width, height = round(doc[0].rect.width * scale), round(doc[0].rect.height * scale)
    rows = (len(doc) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * (width + 12) + 12, rows * (height + 30) + 12), "#dedbd5")
    ink = ImageDraw.Draw(sheet)
    for index, page in enumerate(doc):
        thumb = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        x = 12 + index % columns * (width + 12)
        y = 12 + index // columns * (height + 30)
        sheet.paste(Image.frombytes("RGB", (thumb.width, thumb.height), thumb.samples), (x, y))
        ink.text((x, y + height + 4), f"{index + 1:02d}", fill="#222222")
    sheet.save(folder / "contato.png")
    doc[0].get_pixmap(dpi=130, alpha=False).save(folder / "previa-capa.png")


def page_art(values):
    return {int(page): name for page, name in (value.split("=", 1) for value in values)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, help="Pasta com capa.webp e as artes da unidade e do contexto")
    parser.add_argument("--theme", choices=("hub", "school"), required=True)
    parser.add_argument("--chromium", required=True)
    parser.add_argument("--puppeteer-module", default="puppeteer-core")
    parser.add_argument("--opener", action="append", required=True, metavar="PÁGINA=ARTE.WEBP")
    parser.add_argument("--context", action="append", required=True, metavar="PÁGINA=ARTE.WEBP")
    opts = parser.parse_args()
    folder = opts.output.resolve()
    openers, contexts = page_art(opts.opener), page_art(opts.context)
    for name in {"capa.webp", *openers.values(), *contexts.values()}:
        with Image.open(folder / name) as photo:
            if photo.format != "WEBP" or photo.width <= photo.height:
                raise ValueError(f"Arte deve ser WebP horizontal: {name}")
    with pymupdf.open(opts.source) as source, tempfile.TemporaryDirectory(prefix="livro-editorial-") as tmp:
        scratch = Path(tmp)
        html = scratch / "livro.html"
        pdf = scratch / "livro.pdf"
        html.write_text(create_html(source, opts.theme, folder, openers, contexts), encoding="utf-8")
        subprocess.run([
            "node", str(HERE / "print.mjs"), str(html), str(pdf), str(scratch / "profile"),
            opts.chromium, opts.puppeteer_module,
        ], check=True, timeout=90)
        with pymupdf.open(pdf) as doc:
            verify(source, doc)
            previews(doc, folder)
            doc.save(folder / "livro.pdf")
            print(f"{opts.theme}: {len(doc)} páginas A4 horizontais")


if __name__ == "__main__":
    main()
