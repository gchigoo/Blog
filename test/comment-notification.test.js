'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseCommentsConfig } = require('../server/comments/config');
const { buildNotificationMessage, sendCommentNotification } = require('../server/comments/notification');

const COMMENT_ENV = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'https://blog.example.test/auth/google/callback',
  COMMENT_SESSION_SECRET: 'x'.repeat(48)
};

function decodeHeader(value) {
  return value
    .split('\n ')
    .map(word => {
      const match = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(word);
      return match ? Buffer.from(match[1], 'base64').toString('utf8') : word;
    })
    .join('');
}

function parseMessage(message) {
  const [head, body] = message.split('\n\n');
  const headers = {};
  let name;
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) {
      headers[name] += `\n${line}`;
      continue;
    }
    const index = line.indexOf(':');
    name = line.slice(0, index);
    headers[name] = line.slice(index + 2);
  }
  return { headers, body };
}

test('notifications are enabled only by COMMENT_NOTIFY_SENDMAIL', () => {
  assert.deepEqual(parseCommentsConfig(COMMENT_ENV).notification, { enabled: false });
  assert.deepEqual(parseCommentsConfig({ ...COMMENT_ENV, RESEND_API_KEY: 're_x' }).notification, { enabled: false });
  assert.deepEqual(parseCommentsConfig({ ...COMMENT_ENV, COMMENT_NOTIFY_SENDMAIL: ' /usr/sbin/sendmail ' }).notification, {
    enabled: true,
    sendmailPath: '/usr/sbin/sendmail',
    to: 'stanz.guo@gmail.com',
    from: 'Blog Notifications <blog@fangmo.dev>'
  });
});

test('message has the required headers, an encoded subject and a base64 HTML body', () => {
  const subject = '【待审核评论】一篇标题很长的文章，用来确认编码后的主题会被拆成多段而且每段都不超过限制';
  const html = '<p>评论内容</p>';
  const { headers, body } = parseMessage(buildNotificationMessage({
    from: 'Blog Notifications <blog@fangmo.dev>',
    to: 'admin@example.test',
    subject,
    html,
    date: new Date('2026-10-21T08:00:00Z')
  }));

  assert.equal(headers.From, 'Blog Notifications <blog@fangmo.dev>');
  assert.equal(headers.To, 'admin@example.test');
  assert.equal(headers.Date, 'Wed, 21 Oct 2026 08:00:00 GMT');
  assert.match(headers['Message-ID'], /^<[0-9a-f-]{36}@fangmo\.dev>$/);
  assert.equal(headers['Content-Type'], 'text/html; charset=UTF-8');
  assert.equal(decodeHeader(headers.Subject), subject);
  for (const word of headers.Subject.split('\n ')) assert.ok(word.length <= 75, word);
  assert.equal(Buffer.from(body.replace(/\n/g, ''), 'base64').toString('utf8'), html);
  for (const line of body.split('\n')) assert.ok(line.length <= 76);
});

test('a title with line breaks cannot add headers', () => {
  const { headers } = parseMessage(buildNotificationMessage({
    from: 'blog@fangmo.dev',
    to: 'admin@example.test',
    subject: 'Title\nBcc: victim@example.test',
    html: '<p>x</p>'
  }));
  assert.equal(headers.Bcc, undefined);
  assert.equal(decodeHeader(headers.Subject), 'Title\nBcc: victim@example.test');
  assert.throws(() => buildNotificationMessage({ from: 'a@b\nBcc: c@d', to: 'x@y', subject: 's', html: '' }));
});

test('sendmail receives the envelope sender and the message', {
  skip: process.platform === 'win32' ? 'POSIX sendmail script only' : false
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-notify-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sendmail = path.join(dir, 'sendmail');
  await fs.writeFile(sendmail, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/message"\n`, { mode: 0o755 });

  await sendCommentNotification({
    sendmailPath: sendmail,
    from: 'Blog Notifications <blog@fangmo.dev>',
    to: 'admin@example.test',
    articleTitle: '测试文章',
    articleUrl: 'https://blog.example.test/zh/article/test',
    commenterName: '<script>',
    content: 'hello',
    createdAt: '2026-10-21T08:00:00.000Z',
    moderationUrl: 'https://blog.example.test/admin/comments?status=pending'
  });

  assert.deepEqual((await fs.readFile(path.join(dir, 'args'), 'utf8')).trim().split('\n'), ['-t', '-oi', '-f', 'blog@fangmo.dev']);
  const { headers, body } = parseMessage(await fs.readFile(path.join(dir, 'message'), 'utf8'));
  assert.equal(decodeHeader(headers.Subject), '【待审核评论】测试文章');
  const html = Buffer.from(body.replace(/\n/g, ''), 'base64').toString('utf8');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('a failing sendmail is logged and never rejects', {
  skip: process.platform === 'win32' ? 'POSIX sendmail script only' : false
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-notify-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sendmail = path.join(dir, 'sendmail');
  await fs.writeFile(sendmail, '#!/bin/sh\ncat > /dev/null\necho "msmtp: authentication failed" >&2\nexit 77\n', { mode: 0o755 });
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));

  await sendCommentNotification({
    sendmailPath: sendmail,
    from: 'blog@fangmo.dev',
    to: 'admin@example.test',
    articleTitle: 't',
    content: 'c'
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sendmail exited with 77: msmtp: authentication failed/);
});
