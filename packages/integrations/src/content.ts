// Post bodies are HTML from the rich text editor. WordPress takes the HTML; social platforms only
// accept plain text, so they get a readable text version. Bodies written before the editor existed
// are plain text and are handled too.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#') && lower !== '#39')
      return String.fromCodePoint(Number(lower.slice(1)));
    return ENTITIES[lower] ?? match;
  });

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** True for bodies produced by the rich text editor (they always start with a block tag). */
export const isHtmlBody = (body: string) =>
  /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|hr|div|img|figure)[\s>/]/i.test(body);

/** Plain text to simple HTML paragraphs. */
export function textToHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Readable plain text from editor HTML: paragraphs, bullets, and links as "text (url)". */
export function htmlToText(html: string) {
  let listDepth = 0;
  const ordered: number[] = [];
  const text = html
    .replace(/\r?\n/g, ' ')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '');
      const url = decodeEntities(href);
      return decodeEntities(label).trim() === url ? label : `${label} (${escapeHtml(url)})`;
    })
    .replace(/<(\/?)(ul|ol|li|br|p|h[1-6]|blockquote|pre|hr|div)\b[^>]*>/gi, (_, close, tag) => {
      const t = String(tag).toLowerCase();
      if (t === 'br') return '\n';
      if (t === 'hr') return '\n\n';
      if (t === 'ul' || t === 'ol') {
        if (close) {
          listDepth -= 1;
          if (t === 'ol') ordered.pop();
        } else {
          listDepth += 1;
          if (t === 'ol') ordered.push(0);
        }
        return '\n';
      }
      if (t === 'li') {
        if (close) return '\n';
        const indent = '  '.repeat(Math.max(0, listDepth - 1));
        if (ordered.length && listDepth > 0) {
          ordered[ordered.length - 1]! += 1;
          return `${indent}${ordered[ordered.length - 1]}. `;
        }
        return `${indent}• `;
      }
      // Block elements: paragraphs inside list items stay on the bullet's line.
      if (listDepth > 0) return '';
      return close ? '\n\n' : '';
    })
    .replace(/<[^>]+>/g, '');
  return (
    decodeEntities(text)
      .split('\n')
      // Keep the indent of nested list items; trim stray spaces everywhere else.
      .map((line) => (/^ +(•|\d+\.) /.test(line) ? line.trimEnd() : line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Both forms of a post body, whichever way it was written. */
export function bodyFormats(body: string) {
  return isHtmlBody(body)
    ? { html: body, text: htmlToText(body) }
    : { html: textToHtml(body), text: body.trim() };
}
