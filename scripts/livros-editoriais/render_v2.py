#!/usr/bin/env python3
"""Recompõe os dois livros-piloto em A4 horizontal, com paginação editorial."""
import argparse
from collections import Counter
from html import escape
import json
from pathlib import Path
import re
import subprocess
import tempfile

import pymupdf
from PIL import Image, ImageDraw

from render import HERE, as_rows, characters, icon, source_title, span_html, split_title

SCHOOL_TABLES = {
    3: ((11, 20),),
    5: ((4, 17),),
    6: ((15, 20),),
    8: ((14, 19),),
    9: ((16, 25),),
    10: ((5, 11), (17, 21)),
    11: ((6, 10),),
    13: ((17, 22),),
    14: ((15, 21), (27, 32), (37, 42)),
}
NUMBER = re.compile(r"^\d+[.)]$")
STEP = re.compile(r"^\d{1,2}(?:\s*[–/-]\s*\d{1,2}|\+)?$")
EXERCISE = re.compile(
    r"^(?:(?:[\W_]+ )?(?:Exercise|Exercício|Atividade|Tarefa)\s*(?:\d+\b|[A-E]\s*[—:-]|de recuperação)"
    r"|Parte [A-D] —|Prática controlada\b)", re.I,
)
ANSWER = re.compile(r"^(?:Page|Página) \d+\s*[·—]", re.I)
ANSWER_EXERCISE = re.compile(r"^(?:Exercício|Ex\.)\s*\d+\s*[—:-]\s*[^\W\d_][^:]{2,47}:?\s*$", re.I)
ANSWER_PART = re.compile(r"^(?:Part|Parte) [A-D1-9](?:$|\s*[:—-])", re.I)
TOPIC = re.compile(
    r"^(?:Listening Script|Script de Escuta|Roteiro de escuta|Resultado|Pronúncia —|"
    r"Linguagem (?:útil|de apoio)|Suporte para planejamento|Apoio para o planejamento|"
    r"Etapa \d|Autoavaliação|Estratégias de comunicação|Como as habilidades trabalham juntas|"
    r"Opções de colaboração|Entregas (?:do projeto|obrigatórias)|Comece assim|Estrutura sugerida|Watch out|Rotina(?=:)|"
    r"Área \d|Parte \d|Parte [A-D] —|Self[- ]check|Quick retrieval|Retrieval activity|"
    r"Atividade Rápida|Tarefas de Compreensão|Phrasal Verb Glossary|Project Stages)\b", re.I,
)
TABLE_HEADER = re.compile(
    r"^(?:Expressão|Estrutura|Verbo(?: \(base\))?|Pronome|Palavra(?: / Expressão)?|"
    r"Critério|Função|Situação|Singular|Categoria|Cumprimentos e despedidas|"
    r"#|Q|Afirmação|Item|Nº|Parte|Coluna A|A\s*[—-]\s*Expressão|Exercício / Item|Ponto gramatical)$", re.I,
)
TIP = re.compile(r"^(?:[💡⚠⭐✅️ ]*)(?:Common errors|Erros comuns|Exemplo de início|Reciclar vocabulário)", re.I)
GOALS = re.compile(r"^(?:[✅️ ]*)(?:Your goals|Can-do goals|Can-do outcomes)", re.I)
BODY = " ".join


def normalize(text):
    return re.sub(r"(?<=\w)-\s+(?=[a-z])", "-", text.replace("Nominalisatio n", "Nominalisation"))


def words(text):
    return Counter(re.findall(r"[^\W_]+", normalize(text)))


def line_text(line):
    return "".join(span["text"] for span in line["spans"])


def block_text(lines):
    return normalize(BODY(line_text(line).strip() for line in lines))


def runs(lines):
    markup = normalize(BODY("".join(span_html(span) for span in line["spans"]).strip() for line in lines))
    pronunciation = re.sub(r"(?<![\w/])/[^/<>\s]+/(?![\w/])", lambda m: f'<span class="phonetic">{m[0]}</span>', markup)
    return re.sub(r"\b[A-Za-z]+(?:/[A-Za-z]+){2,}\b[.,?!;:]?", lambda m: f'<span class="phonetic">{m[0]}</span>', pronunciation)


