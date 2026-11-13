// Post bodies are HTML from the rich text editor. Posts written before it are plain text.
// The server converts bodies for platforms (packages/integrations/src/content.ts); this is for display.

export const isHtmlBody = (body: string) =>
  /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|hr|div|img|figure)[\s>/]/i.test(body);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Editor content for a body of either kind. */
export function bodyToEditorHtml(body: string) {
  if (!body || isHtmlBody(body)) return body;
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Plain text of a body, for previews, title suggestions and copying. */
export function bodyToText(body: string) {
  if (!isHtmlBody(body)) return body.trim();
  const html = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|h[1-6]|li|blockquote|pre)>/gi, '\n');
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
