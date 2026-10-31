const state = {
  view: 'overview',
  offset: 0,
  limit: 25,
  total: 0,
  refreshIntervalMs: 4000,
  refreshing: false,
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Request failed: ${response.status}`);
  return data;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}

function timeAgo(value) {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function statusNode(status) {
  return element('span', `status ${status}`, status.replace('_', ' '));
}

function setMetric(selector, value) {
  const target = $(selector);
  const next = formatNumber(value);
  if (target.textContent !== next) {
    target.textContent = next;
    target.classList.remove('changed');
    requestAnimationFrame(() => target.classList.add('changed'));
    setTimeout(() => target.classList.remove('changed'), 450);
  }
}

function eventLabel(event) {
  const labels = {
    CLAIMED: 'Operation claimed',
    EXECUTION_STARTED: 'External execution started',
    SUCCEEDED: 'Success confirmed',
    UNKNOWN: 'Outcome became uncertain',
    CLAIM_EXPIRED_TO_UNKNOWN: 'Orphaned claim detected',
    RECONCILED_SUCCEEDED: 'Success reconciled',
    ATTEMPT_RETURNED_CACHED_SUCCESS: 'Cached result returned',
    ATTEMPT_SUPPRESSED_IN_PROGRESS: 'Concurrent attempt suppressed',
    ATTEMPT_BLOCKED_UNKNOWN: 'Attempt blocked by uncertainty',
    ATTEMPT_INPUT_CONFLICT: 'Conflicting input rejected',
  };
  return labels[event] || event.toLowerCase().replaceAll('_', ' ');
}

function renderChart(points) {
  const container = $('#trend-chart');
  if (!points.length) {
    container.innerHTML = '<div class="empty-state"><strong>No attempt activity yet</strong><span>Protected calls will appear here as they occur.</span></div>';
    return;
  }
  const width = 1000;
  const height = 180;
  const pad = { top: 12, right: 8, bottom: 24, left: 8 };
  const max = Math.max(1, ...points.flatMap(point => [point.attempts, point.suppressed]));
  const x = index => pad.left + (index / Math.max(1, points.length - 1)) * (width - pad.left - pad.right);
  const y = value => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  const path = key => points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
  const area = `${path('attempts')} L${x(points.length - 1)},${height - pad.bottom} L${x(0)},${height - pad.bottom} Z`;
  const labels = [0, Math.floor(points.length / 2), points.length - 1]
    .filter((value, index, list) => list.indexOf(value) === index)
    .map(index => `<text class="chart-label" x="${x(index)}" y="${height - 4}" text-anchor="${index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}">${new Date(points[index].bucket).toLocaleTimeString([], { hour: 'numeric' })}</text>`)
    .join('');
  const grid = [0, .5, 1].map(ratio => `<line class="chart-grid" x1="0" x2="${width}" y1="${y(max * ratio)}" y2="${y(max * ratio)}"/>`).join('');
  const pointsMarkup = points.map((point, index) => `<circle cx="${x(index)}" cy="${y(point.attempts)}" r="3.5" fill="#3157d5"/><circle cx="${x(index)}" cy="${y(point.suppressed)}" r="2.5" fill="#a85e14"/>`).join('');
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3157d5" stop-opacity=".16"/><stop offset="1" stop-color="#3157d5" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path('attempts')}"/><path class="chart-suppressed" d="${path('suppressed')}"/>${pointsMarkup}${labels}
  </svg>`;
}

function renderActivity(items) {
  const list = $('#activity-list');
  list.replaceChildren();
  if (!items.length) {
    const empty = element('li');
    empty.append(element('span', 'activity-index', '—'), element('div', 'activity-copy', 'No recorded activity yet'));
    list.append(empty);
    return;
  }
  items.slice(0, 8).forEach((item, index) => {
    const li = element('li');
    const copy = element('div', 'activity-copy');
    copy.append(element('strong', '', eventLabel(item.event)), element('span', '', `${item.action} · ${item.operationId}`));
    li.append(element('span', 'activity-index', String(index + 1).padStart(2, '0')), copy, element('time', 'activity-time', timeAgo(item.timestamp)));
    li.addEventListener('click', () => openDetails(item.namespace, item.operationId));
    list.append(li);
  });
}