def source_groups(page, title):
    for block in page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)["blocks"]:
        lines = [line for line in block["lines"] if line_text(line).strip()]
        if not lines:
            continue
        label = block_text(lines)
        x, y, _, _ = block["bbox"]
        if x < 18 and y < 24 and title and (
            label == title or label.startswith((title + ":", title + " "))
            or label.casefold().replace(" and ", " & ") == title.casefold()
            or re.fullmatch(re.escape(title) + r"\s+[ABC][12]", label)
        ):
            continue
        if y > page.rect.height - 28 and (
            label.startswith("Uso em aula pelo professor assinante") or label == str(page.number + 1)
        ):
            continue
        if y > page.rect.height - 4 and x < 18 and len(lines) > 2 and (
            line_text(lines[-1]).strip() == str(page.number + 1)
            and all(len(line_text(line).strip()) == 1 for line in lines[:-1])
        ):
            continue
        yield lines


def is_answer_heading(group):
    label = re.sub(r"^[^\w]+", "", block_text(group))
    return bool(ANSWER.match(label) or ANSWER_PART.match(label))


def table_rows(groups):
    header = sorted(groups[0], key=lambda line: line["bbox"][0])
    starts = [line["bbox"][0] for line in header]
    rows = [[runs([line]) for line in header]]
    baselines = []
    for group in groups[1:]:
        row_top = group[0]["spans"][0]["origin"][1]
        if not baselines or abs(row_top - baselines[-1]) > 3:
            rows.append([[] for _ in header])
            baselines.append(row_top)
        for line in group:
            x = line["bbox"][0]
            col = min(range(len(starts)), key=lambda i: abs(starts[i] - x))
            rows[-1][col].append(line)
    return [rows[0], *[[runs(cell) for cell in row] for row in rows[1:]]]


def table_markup(rows):
    def row(cells, tag):
        return "<tr>" + "".join(f"<{tag}>{blank_lines(cell)}</{tag}>" for cell in cells) + "</tr>"
    return (
        '<div class="table-card"><table><thead>' + row(rows[0], "th") +
        "</thead><tbody>" + "".join(row(cells, "td") for cells in rows[1:]) +
        "</tbody></table></div>"
    )


def item_markup(lines):
    ordered = sorted(lines, key=lambda line: line["spans"][0]["origin"][1])
    items = []
    for row in as_rows(ordered):
        visual = sorted(row, key=lambda line: line["bbox"][0])
        number = None
        fragments = []
        for line in visual:
            if NUMBER.fullmatch(block_text([line])):
                number = runs([line])
            else:
                fragments.append(runs([line]))
        if number or not items:
            items.append((number, fragments))
        else:
            items[-1][1].extend(fragments)
    return "".join(
        f'<div class="numbered"><b>{number}</b><span>{BODY(fragments)}</span></div>'
        if number else f'<div>{BODY(fragments)}</div>'
        for number, fragments in items
    )


def plain_html(lines):
    if any(NUMBER.fullmatch(line_text(line).strip()) for line in lines):
        return item_markup(lines)
    if len(lines) > 1 and len(as_rows(sorted(lines, key=lambda line: line["spans"][0]["origin"][1]))) == 1:
        return " · ".join(runs([line]) for line in sorted(lines, key=lambda line: line["bbox"][0]))
    if len(lines) > 1 and all(line_text(line).lstrip().startswith('"') for line in lines):
        return "<br>".join(runs([line]) for line in lines)
    return runs(lines)


def blank_lines(markup):
    def ruled(match):
        blank, punctuation = match.groups()
        line = f'<span class="blank" style="--length:{min(len(blank), 12)}em"></span>'
        return f'<span class="ruled-answer">{line}{punctuation}</span>'
    return re.sub(r"(_{3,})([.,?!:]?)", ruled, markup)


def merged_paragraphs(raw):
    result = []
    for group in raw:
        if result and len(group) == 1 and not NUMBER.fullmatch(block_text(group)):
            prev = result[-1][-1]
            x, y = prev["spans"][0]["origin"]
            line = group[0]
            nx, ny = line["spans"][0]["origin"]
            size = prev["spans"][0]["size"]
            if (
                (abs(x - nx) < 1 or (abs(x - nx) < 22 and len(line_text(line).split()) <= 3
                    and line_text(prev).endswith(" "))) and 0 < ny - y < size * 1.8
                and not ANSWER.match(block_text(group))
                and (line_text(prev).endswith(" ") or (
                    len(line_text(line).split()) <= 3 and line_text(line).lstrip()[:1].islower()
                    and not line_text(prev).rstrip().endswith((".", "!", "?", ":"))
                ))
                and abs(size - line["spans"][0]["size"]) < .22
                and not any(NUMBER.fullmatch(line_text(l).strip()) for l in result[-1])
            ):
                result[-1].extend(group)
                continue
        result.append(group.copy())
    return result


