const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const express = require('express');
const jwt = require('jsonwebtoken');
const appConfig = require('../server/config');
const { parseCommentsConfig } = require('../server/comments/config');
const { createCommentsModule } = require('../server/comments/module');

function getSetCookies(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
}

function extractCookie(response, name) {
  const header = getSetCookies(response).find(value => value.startsWith(`${name}=`));
  assert.ok(header, `missing ${name} cookie`);
  return header.split(';', 1)[0];
}

function adminCookie(id = 1, username = `admin-${id}`) {
  const token = jwt.sign({ id, username }, appConfig.jwtSecret, { expiresIn: '5m' });
  return `token=${token}`;
}

function mutableClock() {
  let now = Date.parse('2026-07-16T01:00:00.000Z');
  return {
    now: () => new Date(now),
    advance: milliseconds => { now += milliseconds; }
  };
}

async function createHarness(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      tags TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    INSERT INTO articles (title, slug, content, html, tags, created_at)
    VALUES ('Article', 'article', 'body', '<p>body</p>', '[]', '2026-07-16T00:00:00.000Z');
    INSERT INTO users (username) VALUES ('admin-1'), ('admin-2');
  `);
  const clock = mutableClock();
  const identityClient = {
    createAuthorizationUrl({ state }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchangeCode() {
      return { subject: 'commenter-sub', displayName: 'Commenter' };
    }
  };
  const comments = createCommentsModule({
    db,
    config: parseCommentsConfig({
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/auth/google/callback',
      COMMENT_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      NODE_ENV: 'test'
    }),
    identityClient,
    clock
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', 'views'));
  app.locals.commentsEnabled = true;
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(comments.commenterSession);
  app.use(comments.authRouter);
  app.use(comments.publicRouter);
  app.use(comments.adminRouter);
  app.get('/_session', (req, res) => {
    res.json({ csrfToken: req.commentSession?.csrfToken || null });
  });
  app.get('/article/:slug', (req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
    article.tags = JSON.parse(article.tags || '[]');
    res.render('article', {
      article,
      user: null,
      comments: comments.getArticleCommentsViewModel(article.id, {
        commenter: req.commenter,
        csrfToken: req.commentSession?.csrfToken || null
      })
    });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    clock,
    db
  };
}

function seedComment(db, { status = 'pending', content = 'moderate me' } = {}) {
  const user = db.prepare(`
    INSERT INTO comment_users (google_sub, display_name, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get('seed-subject', 'Seed Reader', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
  return db.prepare(`
    INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
    VALUES (1, ?, ?, ?, '2026-07-16T00:00:00.000Z')
    RETURNING id
  `).get(user.id, content, status).id;
}

async function loginCommenter(baseUrl) {
  const start = await fetch(`${baseUrl}/auth/google?returnTo=/article/article`, {
    redirect: 'manual'
  });
  const oauthCookie = extractCookie(start, 'comment_oauth');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=valid&state=${state}`,
    { headers: { cookie: oauthCookie }, redirect: 'manual' }
  );
  return extractCookie(callback, 'comment_session');
}

function moderate(baseUrl, commentId, status, options = {}) {
  return fetch(`${baseUrl}/api/admin/comments/${commentId}`, {
    method: 'PATCH',
    headers: {
      cookie: options.cookie || adminCookie(),
      origin: options.origin === undefined ? baseUrl : options.origin,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ status })
  });
}

test('commenter/admin identities and same-origin moderation boundary are isolated', async t => {
  const { baseUrl, db } = await createHarness(t);
  const commentId = seedComment(db);
  const commenterCookie = await loginCommenter(baseUrl);

  const commenterAttempt = await moderate(baseUrl, commentId, 'approved', {
    cookie: commenterCookie
  });
  assert.equal(commenterAttempt.status, 401);

  const forgedOrigin = await moderate(baseUrl, commentId, 'approved', {
    origin: 'https://evil.example'
  });
  assert.equal(forgedOrigin.status, 403);

  const missingOrigin = await fetch(`${baseUrl}/api/admin/comments/${commentId}`, {
    method: 'PATCH',
    headers: {
      cookie: adminCookie(),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ status: 'approved' })
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(db.prepare('SELECT status FROM comments WHERE id = ?').get(commentId).status, 'pending');

  const adminSubmit = await fetch(`${baseUrl}/api/articles/1/comments`, {
    method: 'POST',
    headers: { cookie: adminCookie(), 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'admin is not commenter', csrfToken: 'x' })
  });
  assert.equal(adminSubmit.status, 401);
});

test('approve/reject transitions change public visibility and idempotent review preserves metadata', async t => {
  const { baseUrl, clock, db } = await createHarness(t);
  const commentId = seedComment(db, { content: 'visible after approval' });

  const approvedResponse = await moderate(baseUrl, commentId, 'approved');
  assert.equal(approvedResponse.status, 200);
  const approved = (await approvedResponse.json()).comment;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewedBy, 1);
  assert.match(await (await fetch(`${baseUrl}/article/article`)).text(), /visible after approval/);

  clock.advance(60_000);
  const repeatedResponse = await moderate(baseUrl, commentId, 'approved', {
    cookie: adminCookie(2)
  });
  const repeated = (await repeatedResponse.json()).comment;
  assert.equal(repeated.reviewedBy, approved.reviewedBy);
  assert.equal(repeated.reviewedAt, approved.reviewedAt);

  const rejectedResponse = await moderate(baseUrl, commentId, 'rejected', {
    cookie: adminCookie(2)
  });
  assert.equal(rejectedResponse.status, 200);
  const rejected = (await rejectedResponse.json()).comment;
  assert.equal(rejected.reviewedBy, 2);
  assert.doesNotMatch(await (await fetch(`${baseUrl}/article/article`)).text(), /visible after approval/);

  const reapproved = await moderate(baseUrl, commentId, 'approved');
  assert.equal(reapproved.status, 200);
  assert.match(await (await fetch(`${baseUrl}/article/article`)).text(), /visible after approval/);

  const rollback = await moderate(baseUrl, commentId, 'pending');
  assert.equal(rollback.status, 422);
});

test('admin can hard-delete comments and repeated deletion returns 404', async t => {
  const { baseUrl, db } = await createHarness(t);
  const commentId = seedComment(db, { status: 'approved', content: 'delete permanently' });
  const headers = { cookie: adminCookie(), origin: baseUrl };

  const deleted = await fetch(`${baseUrl}/api/admin/comments/${commentId}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(deleted.status, 204);
  assert.doesNotMatch(await (await fetch(`${baseUrl}/article/article`)).text(), /delete permanently/);

  const repeated = await fetch(`${baseUrl}/api/admin/comments/${commentId}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(repeated.status, 404);
});

test('moderation page filters status, escapes content, and exposes the admin navigation entry', async t => {
  const { baseUrl, db } = await createHarness(t);
  seedComment(db, { content: '<script>pending</script>' });
  db.prepare(`
    INSERT INTO comments (article_id, comment_user_id, content, status, created_at)
    VALUES (1, 1, 'approved-only', 'approved', '2026-07-16T00:00:01.000Z')
  `).run();

  const response = await fetch(`${baseUrl}/admin/comments?status=pending`, {
    headers: { cookie: adminCookie() }
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /评论审核/);
  assert.match(html, /&lt;script&gt;pending&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>pending<\/script>/);
  assert.doesNotMatch(html, /approved-only/);
  assert.match(html, /href="\/admin\/comments"/);
  assert.match(html, /<div class="moderation-meta">/);
  assert.doesNotMatch(html, /<header class="moderation-meta">/);
});
