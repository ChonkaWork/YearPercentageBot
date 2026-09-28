// A tiny single-page app with www.youtube.com's element structure. Navigation is client-side
// (pushState) like YouTube's, and fires `yt-navigate-finish` unless asked not to.

const VIDEOS = {
  focus000001: { title: 'Refactoring a messy module, step by step', channel: '@calmcoding', name: 'Calm Coding', hue: 95 },
  focus000002: { title: 'Reading a stack trace without panic', channel: '@calmcoding', name: 'Calm Coding', hue: 140 },
  noise000001: { title: 'You won’t BELIEVE what happened next!!', channel: '@loudclips', name: 'Loud Clips', hue: 5 },
  noise000002: { title: '50 hacks in 60 seconds', channel: '@loudclips', name: 'Loud Clips', hue: 30 },
  study000001: { title: 'Linear algebra, lecture 4: eigenvectors', channel: '@openlectures', name: 'Open Lectures', hue: 210 },
  study000002: { title: 'How transistors work', channel: '@openlectures', name: 'Open Lectures', hue: 250 },
};

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

function richItem(id) {
  const video = VIDEOS[id];
  return el(
    'ytd-rich-item-renderer',
    { 'data-video': id },
    el('a', { href: `/watch?v=${id}`, id: 'thumbnail' }, thumb(video.hue)),
    el('div', { class: 'meta' }, el('a', { href: `/watch?v=${id}`, class: 'title', text: video.title }), el('a', { href: `/${video.channel}`, class: 'byline', text: video.name })),
  );
}

function shortItem(id, tag = 'ytd-rich-item-renderer') {
  return el(tag, { 'data-short': id }, el('a', { href: `/shorts/${id}` }, thumb(320, true)), el('div', { class: 'meta' }, el('span', { class: 'title', text: 'A Short you didn’t ask for' })));
}

function shortsShelf() {
  const tiles = ['shortAAAA001', 'shortAAAA002', 'shortAAAA003', 'shortAAAA004'].map((id) =>
    el('ytm-shorts-lockup-view-model-v2', {}, el('a', { href: `/shorts/${id}` }, thumb(330, true)), el('span', { class: 'title', text: 'Short' })),
  );
  return el('ytd-rich-section-renderer', {}, el('div', { id: 'content' }, el('ytd-rich-shelf-renderer', { 'is-shorts': '' }, el('h2', { text: 'Shorts' }), el('div', { class: 'shelf' }, ...tiles))));
}

function grid(subtype, ids) {
  const items = ids.map(richItem);
  items.splice(2, 0, shortItem('shortBBBB001'));
  return el(
    'ytd-browse',
    { 'page-subtype': subtype },
    el(
      'ytd-rich-grid-renderer',
      {},
      el('div', { id: 'chips' }, ...['All', 'Music', 'Gaming', 'Live', 'News'].map((chip) => el('span', { class: 'chip', text: chip }))),
      el('div', { id: 'contents' }, ...items.slice(0, 4), shortsShelf(), ...items.slice(4)),
    ),
  );
}

function searchPage(query) {
  const row = (id) => {
    const video = VIDEOS[id];
    return el('ytd-video-renderer', { 'data-video': id }, el('a', { href: `/watch?v=${id}` }, thumb(video.hue)), el('div', { class: 'meta' }, el('a', { class: 'title', href: `/watch?v=${id}`, text: video.title }), el('a', { href: `/${video.channel}`, class: 'byline', text: video.name })));
  };
  const shortRow = el('ytd-video-renderer', { 'data-short': 'shortCCCC001' }, el('a', { href: '/shorts/shortCCCC001' }, thumb(320, true)), el('div', { class: 'meta' }, el('span', { class: 'title', text: 'A Short in the results' })));
  const reelShelf = el('ytd-reel-shelf-renderer', {}, el('h2', { text: 'Shorts' }), el('div', { class: 'shelf' }, ...['shortDDDD001', 'shortDDDD002', 'shortDDDD003'].map((id) => el('ytd-reel-item-renderer', {}, el('a', { href: `/shorts/${id}` }, thumb(300, true))))));
  const alsoWatched = el('ytd-shelf-renderer', {}, el('h2', { text: 'People also watched' }), row('noise000002'));
  const alsoSearch = el('ytd-horizontal-card-list-renderer', {}, el('h2', { text: 'People also search for' }), el('span', { class: 'chip', text: 'more hacks' }));
  return el(
    'ytd-search',
    {},
    el('ytd-section-list-renderer', {}, el('p', { class: 'query', text: `Results for “${query}”` }), row('study000001'), shortRow, reelShelf, row('focus000002'), alsoWatched, alsoSearch, row('study000002')),
  );
}