def attach_list_numbers(raw):
    groups = [group.copy() for group in raw]
    omit = set()
    for index, group in enumerate(groups):
        if len(group) != 1 or not NUMBER.fullmatch(line_text(group[0]).strip()):
            continue
        marker = group[0]
        x, y = marker["spans"][0]["origin"]
        candidates = []
        for j in range(max(0, index - 8), min(len(groups), index + 5)):
            if j == index or j in omit:
                continue
            target = groups[j][0]
            tx, ty = target["spans"][0]["origin"]
            if 4 < tx - x < 34 and abs(ty - y) < 2 and not NUMBER.fullmatch(line_text(target).strip()):
                candidates.append((abs(ty - y), tx - x, abs(index - j), j))
        if candidates:
            target = min(candidates)[-1]
            if target < index and all(
                len(groups[j]) <= 3 and abs(groups[j][0]["bbox"][0] - groups[target][0]["bbox"][0]) < 2
                for j in range(target + 1, index)
            ):
                for j in range(target + 1, index):
                    groups[target].extend(groups[j])
                    omit.add(j)
            groups[target].append(marker)
            omit.add(index)
    return [group for index, group in enumerate(groups) if index not in omit]


def keep_together(units):
    return '<div class="keep-together">' + "".join(units) + "</div>"


def group_markup(raw, size, key):
    separated = []
    for group in raw:
        start = 0
        for i, line in enumerate(group):
            value = line_text(line).strip()
            label = re.sub(r"^[^\w]+", "", value)
            split = (
                (key and (ANSWER.match(label) or ANSWER_PART.match(label) or ANSWER_EXERCISE.match(label)))
                or STEP.fullmatch(value) or TOPIC.match(label)
            )
            if split and i > start:
                separated.append(group[start:i])
                start = i
        separated.append(group[start:])
    groups = merged_paragraphs(attach_list_numbers(separated))
    pending = []
    header = ""
    kind = "prose"

    def flush():
        if not header and not pending:
            return None
        body = "".join(pending)
        if kind == "exercise" and "class=\"blank\"" not in body:
            body += '<div class="response" aria-hidden="true"></div>'
        return f'<article class="unit-card {kind}">{header}{body}</article>'

    for group in groups:
        text = block_text(group)
        label = re.sub(r"^[^\w]+", "", text)
        standalone_marker = STEP.fullmatch(text) or NUMBER.fullmatch(text)
        mark = "answer" if key and (ANSWER.match(label) or ANSWER_PART.match(label) or ANSWER_EXERCISE.match(label)
                                   or re.match(r"^Exercício \d.+:\s*$", label, re.I)) else ""
        if not key:
            if EXERCISE.match(text) or re.match(r"^(Prática controlada|Atividade de (recordação|fixação)|Atividade \d|[A-D] — Compreensão)", label, re.I):
                mark = "exercise"
            elif TOPIC.match(label):
                mark = "topic"
            elif TIP.match(text):
                mark = "tip"
            elif GOALS.match(text):
                mark = "goals"
            elif (group[0]["spans"][0]["size"] >= size * 1.17 and len(text) < 140
                  and group[0]["spans"][0]["flags"] & 16
                  and not standalone_marker
                  and not (kind == "exercise" and label.casefold() in {"verbos", "substantivos"})
                  and not re.match(r"^(Coluna [AB]|Tarefa de escuta|Perguntas de Escuta|Perguntas sobre o script)\b", label, re.I)) or re.search(r"Critérios de sucesso", text):
                mark = "topic"
        if mark:
            prefix = pending.pop() if pending and 'class="para step-marker"' in pending[-1] else ""
            item = flush()
            if item:
                yield item
            pending = []
            kind = mark
            badge = ""
            if mark == "exercise":
                number = re.search(r"\d+|(?<=Parte )[A-D]", text)
                badge = '<span class="exercise-number" aria-hidden="true">' + (number[0] if number else "✎") + "</span>"
            elif mark in {"tip", "goals"} and not text.startswith(("⚠", "💡", "⭐", "🌟", "✅")):
                badge = '<span class="mini-icon" aria-hidden="true">' + ("!" if mark == "tip" else "✓") + "</span>"
            header = f'{prefix}<h3>{badge}<span>{plain_html(group)}</span></h3>'
        else:
            markup = plain_html(group)
            if not key:
                markup = blank_lines(markup)
            if standalone_marker:
                pending.append(f'<div class="para step-marker">{markup}</div>')
            else:
                if pending and 'class="para step-marker"' in pending[-1]:
                    marker = pending.pop()
                    pending.append(f'<div class="para keep-together">{marker}{markup}</div>')
                else:
                    pending.append(f'<div class="para">{markup}</div>')
            if not header and kind == "prose" and not standalone_marker:
                item = flush()
                if item:
                    yield item
                pending = []
    item = flush()
    if item:
        yield item


