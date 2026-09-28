// m.youtube.com-like structure (ytm-* elements), client-side navigation with yt-navigate-finish.

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
};
const thumb = (hue, short = false) => el('div', { class: short ? 'thumb short' : 'thumb', style: `--hue:${hue}` });

const video = (id, title, hue) => el('ytm-video-with-context-renderer', { 'data-video': id }, el('a', { href: `/watch?v=${id}` }, thumb(hue)), el('span', { class: 'title', text: title }));
const short = (id) => el('ytm-video-with-context-renderer', { 'data-short': id }, el('a', { href: `/shorts/${id}` }, thumb(320, true)), el('span', { class: 'title', text: 'A Short' }));

function feed(isHome) {
  return el(
    'ytm-browse',
    {},
    isHome ? el('ytm-feed-filter-chip-bar-renderer', {}, el('span', { class: 'chip', text: 'All' }), el('span', { class: 'chip', text: 'Music' })) : '',
    el(
      'ytm-rich-grid-renderer',
      {},
      el('ytm-rich-item-renderer', {}, video('focus000001', 'Refactoring a messy module', 95)),
      el('ytm-rich-item-renderer', { 'data-short': 'shortBBBB001' }, el('a', { href: '/shorts/shortBBBB001' }, thumb(320, true))),
      el('ytm-rich-section-renderer', {}, el('ytm-reel-shelf-renderer', {}, el('h2', { text: 'Shorts' }))),
      el('ytm-rich-item-renderer', {}, video('study000001', 'Linear algebra, lecture 4', 210)),
    ),
  );
}

function watch(id) {
  const channel = id.startsWith('focus') ? ['@calmcoding', 'Calm Coding'] : ['@loudclips', 'Loud Clips'];
  return el(
    'ytm-watch',
    {},
    el('div', { class: 'html5-video-player' }, el('div', { class: 'video-surface', style: '--hue:95' }), el('div', { class: 'ytp-ce-element', text: 'End card' })),
    el('ytm-slim-video-metadata-section-renderer', {}, el('h1', { text: 'Now playing' }), el('ytm-slim-owner-renderer', {}, el('a', { href: `/${channel[0]}`, text: channel[1] }))),
    el('ytm-comments-entry-point-header-renderer', { text: 'Comments 1.2K' }),
    el(
      'ytm-single-column-watch-next-results-renderer',
      {},
      el('ytm-item-section-renderer', { 'section-identifier': 'related-items' }, video('noise000001', 'You won’t BELIEVE this', 5), short('shortCCCC001')),
    ),
  );
}

function render() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.fixtureRoute = path;
  let page;
  if (path === '/') page = feed(true);
  else if (path === '/feed/subscriptions') page = feed(false);
  else if (path === '/watch') page = watch(params.get('v') ?? 'focus000001');
  else page = el('h1', { text: path });
  document.getElementById('app').replaceChildren(page);
}

window.fixtureNavigate = (url, { event = true } = {}) => {
  history.pushState({}, '', url);
  render();
  if (event) document.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true }));
};
document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link || link.origin !== location.origin) return;
  event.preventDefault();
  window.fixtureNavigate(link.getAttribute('href'));
});
window.addEventListener('popstate', render);
render();
