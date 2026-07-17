(() => {
  const form = document.getElementById('analytics-filter-form');
  for (const shortcut of document.querySelectorAll('.analytics-filter-shortcut')) {
    shortcut.addEventListener('click', () => {
      if (!form) return;
      const input = form.elements[shortcut.dataset.filterName];
      if (!input) return;
      let value = shortcut.dataset.filterValue;
      if (['subdivision', 'city'].includes(shortcut.dataset.filterName) && value.includes(':')) {
        const separator = value.indexOf(':');
        const country = form.elements.country;
        if (country) country.value = value.slice(0, separator);
        value = value.slice(separator + 1);
      }
      input.value = value;
      form.requestSubmit();
    });
  }

  const status = document.getElementById('analytics-detail-status');
  const panel = document.getElementById('analytics-detail-panel');
  const detailJson = document.getElementById('analytics-detail-json');
  const fields = {
    id: document.getElementById('analytics-detail-id'),
    time: document.getElementById('analytics-detail-time'),
    displayPath: document.getElementById('analytics-detail-display-path'),
    rawPath: document.getElementById('analytics-detail-raw-path'),
    ip: document.getElementById('analytics-detail-ip'),
    browser: document.getElementById('analytics-detail-browser')
  };

  function setStatus(message, error = false) {
    status.hidden = false;
    status.textContent = message;
    status.className = error ? 'message error' : 'message info';
  }

  function setText(target, value) {
    target.textContent = value === null || value === undefined || value === '' ? '未知' : String(value);
  }

  async function showDetail(eventId) {
    panel.hidden = true;
    setStatus('正在加载访问详情……');
    try {
      const response = await fetch(`/api/admin/analytics/events/${encodeURIComponent(eventId)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = await response.json();
      setText(fields.id, detail.id);
      setText(fields.time, detail.observedAtUtc);
      setText(fields.displayPath, detail.displayPath);
      setText(fields.rawPath, detail.requestPath);
      setText(fields.ip, detail.ipAddress);
      setText(fields.browser, `${detail.client?.browser?.name || '未知'} ${detail.client?.browser?.version || ''}`.trim());
      detailJson.textContent = JSON.stringify(detail, null, 2);
      status.hidden = true;
      panel.hidden = false;
      panel.focus();
    } catch {
      setStatus('访问详情加载失败，请稍后重试。', true);
      status.focus();
    }
  }

  for (const button of document.querySelectorAll('.analytics-detail-button')) {
    button.addEventListener('click', () => showDetail(button.dataset.eventId));
  }
})();