function renderAttention(operations) {
  const list = $('#attention-list');
  list.replaceChildren();
  if (!operations.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('strong', '', 'No unknown outcomes'), element('span', '', 'Every recorded operation currently has a known state.'));
    list.append(empty);
    return;
  }
  operations.slice(0, 5).forEach(operation => {
    const button = element('button', 'attention-item');
    const copy = element('div');
    copy.append(element('strong', '', operation.operationId), element('span', '', operation.reason || 'Outcome requires provider verification'));
    button.append(copy, element('span', '', timeAgo(operation.unknownAt || operation.updatedAt)));
    button.addEventListener('click', () => openDetails(operation.namespace, operation.operationId));
    list.append(button);
  });
}

async function loadOverview() {
  const [metrics, activity, series, unknown] = await Promise.all([
    api('/api/overview'),
    api('/api/activity?limit=12'),
    api('/api/series?hours=24'),
    api('/api/operations?status=UNKNOWN&limit=5'),
  ]);
  setMetric('#metric-attempts', metrics.totalAttempts);
  setMetric('#metric-operations', metrics.uniqueOperations);
  setMetric('#metric-succeeded', metrics.succeeded);
  setMetric('#metric-suppressed', metrics.repeatedAttemptsSuppressed);
  setMetric('#metric-unknown', metrics.unknown);
  setMetric('#metric-progress', metrics.inProgress);
  renderChart(series.series);
  renderActivity(activity.activity);
  renderAttention(unknown.operations);
}

function currentFilterQuery() {
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  const values = {
    query: $('#filter-query').value.trim(),
    status: $('#filter-status').value,
    action: $('#filter-action').value.trim(),
  };
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params;
}

async function loadOperations() {
  const page = await api(`/api/operations?${currentFilterQuery()}`);
  state.total = page.total;
  const body = $('#operations-body');
  body.replaceChildren();
  page.operations.forEach(operation => {
    const row = element('tr');
    const identity = element('td', 'operation-id', operation.operationId);
    identity.append(element('span', 'namespace', operation.namespace));
    const statusCell = element('td');
    statusCell.append(statusNode(operation.status));
    row.append(
      identity,
      element('td', '', operation.action),
      statusCell,
      element('td', '', String(operation.attemptCount)),
      element('td', '', formatDate(operation.createdAt)),
      element('td', '', timeAgo(operation.updatedAt)),
    );
    row.addEventListener('click', () => openDetails(operation.namespace, operation.operationId));
    body.append(row);
  });
  $('#operations-empty').classList.toggle('hidden', page.operations.length !== 0);
  const start = page.total ? state.offset + 1 : 0;
  const end = Math.min(state.offset + state.limit, page.total);
  $('#page-summary').textContent = `${start}–${end} of ${formatNumber(page.total)} operations`;
  $('#previous-page').disabled = state.offset === 0;
  $('#next-page').disabled = state.offset + state.limit >= page.total;
}

async function loadInvestigation() {
  const page = await api('/api/operations?status=UNKNOWN&limit=100');
  const list = $('#investigation-list');
  list.replaceChildren();
  if (!page.operations.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('strong', '', 'Investigation queue is clear'), element('span', '', 'Unknown outcomes will appear here without being retried.'));
    list.append(empty);
    return;
  }
  page.operations.forEach(operation => {
    const item = element('article', 'investigation-item');
    const copy = element('div');
    copy.append(element('h3', '', operation.operationId), element('p', '', operation.reason || 'The external outcome could not be established.'));
    const timing = document.createElement('dl');
    timing.append(element('dt', '', 'Became unknown'), element('dd', '', formatDate(operation.unknownAt || operation.updatedAt)));
    item.append(copy, timing, statusNode(operation.status));
    item.addEventListener('click', () => openDetails(operation.namespace, operation.operationId));
    list.append(item);
  });
}

function detailField(label, value) {
  const container = element('div');
  container.append(element('span', '', label), element('strong', '', value ?? '—'));
  return container;
}

