const FENCE = /^\s{0,3}\x60{3}([a-zA-Z0-9_+-]{0,30})\s*$/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d+\.)\s+(.+)$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.+)$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function safeMarkdownHref(raw) {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 2048 || /[\u0000-\u0020]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url.href;
}

export function parseInlineMarkdown(source) {
  const text = String(source ?? "");
  const tokens = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (!buffer) return;
    tokens.push({ type: "text", value: buffer });
    buffer = "";
  };

  while (index < text.length) {
    if (text[index] === "\\") {
      if (index + 1 < text.length) {
        buffer += text[index + 1];
        index += 2;
      } else {
        buffer += "\\";
        index += 1;
      }
      continue;
    }

    if (text[index] === "\x60") {
      const end = text.indexOf("\x60", index + 1);
      if (end > index + 1) {
        flush();
        tokens.push({ type: "code", value: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        flush();
        tokens.push({
          type: "strong",
          children: parseInlineMarkdown(text.slice(index + 2, end)),
        });
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "*") {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1 && text[end - 1] !== " ") {
        flush();
        tokens.push({
          type: "emphasis",
          children: parseInlineMarkdown(text.slice(index + 1, end)),
        });
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const labelEnd = text.indexOf("](", index + 1);
      const hrefEnd = labelEnd >= 0 ? text.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd > index + 1 && hrefEnd > labelEnd + 2) {
        const label = text.slice(index + 1, labelEnd);
        const href = safeMarkdownHref(text.slice(labelEnd + 2, hrefEnd));
        if (href) {
          flush();
          tokens.push({ type: "link", label, href });
          index = hrefEnd + 1;
          continue;
        }
      }
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return tokens;
}

export function parseMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const language = fence[1] || "";
      index += 1;
      const code = [];
      while (index < lines.length && !/^\s{0,3}\x60{3}\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code-block", language, value: code.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        value: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", value: quote.join("\n") });
      continue;
    }

    const firstList = line.match(LIST_ITEM);
    if (firstList) {
      const ordered = /\d+\./.test(firstList[1]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST_ITEM);
        if (!item || (/\d+\./.test(item[1]) !== ordered)) break;
        items.push(item[2].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim() || FENCE.test(next) || HEADING.test(next) || RULE.test(next) ||
          /^\s{0,3}>\s?/.test(next) || LIST_ITEM.test(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", value: paragraph.join("\n") });
  }

  return blocks;
}

export function renderMarkdown(container, source) {
  container.replaceChildren();
  for (const block of parseMarkdown(source)) {
    let element;
    if (block.type === "heading") {
      element = document.createElement("h" + block.level);
      appendInline(element, block.value);
    } else if (block.type === "paragraph") {
      element = document.createElement("p");
      appendInline(element, block.value);
    } else if (block.type === "code-block") {
      element = document.createElement("pre");
      const code = document.createElement("code");
      if (block.language) code.dataset.language = block.language;
      code.textContent = block.value;
      element.append(code);
    } else if (block.type === "quote") {
      element = document.createElement("blockquote");
      const paragraph = document.createElement("p");
      appendInline(paragraph, block.value);
      element.append(paragraph);
    } else if (block.type === "list") {
      element = document.createElement(block.ordered ? "ol" : "ul");
      for (const value of block.items) {
        const item = document.createElement("li");
        appendInline(item, value);
        element.append(item);
      }
    } else if (block.type === "rule") {
      element = document.createElement("hr");
    } else {
      continue;
    }
    container.append(element);
  }
}

function appendInline(container, value) {
  for (const token of parseInlineMarkdown(value)) {
    if (token.type === "text") {
      container.append(document.createTextNode(token.value));
    } else if (token.type === "code") {
      const code = document.createElement("code");
      code.textContent = token.value;
      container.append(code);
    } else if (token.type === "strong" || token.type === "emphasis") {
      const element = document.createElement(token.type === "strong" ? "strong" : "em");
      appendTokens(element, token.children);
      container.append(element);
    } else if (token.type === "link") {
      const link = document.createElement("a");
      link.href = token.href;
      link.textContent = token.label;
      link.rel = "noopener noreferrer";
      if (token.href.startsWith("https:") || token.href.startsWith("http:")) {
        link.target = "_blank";
      }
      container.append(link);
    }
  }
}

function appendTokens(container, tokens) {
  for (const token of tokens) {
    if (token.type === "text") {
      container.append(document.createTextNode(token.value));
    } else if (token.type === "code") {
      const element = document.createElement("code");
      element.textContent = token.value;
      container.append(element);
    } else if (token.type === "strong" || token.type === "emphasis") {
      const element = document.createElement(token.type === "strong" ? "strong" : "em");
      appendTokens(element, token.children);
      container.append(element);
    } else if (token.type === "link") {
      const element = document.createElement("a");
      element.href = token.href;
      element.textContent = token.label;
      element.rel = "noopener noreferrer";
      if (token.href.startsWith("https:") || token.href.startsWith("http:")) {
        element.target = "_blank";
      }
      container.append(element);
    }
  }
}