def school_adjust(page, before):
    if page == 14:
        start = next(i for i, group in enumerate(before) if block_text(group).startswith("Página 5 —"))
        before[start+1:start+11] = [
            before[i] + before[i+1] for i in range(start + 1, start + 11, 2)
        ]
    return before


def grouped_section(page_number, raw, school, key):
    body = raw[1:]
    size = Counter(round(l["spans"][0]["size"], 1) for group in body for l in group).most_common(1)[0][0]
    if school and page_number in SCHOOL_TABLES:
        units = []
        first = 1
        for start, end in SCHOOL_TABLES[page_number]:
            before = school_adjust(page_number, raw[first:start]) if page_number == 14 and first == 1 else raw[first:start]
            units.extend(group_markup(before, size, key))
            rows = table_rows(raw[start:end])
            previous = units.pop() if units else ""
            groups = [rows[1:7], rows[7:]] if len(rows) > 9 else [rows[1:]]
            for group in groups:
                table = table_markup([rows[0], *group])
                units.append(f'<div class="table-bundle">{previous}{table}</div>')
                previous = ""
            first = end
        if page_number == 3:
            for start, end in [(20, 23), (23, 26), (26, 29), (29, 31)]:
                label = runs(raw[start])
                copy = runs([line for chunk in raw[start + 1:end] for line in chunk])
                units.append(f'<article class="unit-card topic"><h3>{label}</h3><p class="para">{copy}</p></article>')
        elif page_number == 10:
            units.append(keep_together([
                f'<article class="unit-card topic"><h3>{runs(raw[21])}</h3>' +
                "".join(
                    f'<div class="goal-row"><b>{runs(raw[j])} · {runs(raw[j + 1])}</b>'
                    f'<p>{runs(raw[j + 2])}</p></div>'
                    for j in (22, 25, 28, 31)
                ) + "</article>"
            ]))
        elif page_number == 11:
            left = "".join(f'<div>{item_markup(g)}</div>' for g in raw[13:18])
            right = "".join(f'<div>{runs([line])}</div>' for line in raw[19])
            units.append(
                f'<article class="unit-card exercise"><h3>{runs(raw[10])}</h3><p>{runs(raw[11])}</p>'
                f'<div class="pairing"><div><b>{runs(raw[12])}</b>{left}</div>'
                f'<div><b>{runs(raw[18])}</b>{right}</div></div></article>'
            )
            units.extend(group_markup(raw[20:], size, key))
        else:
            units.extend(group_markup(raw[first:], size, key))
        return units
    if school and page_number == 4:
        card = f'<article class="unit-card goals"><h3>{runs(raw[3])}</h3>'
        for first in (4, 6, 8):
            card += f'<div class="goal-row"><b>{runs(raw[first])}</b><p>{runs(raw[first + 1])}</p></div>'
        return [*group_markup(raw[1:3], size, key), card + "</article>", *group_markup(raw[10:], size, key)]
    if school and page_number == 7:
        reading, listening, reading_title = raw[1]
        dialogue = "".join(
            f'<div class="dialogue-turn"><b>{runs(raw[j])}</b><p>{runs(raw[j + 1])}</p></div>'
            for j in range(15, len(raw), 2)
        )
        script = (f'<article class="unit-card topic"><div>{runs([listening])}</div><h3>{runs(raw[11])}</h3>'
                  f'<p>{runs(raw[12])}</p>{dialogue}</article>')
        return [
            *group_markup([[reading], [reading_title], *raw[2:11]], size, key),
            keep_together([script]), *group_markup(raw[13:15], size, key),
        ]
    if not school and page_number == 11:
        stages = []
        for start, end in ((23, 26), (26, 30), (30, 32), (32, 35)):
            heading = re.sub(r"^(\d+)\s+", r"\1 · ", block_text(raw[start]))
            copy = runs([line for chunk in raw[start + 1:end] for line in chunk])
            stages.append(f'<div class="goal-row"><b>{escape(heading)}</b><p>{copy}</p></div>')
        section = f'<article class="unit-card topic"><h3>{runs(raw[22])}</h3>{"".join(stages)}</article>'
        return [*group_markup(raw[1:22], size, key), keep_together([section]), *group_markup(raw[35:], size, key)]
    return list(group_markup(body, size, key))


