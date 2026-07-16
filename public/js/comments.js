document.addEventListener('DOMContentLoaded', () => {
  const commentForm = document.querySelector('#comment-form');
  const feedback = document.querySelector('#comment-feedback');

  if (commentForm && feedback) {
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
        if (!response.ok) throw new Error(body.error || 'comment_failed');

        commentForm.reset();
        feedback.textContent = body.message;
        feedback.className = 'message success';
      } catch {
        feedback.textContent = '评论提交失败，请检查内容后重试。';
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
