// Images placed inside a post body by the editor are <img src="/files/<media id>"> tags,
// pointing at PostHub's own media route. Platforms that support them (WordPress) get the files.

const INLINE_IMAGE = /<img\b[^>]*\bsrc="\/files\/([0-9a-f-]{36})"/gi;

export const inlineRef = (mediaId: string) => `/files/${mediaId}`;

/** Media ids of images inside a body, in order, without duplicates. */
export function inlineMediaIds(body: string) {
  return [...new Set([...body.matchAll(INLINE_IMAGE)].map((m) => m[1]!))];
}
