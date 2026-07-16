document.addEventListener('DOMContentLoaded', () => {
  const message = document.querySelector('#moderation-message');

  function showMessage(type, text) {
    message.textContent = text;
    message.className = `message ${type}`;
    message.focus();
  }

  document.querySelectorAll('[data-moderation-action]').forEach(button => {
    button.addEventListener('click', async () => {
      const card = button.closest('[data-comment-id]');
      const commentId = card.dataset.commentId;
      const action = button.dataset.moderationAction;
      if (action === 'delete' && !window.confirm('确定永久删除这条评论吗？')) return;

      card.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try {
        const response = await fetch(`/api/admin/comments/${commentId}`, {
          method: action === 'delete' ? 'DELETE' : 'PATCH',
          headers: action === 'delete' ? {} : { 'content-type': 'application/json' },
          body: action === 'delete' ? undefined : JSON.stringify({ status: action })
        });
        if (!response.ok) throw new Error('moderation_failed');
        showMessage('success', action === 'delete' ? '评论已删除。' : '评论状态已更新。');
        card.remove();
      } catch {
        card.querySelectorAll('button').forEach(item => { item.disabled = false; });
        showMessage('error', '操作失败，请刷新后重试。');
      }
    });
  });
});
