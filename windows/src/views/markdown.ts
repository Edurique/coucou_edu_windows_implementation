// What Claude writes, as it means it to be read: its answers are Markdown.
//
// No Markdown library — the island shows one answer at a time, and what an
// answer is made of is short to list: headings, paragraphs, lists, tables,
// fenced code, and inside a line bold, italics, code and links. Anything else
// stays as it was written. Everything is built as text nodes: nothing an
// answer contains is ever read as HTML, and a link is shown, not followed.

import { h, svg } from "./dom";
import { ICONS } from "./icons";

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\s][^*\n]*\*)/g;

/** What a place that shows Markdown may add to it. The chat does; a session's reply is only read. */
export interface MarkdownOptions {
  /** Lines that start with `>` are drawn as quotes. */
  quotes?: boolean;
  /** Links to the web can be followed: this opens one. Any other kind of link is only shown. */
  open?: (url: string) => void;
  /** Code blocks get a button that hands their code, and itself, to this. */
  copy?: (code: string, button: HTMLElement) => void;
}

const WEB_LINK = /^https?:\/\//i;

/** A line's words, with what is bold, in italics, code or a link marked as such. */
function inlineOf(text: string, open?: (url: string) => void): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const piece = match[0];
    const start = match.index ?? 0;
    if (start > at) out.push(document.createTextNode(text.slice(at, start)));
    if (piece.startsWith("**")) out.push(h("b", { text: piece.slice(2, -2) }));
    else if (piece.startsWith("`")) out.push(h("code", { text: piece.slice(1, -1) }));
    else if (piece.startsWith("[")) {
      const label = piece.slice(1, piece.indexOf("]("));
      const url = piece.slice(piece.indexOf("](") + 2, -1).trim();
      if (open && WEB_LINK.test(url)) {
        out.push(h("span", { class: "md-link go", title: url, text: label, onclick: () => open(url) }));
      } else {
        out.push(h("span", { class: "md-link", text: label }));
      }
    }
    else out.push(h("em", { text: piece.slice(1, -1) }));
    at = start + piece.length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>(?: (.*))?$/;
/** Spaces of indentation that make a list item one level deeper, and how far in a level sits, in px. */
const INDENT = 2;
const LEVEL_PX = 12;

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

/** An answer, block by block. */
export function markdown(source: string, options: MarkdownOptions = {}): HTMLElement {
  const root = h("div", { class: "md" });
  const inline = (text: string) => inlineOf(text, options.open);
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    root.append(h("p", {}, ...inline(paragraph.join("\n"))));
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      const text = code.join("\n");
      const block = h("pre", { class: "md-code", text });
      const { copy } = options;
      if (copy) {
        const button = h("button", { class: "md-copy", title: "Copy" }, svg(ICONS.copy, 10));
        button.addEventListener("click", () => copy(text, button));
        root.append(h("div", { class: "md-codebox" }, block, button));
      } else {
        root.append(block);
      }
      continue;
    }

    const quote = options.quotes ? QUOTE.exec(line) : null;
    if (quote) {
      flush();
      root.append(h("div", { class: "md-quote" }, ...inline(quote[1] ?? "")));
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flush();
      const head = h("tr", {}, ...cells(line).map((cell) => h("th", {}, ...inline(cell))));
      const body: HTMLElement[] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
        body.push(h("tr", {}, ...cells(lines[i]).map((cell) => h("td", {}, ...inline(cell)))));
      }
      i--;
      root.append(h("table", { class: "md-table" }, h("thead", {}, head), h("tbody", {}, ...body)));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      root.append(h("div", { class: heading[1].length <= 2 ? "md-h big" : "md-h" }, ...inline(heading[2])));
      continue;
    }

    if (ITEM.test(line)) {
      flush();
      const list = h("div", { class: "md-list" });
      for (; i < lines.length; i++) {
        const item = ITEM.exec(lines[i]);
        if (!item) {
          // A line that goes on under its item belongs to it; anything else ends the list.
          if (lines[i].trim() && /^\s+/.test(lines[i]) && list.lastElementChild) {
            list.lastElementChild.lastElementChild?.append(" ", ...inline(lines[i].trim()));
            continue;
          }
          break;
        }
        const numbered = /\d/.test(item[2]);
        const row = h("div", { class: "md-item" }, h("i", { text: numbered ? item[2].replace(")", ".") : "•" }), h("span", {}, ...inline(item[3])));
        row.style.paddingLeft = `${Math.floor(item[1].length / INDENT) * LEVEL_PX}px`;
        list.append(row);
      }
      i--;
      root.append(list);
      continue;
    }

    if (RULE.test(line)) {
      flush();
      root.append(h("hr", { class: "md-rule" }));
      continue;
    }

    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return root;
}