def detected_tables(page, raw, key=False):
    tables = page.find_tables(strategy="lines_strict").tables
    ranges = []
    for table in tables:
        if table.row_count < 2 or table.col_count < 2:
            continue
        box = pymupdf.Rect(table.bbox)
        indices = [
            index for index, group in enumerate(raw)
            if all(box.contains(pymupdf.Point(line["spans"][0]["origin"])) for line in group)
        ]
        if not indices or indices != list(range(indices[0], indices[-1] + 1)):
            continue
        if key and any(is_answer_heading(raw[index]) for index in indices):
            continue
        rows = []
        for row in table.rows:
            cells = []
            for bounds in row.cells:
                if bounds is None:
                    cells.append("")
                    continue
                cell = pymupdf.Rect(bounds)
                lines = [
                    line for index in indices for line in raw[index]
                    if cell.contains(pymupdf.Point(line["spans"][0]["origin"]))
                ]
                cells.append(runs(lines))
            rows.append(cells)
        if len(rows) > 1 and any(rows[0]) and any(any(row) for row in rows[1:]):
            ranges.append((indices[0], indices[-1] + 1, rows))
    # Some Gamma tables use shaded cards without visible rules.
    occupied = {i for a, b, _ in ranges for i in range(a, b)}
    for i, group in enumerate(raw):
        label = re.sub(r"^[^\w#]+", "", line_text(group[0]).strip())
        if i in occupied or len(group) < 2 or not TABLE_HEADER.fullmatch(label):
            continue
        top = group[0]["spans"][0]["origin"][1]
        cols = [line["bbox"][0] for line in group if abs(line["spans"][0]["origin"][1] - top) < 3]
        if len(cols) < 2 or min(b - a for a, b in zip(cols, cols[1:])) < 25:
            continue
        end = i + 1
        last_y = top
        while end < len(raw) and end not in occupied:
            row = raw[end]
            if (key and is_answer_heading(row)) or (
                len(row) > 1 and TABLE_HEADER.fullmatch(line_text(row[0]).strip())
                and row[0]["spans"][0]["flags"] & 16
            ):
                break
            x, y = row[0]["spans"][0]["origin"]
            column = min(range(len(cols)), key=lambda c: abs(cols[c] - x))
            if (not -1 < y - last_y <= 56 or abs(x-cols[column]) > 6
                or not all(min(abs(l["bbox"][0] - x0) for x0 in cols) < 7
                           or line_text(l).strip() in {"+", "="} for l in row)):
                break
            end += 1
            last_y = max(line["spans"][0]["origin"][1] for line in row if line["spans"])
            if end < len(raw) and abs(raw[end][0]["spans"][0]["origin"][1] - y) < 3:
                last_y = y
        rows = table_rows(raw[i:end])
        if len(rows) > 2:
            ranges.append((i, end, rows))
            occupied.update(range(i, end))
    return sorted(ranges, key=lambda match: match[0])


def wave_section(page, raw, key):
    size = Counter(round(l["spans"][0]["size"], 1) for unit in raw[1:] for l in unit).most_common(1)
    size = size[0][0] if size else 10
    units = []
    start = 1
    for left, right, rows in detected_tables(page, raw, key):
        if left < start:
            continue
        units.extend(group_markup(raw[start:left], size, key))
        leader = units.pop() if units and re.search(r'<article class="unit-card (answer|topic|exercise|tip)">', units[-1]) else ""
        for i in range(1, len(rows), 6):
            table = table_markup([rows[0], *rows[i:i + 6]])
            units.append(f'<div class="table-bundle">{leader}{table}</div>')
            leader = ""
        start = right
    units.extend(group_markup(raw[start:], size, key))
    result = []
    headings = []
    for unit in units:
        if re.fullmatch(r'<article class="unit-card (?:topic|answer|tip|goals)">(?:<div class="para step-marker">.*?</div>)?<h3>.*?</h3></article>', unit):
            headings.append(unit)
            continue
        result.append(keep_together([*headings, unit]) if headings else unit)
        headings.clear()
    result.extend(headings)
    return result


