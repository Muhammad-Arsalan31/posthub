import { describe, expect, it } from 'vite-plus/test';
import { bodyFormats, htmlToText, isHtmlBody, textToHtml } from './content';

describe('post body content', () => {
  it('turns editor HTML into readable text', () => {
    const html =
      '<h2>Big news</h2><p>We <strong>launched</strong> &amp; it&#39;s live.<br>Line two</p>' +
      '<ul><li><p>One</p></li><li><p>Two</p><ul><li><p>Nested</p></li></ul></li></ul>' +
      '<ol><li><p>First</p></li><li><p>Second</p></li></ol>' +
      '<p>Read <a href="https://x.dev/post">the post</a> or <a href="https://x.dev">https://x.dev</a></p>' +
      '<blockquote><p>Quote</p></blockquote>';
    expect(htmlToText(html)).toBe(
      [
        'Big news',
        '',
        "We launched & it's live.",
        'Line two',
        '',
        '• One',
        '• Two',
        '  • Nested',
        '',
        '1. First',
        '2. Second',
        '',
        'Read the post (https://x.dev/post) or https://x.dev',
        '',
        'Quote',
      ].join('\n'),
    );
  });

  it('tells editor HTML from older plain-text bodies', () => {
    expect(isHtmlBody('<p>Hi</p>')).toBe(true);
    expect(isHtmlBody('<h2>Hi</h2>')).toBe(true);
    expect(isHtmlBody('I <3 cats')).toBe(false);
    expect(isHtmlBody('Plain\n\ntext')).toBe(false);
  });

  it('gives both forms for either kind of body', () => {
    expect(bodyFormats('<p>A &lt;b&gt;</p>')).toEqual({
      html: '<p>A &lt;b&gt;</p>',
      text: 'A <b>',
    });
    expect(bodyFormats('A <b>\n\nB')).toEqual({
      html: '<p>A &lt;b&gt;</p>\n<p>B</p>',
      text: 'A <b>\n\nB',
    });
    expect(textToHtml('one\ntwo')).toBe('<p>one<br>two</p>');
  });
});