function watchPage(id) {
  const video = VIDEOS[id] ?? VIDEOS.focus000001;
  const related = ['noise000001', 'noise000002', 'study000002', 'focus000002'].filter((other) => other !== id).map((other) =>
    el('ytd-compact-video-renderer', { 'data-video': other }, el('a', { href: `/watch?v=${other}` }, thumb(VIDEOS[other].hue)), el('div', { class: 'meta' }, el('a', { class: 'title', href: `/watch?v=${other}`, text: VIDEOS[other].title }), el('span', { class: 'byline', text: VIDEOS[other].name }))),
  );
  const player = el(
    'div',
    { class: 'html5-video-player' },
    el('div', { class: 'video-surface', style: `--hue:${video.hue}` }, el('span', { class: 'now-playing', text: video.title })),
    el('div', { class: 'ytp-ce-element ytp-ce-video', text: 'Next: ' + VIDEOS.noise000001.title }),
    el('div', { class: 'ytp-ce-element ytp-ce-channel', text: 'Subscribe' }),
    el('div', { class: 'ytp-endscreen-content', text: 'More videos' }),
    el('div', { class: 'ytp-autonav-endscreen-countdown-overlay', text: 'Up next in 5' }),
  );
  const comments = el('ytd-comments', { id: 'comments' }, el('h2', { text: '1,204 Comments' }), ...['First!', 'Who’s watching in 2026?', 'Great explanation, thanks.'].map((text) => el('ytd-comment-thread-renderer', { text })));
  return el(
    'ytd-watch-flexy',
    { 'video-id': id },
    el(
      'div',
      { id: 'columns' },
      el(
        'div',
        { id: 'primary' },
        el('div', { id: 'player' }, player),
        el(
          'div',
          { id: 'below' },
          el(
            'ytd-watch-metadata',
            {},
            el('h1', { class: 'video-title', text: video.title }),
            el('div', { id: 'owner' }, el('ytd-video-owner-renderer', {}, el('ytd-channel-name', {}, el('a', { href: `/${video.channel}`, text: video.name })))),
          ),
          comments,
        ),
      ),
      el('div', { id: 'secondary' }, el('div', { id: 'related' }, el('ytd-watch-next-secondary-results-renderer', {}, el('ytd-reel-shelf-renderer', {}, el('h2', { text: 'Shorts' }), el('div', { class: 'shelf small' }, ...['shortEEEE001', 'shortEEEE002', 'shortEEEE003'].map((short) => el('ytd-reel-item-renderer', {}, el('a', { href: `/shorts/${short}` }, thumb(300, true)))))), ...related))),
    ),
  );
}

/** YouTube keeps the previous video's metadata for a moment after navigating: so does this. */
function updateWatch(id) {
  const flexy = document.querySelector('ytd-watch-flexy');
  setTimeout(() => {
    if (new URLSearchParams(location.search).get('v') !== id) return;
    flexy.replaceWith(watchPage(id));
  }, 300);
}

function render() {
  const manager = document.getElementById('page-manager');
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.fixtureRoute = path;
  if (path === '/watch' && document.querySelector('ytd-watch-flexy') && window.fixtureStale !== false) {
    updateWatch(params.get('v'));
    return;
  }
  let page;
  if (path === '/') page = grid('home', ['noise000001', 'study000001', 'focus000001', 'noise000002', 'study000002', 'focus000002']);
  else if (path === '/feed/subscriptions') page = grid('subscriptions', ['focus000001', 'study000002', 'focus000002', 'study000001']);
  else if (path === '/results') page = searchPage(params.get('search_query') ?? '');
  else if (path === '/watch') page = watchPage(params.get('v'));
  else if (path.startsWith('/shorts/')) page = el('ytd-shorts', {}, el('ytd-reel-video-renderer', {}, thumb(320, true), el('p', { text: 'Shorts player' })));
  else if (path === '/feed/trending') page = el('ytd-browse', { 'page-subtype': 'trending' }, el('h1', { text: 'Trending' }), richItem('noise000001'));
  else page = el('ytd-browse', { 'page-subtype': 'other' }, el('h1', { text: path }));
  manager.replaceChildren(page);
}

/** Client-side navigation like YouTube's. `event: false` changes the URL without yt-navigate-finish. */
window.fixtureNavigate = (url, { event = true } = {}) => {
  history.pushState({}, '', url);
  render();
  if (event) document.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true }));
};

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link || link.origin !== location.origin || event.defaultPrevented) return;
  event.preventDefault();
  window.fixtureNavigate(link.getAttribute('href'));
});
document.getElementById('search').addEventListener('submit', (event) => {
  event.preventDefault();
  window.fixtureNavigate(`/results?search_query=${encodeURIComponent(event.target.search_query.value)}`);
});
window.addEventListener('popstate', render);
if (new URLSearchParams(location.search).has('dark')) document.documentElement.setAttribute('dark', '');
render();