def cover_groups(groups, title):
    for index, group in enumerate(groups):
        for start in range(len(group)):
            for end in range(start + 1, len(group) + 1):
                title_lines = group[start:end]
                if block_text(title_lines) != title:
                    continue
                other = [part for part in (group[:start], group[end:]) if part]
                return [title_lines, *groups[:index], *other, *groups[index + 1:]]
    # The cover can use a catalog title that's styled differently in the source.
    # Keep every original group on the facing page when no exact title matches.
    return [[], *groups]


def construct(source, images, theme, level, wave_title, openers):
    title = wave_title or source_title(source)
    school = theme == "school"
    imprint = "Wise Wolf Language" if school else "Uso em aula pelo professor assinante"
    logo = ""
    if school:
        mark = HERE.parents[1] / "public/assets/brand/wise-wolf-mark-trim-20261028.png"
        logo = f'<img class="mark" alt="Wise Wolf" src="{mark.as_uri()}">'
    sections = []
    for pg in source:
        original = pg.number + 1
        raw = list(source_groups(pg, title))
        first, subtitles = split_title(raw[0])
        if original == 1 and wave_title:
            raw = cover_groups(raw, wave_title)
            subtitles = []
        key = re.search(r"^(Answer key|Gabarito)", first, re.I) is not None
        if wave_title and key and len(raw[0]) > 1:
            contents = [line for line in raw[0] if ANSWER.match(line_text(line).strip())]
            if contents:
                raw = [[line for line in raw[0] if line not in contents], contents, *raw[1:]]
                first, subtitles = split_title(raw[0])
        art_path = images / f"orig-{original:02d}.webp"
        if original == 1:
            # Retain the previous cover text in the opening spread, under the original folio.
            first = title
        units = wave_section(pg, raw, key) if wave_title else grouped_section(original, raw, school, key)
        if not school and original == 3:
            units = [re.sub(r"Nominalisatio(?:</strong>)?\s+(?:<strong>)?n(?=</strong>|<)", "Nominalisation", u) for u in units]
        sections.append({
            "origin": original, "title": first, "subtitle": " · ".join(subtitles), "key": key, "units": units,
            "opener": original in openers,
            "art": art_path.as_uri() if art_path.exists() else "",
            "skill": icon(first),
        })
    css = (HERE / "editorial_v2.css").read_text()
    symbol_font = (HERE / "fonts" / "NotoSansMath-elocucoes.ttf").as_uri()
    css += f'\n@font-face {{ font-family: "Editorial Symbols"; src: url("{symbol_font}"); unicode-range: U+2322; }}'
    js = (HERE / "paginate_v2.js").read_text()
    data = json.dumps({
        "title": title, "level": level, "imprint": imprint, "logo": logo,
        "sections": sections, "cover": (images / "capa.webp").as_uri(),
        "school": school,
    }, ensure_ascii=False).replace("</", "<\\/")
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{escape(title)}</title>'
        f'<style>{css}</style></head><body class="{theme}"><main id="book"></main>'
        f'<script type="application/json" id="data">{data}</script><script>{js}</script></body></html>'
    )


