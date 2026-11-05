import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const markdown = new Marked({ gfm: true, breaks: true, renderer: {
  // Assistant text is content, never page markup or an automatic network fetch.
  html: ({ text }) => escapeHtml(text),
  image: ({ text }) => escapeHtml(text),
} });
const tags = ['p', 'br', 'em', 'strong', 'del', 'blockquote', 'ul', 'ol', 'li', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'input'];

/** Render once on an explicit read action; live snapshots never replace the open body. */
export function renderReplyMarkdown(node, text) {
  const content = DOMPurify.sanitize(markdown.parse(text), {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of content.querySelectorAll('a')) {
    if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    link.target = '_blank'; link.rel = 'noopener noreferrer';
  }
  // Parser formatting between blocks does not belong to the reply's text.
  for (const child of [...content.childNodes]) if (child.nodeType === Node.TEXT_NODE && !child.textContent.trim()) child.remove();
  node.replaceChildren(content);
}
