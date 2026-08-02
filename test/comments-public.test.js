const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const express = require('express');
const { parseCommentsConfig } = require('../server/comments/config');
const { createCommentsModule } = require('../server/comments/module');
const { createTranslator } = require('../server/i18n/messages');
const { localeMetadata } = require('../server/i18n/config');

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
      locale TEXT NOT NULL DEFAULT 'zh' CHECK (locale IN ('zh', 'en')),
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      html TEXT NOT NULL,
      tags TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(locale, slug)
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    INSERT INTO articles (locale, title, slug, content, html, tags, created_at)
    VALUES ('zh', 'Article', 'article', 'body', '<p>body</p>', '[]', '2026-07-16T00:00:00.000Z');
    INSERT INTO articles (locale, title, slug, content, html, tags, created_at)
    VALUES ('en', 'English Article', 'article', 'body', '<p>body</p>', '[]', '2026-07-16T00:00:00.000Z');
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
    // Optional localized rendering: `?locale=en` installs the same locale
    // locals a production localized route would set; the default keeps the
    // legacy fallback so existing zh assertions are untouched.
    const locale = req.query.locale === 'en' ? 'en' : req.query.locale === 'zh' ? 'zh' : null;
    const article = locale
      ? db.prepare('SELECT * FROM articles WHERE locale = ? AND slug = ?').get(locale, req.params.slug)
      : db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
    if (!article) return res.status(404).end();
    if (locale) {
      res.locals.locale = locale;
      res.locals.i18n = createTranslator(locale);
      res.locals.localeMeta = localeMetadata(locale);
      res.locals.localizedPath = pathname => `/${locale}${pathname}`;
    }
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
  assert.equal(body.code, 'comment_submitted');
  assert.equal(body.message, undefined);
  assert.equal(body.comment.status, 'pending');
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

