const scenarios = Object.freeze([
  { id: 'home-anonymous', path: '/zh/' },
  { id: 'home-admin', path: '/zh/__visual/home-admin' },
  { id: 'article-comments-disabled', path: '/zh/article/comments-disabled' },
  { id: 'article-comments-guest', path: '/zh/article/comments-browser-smoke' },
  {
    id: 'article-comments-commenter',
    setupPath: '/zh/__test/commenter-login',
    path: '/zh/article/comments-browser-smoke'
  },
  { id: 'article-comments-empty', path: '/zh/article/comments-empty' },
  { id: 'archive', path: '/zh/archive' },
  { id: 'tags', path: '/zh/tags' },
  { id: 'tag-upgrade', path: '/zh/tag/upgrade' },
  { id: 'search', path: '/zh/search?q=EJS' },
  { id: 'about', path: '/zh/about' },
  { id: 'not-found', path: '/zh/__visual/not-found' },
  { id: 'home-en', path: '/en/' },
  { id: 'article-en', path: '/en/article/comments-browser-smoke-en' },
  { id: 'tags-en', path: '/en/tags' },
  { id: 'about-en', path: '/en/about' },
  { id: 'category-technology', path: '/en/category/technology' },
  { id: 'article-audio-en', path: '/en/__audio/article' },
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
