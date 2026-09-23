'use strict';

/**
 * Escape plain text to safe HTML entities.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Asynchronously send a moderation notification via Resend API.
 * Any network or API failures are caught and logged so commenter requests
 * are never affected or blocked.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.from
 * @param {string} options.to
 * @param {string} options.articleTitle
 * @param {string} options.articleUrl
 * @param {string} options.commenterName
 * @param {string} options.content
 * @param {string} options.createdAt
 * @param {string} options.moderationUrl
 */
async function sendCommentNotification({
  apiKey,
  from,
  to,
  articleTitle,
  articleUrl,
  commenterName,
  content,
  createdAt,
  moderationUrl
}) {
  if (!apiKey || !to || !from) return;

  const subject = `【待审核评论】${articleTitle || '新评论'}`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #222; margin: 0; padding: 20px; background-color: #f7f9fa; }
    .card { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; border: 1px solid #e1e8ed; padding: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.04); }
    h2 { margin-top: 0; color: #1a1a1a; font-size: 1.25rem; border-bottom: 2px solid #0066cc; padding-bottom: 8px; }
    .meta { font-size: 0.9rem; color: #555; margin-bottom: 16px; }
    .meta p { margin: 4px 0; }
    .content-box { background: #f4f6f8; border-left: 4px solid #0066cc; padding: 12px 16px; border-radius: 4px; font-size: 0.95rem; white-space: pre-wrap; word-break: break-word; margin: 16px 0; color: #111; }
    .btn-container { margin-top: 24px; text-align: center; }
    .btn { display: inline-block; padding: 10px 20px; background-color: #0066cc; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 0.95rem; }
    .footer { margin-top: 24px; font-size: 0.8rem; color: #888; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📝 博客新评论待审核通知</h2>
    <div class="meta">
      <p><strong>文章：</strong><a href="${escapeHtml(articleUrl)}" target="_blank" rel="noopener">${escapeHtml(articleTitle)}</a></p>
      <p><strong>评论者：</strong>${escapeHtml(commenterName)}</p>
      <p><strong>提交时间：</strong>${escapeHtml(createdAt)}</p>
    </div>
    <div class="content-box">${escapeHtml(content)}</div>
    <div class="btn-container">
      <a class="btn" href="${escapeHtml(moderationUrl)}" target="_blank" rel="noopener">前往后台审核评论</a>
    </div>
    <div class="footer">
      本邮件由个人博客评论系统自动发送至管理员信箱。
    </div>
  </div>
</body>
</html>
  `.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html
      })
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[comments-notify] Resend API responded with ${res.status}: ${errBody}`);
    } else {
      console.info('[comments-notify] notification email sent successfully');
    }
  } catch (error) {
    console.warn(`[comments-notify] failed to send notification: ${error.message}`);
  }
}

module.exports = {
  sendCommentNotification
};