def verify(source, rendered, mapping, wave_title):
    title = wave_title or source_title(source)
    if len(rendered) != len(mapping):
        raise ValueError(f"Paginação divergente: {len(mapping)} planejadas, {len(rendered)} renderizadas")
    for pg in rendered:
        if not (840 < pg.rect.width < 844 and 593 < pg.rect.height < 597):
            raise ValueError(f"Página {pg.number + 1} fora do A4 paisagem")
        for line in pg.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)["blocks"]:
            for row in line["lines"]:
                if "".join(span["text"] for span in row["spans"]).strip() == ".":
                    dot_x, dot_y = row["spans"][0]["origin"]
                    adjacent_rule = any(
                        item["rect"].width > 12
                        and abs(dot_x - item["rect"].x1) < 4
                        and abs(dot_y - item["rect"].y0) < 4
                        for item in pg.get_drawings()
                    )
                    if not adjacent_rule:
                        raise ValueError(f"Página {pg.number + 1} (orig. {mapping[pg.number]}): ponto isolado em {dot_x:.1f}, {dot_y:.1f}")
                for span in row["spans"]:
                    if span["text"].strip() and span["size"] < 9.93:
                        raise ValueError(f"Página {pg.number + 1}: {span['text']!r} em {span['size']:.2f} pt")
    for old in source:
        idx = old.number + 1
        expected = BODY(block_text(group) for group in source_groups(old, title))
        actual = BODY(rendered[i].get_text() for i, origin in enumerate(mapping) if origin == idx)
        missing = words(expected) - words(actual)
        missing_chars = characters(expected.replace("_", "")) - characters(actual)
        if missing or missing_chars:
            raise ValueError(f"Orig. {idx}: palavras ausentes {dict(missing)}, caracteres ausentes {dict(missing_chars)}")


def previews(doc, folder):
    scale = .30
    cols = 3
    width, height = (round(doc[0].rect.width * scale), round(doc[0].rect.height * scale))
    for previous in folder.glob("contato-*.png"):
        previous.unlink()
    for part, first in enumerate(range(0, len(doc), 12), 1):
        count = min(12, len(doc) - first)
        rows = (count + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (width + 14) + 14, rows * (height + 30) + 14), "#ddd9d1")
        pen = ImageDraw.Draw(sheet)
        for index in range(count):
            pg = doc[first + index]
            thumb = pg.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            x, y = 14 + index % cols * (width + 14), 14 + index // cols * (height + 30)
            sheet.paste(Image.frombytes("RGB", (thumb.width, thumb.height), thumb.samples), (x, y))
            pen.text((x, y + height + 4), f"{pg.number + 1:02d}", fill="#222222")
        sheet.save(folder / f"contato-{part:02d}.png")
    doc[0].get_pixmap(dpi=128, alpha=False).save(folder / "previa-capa.png")


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("source", type=Path)
    cli.add_argument("output", type=Path)
    cli.add_argument("--theme", choices=("hub", "school"), required=True)
    cli.add_argument("--level", choices=("A1", "A2", "B1", "B2", "C1", "C2"), required=True)
    cli.add_argument("--chromium", required=True)
    cli.add_argument("--wave-title", help="Título validado da fonte para importar tabelas por geometria")
    cli.add_argument("--unit-opener", type=int, action="append")
    cli.add_argument("--puppeteer-module", default="puppeteer-core")
    args = cli.parse_args()
    out = args.output.resolve()
    for photo in out.glob("*.webp"):
        with Image.open(photo) as img:
            if img.format != "WEBP" or img.width <= img.height:
                raise ValueError(f"Arte inválida: {photo}")
    with pymupdf.open(args.source) as src, tempfile.TemporaryDirectory(prefix="livro-editorial-v2-") as scratch:
        working = Path(scratch)
        html = working / "livro.html"
        pdf = working / "livro.pdf"
        map_path = working / "paginas.json"
        html.write_text(construct(src, out, args.theme, args.level, args.wave_title, set(args.unit_opener or [4])), encoding="utf-8")
        subprocess.run([
            "node", str(HERE / "print.mjs"), str(html), str(pdf), str(working / "profile"),
            args.chromium, args.puppeteer_module, str(map_path),
        ], check=True, timeout=90)
        report = json.loads(map_path.read_text())
        with pymupdf.open(pdf) as result:
            verify(src, result, [page["origin"] for page in report], args.wave_title)
            previews(result, out)
            first_for = {}
            for index, page in enumerate(report, 1):
                if page["origin"] and page["style"] != "cover":
                    first_for.setdefault(page["origin"], index)
            title = source_title(src)
            result.set_toc([
                [1, f"{original:02d} · {block_text(next(source_groups(src[original - 1], title)))}", page]
                for original, page in first_for.items()
            ])
            result.set_pagelayout("TwoPageRight")
            result.save(out / "livro.pdf", garbage=4, deflate=True)
        (out / "paginas.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(f"{args.theme}: {len(report)} páginas, {len(list(out.glob('*.webp')))} artes WebP")


if __name__ == "__main__":
    main()
