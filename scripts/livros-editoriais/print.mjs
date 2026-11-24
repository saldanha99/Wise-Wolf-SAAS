import { pathToFileURL } from "node:url";

const [html, pdf, profile, executablePath, puppeteerModule = "puppeteer-core"] = process.argv.slice(2);
const specifier = puppeteerModule.startsWith("/") ? pathToFileURL(puppeteerModule).href : puppeteerModule;
const { default: puppeteer } = await import(specifier);
const browser = await puppeteer.launch({
  executablePath,
  userDataDir: profile,
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1123, height: 794 });
  await page.emulateMediaType("print");
  await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
  const problems = await page.evaluate(async () => {
    await document.fonts.ready;
    const broken = [...document.images].filter(img => !img.naturalWidth).map(img => img.src);
    if (broken.length) return broken;
    return window.fitEditorialPages();
  });
  if (problems.length) throw new Error(`Elementos sem espaço ou imagem indisponível: ${problems.join(", ")}`);
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
} finally {
  await browser.close();
}
