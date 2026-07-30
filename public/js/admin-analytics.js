(() => {
  const root = document.getElementById('event-list');
  const form = document.getElementById('analytics-filter-form');
  if (!root || !form) return;

  const summary = document.getElementById('analytics-event-summary');
  const tableBody = document.getElementById('analytics-event-table-body');
  const cards = document.getElementById('analytics-event-cards');
  const listStatus = document.getElementById('analytics-event-status');
  const pagination = root.querySelector('.analytics-event-pagination');
  const detailStatus = document.getElementById('analytics-detail-status');
  const detailPanel = document.getElementById('analytics-detail-panel');
  const detailJson = document.getElementById('analytics-detail-json');
  const detailFields = {
    id: document.getElementById('analytics-detail-id'),
    time: document.getElementById('analytics-detail-time'),
    displayPath: document.getElementById('analytics-detail-display-path'),
    rawPath: document.getElementById('analytics-detail-raw-path'),
    ip: document.getElementById('analytics-detail-ip'),
    browser: document.getElementById('analytics-detail-browser')
  };
  const emptyState = root.querySelector('.analytics-empty') || createEmptyState();
  const filterNames = [
    'days', 'search', 'traffic', 'ip', 'country', 'subdivision', 'city', 'browser',
    'os', 'device', 'pathPrefix', 'referrerHost', 'limit'
  ];

  let currentCursor = new URL(window.location.href).searchParams.get('cursor');
  let nextCursor = cursorFromPagination('next');
  let cursorStack = [];
  let activeController = null;
  let requestId = 0;
  let pendingRequest = null;

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createEmptyState() {
    const node = element('p', 'analytics-empty', '暂无符合条件的访问明细。可放宽搜索或筛选条件后重试。');
    node.hidden = true;
    tableBody.parentElement.parentElement.before(node);
    return node;
  }

  function safeValue(value, fallback = '未知') {
    return value === null || value === undefined || value === '' ? fallback : String(value);
  }

  function joinedName(value) {
    if (!value) return '未知';
    return `${safeValue(value.name)} ${value.version || ''}`.trim();
  }

  function locationText(item) {
    return [
      item.location?.country?.name,
      item.location?.subdivision?.name,
      item.location?.city
    ].map(value => safeValue(value)).join(' / ');
  }

  function eventPage(item) {
    return item.page || {
      title: safeValue(item.displayPath),
      displayPath: safeValue(item.displayPath)
    };
  }

  function trafficNodes(item) {
    const trafficKind = item.trafficKind === 'bot' ? 'bot' : 'human';
    const label = element(
      'span',
      `analytics-traffic-label ${trafficKind === 'bot' ? 'is-bot' : 'is-human'}`,
      trafficKind === 'bot' ? '爬虫' : '真人'
    );
    if (trafficKind !== 'bot') return [label];
    return [label, element('span', 'analytics-bot-name', safeValue(item.botName))];
  }

  function eventTime(item) {
    const node = element('time', '', formatBeijingTime(item.observedAtUtc));
    node.dateTime = safeValue(item.observedAtUtc, '');
    return node;
  }

  function detailButton(item) {
    const node = element('button', 'analytics-detail-button', '查看详情');
    node.type = 'button';
    node.dataset.eventId = safeValue(item.id, '');
    return node;
  }

  function eventRow(item) {
    const row = element('tr');
    row.dataset.trafficKind = item.trafficKind === 'bot' ? 'bot' : 'human';

    const timeCell = element('td');
    timeCell.append(eventTime(item));

    const pageCell = element('td');
    const pageContent = element('div', 'analytics-page-cell');
    pageContent.append(...trafficNodes(item));
    const page = eventPage(item);
    pageContent.append(
      element('strong', '', safeValue(page.title)),
      element('code', 'analytics-break', safeValue(page.displayPath))
    );
    pageCell.append(pageContent);

    const locationCell = element('td');
    locationCell.append(
      element('code', 'analytics-break', safeValue(item.ipAddress)),
      element('span', 'analytics-secondary-line', locationText(item))
    );

    const clientCell = element('td');
    clientCell.append(
      element('span', '', safeValue(item.client?.deviceType)),
      element(
        'span',
        'analytics-secondary-line',
        `${joinedName(item.client?.browser)} · ${joinedName(item.client?.os)}`
      )
    );

    const actionCell = element('td');
    actionCell.append(detailButton(item));
    row.append(timeCell, pageCell, locationCell, clientCell, actionCell);
    return row;
  }

  function eventCard(item) {
    const card = element('article', 'analytics-event-card');
    card.dataset.trafficKind = item.trafficKind === 'bot' ? 'bot' : 'human';

    const header = element('header', 'analytics-event-card-header');
    const traffic = element('div');
    traffic.append(...trafficNodes(item));
    header.append(traffic, eventTime(item));

    const page = eventPage(item);
    const pageContent = element('div', 'analytics-event-card-page');
    pageContent.append(
      element('strong', '', safeValue(page.title)),
      element('code', 'analytics-break', safeValue(page.displayPath))
    );

    const details = element('dl', 'analytics-event-card-details');
    const location = element('dd');
    location.append(
      element('code', 'analytics-break', safeValue(item.ipAddress)),
      element('span', '', locationText(item))
    );
    const client = element('dd');
    client.append(
      element('span', '', safeValue(item.client?.deviceType)),
      element('span', '', `${joinedName(item.client?.browser)} · ${joinedName(item.client?.os)}`)
    );
    details.append(
      element('dt', '', 'IP / 地区'),
      location,
      element('dt', '', '客户端'),
      client
    );

    card.append(header, pageContent, details, detailButton(item));
    return card;
  }

  function formatBeijingTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return safeValue(value);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(date);
  }

  function pageNumber() {
    return cursorStack.length + 1;
  }

  function pagingButton(direction, enabled) {
    const text = direction === 'previous' ? '← 上一页' : '下一页 →';
    const node = element('button', '', text);
    node.type = 'button';
    node.dataset.analyticsPage = direction;
    node.disabled = !enabled;
    return node;
  }

  function renderPagination() {
    pagination.replaceChildren(
      pagingButton('previous', cursorStack.length > 0),
      pagingButton('next', Boolean(nextCursor))
    );
  }

  function filterSummaryText() {
    const search = form.elements.search?.value || '';
    const traffic = form.elements.traffic?.value || 'all';
    const advanced = ['ip', 'country', 'subdivision', 'city', 'browser', 'os', 'device', 'pathPrefix', 'referrerHost']
      .some(name => form.elements[name]?.value);
    return [
      `近 ${form.elements.days?.value || '7'} 天`,
      traffic === 'human' ? '仅真人' : traffic === 'bot' ? '仅爬虫' : '全部访问',
      search ? `搜索“${search}”` : '',
      advanced ? '已应用高级筛选' : ''
    ].filter(Boolean).join(' · ');
  }

  function updateAppliedFilters() {
    const target = form.querySelector('.analytics-applied-filters');
    if (!target) return;
    const label = element('strong', '', '当前条件：');
    target.replaceChildren(label, document.createTextNode(` ${filterSummaryText()}`));
  }

  function renderEvents(items) {
    tableBody.replaceChildren(...items.map(eventRow));
    cards.replaceChildren(...items.map(eventCard));
    emptyState.hidden = items.length !== 0;
    summary.textContent = `逐次访问明细 · 第 ${pageNumber()} 页 · 本页 ${items.length} 条`;
    updateAppliedFilters();
    renderPagination();
  }

  function cursorFromPagination(direction) {
    const control = root.querySelector(`[data-analytics-page="${direction}"]`);
    if (!control || control.tagName !== 'A') return null;
    try {
      return new URL(control.href).searchParams.get('cursor');
    } catch {
      return null;
    }
  }

  function paramsFromForm() {
    const data = new FormData(form);
    const params = new URLSearchParams();
    for (const name of filterNames) {
      const value = data.get(name);
      if (typeof value === 'string' && value !== '') params.set(name, value);
    }
    return params;
  }

  function paramsForCursor(cursor) {
    const params = paramsFromForm();
    params.delete('cursor');
    if (cursor) params.set('cursor', cursor);
    return params;
  }

  function pageUrl(params) {
    const query = params.toString();
    return `${window.location.pathname}${query ? `?${query}` : ''}`;
  }

  function apiUrl(params) {
    const query = params.toString();
    return `/api/admin/analytics/events${query ? `?${query}` : ''}`;
  }

  function historyState(params) {
    return {
      analytics: {
        cursor: currentCursor,
        cursorStack: [...cursorStack],
        query: params.toString()
      }
    };
  }

  function applyParamsToForm(params) {
    for (const name of filterNames) {
      const control = form.elements[name];
      if (!control) continue;
      const value = params.get(name) || '';
      if (typeof control.length === 'number' && !control.tagName) {
        for (const option of control) option.checked = option.value === (value || 'all');
      } else {
        control.value = value;
      }
    }
  }

  function setHistory(mode, params) {
    if (mode === 'none') return;
    const method = mode === 'push' ? 'pushState' : 'replaceState';
    history[method](historyState(params), '', pageUrl(params));
  }

  function restoreHistoryState(state, params) {
    const analytics = state?.analytics;
    currentCursor = analytics && typeof analytics.cursor === 'string'
      ? analytics.cursor
      : params.get('cursor');
    cursorStack = Array.isArray(analytics?.cursorStack)
      ? analytics.cursorStack.filter(value => value === null || typeof value === 'string')
      : [];
  }

  function setControlsDisabled(disabled) {
    for (const control of form.querySelectorAll('button')) control.disabled = disabled;
    for (const control of pagination.querySelectorAll('button, a')) {
      if (control.tagName === 'BUTTON') {
        if (disabled) control.disabled = true;
        else control.disabled = control.dataset.analyticsPage === 'previous'
          ? cursorStack.length === 0
          : !nextCursor;
      }
      control.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
  }

  function setListStatus(message, error = false, retry = false) {
    listStatus.hidden = false;
    listStatus.className = error
      ? 'analytics-event-status message error'
      : 'analytics-event-status message info';
    listStatus.setAttribute('role', error ? 'alert' : 'status');
    listStatus.replaceChildren(document.createTextNode(message));
    if (retry) {
      const button = element('button', 'secondary-button', '重试');
      button.type = 'button';
      button.setAttribute('data-analytics-retry', '');
      listStatus.append(document.createTextNode(' '), button);
    }
  }

  function clearListStatus() {
    listStatus.hidden = true;
    listStatus.className = 'analytics-event-status';
    listStatus.setAttribute('role', 'status');
    listStatus.replaceChildren();
  }

  function closeDetail() {
    if (detailPanel) detailPanel.hidden = true;
    if (detailStatus) detailStatus.hidden = true;
  }

  function focusSummary(scrollPosition) {
    try {
      summary.focus({ preventScroll: true });
    } catch {
      summary.focus();
      window.scrollTo(window.scrollX, scrollPosition);
    }
    if (window.scrollY !== scrollPosition) window.scrollTo(window.scrollX, scrollPosition);
  }

  async function requestEvents(params, options = {}) {
    const id = ++requestId;
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const scrollPosition = window.scrollY;
    const attempt = {
      params: new URLSearchParams(params),
      historyMode: options.historyMode || 'push',
      cursor: options.cursor === undefined ? params.get('cursor') : options.cursor,
      cursorStack: options.cursorStack === undefined ? [...cursorStack] : [...options.cursorStack]
    };
    pendingRequest = attempt;
    root.setAttribute('aria-busy', 'true');
    setControlsDisabled(true);
    setListStatus('正在加载访问明细……');

    try {
      const response = await fetch(apiUrl(params), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.payload = payload;
        throw error;
      }
      if (id !== requestId) return;

      currentCursor = attempt.cursor;
      cursorStack = [...attempt.cursorStack];
      nextCursor = payload.nextCursor || null;
      renderEvents(Array.isArray(payload.items) ? payload.items : []);
      closeDetail();
      clearListStatus();
      setHistory(attempt.historyMode, params);
      pendingRequest = null;
      focusSummary(scrollPosition);
    } catch (error) {
      if (error.name === 'AbortError' || id !== requestId) return;
      const invalid = error.payload?.error === 'invalid_filter';
      setListStatus(
        invalid ? '筛选条件无效，请检查输入后重试。' : '访问明细加载失败，现有结果仍可继续使用。',
        true,
        true
      );
      listStatus.focus({ preventScroll: true });
      if (window.scrollY !== scrollPosition) window.scrollTo(window.scrollX, scrollPosition);
    } finally {
      if (id === requestId) {
        activeController = null;
        root.setAttribute('aria-busy', 'false');
        setControlsDisabled(false);
        renderPagination();
      }
    }
  }

  function submitFilters() {
    const params = paramsForCursor(null);
    requestEvents(params, { historyMode: 'push', cursor: null, cursorStack: [] });
  }

  function nextPage() {
    if (!nextCursor) return;
    requestEvents(paramsForCursor(nextCursor), {
      historyMode: 'push',
      cursor: nextCursor,
      cursorStack: [...cursorStack, currentCursor]
    });
  }

  function previousPage() {
    if (cursorStack.length === 0) return;
    const stack = [...cursorStack];
    const previousCursor = stack.pop();
    requestEvents(paramsForCursor(previousCursor), {
      historyMode: 'push',
      cursor: previousCursor,
      cursorStack: stack
    });
  }

  function applyShortcut(shortcut) {
    const input = form.elements[shortcut.dataset.filterName];
    if (!input) return;
    let value = shortcut.dataset.filterValue || '';
    if (['subdivision', 'city'].includes(shortcut.dataset.filterName) && value.includes(':')) {
      const separator = value.indexOf(':');
      const country = form.elements.country;
      if (country) country.value = value.slice(0, separator);
      value = value.slice(separator + 1);
    }
    input.value = value;
    submitFilters();
  }

  function setDetailStatus(message, error = false) {
    if (!detailStatus) return;
    detailStatus.hidden = false;
    detailStatus.textContent = message;
    detailStatus.className = error ? 'message error' : 'message info';
    detailStatus.setAttribute('role', error ? 'alert' : 'status');
  }

  function setDetailText(target, value) {
    if (target) target.textContent = safeValue(value);
  }

  async function showDetail(eventId) {
    if (!detailPanel || !detailStatus || !detailJson) return;
    detailPanel.hidden = true;
    setDetailStatus('正在加载访问详情……');
    try {
      const response = await fetch(`/api/admin/analytics/events/${encodeURIComponent(eventId)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = await response.json();
      setDetailText(detailFields.id, detail.id);
      setDetailText(detailFields.time, detail.observedAtUtc);
      setDetailText(detailFields.displayPath, detail.displayPath);
      setDetailText(detailFields.rawPath, detail.requestPath);
      setDetailText(detailFields.ip, detail.ipAddress);
      setDetailText(detailFields.browser, joinedName(detail.client?.browser));
      detailJson.textContent = JSON.stringify(detail, null, 2);
      detailStatus.hidden = true;
      detailPanel.hidden = false;
      detailPanel.focus();
    } catch {
      setDetailStatus('访问详情加载失败，请稍后重试。', true);
      detailStatus.focus();
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    submitFilters();
  });

  document.addEventListener('click', event => {
    const target = event.target.closest(
      '.analytics-filter-shortcut, .analytics-detail-button, [data-analytics-page], [data-analytics-retry]'
    );
    if (!target) return;

    if (target.matches('.analytics-filter-shortcut')) {
      event.preventDefault();
      applyShortcut(target);
      return;
    }
    if (target.matches('.analytics-detail-button')) {
      event.preventDefault();
      showDetail(target.dataset.eventId);
      return;
    }
    if (target.matches('[data-analytics-retry]')) {
      event.preventDefault();
      if (pendingRequest) requestEvents(pendingRequest.params, {
        historyMode: pendingRequest.historyMode,
        cursor: pendingRequest.cursor,
        cursorStack: pendingRequest.cursorStack
      });
      return;
    }
    if (target.matches('[data-analytics-page="previous"]')) {
      event.preventDefault();
      previousPage();
      return;
    }
    if (target.matches('[data-analytics-page="next"]')) {
      event.preventDefault();
      nextPage();
    }
  });

  window.addEventListener('popstate', event => {
    const params = new URL(window.location.href).searchParams;
    applyParamsToForm(params);
    restoreHistoryState(event.state, params);
    requestEvents(params, {
      historyMode: 'none',
      cursor: currentCursor,
      cursorStack
    });
  });

  const initialParams = new URL(window.location.href).searchParams;
  const initialState = history.state?.analytics;
  if (initialState && initialState.query === initialParams.toString()) {
    restoreHistoryState(history.state, initialParams);
  }
  renderPagination();
  history.replaceState(historyState(initialParams), '', pageUrl(initialParams));
})();