test('localized article pages link the locale-correct login return and keep sibling threads isolated', async t => {
  const { baseUrl, db } = await createHarness(t);
  const session = await login(baseUrl);
  const response = await submit(baseUrl, session, {
    content: 'zh thread only',
    csrfToken: session.csrfToken
  });
  assert.equal(response.status, 201);
  db.prepare(`
    UPDATE comments SET status = 'approved', reviewed_at = ?, reviewed_by = NULL
    WHERE id = ?
  `).run('2026-07-16T02:00:00.000Z', (await response.json()).comment.id);

  const zhPage = await (await fetch(`${baseUrl}/article/article?locale=zh`)).text();
  assert.match(zhPage, /href="\/auth\/google\?returnTo=%2Fzh%2Farticle%2Farticle"/);
  assert.match(zhPage, /zh thread only/);
  assert.match(zhPage, /使用 Google 登录后评论/);

  const enPage = await (await fetch(`${baseUrl}/article/article?locale=en`)).text();
  assert.match(enPage, /href="\/auth\/google\?returnTo=%2Fen%2Farticle%2Farticle"/);
  assert.doesNotMatch(enPage, /zh thread only/);
  assert.match(enPage, /No approved comments yet\./);
  assert.match(enPage, /Sign in with Google to comment/);
  assert.match(enPage, /lang="en"/);

  // The English login round trip returns to the English article and the
  // issued comment session Cookie works on that English page.
  const enLogin = await fetch(
    `${baseUrl}/auth/google?returnTo=${encodeURIComponent('/en/article/article')}`,
    { redirect: 'manual' }
  );
  const oauthCookie = extractCookie(enLogin, 'comment_oauth');
  const state = new URL(enLogin.headers.get('location')).searchParams.get('state');
  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=valid&state=${encodeURIComponent(state)}`,
    { headers: { cookie: oauthCookie }, redirect: 'manual' }
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/en/article/article');
  const enSessionCookie = extractCookie(callback, 'comment_session');
  const loggedInEnPage = await (await fetch(`${baseUrl}/article/article?locale=en`, {
    headers: { cookie: enSessionCookie }
  })).text();
  assert.match(loggedInEnPage, /id="comment-form"/);
  assert.match(loggedInEnPage, /Commenting as Reader &lt;One&gt;\./);
});

test('comment form renders localized data attributes for every machine code', async t => {
  const { baseUrl } = await createHarness(t);
  const session = await login(baseUrl);
  const zhLoggedIn = await (await fetch(`${baseUrl}/article/article?locale=zh`, {
    headers: { cookie: session.sessionCookie }
  })).text();
  for (const attribute of [
    'data-comment-submitted="评论已提交，等待审核"',
    'data-comment-login-required="请先登录后再评论。"',
    'data-comment-invalid-csrf="登录状态已过期，请重新登录。"',
    'data-comment-article-not-found="文章不存在或已删除。"',
    'data-comment-invalid-content="评论内容无效，请检查后重试。"',
    'data-comment-rate-limited="评论过于频繁，请稍后再试。"',
    'data-comment-server-error="评论提交失败，请稍后重试。"',
    'data-comment-unknown-error="评论提交失败，请检查内容后重试。"'
  ]) {
    assert.match(zhLoggedIn, new RegExp(attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const enLoggedIn = await (await fetch(`${baseUrl}/article/article?locale=en`, {
    headers: { cookie: session.sessionCookie }
  })).text();
  assert.match(enLoggedIn, /data-comment-submitted="Comment submitted for review"/);
  assert.match(enLoggedIn, /data-comment-rate-limited="You are commenting too quickly\. Please try again later\."/);
});

test('comments.js maps stable codes to page-provided localized strings via textContent', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'public/js/comments.js'), 'utf8');

  function runSubmit({ status, body, dataset, networkError = false }) {
    const formListeners = {};
    const state = {
      feedbackText: null,
      feedbackClass: null,
      feedbackHidden: true,
      feedbackFocusCount: 0,
      formReset: false,
      submitDisabled: true
    };
    const feedback = {
      textContent: '',
      className: '',
      hidden: true,
      focus() { state.feedbackFocusCount += 1; }
    };
    const submitButton = { disabled: false };
    const form = {
      action: '/api/articles/1/comments',
      dataset: dataset || {},
      querySelector(selector) {
        return selector === 'button[type="submit"]' ? submitButton : null;
      },
      addEventListener(event, callback) { formListeners[event] = callback; },
      reset() { state.formReset = true; }
    };
    const elements = {
      '#comment-form': form,
      '#comment-feedback': feedback,
      '#comment-logout-form': null
    };
    let onReady = null;
    const context = {
      document: {
        addEventListener(event, callback) {
          if (event === 'DOMContentLoaded') onReady = callback;
        },
        querySelector(selector) { return elements[selector] || null; }
      },
      FormData: function FormData() { return new Map(); },
      fetch: async () => {
        if (networkError) throw new Error('network unavailable');
        return { ok: status >= 200 && status < 300, json: async () => body };
      },
      window: { location: { reload() {} } }
    };
    vm.runInNewContext(source, context);
    return Promise.resolve(onReady())
      .then(() => formListeners.submit({ preventDefault() {} }))
      .then(() => {
        state.feedbackText = feedback.textContent;
        state.feedbackClass = feedback.className;
        state.feedbackHidden = feedback.hidden;
        state.submitDisabled = submitButton.disabled;
        return state;
      });
  }

  const zhMessages = {
    commentSubmitted: '评论已提交，等待审核',
    commentLoginRequired: '请先登录后再评论。',
    commentInvalidCsrf: '登录状态已过期，请重新登录。',
    commentArticleNotFound: '文章不存在或已删除。',
    commentInvalidContent: '评论内容无效，请检查后重试。',
    commentRateLimited: '评论过于频繁，请稍后再试。',
    commentServerError: '评论提交失败，请稍后重试。',
    commentUnknownError: '评论提交失败，请检查内容后重试。'
  };
  const enMessages = {
    commentSubmitted: 'Comment submitted for review',
    commentLoginRequired: 'Please sign in before commenting.',
    commentInvalidCsrf: 'Your session expired. Please sign in again.',
    commentArticleNotFound: 'This article was not found or has been removed.',
    commentInvalidContent: 'Invalid comment content. Please check your comment and try again.',
    commentRateLimited: 'You are commenting too quickly. Please try again later.',
    commentServerError: 'Comment submission failed. Please try again later.',
    commentUnknownError: 'Comment submission failed. Please check your comment and try again.'
  };

  const success = await runSubmit({
    status: 201,
    body: { code: 'comment_submitted', comment: { id: 1, status: 'pending' } },
    dataset: zhMessages
  });
  assert.equal(success.feedbackText, '评论已提交，等待审核');
  assert.equal(success.feedbackClass, 'message success');
  assert.equal(success.formReset, true);
  assert.equal(success.feedbackHidden, false);
  assert.equal(success.submitDisabled, false);
  assert.ok(success.feedbackFocusCount >= 1);

  const cases = [
    [401, { error: 'comment_login_required' }, '请先登录后再评论。'],
    [403, { error: 'invalid_csrf_token' }, '登录状态已过期，请重新登录。'],
    [404, { error: 'article_not_found' }, '文章不存在或已删除。'],
    [422, { error: 'invalid_comment_content' }, '评论内容无效，请检查后重试。'],
    [429, { error: 'comment_rate_limited' }, '评论过于频繁，请稍后再试。'],
    [500, { error: 'comment_create_failed' }, '评论提交失败，请稍后重试。'],
    [200, {}, '评论提交失败，请检查内容后重试。']
  ];
  for (const [status, body, expected] of cases) {
    const state = await runSubmit({ status, body, dataset: zhMessages });
    assert.equal(state.feedbackText, expected, `status ${status}`);
    assert.equal(state.feedbackClass, 'message error', `status ${status}`);
    assert.equal(state.formReset, false, `status ${status}`);
    assert.ok(state.feedbackFocusCount >= 1, `focus preserved for status ${status}`);
  }

  const network = await runSubmit({ status: 500, body: {}, dataset: zhMessages, networkError: true });
  assert.equal(network.feedbackText, '评论提交失败，请检查内容后重试。');
  assert.equal(network.feedbackClass, 'message error');

  const enSuccess = await runSubmit({
    status: 201,
    body: { code: 'comment_submitted', comment: { id: 2, status: 'pending' } },
    dataset: enMessages
  });
  assert.equal(enSuccess.feedbackText, 'Comment submitted for review');
  assert.equal(enSuccess.feedbackClass, 'message success');
  const enLimited = await runSubmit({
    status: 429,
    body: { error: 'comment_rate_limited' },
    dataset: enMessages
  });
  assert.equal(enLimited.feedbackText, 'You are commenting too quickly. Please try again later.');
});