async function openDetails(namespace, operationId) {
  try {
    const data = await api(`/api/operations/${encodeURIComponent(namespace)}/${encodeURIComponent(operationId)}`);
    const operation = data.operation;
    const content = $('#detail-content');
    content.replaceChildren();
    const heading = element('header', 'detail-heading');
    heading.append(element('span', 'eyebrow', operation.action), element('h2', '', operation.operationId), element('code', '', operation.namespace));
    const grid = element('div', 'detail-grid');
    grid.append(
      detailField('Status', operation.status),
      detailField('Attempts', String(operation.attemptCount)),
      detailField('Executed', String(operation.executionAttemptCount)),
      detailField('Suppressed', String(operation.suppressedAttemptCount)),
      detailField('Created', formatDate(operation.createdAt)),
      detailField('Last update', formatDate(operation.updatedAt)),
    );
    content.append(heading, grid);
    if (operation.reason || operation.providerReference) {
      const context = element('section', 'detail-section');
      context.append(element('h3', '', 'Outcome context'));
      if (operation.reason) context.append(element('p', '', operation.reason));
      if (operation.providerReference) context.append(element('pre', '', operation.providerReference));
      content.append(context);
    }
    if (operation.metadata || operation.resultSummary) {
      const dataSection = element('section', 'detail-section');
      dataSection.append(element('h3', '', 'Safe diagnostic summary'));
      dataSection.append(element('pre', '', JSON.stringify({ metadata: operation.metadata, result: operation.resultSummary }, null, 2)));
      content.append(dataSection);
    }
    const timelineSection = element('section', 'detail-section');
    timelineSection.append(element('h3', '', 'Audit timeline'));
    const timeline = element('ol', 'timeline');
    (operation.events || []).forEach(event => {
      const item = element('li');
      item.append(element('strong', '', eventLabel(event.event)), element('span', '', formatDate(event.timestamp)));
      if (event.detail) item.append(element('p', '', event.detail));
      timeline.append(item);
    });
    timelineSection.append(timeline);
    content.append(timelineSection);
    $('#drawer-backdrop').hidden = false;
    requestAnimationFrame(() => {
      $('#drawer-backdrop').classList.add('open');
      $('#detail-drawer').classList.add('open');
      $('#detail-drawer').setAttribute('aria-hidden', 'false');
    });
  } catch (error) {
    showToast(error.message);
  }
}

function closeDetails() {
  $('#drawer-backdrop').classList.remove('open');
  $('#detail-drawer').classList.remove('open');
  $('#detail-drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('#drawer-backdrop').hidden = true; }, 230);
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#refresh-button').textContent = 'Refreshing…';
  try {
    if (state.view === 'overview') await loadOverview();
    if (state.view === 'actions') await loadOperations();
    if (state.view === 'investigate') await loadInvestigation();
    $('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
    $('#connection-label').textContent = 'Live ledger';
  } catch (error) {
    $('#connection-label').textContent = 'Connection issue';
    showToast(error.message);
  } finally {
    state.refreshing = false;
    $('#refresh-button').textContent = 'Refresh';
  }
}

function switchView(view) {
  state.view = view;
  $$('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`));
  $$('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  history.replaceState(null, '', `#${view}`);
  refresh();
}

$$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-jump]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.jump)));
$('#refresh-button').addEventListener('click', refresh);
$('#filters').addEventListener('submit', event => { event.preventDefault(); state.offset = 0; loadOperations(); });
$('#previous-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadOperations(); });
$('#next-page').addEventListener('click', () => { state.offset += state.limit; loadOperations(); });
$('#close-drawer').addEventListener('click', closeDetails);
$('#drawer-backdrop').addEventListener('click', closeDetails);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDetails(); });

async function start() {
  try {
    const config = await api('/api/config');
    state.refreshIntervalMs = config.refreshIntervalMs;
    $('#database-path').textContent = config.storagePath;
    $('#database-path').title = config.storagePath;
    const requested = location.hash.slice(1);
    if (['overview', 'actions', 'investigate'].includes(requested)) switchView(requested);
    else await refresh();
    setInterval(refresh, state.refreshIntervalMs);
  } catch (error) {
    $('#connection-label').textContent = 'Unable to open ledger';
    showToast(error.message);
  }
}

start();
