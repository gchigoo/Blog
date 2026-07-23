const scenarios = Object.freeze([
  { id: 'home-anonymous', path: '/' },
  { id: 'home-admin', path: '/__visual/home-admin' },
  { id: 'article-comments-disabled', path: '/article/comments-disabled' },
  { id: 'article-comments-guest', path: '/article/comments-browser-smoke' },
  {
    id: 'article-comments-commenter',
    setupPath: '/__test/commenter-login',
    path: '/article/comments-browser-smoke'
  },
  { id: 'article-comments-empty', path: '/article/comments-empty' },
  { id: 'archive', path: '/archive' },
  { id: 'tags', path: '/tags' },
  { id: 'tag-upgrade', path: '/tag/upgrade' },
  { id: 'search', path: '/search?q=EJS' },
  { id: 'about', path: '/about' },
  { id: 'not-found', path: '/visual-not-found' },
  { id: 'admin-login', path: '/admin/login' },
  { id: 'admin-upload', path: '/admin/upload' },
  { id: 'admin-articles', path: '/admin/articles' },
  { id: 'admin-analytics', path: '/admin/analytics' },
  {
    id: 'admin-comments-pending',
    setupPath: '/__test/admin-login',
    path: '/admin/comments?status=pending'
  },
  {
    id: 'admin-comments-approved',
    setupPath: '/__test/admin-login',
    path: '/admin/comments?status=approved'
  }
]);

module.exports = { scenarios };
