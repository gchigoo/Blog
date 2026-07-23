const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const express = require('express');
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
  `);
  const identityState = {
    identity: { subject: 'stable-google-sub', displayName: 'Reader <One>' }
  };
  const identityClient = {
    createAuthorizationUrl({ state, codeChallenge }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      return url.toString();
    },
    async exchangeCode() {
      return identityState.identity;
    }
  };
  const clock = { now: () => new Date('2026-07-16T01:00:00.000Z') };
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
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(comments.commenterSession);
  app.use(comments.authRouter);
  app.use(comments.publicRouter);
  app.get('/_session', (req, res) => {
    res.json({ csrfToken: req.commentSession?.csrfToken || null });
  });
  app.get('/article/:slug', (req, res) => {
    const article = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
    if (!article) return res.status(404).end();
    article.tags = JSON.parse(article.tags || '[]');
    return res.render('article', {
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
    db,
    identityState
  };
}

async function login(baseUrl) {
  const start = await fetch(`${baseUrl}/auth/google?returnTo=/article/article`, {
    redirect: 'manual'
  });
  const oauthCookie = extractCookie(start, 'comment_oauth');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=valid&state=${encodeURIComponent(state)}`,
    { headers: { cookie: oauthCookie }, redirect: 'manual' }
  );
  const sessionCookie = extractCookie(callback, 'comment_session');
  const sessionResponse = await fetch(`${baseUrl}/_session`, {
    headers: { cookie: sessionCookie }
  });
  return {
    csrfToken: (await sessionResponse.json()).csrfToken,
    sessionCookie
  };
}

async function submit(baseUrl, session, body, articleId = 1) {
  return fetch(`${baseUrl}/api/articles/${articleId}/comments`, {
    method: 'POST',
    headers: {
      cookie: session?.sessionCookie || '',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('comment submission requires an independent commenter session and CSRF token', async t => {
  const { baseUrl, db } = await createHarness(t);
  const anonymous = await submit(baseUrl, null, { content: 'anonymous', csrfToken: 'x' });
  assert.equal(anonymous.status, 401);

  const session = await login(baseUrl);
  const forged = await submit(baseUrl, session, {
    content: 'forged',
    csrfToken: 'wrong-token'
  });
  assert.equal(forged.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 0);
});

test('valid plain text is stored pending, hidden until approval, and escaped when rendered', async t => {
  const { baseUrl, db, identityState } = await createHarness(t);
  const session = await login(baseUrl);
  const content = '  <script>alert("x")</script>\nThanks  ';
  const response = await submit(baseUrl, session, {
    content,
    csrfToken: session.csrfToken
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.comment.status, 'pending');
  assert.equal(body.message, '评论已提交，等待审核');
  const stored = db.prepare('SELECT * FROM comments').get();
  assert.equal(stored.content, '<script>alert("x")</script>\nThanks');
  assert.equal(stored.status, 'pending');

  const pendingPage = await (await fetch(`${baseUrl}/article/article`)).text();
  assert.doesNotMatch(pendingPage, /alert\(&#34;x&#34;\)/);

  db.prepare(`
    UPDATE comments
    SET status = 'approved', reviewed_at = ?, reviewed_by = NULL
    WHERE id = ?
  `).run('2026-07-16T02:00:00.000Z', stored.id);
  const approvedPage = await (await fetch(`${baseUrl}/article/article`)).text();
  assert.doesNotMatch(approvedPage, /<script>alert/);
  assert.match(approvedPage, /&lt;script&gt;alert\(&#34;x&#34;\)&lt;\/script&gt;/);
  assert.match(approvedPage, /Reader &lt;One&gt;/);
  assert.match(approvedPage, /<div class="comment-meta">/);
  assert.doesNotMatch(approvedPage, /<header class="comment-meta">/);
  assert.doesNotMatch(approvedPage, /email|avatar/i);

  identityState.identity = { subject: 'stable-google-sub', displayName: 'Renamed Reader' };
  await login(baseUrl);
  const renamedPage = await (await fetch(`${baseUrl}/article/article`)).text();
  assert.match(renamedPage, /Renamed Reader/);
  assert.doesNotMatch(renamedPage, /Reader &lt;One&gt;/);
});

test('article UI explains public display names and exposes the correct login or form state', async t => {
  const { baseUrl } = await createHarness(t);
  const loggedOutPage = await (await fetch(`${baseUrl}/article/article`)).text();
  assert.match(loggedOutPage, /id="comments"/);
  assert.match(loggedOutPage, /Google 登录/);
  assert.match(loggedOutPage, /审核通过/);
  assert.match(loggedOutPage, /当前 Google 展示名称/);
  assert.match(loggedOutPage, /\/css\/custom\.css/);
  assert.match(loggedOutPage, /\/js\/comments\.js/);
  assert.match(loggedOutPage, /\/vendor\/inter\.css/);
  assert.doesNotMatch(loggedOutPage, /fonts\.xz\.style|cdn\.jsdelivr\.net/);
  assert.doesNotMatch(loggedOutPage, /id="comment-form"/);

  const session = await login(baseUrl);
  const loggedInPage = await (await fetch(`${baseUrl}/article/article`, {
    headers: { cookie: session.sessionCookie }
  })).text();
  assert.match(loggedInPage, /id="comment-form"/);
  assert.match(loggedInPage, /class="comment-identity"/);
  assert.match(loggedInPage, /class="comment-form-actions"/);
  const customCss = fs.readFileSync(path.resolve(__dirname, '..', 'public/css/custom.css'), 'utf8');
  assert.match(
    customCss,
    /\.secondary-button\.comment-logout-button\s*\{[^}]*background:\s*transparent/s
  );
  assert.match(
    customCss,
    /\.comment-identity p\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s
  );
  assert.match(
    customCss,
    /\.moderation-meta\s*>\s*\*\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s
  );
  assert.match(loggedInPage, new RegExp(`value="${session.csrfToken}"`));
  assert.match(loggedInPage, /Reader &lt;One&gt;/);
});

test('content uses Unicode code-point limits and returns stable 404, 422, and 429 errors', async t => {
  const { baseUrl, db } = await createHarness(t);
  const session = await login(baseUrl);

  const blank = await submit(baseUrl, session, {
    content: '   ',
    csrfToken: session.csrfToken
  });
  assert.equal(blank.status, 422);

  const tooLong = await submit(baseUrl, session, {
    content: '😀'.repeat(1001),
    csrfToken: session.csrfToken
  });
  assert.equal(tooLong.status, 422);

  const missingArticle = await submit(baseUrl, session, {
    content: 'valid',
    csrfToken: session.csrfToken
  }, 999);
  assert.equal(missingArticle.status, 404);

  for (let index = 0; index < 5; index += 1) {
    const response = await submit(baseUrl, session, {
      content: index === 0 ? '😀'.repeat(1000) : `valid ${index}`,
      csrfToken: session.csrfToken
    });
    assert.equal(response.status, 201);
  }
  const limited = await submit(baseUrl, session, {
    content: 'sixth',
    csrfToken: session.csrfToken
  });
  assert.equal(limited.status, 429);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count, 5);
});
