/**
 * Markdown to HTML with a print stylesheet, hand-rolled.
 *
 * A markdown library would be a third dependency for a document whose shape we
 * fully control, so this handles exactly the constructs the assembler emits and
 * nothing else. It is not a general markdown renderer and does not pretend to be.
 */

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface FrontMatter {
  fields: Record<string, string>;
  rest: string;
}

function splitFrontMatter(md: string): FrontMatter {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, rest: md };

  const fields: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      i++;
      break;
    }
    const idx = line.indexOf(":");
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { fields, rest: lines.slice(i).join("\n") };
}

/** Inline formatting. Escaping happens first, so no user text can inject markup. */
function inline(text: string): string {
  return esc(text)
    .replace(/\[\^([^\]]+)\]/g, (_m, id: string) =>
      `<sup class="fn"><a href="#fn-${esc(id)}" id="ref-${esc(id)}">${esc(id)}</a></sup>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(
      /(https?:\/\/[^\s<]+)/g,
      (m) => `<a href="${m}" target="_blank" rel="noreferrer">${m}</a>`,
    );
}

function body(md: string): { html: string; footnotes: string[] } {
  const out: string[] = [];
  const footnotes: string[] = [];
  let list: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
    list = [];
  };

  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    const definition = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(trimmed);
    if (definition) {
      const [, id = "", text = ""] = definition;
      footnotes.push(
        `<li id="fn-${esc(id)}"><a class="back" href="#ref-${esc(id)}">${esc(id)}</a> ${inline(text)}</li>`,
      );
      continue;
    }

    if (trimmed === "") {
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushList();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(trimmed);
    if (item) {
      // Continuation lines belong to the item above.
      let text = item[1] ?? "";
      while (
        i + 1 < lines.length &&
        /^\s{2,}\S/.test(lines[i + 1] ?? "") &&
        !/^\s*[-*]\s/.test(lines[i + 1] ?? "")
      ) {
        text += " " + (lines[++i] ?? "").trim();
      }
      list.push(inline(text));
      continue;
    }

    flushList();
    out.push(`<p>${inline(trimmed)}</p>`);
  }

  flushList();
  return { html: out.join("\n"), footnotes };
}

const STYLE = `
@page { size: A4; margin: 14mm 15mm; }
:root { --ink:#15181c; --muted:#5d6874; --line:#d9dee5; --accent:#0b4f6c;
        --ok:#0d7a4a; --part:#8a6100; --no:#a4243b; }
* { box-sizing:border-box }
html { -webkit-print-color-adjust:exact; print-color-adjust:exact }
body { margin:0 auto; max-width:200mm; padding:14mm 15mm; background:#fff; color:var(--ink);
       font:10.2pt/1.42 "Charter","Bitstream Charter",Georgia,"Times New Roman",serif }
h1 { font-size:19pt; line-height:1.1; margin:0 0 2mm; letter-spacing:-.01em }
h2 { font-size:10pt; text-transform:uppercase; letter-spacing:.09em; color:var(--accent);
     margin:5mm 0 1.6mm; padding-bottom:1mm; border-bottom:.5pt solid var(--line) }
h3 { font-size:10.6pt; margin:3mm 0 1mm }
p { margin:0 0 1.8mm }
ul { margin:0 0 2mm; padding-left:4.5mm }
li { margin:0 0 1.1mm }
code { font:9pt ui-monospace,SFMono-Regular,Menlo,monospace; background:#f2f4f7;
       padding:.3mm 1mm; border-radius:1mm }
a { color:inherit; text-decoration:none; border-bottom:.4pt solid var(--line) }
sup.fn a { color:var(--accent); border:0; font-size:7.4pt; font-weight:700; padding-left:.3mm }
.meta { color:var(--muted); font-size:8.6pt; margin:0 0 3mm }
.counts { display:flex; gap:4mm; flex-wrap:wrap; margin:0 0 4mm;
          font:8.4pt ui-monospace,Menlo,monospace; color:var(--muted) }
.counts b { color:var(--ink) }
.counts .v b { color:var(--ok) } .counts .p b { color:var(--part) } .counts .r b { color:var(--no) }
.footnotes { margin-top:5mm; padding-top:2mm; border-top:.5pt solid var(--line) }
.footnotes ol { margin:0; padding:0; list-style:none }
.footnotes li { font-size:7.6pt; line-height:1.34; color:var(--muted); margin-bottom:.7mm;
                word-break:break-word }
.footnotes .back { color:var(--accent); font-weight:700; border:0; margin-right:1mm }
@media print { body { padding:0 } a { border:0 } }
`;

export function toHtml(markdown: string): string {
  const { fields, rest } = splitFrontMatter(markdown);
  const { html, footnotes } = body(rest);

  const header =
    Object.keys(fields).length > 0
      ? `<p class="meta">${esc(fields["role"] ?? "")}${fields["company"] ? `, ${esc(fields["company"])}` : ""}
         &middot; ${esc(fields["linkedin"] ?? "")}
         &middot; assessed ${esc(fields["assessed_at"] ?? "")}
         &middot; pipeline ${esc(fields["pipeline_version"] ?? "")}</p>
         <div class="counts">
           <span>claims extracted <b>${esc(fields["claims_extracted"] ?? "0")}</b></span>
           <span class="v">verified <b>${esc(fields["verified"] ?? "0")}</b></span>
           <span class="p">partially verified <b>${esc(fields["partially_verified"] ?? "0")}</b></span>
           <span class="r">refused <b>${esc(fields["refused"] ?? "0")}</b></span>
         </div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(fields["name"] ?? "Diagnostic")} &middot; public-source diagnostic</title>
<style>${STYLE}</style>
</head>
<body>
${html.replace("</h1>", `</h1>\n${header}`)}
${
  footnotes.length > 0
    ? `<div class="footnotes"><ol>${footnotes.join("")}</ol></div>`
    : ""
}
</body>
</html>
`;
}
