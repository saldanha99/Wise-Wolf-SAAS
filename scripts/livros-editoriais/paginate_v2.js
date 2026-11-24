const model = JSON.parse(document.querySelector("#data").textContent);
const book = document.querySelector("#book");
const mapping = [];

function html(value) {
  return value.replace(/[&<>"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[char]);
}

function node(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.firstElementChild;
}

function photoPage(section) {
  const opener = section.origin === 4;
  const sheet = node(`<section class="sheet bleed ${opener ? "opener" : ""}">
    <img class="hero" alt="" src="${opener ? section.art : model.cover}">
    ${model.logo}
    <div class="cover-copy">
      ${opener ? "" : `<span class="level">${model.level}</span>`}
      <h1>${html(opener ? section.title : model.title)}</h1>
    </div><div class="cover-footer">${html(opener ? (model.school ? "Referência original 04" : "Original page 04") : model.imprint)}</div>
  </section>`);
  book.append(sheet);
  mapping.push({origin: section.origin, style: opener ? "opener" : "cover"});
}

function bodyPage(section, part, mode, showPhoto) {
  const original = String(section.origin).padStart(2, "0");
  const reference = model.school ? "Referência original" : "Original page";
  const heading = html(section.title);
  const page = node(`<section class="sheet ${section.key ? "key" : ""}">
    <header class="top"><span>${html(model.title)}</span>${model.logo}</header>
    <div class="heading">${section.skill}<div><h2>${heading}</h2>${section.subtitle ? `<div class="subtitle">${html(section.subtitle)}</div>` : ""}</div></div>
    <div class="canvas">
      <div class="wide-band"></div>
      <div class="grid ${mode}">
        <div class="column"></div>
        ${(!mode || mode === "mixed") ? '<div class="column"></div>' : ""}
        ${showPhoto ? `<figure class="scene"><img src="${section.art}" alt=""></figure>` : ""}
      </div>
    </div>
    <footer><span>${html(model.imprint)}</span>
      <span class="origin-ribbon">${reference} ${original}${part > 1 ? " · " + (model.school ? "continuação" : "continued") : ""}</span>
      <b class="folio">${String(mapping.length + 1).padStart(2, "0")}</b>
    </footer>
  </section>`);
  book.append(page);
  return page;
}

function fits(container, child, bottom) {
  container.append(child);
  const end = child.getBoundingClientRect().bottom;
  if (end <= bottom + .4) return true;
  child.remove();
  return false;
}

function splitArticle(article) {
  if (!article.matches("article.unit-card")) return null;
  const paragraphs = [...article.querySelectorAll(":scope > .para")];
  if (paragraphs.length < 2) return null;
  const middle = Math.ceil(paragraphs.length / 2);
  const rest = article.cloneNode(false);
  const heading = article.querySelector("h3");
  if (heading) rest.append(heading.cloneNode(true));
  paragraphs.slice(middle).forEach(paragraph => rest.append(paragraph));
  return rest;
}

function rebalance(column, other, limit) {
  if (!other || !column.firstElementChild || !other.firstElementChild) return;
  while (column.children.length > 1) {
    const a = column.lastElementChild;
    const left = a.getBoundingClientRect().bottom;
    const right = other.lastElementChild.getBoundingClientRect().bottom;
    if (left <= right + a.getBoundingClientRect().height) break;
    other.prepend(a);
    if (other.lastElementChild.getBoundingClientRect().bottom > limit) {
      column.append(a);
      break;
    }
  }
}

function trial(section, part, mode, todo) {
  const page = bodyPage(section, part, mode, mode === "illustrated");
  const grid = page.querySelector(".grid");
  const band = page.querySelector(".wide-band");
  const limit = grid.getBoundingClientRect().bottom - 3;
  const columns = [...grid.querySelectorAll(".column")];
  let count = 0;
  if (mode === "mixed") {
    const table = todo.findIndex(item => item.matches(".table-bundle"));
    const bandLimit = grid.getBoundingClientRect().top + grid.getBoundingClientRect().height * .72;
    while (count <= table && fits(band, todo[count].cloneNode(true), bandLimit)) count += 1;
    if (count <= table) return {page, columns, count: 0, limit, mode};
  }
  for (const col of columns) {
    while (count < todo.length) {
      if (todo[count].matches(".table-bundle") && mode !== "full") break;
      if (!fits(col, todo[count].cloneNode(true), limit)) break;
      count += 1;
    }
  }
  return {page, columns, count, limit, mode};
}

function layOut(section) {
  const todo = section.units.map(node);
  let photo = Boolean(section.art) && section.origin !== 4;
  let part = 1;
  if (section.origin === 4) {
    photoPage(section);
    part += 1;
  }
  while (todo.length) {
    const modes = photo ? ["illustrated"] : ["", "full"];
    if (!photo && todo.slice(0, 5).some(item => item.matches(".table-bundle"))) modes.push("mixed");
    const candidates = modes.map(mode => trial(section, part, mode, todo));
    const selected = candidates.reduce((best, option) => option.count > best.count ? option : best);
    for (const trialPage of candidates) {
      if (trialPage !== selected) trialPage.page.remove();
    }
    const {page, columns, limit, mode, count} = selected;
    if (!count) {
      const continuation = splitArticle(todo[0]);
      if (!continuation) throw new Error(`Bloco maior que uma página na origem ${section.origin}: ${todo[0].innerText}`);
      page.remove();
      todo.splice(1, 0, continuation);
      continue;
    }
    todo.splice(0, count);
    if (columns.length > 1) rebalance(columns[0], columns[1], limit);
    const height = page.querySelector(".grid").getBoundingClientRect().height;
    function occupation(col) {
      if (!col.lastElementChild) return 0;
      return (col.lastElementChild.getBoundingClientRect().bottom - col.getBoundingClientRect().top) / height;
    }
    let photoPanel = mode === "illustrated";
    if (!section.key && section.art && mode === "" && columns.length === 2 && !columns[1].children.length) {
      columns[1].replaceWith(node(`<figure class="scene"><img src="${section.art}" alt=""></figure>`));
      columns.pop();
      photoPanel = true;
    }
    if (section.origin === 1 || page.querySelector(".exercise, .goals") || (section.key && !todo.length)) {
      const target = columns.find(col => occupation(col) < .63);
      if (target) {
        const notesHeight = Math.min(320, Math.max(0, height * (.87 - occupation(target))));
        if (notesHeight > 30) {
          const label = section.key ? (model.school ? "Anotações do professor" : "Teacher notes") : "";
          const rules = "<i></i>".repeat(Math.max(1, Math.floor(notesHeight / 34) - Number(Boolean(label))));
          fits(target, node(`<div class="notes" style="height:${notesHeight}px">${label ? `<b>${label}</b>` : ""}${rules}</div>`), limit);
        }
      }
    }
    const bandHeight = page.querySelector(".wide-band").getBoundingClientRect().height;
    const pageFill = () => {
      const gridFill = (columns.reduce((n, col) => n + occupation(col), 0) + Number(photoPanel)) /
        (columns.length + Number(photoPanel));
      return (height * gridFill + bandHeight) / (height + bandHeight);
    };
    if (pageFill() < .60 && page.querySelector(".grid").children.length) {
      for (const scale of [1.1, 1.2, 1.3]) {
        const padding = Math.round(26 * (scale - 1));
        page.style.setProperty("--room", `${padding}px`);
        page.style.setProperty("--reading-size", `${(section.key ? 10.5 : 11) * scale}pt`);
        if (columns.some(col => col.lastElementChild?.getBoundingClientRect().bottom > limit)) break;
        if (pageFill() >= .60) break;
      }
      if (columns.some(col => col.lastElementChild?.getBoundingClientRect().bottom > limit)) {
        page.style.removeProperty("--room");
        page.style.removeProperty("--reading-size");
      }
    }
    const fill = pageFill();
    mapping.push({origin: section.origin, style: mode || "columns", part, fill: Math.round(fill * 100)});
    part += 1;
    photo = false;
  }
}

function addIndex() {
  const title = model.school ? "Referências e seções" : "Section and page references";
  const intro = model.school
    ? "Use o número de referência no rodapé para localizar exercícios e respostas da mesma seção."
    : "Use the original page number in the footer to locate the exercise or answer in this edition.";
  const section = {origin: 0, title, skill: "", key: false};
  const page = bodyPage(section, 1, "", false);
  page.querySelector(".origin-ribbon").remove();
  const columns = [...page.querySelectorAll(".column")];
  columns[0].append(node(`<p class="index-intro">${html(intro)}</p>`));
  for (const [i, entry] of model.sections.entries()) {
    const number = String(entry.origin).padStart(2, "0");
    columns[Number(i >= Math.ceil(model.sections.length / 2))].append(node(
      `<div class="index-entry"><b>${number}</b><span>${html(entry.subtitle || entry.title)}</span></div>`
    ));
  }
  mapping.push({origin: 0, style: "index", part: 1, fill: 70});
}

window.fitEditorialPages = async () => {
  photoPage(model.sections[0]);
  for (const section of model.sections) {
    if (section.origin === 4 && mapping.length % 2 === 0) addIndex();
    layOut(section);
  }
  await Promise.all([...document.images].map(img => img.decode()));
  window.editorialPageMap = mapping;
  return [...book.children].flatMap((sheet, i) => {
    const footer = sheet.querySelector("footer");
    if (!footer) return [];
    const limit = sheet.getBoundingClientRect().bottom - 29;
    const occupied = [...sheet.querySelectorAll(".column > *, .wide-band > *")];
    return footer.getBoundingClientRect().bottom > limit ||
      occupied.some(item => item.getBoundingClientRect().bottom > footer.getBoundingClientRect().top - 2)
      ? [i + 1] : [];
  });
};
