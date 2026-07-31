(() => {
  const root = document.getElementById('event-list');
  const form = document.getElementById('analytics-filter-form');
  if (!root || !form || root.dataset.analyticsEnhancement !== 'enabled') return;

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
    pageTitle: document.getElementById('analytics-detail-page-title'),
    pagePath: document.getElementById('analytics-detail-page-path'),
    rawPath: document.getElementById('analytics-detail-raw-path'),
    traffic: document.getElementById('analytics-detail-traffic'),
    botName: document.getElementById('analytics-detail-bot-name'),
    referrer: document.getElementById('analytics-detail-referrer'),
    ip: document.getElementById('analytics-detail-ip'),
    browser: document.getElementById('analytics-detail-browser'),
    userAgent: document.getElementById('analytics-detail-user-agent'),
    clientStatus: document.getElementById('analytics-detail-client-status'),
    contextStatus: document.getElementById('analytics-detail-context-status')
  };
  const advancedSummary = document.getElementById('analytics-advanced-filter-summary');
  const emptyState = root.querySelector('.analytics-empty') || createEmptyState();
  const advancedFilterNames = [
    'ip', 'country', 'subdivision', 'city', 'browser', 'os', 'device', 'pathPrefix', 'referrerHost'
  ];
  const formFilterNames = ['days', 'search', 'traffic', ...advancedFilterNames];
  const supportedQueryNames = new Set([...formFilterNames, 'limit', 'cursor']);
  const cursorPattern = /^[A-Za-z0-9_-]+$/;
  const maximumCursorStack = 100;

  const initialQuery = window.location.search.slice(1);
  const initialQueryValue = acceptedQuery(initialQuery);
  const initialParams = initialQueryValue?.params || new URLSearchParams(initialQuery);
  let committed = {
    params: initialParams,
    query: initialQuery,
    cursor: initialQueryValue?.cursor ?? null,
    cursorStack: [],
    nextCursor: cursorFromPagination('next')
  };
  let activeController = null;
  let requestId = 0;
  let pendingRequest = null;
  let detailController = null;
  let detailRequestId = 0;

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

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function validCursor(value, nullable = true) {
    return (nullable && value === null) || (
      typeof value === 'string' && value.length > 0 && value.length <= 4096 && cursorPattern.test(value)
    );
  }

  function acceptedQuery(query) {
    const params = new URLSearchParams(query);
    for (const name of supportedQueryNames) {
      if (params.getAll(name).length > 1) return null;
    }
    if (params.has('cursor') && !validCursor(params.get('cursor'), false)) return null;
    return { params, query, cursor: params.get('cursor') };
  }

  function cloneParams(params) {
    return new URLSearchParams(params.toString());
  }

  function joinedName(value) {
    if (!value) return '未知';
    return `${safeValue(value.name)} ${value.version || ''}`.trim();
  }

  function locationText(item) {
    return [
      item.location.country.name,
      item.location.subdivision.name,
      item.location.city
    ].map(value => safeValue(value)).join(' / ');
  }

  function trafficNodes(item) {
    const label = element(
      'span',
      `analytics-traffic-label ${item.trafficKind === 'bot' ? 'is-bot' : 'is-human'}`,
      item.trafficKind === 'bot' ? '爬虫' : '真人'
    );
    if (item.trafficKind !== 'bot') return [label];
    return [label, element('span', 'analytics-bot-name', safeValue(item.botName))];
  }

  function eventTime(item) {
    const node = element('time', '', formatBeijingTime(item.observedAtUtc));
    node.dateTime = item.observedAtUtc;
    return node;
  }

  function detailButton(item) {
    const node = element('button', 'analytics-detail-button', '查看详情');
    node.type = 'button';
    node.dataset.eventId = item.id;
    return node;
  }

  function eventRow(item) {
    const row = element('tr');
    row.dataset.trafficKind = item.trafficKind;

    const timeCell = element('td');
    timeCell.append(eventTime(item));

    const pageCell = element('td');
    const pageContent = element('div', 'analytics-page-cell');
    pageContent.append(...trafficNodes(item));
    pageContent.append(
      element('strong', '', item.page.title),
      element('code', 'analytics-break', item.page.displayPath)
    );
    pageCell.append(pageContent);

    const locationCell = element('td');
    locationCell.append(
      element('code', 'analytics-break', item.ipAddress),
      element('span', 'analytics-secondary-line', locationText(item))
    );

    const clientCell = element('td');
    clientCell.append(
      element('span', '', safeValue(item.client.deviceType)),
      element(
        'span',
        'analytics-secondary-line',
        `${joinedName(item.client.browser)} · ${joinedName(item.client.os)}`
      )
    );

    const actionCell = element('td');
    actionCell.append(detailButton(item));
    row.append(timeCell, pageCell, locationCell, clientCell, actionCell);
    return row;
  }

  function eventCard(item) {
    const card = element('article', 'analytics-event-card');
    card.dataset.trafficKind = item.trafficKind;

    const header = element('header', 'analytics-event-card-header');
    const traffic = element('div');
    traffic.append(...trafficNodes(item));
    header.append(traffic, eventTime(item));

    const pageContent = element('div', 'analytics-event-card-page');
    pageContent.append(
      element('strong', '', item.page.title),
      element('code', 'analytics-break', item.page.displayPath)
    );

    const details = element('dl', 'analytics-event-card-details');
    const location = element('dd');
    location.append(
      element('code', 'analytics-break', item.ipAddress),
      element('span', '', locationText(item))
    );
    const client = element('dd');
    client.append(
      element('span', '', safeValue(item.client.deviceType)),
      element('span', '', `${joinedName(item.client.browser)} · ${joinedName(item.client.os)}`)
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
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(new Date(value));
  }

  function pagingButton(direction, enabled) {
    const node = element('button', '', direction === 'previous' ? '← 上一页' : '下一页 →');
    node.type = 'button';
    node.dataset.analyticsPage = direction;
    node.disabled = !enabled;
    return node;
  }

  function paginationNodes(state) {
    return [
      pagingButton('previous', state.cursorStack.length > 0),
      pagingButton('next', Boolean(state.nextCursor))
    ];
  }

  const filterLabels = {
    search: '搜索',
    traffic: '访问类型',
    ip: '完整 IP',
    country: '国家代码',
    subdivision: '一级行政区',
    city: '城市',
    browser: '浏览器',
    os: '操作系统',
    device: '设备类别',
    pathPrefix: '路径前缀',
    referrerHost: '来源域'
  };

  function appliedFilterItems(params) {
    const items = [];
    const search = params.get('search');
    const traffic = params.get('traffic') || 'all';
    if (search) items.push({ name: 'search', label: filterLabels.search, value: search });
    if (traffic !== 'all') {
      items.push({
        name: 'traffic',
        label: filterLabels.traffic,
        value: traffic === 'human' ? '仅真人' : '仅爬虫'
      });
    }
    for (const name of advancedFilterNames) {
      const value = params.get(name);
      if (value) items.push({ name, label: filterLabels[name], value });
    }
    return items;
  }

  function appliedFilterNodes(params) {
    const range = element('span', 'analytics-filter-range', `近 ${params.get('days') || '7'} 天`);
    const chips = element('div', 'analytics-filter-chips');
    const items = appliedFilterItems(params);
    if (items.length === 0) {
      chips.append(element('span', 'analytics-filter-empty', '全部访问'));
    } else {
      for (const item of items) {
        const chip = element('button', 'analytics-filter-chip');
        chip.type = 'button';
        chip.dataset.analyticsRemoveFilter = item.name;
        chip.setAttribute('aria-label', `移除${item.label}${item.label.endsWith('IP') ? ' ' : ''}筛选：${item.value}`);
        chip.append(
          element('span', '', `${item.label}：${item.value}`),
          element('span', '', ' ×')
        );
        chip.lastChild.setAttribute('aria-hidden', 'true');
        chips.append(chip);
      }
    }
    return [element('strong', '', '当前条件：'), range, chips];
  }

  function advancedFilterCount(params) {
    return advancedFilterNames.filter(name => Boolean(params.get(name))).length;
  }

  function updateAdvancedSummary(params) {
    if (!advancedSummary) return;
    const count = advancedFilterCount(params);
    advancedSummary.textContent = count > 0 ? `高级筛选（${count}）` : '高级筛选';
  }

  function cursorFromPagination(direction) {
    const control = root.querySelector(`[data-analytics-page="${direction}"]`);
    if (!control || control.tagName !== 'A') return null;
    try {
      const cursor = new URL(control.href).searchParams.get('cursor');
      return validCursor(cursor) ? cursor : null;
    } catch {
      return null;
    }
  }

  function paramsFromForm() {
    const data = new FormData(form);
    const params = new URLSearchParams();
    const replacedNames = new Set([...formFilterNames, 'cursor']);
    for (const [name, value] of committed.params) {
      if (!replacedNames.has(name)) params.append(name, value);
    }
    for (const name of formFilterNames) {
      const value = data.get(name);
      if (typeof value === 'string' && value !== '') params.set(name, value);
    }
    return params;
  }

  function paramsForCursor(cursor) {
    const params = cloneParams(committed.params);
    params.delete('cursor');
    if (cursor) params.set('cursor', cursor);
    return params;
  }

  function pageUrl(state) {
    return `${window.location.pathname}${state.query ? `?${state.query}` : ''}`;
  }

  function apiUrl(query) {
    return `/api/admin/analytics/events${query ? `?${query}` : ''}`;
  }

  function historyState(state) {
    return {
      analytics: {
        cursor: state.cursor,
        cursorStack: [...state.cursorStack],
        query: state.query
      }
    };
  }

  function exactHistoryProposal(value, query) {
    const accepted = acceptedQuery(query);
    if (!accepted || !isPlainObject(value) || Object.keys(value).length !== 1 || !isPlainObject(value.analytics)) return null;
    const analytics = value.analytics;
    if (Object.keys(analytics).sort().join(',') !== 'cursor,cursorStack,query') return null;
    if (typeof analytics.query !== 'string' || analytics.query !== accepted.query) return null;
    if (!validCursor(analytics.cursor) || analytics.cursor !== accepted.cursor) return null;
    if (!Array.isArray(analytics.cursorStack) || analytics.cursorStack.length > maximumCursorStack) return null;
    if (!analytics.cursorStack.every(cursor => validCursor(cursor))) return null;
    return {
      params: cloneParams(accepted.params),
      query: accepted.query,
      cursor: analytics.cursor,
      cursorStack: [...analytics.cursorStack]
    };
  }

  function applyParamsToForm(params) {
    for (const name of formFilterNames) {
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

  function writeHistory(mode, state) {
    if (mode === 'none') return;
    const method = mode === 'push' ? 'pushState' : 'replaceState';
    history[method](historyState(state), '', pageUrl(state));
  }

  function setControlsDisabled(disabled) {
    for (const control of form.querySelectorAll('button, input, select')) control.disabled = disabled;
    for (const shortcut of document.querySelectorAll('.analytics-filter-shortcut')) shortcut.disabled = disabled;
    for (const chip of document.querySelectorAll('button[data-analytics-remove-filter]')) chip.disabled = disabled;
    for (const control of pagination.querySelectorAll('button, a')) {
      if (control.tagName === 'BUTTON') control.disabled = disabled || (
        control.dataset.analyticsPage === 'previous'
          ? committed.cursorStack.length === 0
          : !committed.nextCursor
      );
      control.setAttribute('aria-disabled', disabled || control.disabled ? 'true' : 'false');
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

  function invalidateDetail({ clear = false } = {}) {
    const wasPending = Boolean(detailController);
    detailRequestId += 1;
    if (detailController) detailController.abort();
    detailController = null;
    if (wasPending && detailStatus) detailStatus.hidden = true;
    if (clear) {
      if (detailPanel) detailPanel.hidden = true;
      if (detailStatus) detailStatus.hidden = true;
      if (detailJson) detailJson.textContent = '';
      for (const field of Object.values(detailFields)) {
        if (field) field.textContent = '';
      }
    }
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

  function validString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function validOptionalString(value) {
    return value === null || typeof value === 'string';
  }

  function validNullableNumber(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
  }

  function validStringArray(value) {
    return Array.isArray(value) && value.every(entry => typeof entry === 'string');
  }

  function validateItem(item) {
    if (!isPlainObject(item)) throw new Error('invalid_event_item');
    if (!/^[0-9a-f]{32}$/.test(item.id || '')) throw new Error('invalid_event_id');
    if (!validString(item.observedAtUtc) || !Number.isFinite(Date.parse(item.observedAtUtc))) {
      throw new Error('invalid_event_time');
    }
    if (!['human', 'bot'].includes(item.trafficKind)) throw new Error('invalid_traffic_kind');
    if (item.trafficKind === 'bot' && !validString(item.botName)) throw new Error('invalid_bot_name');
    if (item.trafficKind === 'human' && item.botName !== null) throw new Error('invalid_bot_name');
    if (!isPlainObject(item.page) || !validString(item.page.title) || !validString(item.page.displayPath)) {
      throw new Error('invalid_page');
    }
    if (!validString(item.ipAddress)) throw new Error('invalid_ip');
    if (!isPlainObject(item.location) || !isPlainObject(item.location.country)
      || !isPlainObject(item.location.subdivision)) throw new Error('invalid_location');
    if (!validOptionalString(item.location.country.name)
      || !validOptionalString(item.location.subdivision.name)
      || !validOptionalString(item.location.city)) throw new Error('invalid_location');
    if (!isPlainObject(item.client) || !validOptionalString(item.client.deviceType)
      || !isPlainObject(item.client.browser) || !isPlainObject(item.client.os)
      || !validOptionalString(item.client.browser.name)
      || !validOptionalString(item.client.browser.version)
      || !validOptionalString(item.client.os.name)
      || !validOptionalString(item.client.os.version)) throw new Error('invalid_client');
    return item;
  }

  function validateDetail(detail, eventId) {
    validateItem(detail);
    if (detail.id !== eventId) throw new Error('invalid_detail_id');
    if (!isPlainObject(detail.raw) || !validOptionalString(detail.raw.userAgent)
      || !(detail.raw.requestClientHints === null || isPlainObject(detail.raw.requestClientHints))
      || !(detail.raw.browserClientContext === null || isPlainObject(detail.raw.browserClientContext))) {
      throw new Error('invalid_detail_raw');
    }
    if (!isPlainObject(detail.screen) || !validNullableNumber(detail.screen.width)
      || !validNullableNumber(detail.screen.height)) throw new Error('invalid_detail_screen');
    if (!isPlainObject(detail.viewport) || !validNullableNumber(detail.viewport.width)
      || !validNullableNumber(detail.viewport.height)) throw new Error('invalid_detail_viewport');
    if (!isPlainObject(detail.collection) || !validStringArray(detail.collection.sources)
      || !validOptionalString(detail.collection.contextCollectedAt)
      || !validOptionalString(detail.collection.geoDatasetDate)
      || !validString(detail.collection.geoStatus)
      || !['parsed', 'unknown', 'error'].includes(detail.collection.clientParseStatus)) {
      throw new Error('invalid_detail_collection');
    }
    return detail;
  }

  function validateListPayload(payload, attempt) {
    if (!isPlainObject(payload) || !Array.isArray(payload.items) || payload.items.length > 100) {
      throw new Error('invalid_list_response');
    }
    if (!validCursor(payload.nextCursor)) throw new Error('invalid_next_cursor');
    if (payload.nextCursor !== null && payload.nextCursor === attempt.cursor) throw new Error('non_progressing_cursor');
    return {
      items: payload.items.map(validateItem),
      nextCursor: payload.nextCursor
    };
  }

  function stageList(validated, attempt) {
    const state = {
      params: cloneParams(attempt.params),
      query: attempt.query,
      cursor: attempt.cursor,
      cursorStack: [...attempt.cursorStack],
      nextCursor: validated.nextCursor
    };
    const tableRows = validated.items.map(eventRow);
    const cardNodes = validated.items.map(eventCard);
    const pagingNodes = paginationNodes(state);
    const appliedNodes = appliedFilterNodes(state.params);
    const summaryText = `逐次访问明细 · 第 ${state.cursorStack.length + 1} 页 · 本页 ${validated.items.length} 条`;
    return { state, tableRows, cardNodes, pagingNodes, appliedNodes, summaryText, empty: validated.items.length === 0 };
  }

  function restoreList(previous, applied) {
    tableBody.replaceChildren(...previous.tableRows);
    cards.replaceChildren(...previous.cardNodes);
    pagination.replaceChildren(...previous.pagingNodes);
    if (applied) applied.replaceChildren(...previous.appliedNodes);
    if (advancedSummary) advancedSummary.textContent = previous.advancedSummaryText;
    summary.textContent = previous.summaryText;
    emptyState.hidden = previous.emptyHidden;
  }

  function commitList(staged, attempt) {
    const applied = form.querySelector('.analytics-applied-filters');
    const previous = {
      tableRows: [...tableBody.childNodes],
      cardNodes: [...cards.childNodes],
      pagingNodes: [...pagination.childNodes],
      appliedNodes: applied ? [...applied.childNodes] : [],
      advancedSummaryText: advancedSummary?.textContent || '高级筛选',
      summaryText: summary.textContent,
      emptyHidden: emptyState.hidden
    };
    try {
      tableBody.replaceChildren(...staged.tableRows);
      cards.replaceChildren(...staged.cardNodes);
      pagination.replaceChildren(...staged.pagingNodes);
      if (applied) applied.replaceChildren(...staged.appliedNodes);
      updateAdvancedSummary(staged.state.params);
      summary.textContent = staged.summaryText;
      emptyState.hidden = !staged.empty;
      writeHistory(attempt.historyMode, staged.state);
    } catch (error) {
      restoreList(previous, applied);
      throw error;
    }
    committed = staged.state;
    applyParamsToForm(committed.params);
    invalidateDetail({ clear: true });
    clearListStatus();
  }

  function requestError(error, id, scrollPosition) {
    if (error.name === 'AbortError' || id !== requestId) return;
    const invalid = error.payload?.error === 'invalid_filter';
    setListStatus(
      invalid ? '筛选条件无效，请检查输入后重试。' : '访问明细加载失败，现有结果仍可继续使用。',
      true,
      true
    );
    try {
      listStatus.focus({ preventScroll: true });
    } catch {
      listStatus.focus();
    }
    if (window.scrollY !== scrollPosition) window.scrollTo(window.scrollX, scrollPosition);
  }

  async function requestEvents(params, options = {}) {
    const id = ++requestId;
    if (activeController) activeController.abort();
    invalidateDetail();
    const controller = new AbortController();
    activeController = controller;
    const scrollPosition = window.scrollY;
    const attempt = {
      params: cloneParams(params),
      query: options.query === undefined ? params.toString() : options.query,
      historyMode: options.historyMode || 'push',
      cursor: options.cursor === undefined ? params.get('cursor') : options.cursor,
      cursorStack: options.cursorStack === undefined ? [...committed.cursorStack] : [...options.cursorStack]
    };
    pendingRequest = attempt;
    root.setAttribute('aria-busy', 'true');
    setControlsDisabled(true);
    setListStatus('正在加载访问明细……');

    try {
      const response = await fetch(apiUrl(attempt.query), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      const jsonContentType = contentType === 'application/json'
        || (contentType.startsWith('application/') && contentType.endsWith('+json'));
      if (response.ok && !jsonContentType) {
        throw new Error('invalid_json_content_type');
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (response.ok) throw new Error('invalid_json_response', { cause: error });
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.payload = payload;
        throw error;
      }
      if (id !== requestId) return;
      const validated = validateListPayload(payload, attempt);
      const staged = stageList(validated, attempt);
      if (id !== requestId) return;
      commitList(staged, attempt);
      pendingRequest = null;
      focusSummary(scrollPosition);
    } catch (error) {
      requestError(error, id, scrollPosition);
    } finally {
      if (id === requestId) {
        activeController = null;
        root.setAttribute('aria-busy', 'false');
        setControlsDisabled(false);
      }
    }
  }

  function submitFilters() {
    const params = paramsFromForm();
    const query = params.toString();
    requestEvents(params, { query, historyMode: 'push', cursor: null, cursorStack: [] });
  }

  function removeFilter(name) {
    if (!formFilterNames.includes(name) || name === 'days') return;
    const params = cloneParams(committed.params);
    params.delete(name);
    params.delete('cursor');
    if (name === 'traffic') params.set('traffic', 'all');
    requestEvents(params, {
      query: params.toString(),
      historyMode: 'push',
      cursor: null,
      cursorStack: []
    });
  }

  function nextPage() {
    if (!committed.nextCursor) return;
    const params = paramsForCursor(committed.nextCursor);
    const query = params.toString();
    requestEvents(params, {
      query,
      historyMode: 'push',
      cursor: committed.nextCursor,
      cursorStack: [...committed.cursorStack, committed.cursor]
    });
  }

  function previousPage() {
    if (committed.cursorStack.length === 0) return;
    const stack = [...committed.cursorStack];
    const previousCursor = stack.pop();
    const params = paramsForCursor(previousCursor);
    const query = params.toString();
    requestEvents(params, {
      query,
      historyMode: 'push',
      cursor: previousCursor,
      cursorStack: stack
    });
  }

  function applyShortcut(shortcut) {
    if (shortcut.disabled) return;
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

  function setDetailText(target, value, fallback = '未知') {
    if (target) target.textContent = safeValue(value, fallback);
  }

  function detailContextStatus(detail) {
    if (detail.client.contextAvailable) return '已提供浏览器上下文';
    return detail.trafficKind === 'bot'
      ? '爬虫未提供浏览器上下文'
      : '真人访问未提供浏览器上下文';
  }

  function detailClientStatus(detail) {
    if (detail.collection.clientParseStatus === 'parsed') return '已解析';
    if (detail.collection.clientParseStatus === 'error') return '客户端解析失败';
    return '客户端信息未知';
  }

  async function showDetail(eventId) {
    if (!detailPanel || !detailStatus || !detailJson || !/^[0-9a-f]{32}$/.test(eventId || '')) return;
    const id = ++detailRequestId;
    if (detailController) detailController.abort();
    const controller = new AbortController();
    detailController = controller;
    detailPanel.hidden = true;
    setDetailStatus('正在加载访问详情……');
    try {
      const response = await fetch(`/api/admin/analytics/events/${encodeURIComponent(eventId)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (id !== detailRequestId || controller.signal.aborted) return;
      const detail = validateDetail(payload, eventId);
      setDetailText(detailFields.id, detail.id);
      setDetailText(detailFields.time, detail.observedAtUtc);
      setDetailText(detailFields.pageTitle, detail.page.title);
      setDetailText(detailFields.pagePath, detail.page.displayPath);
      setDetailText(detailFields.rawPath, detail.requestPath);
      setDetailText(detailFields.traffic, detail.trafficKind === 'bot' ? '爬虫' : '真人');
      setDetailText(detailFields.botName, detail.botName, '不适用');
      setDetailText(detailFields.referrer, detail.referrer, '无来源');
      setDetailText(detailFields.ip, detail.ipAddress);
      setDetailText(detailFields.browser, joinedName(detail.client.browser));
      setDetailText(detailFields.userAgent, detail.raw.userAgent, '未提供');
      setDetailText(detailFields.clientStatus, detailClientStatus(detail));
      setDetailText(detailFields.contextStatus, detailContextStatus(detail));
      detailJson.textContent = JSON.stringify(detail, null, 2);
      detailStatus.hidden = true;
      detailPanel.hidden = false;
      detailPanel.focus();
    } catch (error) {
      if (error.name === 'AbortError' || id !== detailRequestId) return;
      setDetailStatus('访问详情加载失败，请稍后重试。', true);
      detailStatus.focus();
    } finally {
      if (id === detailRequestId) detailController = null;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    submitFilters();
  });

  document.addEventListener('click', event => {
    const target = event.target.closest(
      '.analytics-filter-shortcut, .analytics-detail-button, [data-analytics-page], [data-analytics-retry], [data-analytics-remove-filter]'
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
    if (target.matches('[data-analytics-remove-filter]')) {
      event.preventDefault();
      removeFilter(target.dataset.analyticsRemoveFilter);
      return;
    }
    if (target.matches('[data-analytics-retry]')) {
      event.preventDefault();
      if (pendingRequest) requestEvents(pendingRequest.params, {
        query: pendingRequest.query,
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
    const query = window.location.search.slice(1);
    const proposal = exactHistoryProposal(event.state, query);
    if (!proposal) {
      requestId += 1;
      if (activeController) activeController.abort();
      activeController = null;
      pendingRequest = null;
      root.setAttribute('aria-busy', 'false');
      setControlsDisabled(false);
      setListStatus('历史状态无效，现有结果仍可继续使用。', true, false);
      return;
    }
    requestEvents(proposal.params, {
      query: proposal.query,
      historyMode: 'none',
      cursor: proposal.cursor,
      cursorStack: proposal.cursorStack
    });
  });

  if (initialQueryValue) {
    const initialProposal = exactHistoryProposal(history.state, initialQuery);
    if (initialProposal) {
      committed = { ...committed, ...initialProposal, nextCursor: committed.nextCursor };
    }
    applyParamsToForm(committed.params);
    updateAdvancedSummary(committed.params);
    pagination.replaceChildren(...paginationNodes(committed));
    history.replaceState(historyState(committed), '', pageUrl(committed));
  }
})();
