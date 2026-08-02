document.addEventListener('DOMContentLoaded', () => {
  const commentForm = document.querySelector('#comment-form');
  const feedback = document.querySelector('#comment-feedback');

  if (commentForm && feedback) {
    // The page provides localized strings through escaped data-* attributes;
    // every message is written with textContent, never HTML.
    const messages = {
      success: commentForm.dataset.commentSubmitted || '评论已提交，等待审核',
      loginRequired: commentForm.dataset.commentLoginRequired || '请先登录后再评论。',
      invalidCsrf: commentForm.dataset.commentInvalidCsrf || '登录状态已过期，请重新登录。',
      articleNotFound: commentForm.dataset.commentArticleNotFound || '文章不存在或已删除。',
      invalidContent: commentForm.dataset.commentInvalidContent || '评论内容无效，请检查后重试。',
      rateLimited: commentForm.dataset.commentRateLimited || '评论过于频繁，请稍后再试。',
      serverError: commentForm.dataset.commentServerError || '评论提交失败，请稍后重试。',
      unknown: commentForm.dataset.commentUnknownError || '评论提交失败，请检查内容后重试。'
    };

    function messageForCode(code) {
      switch (code) {
        case 'comment_submitted':
          return { text: messages.success, success: true };
        case 'comment_login_required':
          return { text: messages.loginRequired };
        case 'invalid_csrf_token':
          return { text: messages.invalidCsrf };
        case 'article_not_found':
          return { text: messages.articleNotFound };
        case 'invalid_comment_content':
          return { text: messages.invalidContent };
        case 'comment_rate_limited':
          return { text: messages.rateLimited };
        case 'comment_create_failed':
          return { text: messages.serverError };
        default:
          return { text: messages.unknown };
      }
    }

    commentForm.addEventListener('submit', async event => {
      event.preventDefault();
      const submitButton = commentForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      feedback.hidden = true;

      try {
        const response = await fetch(commentForm.action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(commentForm)))
        });
        const body = await response.json();
        const code = body && typeof body.code === 'string'
          ? body.code
          : body && typeof body.error === 'string' ? body.error : 'unknown';
        const mapped = messageForCode(code);
        if (response.ok && mapped.success) {
          commentForm.reset();
          feedback.textContent = mapped.text;
          feedback.className = 'message success';
        } else {
          feedback.textContent = mapped.text;
          feedback.className = 'message error';
        }
      } catch {
        feedback.textContent = messages.unknown;
        feedback.className = 'message error';
      } finally {
        submitButton.disabled = false;
        feedback.hidden = false;
        feedback.focus();
      }
    });
  }

  const logoutForm = document.querySelector('#comment-logout-form');
  if (logoutForm) {
    logoutForm.addEventListener('submit', async event => {
      event.preventDefault();
      const response = await fetch(logoutForm.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(logoutForm)))
      });
      if (response.ok) window.location.reload();
    });
  }
});
