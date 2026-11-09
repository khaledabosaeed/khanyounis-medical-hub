(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const views = ['auth-panel', 'admin-login-panel', 'student-dashboard', 'admin-dashboard'];
  const state = {
    publicCsrf: '', sessionCsrf: '', student: null, studentTimer: null, studentRefreshTimer: null,
    studentMessagesTimer: null, studentSessionStatusTimer: null, studentSessionStatusLoading: false,
    studentMessagesLoading: false,
    studentStartedAt: 0, studentTotalAtLoad: 0, studentFetchedAt: 0,
    activeSessionCount: 0, admin: null, adminStudents: [], adminMessages: [],
    adminSessions: [], selectedStudentId: '', adminClockTimer: null, adminRefreshTimer: null,
    adminMessagesTimer: null, adminMessagesLoading: false, adminReadMarkInFlight: '',
    adminTotalSecondsAtLoad: 0, adminOverviewFetchedAt: 0, adminActiveSessionCount: 0, searchTimer: null,
    adminCounterVersion: 0, adminCounterResetting: false,
    studentMessages: [], studentReadInFlight: false, notifyShown: { student: 0, admin: 0 }, resumedSession: false,
    adminRefreshAttempted: new Set(), adminPage: '/admin',
    archive: { days: [], periods: new Map(), index: -1, timeZone: 'UTC', requestId: 0 }, editingStudentId: '',
  };
  const STUDENT_TITLE = 'Student workspace | Medical Hub';
  const ADMIN_TITLE = 'Admin dashboard | Medical Hub';
  const ARCHIVE_TITLE = 'Daily archive | Medical Hub';
  const ADMIN_REFRESH_WARNING = 'The dashboard could not refresh right now. No session is closed because of a network drop.';
  const LOGIN_TITLE = 'Hub Login - Medical Hub - Samir Foundation';

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  async function api(path, { method = 'GET', body, csrfToken = '', headers = {} } = {}) {
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      requestHeaders['X-CSRF-Token'] = csrfToken;
    }
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* A non-JSON response is represented by its status. */ }
    if (!response.ok) throw new ApiError(payload.error || 'The request could not be completed.', response.status, payload.code);
    return payload;
  }

  async function ensurePublicCsrf() {
    const result = await api('/api/csrf');
    state.publicCsrf = result.csrfToken || '';
    return state.publicCsrf;
  }

  function showView(activeId) {
    for (const id of views) $('#' + id)?.classList.toggle('hub-hidden', id !== activeId);
    const workspace = activeId === 'student-dashboard' || activeId === 'admin-dashboard';
    const adminWorkspace = activeId === 'admin-dashboard';
    const adminLogin = activeId === 'admin-login-panel';
    $('#hub-layout').classList.toggle('hub-layout--workspace', workspace);
    $('#hub-layout').classList.toggle('hub-layout--admin', adminWorkspace);
    $('#hub-layout').classList.toggle('hub-layout--admin-login', adminLogin);
    $('#brand-panel')?.classList.toggle('hub-brand-panel--workspace', workspace);
    $('#brand-panel')?.classList.toggle('hub-brand-panel--admin', adminWorkspace);
    if (state.studentTimer) clearInterval(state.studentTimer);
    if (state.studentRefreshTimer) clearInterval(state.studentRefreshTimer);
    if (state.studentMessagesTimer) clearInterval(state.studentMessagesTimer);
    if (state.studentSessionStatusTimer) clearInterval(state.studentSessionStatusTimer);
    state.studentTimer = null;
    state.studentRefreshTimer = null;
    state.studentMessagesTimer = null;
    state.studentSessionStatusTimer = null;
    state.studentSessionStatusLoading = false;
    if (state.adminClockTimer) clearInterval(state.adminClockTimer);
    if (state.adminRefreshTimer) clearInterval(state.adminRefreshTimer);
    if (state.adminMessagesTimer) clearInterval(state.adminMessagesTimer);
    state.adminClockTimer = null;
    state.adminRefreshTimer = null;
    state.adminMessagesTimer = null;
  }

  function showFeedback(element, message, kind = 'error') {
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('hub-hidden', !message);
    element.classList.toggle('hub-feedback--success', kind === 'success');
  }

  function navigate(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    window.scrollTo({ top: 0, behavior: 'instant' });
    route();
  }

  function hms(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = String(Math.floor(safe / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
    const remainder = String(safe % 60).padStart(2, '0');
    return `${hours}:${minutes}:${remainder}`;
  }

  function dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function adminDateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function activeDuration(session, now = Date.now()) {
    if (!session?.startedAt) return Number(session?.durationSeconds) || 0;
    const started = new Date(session.startedAt).getTime();
    if (!Number.isFinite(started)) return Number(session.durationSeconds) || 0;
    return Math.max(0, Math.floor((now - started) / 1000));
  }

  function cell(row, text, tag = 'td') {
    const element = document.createElement(tag);
    element.textContent = text == null ? '' : String(text);
    row.append(element);
    return element;
  }

  function table(headers) {
    const tableElement = document.createElement('table');
    tableElement.className = 'hub-table';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headers.forEach((label) => cell(headerRow, label, 'th'));
    head.append(headerRow);
    tableElement.append(head, document.createElement('tbody'));
    return tableElement;
  }

  function emptyMessage(container, text) {
    container.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.className = 'hub-empty';
    paragraph.textContent = text;
    container.append(paragraph);
  }

  // ---- Message notifications (shared by the student and owner dashboards) ----
  function setNotifyOpen(prefix, open) {
    const button = $(`#${prefix}-notify-button`);
    const panel = $(`#${prefix}-notify-panel`);
    if (!button || !panel) return;
    panel.classList.toggle('hub-hidden', !open);
    button.setAttribute('aria-expanded', String(open));
  }

  function closeAllNotify() { ['student', 'admin'].forEach((prefix) => setNotifyOpen(prefix, false)); }

  function updateNotifyBadge(prefix, count) {
    const button = $(`#${prefix}-notify-button`);
    const badge = $(`#${prefix}-notify-count`);
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hub-hidden', count === 0);
    button.classList.toggle('has-unread', count > 0);
    button.setAttribute('aria-label', count
      ? `Notifications: ${count} new message${count === 1 ? '' : 's'}`
      : 'Notifications: no new messages');
    if (count > state.notifyShown[prefix]) {
      button.classList.remove('is-ringing');
      void button.offsetWidth; // Restart the CSS animation.
      button.classList.add('is-ringing');
    }
    state.notifyShown[prefix] = count;
  }

  function renderNotifyList(prefix, items) {
    const list = $(`#${prefix}-notify-list`);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'hub-notify__empty';
      empty.textContent = 'No new messages.';
      list.append(empty);
      return;
    }
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hub-notify__item';
      button.dataset.notifyKey = item.key;
      const top = document.createElement('span');
      top.className = 'hub-notify__item-top';
      const title = document.createElement('strong');
      title.dir = 'auto';
      title.textContent = item.title;
      const time = document.createElement('time');
      time.textContent = item.time;
      top.append(title, time);
      const body = document.createElement('p');
      body.dir = 'auto';
      body.textContent = item.body;
      const count = document.createElement('small');
      count.textContent = `${item.count} new message${item.count === 1 ? '' : 's'} · Open conversation`;
      button.append(top, body, count);
      list.append(button);
    }
  }

  function setTitleCount(base, count) {
    document.title = count ? `(${count}) ${base}` : base;
  }

  function highlightPanel(panel) {
    if (!panel) return;
    panel.classList.add('is-highlighted');
    setTimeout(() => panel.classList.remove('is-highlighted'), 1600);
  }

  for (const prefix of ['student', 'admin']) {
    $(`#${prefix}-notify-button`).addEventListener('click', () => {
      const open = $(`#${prefix}-notify-panel`).classList.contains('hub-hidden');
      closeAllNotify();
      setNotifyOpen(prefix, open);
    });
  }
  window.addEventListener('click', (event) => {
    if (!event.target?.closest?.('.hub-notify')) closeAllNotify();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const prefix of ['student', 'admin']) {
      if (!$(`#${prefix}-notify-panel`).classList.contains('hub-hidden')) {
        setNotifyOpen(prefix, false);
        $(`#${prefix}-notify-button`).focus();
      }
    }
  });

  function showAuthView(mode = 'login', message = '') {
    showView('auth-panel');
    document.title = LOGIN_TITLE;
    $('#login-view').classList.toggle('hub-hidden', mode !== 'login');
    $('#signup-view').classList.toggle('hub-hidden', mode !== 'signup');
    showFeedback($('#login-error'), mode === 'login' ? message : '');
    showFeedback($('#signup-error'), mode === 'signup' ? message : '');
    if (mode === 'signup') $('#signup-name').focus({ preventScroll: true });
    else $('#login-email').focus({ preventScroll: true });
  }

  function signInData(form, includeName = false) {
    const data = new FormData(form);
    const result = {
      email: String(data.get('email') || '').trim(),
      password: String(data.get('password') || ''),
    };
    if (includeName) {
      result.fullName = String(data.get('fullName') || '').trim();
      result.phone = String(data.get('phone') || '').trim();
    }
    return result;
  }

  $('#show-signup').addEventListener('click', (event) => {
    event.preventDefault();
    history.replaceState({}, '', `${location.pathname}#signup`);
    showAuthView('signup');
  });
  $('#show-login').addEventListener('click', (event) => {
    event.preventDefault();
    history.replaceState({}, '', '/login/khan-younis');
    showAuthView('login');
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = $('#login-error');
    showFeedback(feedback, '');
    if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await ensurePublicCsrf();
      const result = await api('/api/student/login', {
        method: 'POST', body: signInData(form), csrfToken: state.publicCsrf,
      });
      state.sessionCsrf = result.csrfToken || '';
      state.resumedSession = Boolean(result.resumedSession);
      form.reset();
      navigate('/student');
    } catch (error) {
      showFeedback(feedback, error.message || 'Unable to sign in.');
    } finally { submit.disabled = false; }
  });

  $('#signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = $('#signup-error');
    showFeedback(feedback, '');
    if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await ensurePublicCsrf();
      const result = await api('/api/student/register', {
        method: 'POST', body: signInData(form, true), csrfToken: state.publicCsrf,
      });
      state.sessionCsrf = result.csrfToken || '';
      form.reset();
      navigate('/student');
    } catch (error) {
      if (error.code === 'EMAIL_EXISTS') {
        const existingEmail = $('#signup-email').value.trim();
        form.reset();
        history.replaceState({}, '', '/login/khan-younis');
        showAuthView('login', 'An account with this email already exists. Please log in.');
        $('#login-email').value = existingEmail;
      } else {
        showFeedback(feedback, error.message || 'Unable to create your account.');
      }
    } finally { submit.disabled = false; }
  });

  function renderStudentSnapshot(data) {
    state.student = { ...data.student, currentSession: data.currentSession };
    state.sessionCsrf = data.csrfToken || state.sessionCsrf;
    state.studentStartedAt = Date.now();
    state.studentTotalAtLoad = Number(data.totalSeconds) || 0;
    state.studentFetchedAt = Date.now();
    state.activeSessionCount = (data.activeSessions || []).length;
    $('#student-greeting').textContent = data.student?.fullName ? `Signed in as ${data.student.fullName}` : '';
    $('#student-status').textContent = data.currentSession ? 'Study session active' : 'No active session';
    $('#session-badge').textContent = data.currentSession ? 'Active' : 'No active session';
    $('#session-badge').classList.toggle('hub-badge--complete', !data.currentSession);
    $('#session-started').textContent = data.currentSession ? `Started ${dateText(data.currentSession.startedAt)}` : 'There is no active study session.';
    if (!state.studentMessages.length) $('#student-unread-count').textContent = `${Number(data.unreadMessages) || 0} unread`;

    const otherSessions = $('#other-active-sessions');
    otherSessions.replaceChildren();
    const activeSessions = data.activeSessions || [];
    if (activeSessions.length > 1) {
      const label = document.createElement('p');
      label.className = 'hub-muted';
      label.textContent = 'Other active sessions';
      otherSessions.append(label);
      activeSessions.filter((item) => item.id !== data.currentSession?.id).forEach((session) => {
        const item = document.createElement('div');
        item.className = 'hub-list-item';
        item.textContent = `Started ${dateText(session.startedAt)} · ${hms(activeDuration(session))}`;
        otherSessions.append(item);
      });
    }
    updateStudentTimers();
    if (state.studentTimer) clearInterval(state.studentTimer);
    state.studentTimer = setInterval(updateStudentTimers, 1000);
  }

  function updateStudentTimers() {
    const now = Date.now();
    if (!state.student) return;
    const current = state.student.currentSession;
    $('#student-timer').textContent = current ? hms(activeDuration(current, now)) : '00:00:00';
    const elapsed = Math.floor((now - state.studentFetchedAt) / 1000);
    const total = state.studentTotalAtLoad + elapsed * state.activeSessionCount;
    $('#student-total-time').textContent = hms(total);
  }

  function renderStudentHistory(sessions) {
    const container = $('#student-history');
    if (!sessions.length) return emptyMessage(container, 'Your study sessions will appear here.');
    const tableElement = table(['Status', 'Started', 'Ended', 'Duration']);
    const body = $('tbody', tableElement);
    for (const session of sessions) {
      const row = document.createElement('tr');
      cell(row, session.status === 'active' ? 'Active' : 'Completed');
      cell(row, dateText(session.startedAt));
      cell(row, session.endedAt ? dateText(session.endedAt) : '—');
      cell(row, hms(session.status === 'active' ? activeDuration(session) : session.durationSeconds));
      body.append(row);
    }
    container.replaceChildren(tableElement);
  }

  function studentUnreadMessages() {
    return state.studentMessages.filter((message) => message.senderRole === 'admin' && !message.readAt);
  }

  function updateStudentNotifications() {
    const unread = studentUnreadMessages()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    $('#student-unread-count').textContent = `${unread.length} unread`;
    updateNotifyBadge('student', unread.length);
    setTitleCount(STUDENT_TITLE, unread.length);
    renderNotifyList('student', unread.length ? [{
      key: 'hub', title: 'Khanyonis Hub', body: unread[0].body, time: dateText(unread[0].createdAt), count: unread.length,
    }] : []);
  }

  async function markStudentMessagesRead() {
    if (state.studentReadInFlight || !studentUnreadMessages().length) return;
    state.studentReadInFlight = true;
    try {
      await api('/api/student/messages/read', { method: 'POST', body: {}, csrfToken: state.sessionCsrf });
      const readAt = new Date().toISOString();
      renderStudentMessages(state.studentMessages.map((message) =>
        message.senderRole === 'admin' && !message.readAt ? { ...message, readAt } : message));
    } catch { /* The messages stay unread and are retried on the next interaction. */ }
    finally { state.studentReadInFlight = false; }
  }

  function openStudentConversation() {
    closeAllNotify();
    const panel = $('#student-messages-panel');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightPanel(panel);
    $('#student-message-body').focus({ preventScroll: true });
    void markStudentMessagesRead();
  }

  $('#student-notify-list').addEventListener('click', (event) => {
    if (event.target.closest('[data-notify-key]')) openStudentConversation();
  });
  $('#student-message-body').addEventListener('focus', () => { void markStudentMessagesRead(); });
  $('#student-messages').addEventListener('click', () => { void markStudentMessagesRead(); });

  function renderStudentMessages(messages) {
    state.studentMessages = messages;
    updateStudentNotifications();
    const container = $('#student-messages');
    const keepAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 64;
    const ordered = [...messages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (!ordered.length) return emptyMessage(container, 'No messages with the hub yet.');
    container.replaceChildren();
    for (const message of ordered) {
      const fromStudent = message.senderRole === 'student' || message.createdByAdmin === false;
      const item = document.createElement('article');
      item.className = `hub-message-bubble ${fromStudent ? 'hub-message-bubble--outgoing' : 'hub-message-bubble--incoming'}`;
      const heading = document.createElement('strong');
      heading.className = 'hub-message-author';
      heading.textContent = fromStudent ? 'You' : 'Khanyonis Hub';
      const body = document.createElement('p');
      body.textContent = message.body;
      body.dir = 'auto';
      const meta = document.createElement('small');
      const receipt = fromStudent
        ? (message.readAt ? 'Read by the hub' : 'Sent')
        : (message.readAt ? 'Read' : 'New message');
      meta.textContent = `${dateText(message.createdAt)} · ${receipt}`;
      item.append(heading, body, meta);
      container.append(item);
    }
    if (keepAtBottom) container.scrollTop = container.scrollHeight;
  }

  async function loadStudentMessages({ silent = false } = {}) {
    const path = location.pathname.replace(/\/$/, '') || '/';
    if (path !== '/student' || state.studentMessagesLoading) return;
    state.studentMessagesLoading = true;
    try {
      const result = await api('/api/student/messages');
      if ((location.pathname.replace(/\/$/, '') || '/') !== '/student') return;
      renderStudentMessages(result.messages || []);
    } catch (error) {
      if (error.status === 401) await refreshStudentSnapshot();
      else if (!silent) showFeedback($('#student-message-feedback'), error.message || 'Could not load messages.');
    } finally { state.studentMessagesLoading = false; }
  }

  async function renderStudentRoute() {
    showView('student-dashboard');
    document.title = STUDENT_TITLE;
    state.studentMessages = [];
    state.notifyShown.student = 0;
    $('#student-greeting').textContent = 'Loading your workspace…';
    try {
      const data = await api('/api/student/me');
      renderStudentSnapshot(data);
      if (state.resumedSession && data.currentSession) {
        $('#session-started').textContent += ' · Welcome back — your active session was resumed.';
      }
      state.resumedSession = false;
      const [sessions, messages] = await Promise.all([
        api('/api/student/sessions'), api('/api/student/messages'),
      ]);
      renderStudentHistory(sessions.sessions || []);
      renderStudentMessages(messages.messages || []);
      state.studentRefreshTimer = setInterval(refreshStudentSnapshot, 30000);
      state.studentMessagesTimer = setInterval(() => loadStudentMessages({ silent: true }), 5000);
      state.studentSessionStatusTimer = setInterval(checkStudentSessionStatus, 2000);
      void checkStudentSessionStatus();
    } catch (error) {
      if (state.studentTimer) clearInterval(state.studentTimer);
      if (error.status === 401) {
        history.replaceState({}, '', '/login/khan-younis');
        showAuthView('login', 'Your sign-in has expired. Any active study session remains recorded until you sign out or an administrator closes it.');
      } else {
        $('#student-greeting').textContent = error.message || 'Could not load your workspace.';
      }
    }
  }

  async function refreshStudentSnapshot() {
    try {
      const [data, sessions] = await Promise.all([
        api('/api/student/me'), api('/api/student/sessions'),
      ]);
      if ((location.pathname.replace(/\/$/, '') || '/') !== '/student') return;
      renderStudentSnapshot(data);
      renderStudentHistory(sessions.sessions || []);
    } catch (error) {
      if (error.status !== 401 || (location.pathname.replace(/\/$/, '') || '/') !== '/student') return;
      if (state.studentRefreshTimer) clearInterval(state.studentRefreshTimer);
      state.studentRefreshTimer = null;
      history.replaceState({}, '', '/login/khan-younis');
      showAuthView('login', 'Your sign-in has expired. Any active study session remains recorded until you sign out or an administrator closes it.');
    }
  }

  function forceStudentLogin(message) {
    state.student = null;
    state.sessionCsrf = '';
    history.replaceState({}, '', '/login/khan-younis');
    showAuthView('login', message);
  }

  async function checkStudentSessionStatus() {
    const currentPath = location.pathname.replace(/\/$/, '') || '/';
    if (currentPath !== '/student' || state.studentSessionStatusLoading) return;
    state.studentSessionStatusLoading = true;
    const checkedSessionToken = state.sessionCsrf;
    try {
      await api('/api/student/session-status');
    } catch (error) {
      const stillSameStudentPage = (location.pathname.replace(/\/$/, '') || '/') === '/student';
      if (error.status !== 401 || !stillSameStudentPage || checkedSessionToken !== state.sessionCsrf) return;
      const message = error.code === 'STUDENT_STUDY_SESSION_CLOSED'
        ? 'An administrator ended your study session. Please sign in again. / أنهى المشرف جلستك الدراسية. سجّل الدخول من جديد.'
        : 'Your sign-in has expired. Please sign in again. / انتهت صلاحية تسجيل الدخول. سجّل الدخول من جديد.';
      forceStudentLogin(message);
    } finally {
      state.studentSessionStatusLoading = false;
    }
  }

  $('#student-logout').addEventListener('click', async () => {
    const button = $('#student-logout');
    button.disabled = true;
    try {
      await api('/api/student/logout', { method: 'POST', csrfToken: state.sessionCsrf });
      if (state.studentTimer) clearInterval(state.studentTimer);
      if (state.studentRefreshTimer) clearInterval(state.studentRefreshTimer);
      if (state.studentMessagesTimer) clearInterval(state.studentMessagesTimer);
      if (state.studentSessionStatusTimer) clearInterval(state.studentSessionStatusTimer);
      state.studentTimer = null;
      state.studentRefreshTimer = null;
      state.studentMessagesTimer = null;
      state.studentSessionStatusTimer = null;
      state.student = null;
      state.sessionCsrf = '';
      navigate('/login/khan-younis', true);
      showAuthView('login', 'You have signed out. Your study session has been saved.');
    } catch (error) {
      $('#student-greeting').textContent = error.message || 'Could not sign out. Try again.';
    } finally { button.disabled = false; }
  });

  $('#student-message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = $('#student-message-feedback');
    showFeedback(feedback, '');
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/student/messages', {
        method: 'POST', body: { body: $('#student-message-body').value }, csrfToken: state.sessionCsrf,
      });
      $('#student-message-body').value = '';
      showFeedback(feedback, 'Your message was sent.', 'success');
      await markStudentMessagesRead();
      await loadStudentMessages({ silent: true });
    } catch (error) {
      showFeedback(feedback, error.message || 'Could not send your message.');
    } finally { button.disabled = false; }
  });

  function showAdminLogin(message = '') {
    showView('admin-login-panel');
    showFeedback($('#admin-login-error'), message);
    if (location.pathname !== '/admin/login' || location.search) history.replaceState({}, '', '/admin/login');
    document.title = 'Admin sign in | Medical Hub';
  }

  function isOwner() { return state.admin?.role === 'owner'; }

  function adminSignedOut() {
    state.admin = null;
    state.sessionCsrf = '';
    navigate('/admin/login', true);
  }

  function showAdminStatus(message) {
    $('#admin-status').textContent = message || '';
    $('#admin-status').classList.toggle('hub-hidden', !message);
  }

  $('#admin-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showFeedback($('#admin-login-error'), '');
    try {
      await ensurePublicCsrf();
      const result = await api('/api/admin/login', {
        method: 'POST',
        body: { email: $('#admin-login-email').value, password: $('#admin-login-password').value },
        csrfToken: state.publicCsrf,
      });
      $('#admin-login-password').value = '';
      state.admin = result.admin;
      state.sessionCsrf = result.csrfToken || '';
      navigate('/admin', true);
    } catch (error) {
      $('#admin-login-password').value = '';
      showFeedback($('#admin-login-error'), error.message || 'Could not sign in. Check your details and try again.');
    } finally { button.disabled = false; }
  });

  function renderAdminCounter(data) {
    const version = Number(data.counterVersion || 0);
    if (version < state.adminCounterVersion) return;
    state.adminCounterVersion = version;
    state.adminTotalSecondsAtLoad = Number(data.totalSeconds || 0);
    state.adminOverviewFetchedAt = Date.now();
    state.adminActiveSessionCount = Number(data.activeSessionCount || 0);
    $('#admin-total-time').textContent = hms(data.totalSeconds || 0);
    $('#admin-total-period').textContent = data.counterResetAt
      ? `Since last reset: ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(data.counterResetAt))}`
      : 'All student time — since the beginning';
  }

  function renderAdminOverview(data) {
    renderAdminCounter(data);
    $('#admin-students-count').textContent = String(data.studentCount || 0);
    $('#admin-student-total').textContent = String(data.studentCount || 0);
    $('#admin-active-count').textContent = String(data.activeSessionCount || 0);
    $('#admin-active-count-label').textContent = `${data.activeSessionCount || 0} active`;
    $('#admin-completed-count').textContent = String(data.completedSessionCount || 0);
  }

  function renderAdminArchive(archive) {
    const container = $('#admin-counter-archive');
    if (!archive.length) return emptyMessage(container, 'No archived periods yet.');
    const tableElement = table(['Period', 'Period end', 'Completed sessions', 'Study time']);
    const body = $('tbody', tableElement);
    for (const item of archive) {
      const row = document.createElement('tr');
      cell(row, item.periodStartedAt ? `${adminDateText(item.periodStartedAt)} —` : 'Since the beginning');
      cell(row, adminDateText(item.periodEndedAt));
      cell(row, item.completedSessionCount);
      cell(row, hms(item.totalSeconds));
      body.append(row);
    }
    container.replaceChildren(tableElement);
  }

  $('#admin-reset-total').addEventListener('click', async () => {
    if (state.adminCounterResetting) return;
    if (!window.confirm('Reset the counter and start a new period from now?\n\nAll completed sessions move to the daily archive and leave the dashboard. Active sessions keep running. Nothing is deleted.')) return;
    const button = $('#admin-reset-total');
    state.adminCounterResetting = true;
    button.disabled = true;
    try {
      const result = await api('/api/admin/study-counter/reset', {
        method: 'POST', body: { confirmed: true }, csrfToken: state.sessionCsrf,
      });
      renderAdminCounter(result);
      $('#admin-completed-count').textContent = String(result.completedSessionCount || 0);
      const moved = Number(result.archivedSessionCount || 0);
      const message = `The counter was reset and a new period has started. ${moved} completed session${moved === 1 ? ' was' : 's were'} moved to the daily archive.`;
      showAdminStatus(message);
      // Archived sessions leave the lists; refresh them without blocking the button.
      void refreshAdminSnapshot();
      void api('/api/admin/study-counter/archive')
        .then((archive) => renderAdminArchive(archive.archive || []))
        .catch(() => { /* Shown on the next load. */ });
    } catch (error) {
      if (error.status === 401 || error.status === 403) adminSignedOut();
      else showAdminStatus(error.message || 'Could not reset the counter. The period start has not changed.');
    } finally { state.adminCounterResetting = false; button.disabled = false; }
  });

  function renderAdminConversation() {
    const student = state.adminStudents.find((item) => item.id === state.selectedStudentId);
    const selectedBox = $('#admin-selected-student');
    const empty = $('#admin-conversation-empty');
    const messages = $('#admin-conversation-list');
    const form = $('#admin-message-form');
    messages.replaceChildren();

    if (!student) {
      selectedBox.classList.add('hub-hidden');
      form.classList.add('hub-hidden');
      empty.classList.remove('hub-hidden');
      empty.textContent = 'Choose a student from the list to see their messages and send a note.';
      return;
    }

    empty.classList.add('hub-hidden');
    form.classList.remove('hub-hidden');
    selectedBox.classList.remove('hub-hidden');
    const avatar = document.createElement('span');
    avatar.className = 'hub-student-avatar';
    avatar.textContent = (student.fullName || '?').trim().slice(0, 1);
    const details = document.createElement('span');
    details.className = 'hub-selected-student__details';
    const name = document.createElement('strong');
    name.dir = 'auto';
    name.textContent = student.fullName;
    const contact = document.createElement('small');
    contact.dir = 'auto';
    contact.textContent = `${student.email} · ${student.phone}`;
    details.append(name, contact);
    selectedBox.replaceChildren(avatar, details);

    const thread = state.adminMessages
      .filter((message) => message.studentId === student.id)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (!thread.length) {
      emptyMessage(messages, 'No messages with this student yet. Write the first note below.');
      return;
    }
    for (const message of thread) {
      const bubble = document.createElement('article');
      const fromAdmin = message.senderRole ? message.senderRole === 'admin' : Boolean(message.createdByAdmin);
      bubble.className = `hub-message-bubble ${fromAdmin ? 'hub-message-bubble--outgoing' : 'hub-message-bubble--incoming'}`;
      const author = document.createElement('strong');
      author.className = 'hub-message-author';
      author.textContent = fromAdmin ? 'Admin' : 'Student';
      const body = document.createElement('p');
      body.textContent = message.body;
      body.dir = 'auto';
      const meta = document.createElement('small');
      const receipt = fromAdmin
        ? (message.readAt ? 'Read by the student' : 'Not read by the student yet')
        : (message.readAt ? 'Read' : 'New message');
      meta.textContent = `${adminDateText(message.createdAt)} · ${receipt}`;
      bubble.append(author, body, meta);
      messages.append(bubble);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function adminUnreadByStudent() {
    const groups = new Map();
    for (const message of state.adminMessages) {
      if (message.senderRole !== 'student' || message.readAt) continue;
      const group = groups.get(message.studentId) || { studentId: message.studentId, studentName: message.studentName, count: 0, latest: null };
      group.count += 1;
      if (!group.latest || new Date(message.createdAt) > new Date(group.latest.createdAt)) group.latest = message;
      groups.set(message.studentId, group);
    }
    return [...groups.values()].sort((a, b) => new Date(b.latest.createdAt) - new Date(a.latest.createdAt));
  }

  function updateAdminNotifications() {
    if (!isOwner()) return;
    const groups = adminUnreadByStudent();
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    updateNotifyBadge('admin', total);
    setTitleCount(state.adminPage === '/admin/archive' ? ARCHIVE_TITLE : ADMIN_TITLE, total);
    renderNotifyList('admin', groups.map((group) => ({
      key: group.studentId,
      title: group.studentName || 'Student',
      body: group.latest.body,
      time: adminDateText(group.latest.createdAt),
      count: group.count,
    })));
    const counts = new Map(groups.map((group) => [group.studentId, group.count]));
    $$('[data-message-student]', $('#admin-students-list')).forEach((row) => {
      const count = counts.get(row.dataset.messageStudent) || 0;
      let badge = row.querySelector('.hub-student-row__unread');
      if (!count) { badge?.remove(); return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'hub-student-row__unread';
        row.querySelector('.hub-student-row__arrow')?.before(badge);
      }
      badge.textContent = String(count);
      badge.setAttribute('aria-label', `${count} unread`);
    });
  }

  function renderAdminStudents(students) {
    state.adminStudents = students;
    const container = $('#admin-students-list');
    const owner = isOwner();
    if (!students.some((student) => student.id === state.selectedStudentId)) state.selectedStudentId = '';
    if (!students.length) {
      emptyMessage(container, 'No students match your search.');
      if (owner) renderAdminConversation();
      return;
    }

    container.replaceChildren();
    for (const student of students) {
      // Sub-admins see the directory read-only: rows are not buttons for them.
      const row = document.createElement(owner ? 'button' : 'div');
      row.className = owner ? 'hub-student-row' : 'hub-student-row hub-student-row--static';
      if (owner) {
        row.type = 'button';
        row.classList.toggle('is-selected', student.id === state.selectedStudentId);
        row.setAttribute('aria-pressed', String(student.id === state.selectedStudentId));
        row.dataset.messageStudent = student.id;
      }

      const identity = document.createElement('span');
      identity.className = 'hub-student-row__identity';
      const avatar = document.createElement('span');
      avatar.className = 'hub-student-avatar';
      avatar.textContent = (student.fullName || '?').trim().slice(0, 1);
      const details = document.createElement('span');
      details.className = 'hub-student-row__details';
      const name = document.createElement('strong');
      name.dir = 'auto';
      name.textContent = student.fullName;
      const contact = document.createElement('small');
      contact.dir = 'auto';
      contact.textContent = `${student.email} · ${student.phone}`;
      details.append(name, contact);
      identity.append(avatar, details);

      const activity = document.createElement('span');
      activity.className = 'hub-student-row__activity';
      const sessionCount = document.createElement('small');
      const count = Number(student.sessionCount || 0);
      sessionCount.textContent = `${count} session${count === 1 ? '' : 's'}`;
      const studyTime = document.createElement('strong');
      studyTime.textContent = hms(student.totalSeconds || 0);
      activity.append(sessionCount, studyTime);
      row.append(identity, activity);
      if (owner) {
        const arrow = document.createElement('span');
        arrow.className = 'hub-student-row__arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        row.append(arrow);
        const item = document.createElement('div');
        item.className = 'hub-student-item';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'hub-student-edit';
        edit.dataset.editStudent = student.id;
        edit.setAttribute('aria-label', `Edit ${student.fullName}`);
        edit.textContent = 'Edit';
        item.append(row, edit);
        container.append(item);
      } else container.append(row);
    }
    if (owner) {
      renderAdminConversation();
      updateAdminNotifications();
    }
  }

  async function loadAdminStudents(search = '') {
    try {
      const result = await api(`/api/admin/students?search=${encodeURIComponent(search)}`);
      renderAdminStudents(result.students || []);
    } catch (error) { emptyMessage($('#admin-students-list'), error.message || 'Could not load the student list.'); }
  }

  function renderAdminSessions(sessions) {
    state.adminSessions = sessions;
    const owner = isOwner();
    const active = sessions.filter((session) => session.status === 'active');
    const activeContainer = $('#admin-active-sessions');
    $('#admin-active-count-label').textContent = `${active.length} active`;
    if (!active.length) emptyMessage(activeContainer, 'There are no active sessions right now.');
    else {
      activeContainer.replaceChildren();
      for (const session of active) {
        const item = document.createElement('article');
        item.className = 'hub-active-session';
        const identity = document.createElement('div');
        identity.className = 'hub-active-session__identity';
        const avatar = document.createElement('span');
        avatar.className = 'hub-student-avatar';
        avatar.textContent = (session.studentName || '?').trim().slice(0, 1);
        const details = document.createElement('div');
        const name = document.createElement('strong');
        name.dir = 'auto';
        name.textContent = session.studentName;
        const email = document.createElement('small');
        email.dir = 'auto';
        email.textContent = session.email;
        const started = document.createElement('small');
        started.textContent = `Started ${adminDateText(session.startedAt)}`;
        details.append(name, email, started);
        identity.append(avatar, details);

        const duration = document.createElement('div');
        duration.className = 'hub-active-session__duration';
        const durationLabel = document.createElement('small');
        durationLabel.textContent = 'Session time';
        const timer = document.createElement('strong');
        timer.dataset.adminSessionStarted = session.startedAt || '';
        timer.textContent = hms(activeDuration(session));
        duration.append(durationLabel, timer);
        item.append(identity, duration);

        if (owner) {
          const actions = document.createElement('div');
          actions.className = 'hub-active-session__actions';
          const edit = document.createElement('button');
          edit.type = 'button';
          edit.className = 'hub-button hub-button--secondary';
          edit.dataset.editStudent = session.studentId;
          edit.setAttribute('aria-label', `Edit ${session.studentName}`);
          edit.textContent = 'Edit data';
          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'hub-button hub-button--danger';
          close.dataset.closeSession = session.id;
          close.setAttribute('aria-label', `End ${session.studentName}'s session`);
          close.textContent = 'End session';
          actions.append(edit, close);
          item.append(actions);
        }
        activeContainer.append(item);
      }
    }

    const recent = [...sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 10);
    const recentContainer = $('#admin-recent-sessions');
    if (!recent.length) return emptyMessage(recentContainer, 'No sessions recorded yet.');
    const headers = ['Student', 'Status', 'Started', 'Ended', 'Duration'];
    if (owner) headers.push('Action');
    const tableElement = table(headers);
    const body = $('tbody', tableElement);
    for (const session of recent) {
      const row = document.createElement('tr');
      const identity = cell(row, '');
      const name = document.createElement('strong');
      name.dir = 'auto';
      name.textContent = session.studentName;
      const email = document.createElement('div');
      email.className = 'hub-muted';
      email.dir = 'auto';
      email.textContent = session.email;
      identity.append(name, email);
      const status = cell(row, '');
      const badge = document.createElement('span');
      badge.className = session.status === 'active' ? 'hub-badge' : 'hub-badge hub-badge--complete';
      badge.textContent = session.status === 'active' ? 'Active' : 'Completed';
      status.append(badge);
      cell(row, adminDateText(session.startedAt));
      cell(row, adminDateText(session.endedAt));
      const duration = cell(row, '');
      if (session.status === 'active') {
        duration.dataset.adminSessionStarted = session.startedAt || '';
        duration.textContent = hms(activeDuration(session));
      } else duration.textContent = hms(session.durationSeconds);
      if (owner) {
        const action = cell(row, '');
        action.className = 'hub-table-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'hub-table-action';
        edit.dataset.editStudent = session.studentId;
        edit.setAttribute('aria-label', `Edit ${session.studentName}`);
        edit.textContent = 'Edit data';
        action.append(edit);
        if (session.status === 'active') {
          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'hub-table-action hub-table-action--danger';
          close.dataset.closeSession = session.id;
          close.textContent = 'End session';
          action.append(close);
        }
      }
      body.append(row);
    }
    recentContainer.replaceChildren(tableElement);
  }

  function updateAdminTimers() {
    const now = Date.now();
    $$('[data-admin-session-started]').forEach((timer) => {
      timer.textContent = hms(activeDuration({ startedAt: timer.dataset.adminSessionStarted }, now));
    });
    const elapsed = Math.floor((now - state.adminOverviewFetchedAt) / 1000);
    $('#admin-total-time').textContent = hms(state.adminTotalSecondsAtLoad + elapsed * state.adminActiveSessionCount);
  }

  function renderAdminMessages(messages) {
    state.adminMessages = messages;
    renderAdminConversation();
    updateAdminNotifications();
    // A message from a student registered after the last refresh: refresh the
    // directory and counts now instead of waiting for the 30-second cycle.
    const known = new Set(state.adminStudents.map((student) => student.id));
    const unknown = [...new Set(messages.map((message) => message.studentId))]
      .filter((id) => !known.has(id) && !state.adminRefreshAttempted.has(id));
    if (unknown.length && !$('#student-search').value.trim()) {
      unknown.forEach((id) => state.adminRefreshAttempted.add(id));
      void refreshAdminSnapshot();
    }
  }

  async function loadAdminMessages() {
    if (state.adminMessagesLoading) return;
    state.adminMessagesLoading = true;
    try {
      const result = await api('/api/admin/messages');
      renderAdminMessages(result.messages || []);
      await markSelectedStudentMessagesRead();
    } catch (error) {
      if (error.status === 401 || error.status === 403) { adminSignedOut(); return; }
      state.adminMessages = [];
      renderAdminConversation();
      showFeedback($('#admin-message-feedback'), error.message || 'Could not load messages.');
    } finally { state.adminMessagesLoading = false; }
  }

  async function markSelectedStudentMessagesRead() {
    const studentId = state.selectedStudentId;
    if (!studentId || state.adminReadMarkInFlight === studentId) return;
    const hasUnread = state.adminMessages.some((message) =>
      message.studentId === studentId && message.senderRole === 'student' && !message.readAt);
    if (!hasUnread) return;
    state.adminReadMarkInFlight = studentId;
    try {
      await api('/api/admin/messages/read', {
        method: 'POST', body: { studentId }, csrfToken: state.sessionCsrf,
      });
      const readAt = new Date().toISOString();
      renderAdminMessages(state.adminMessages.map((message) =>
        message.studentId === studentId && message.senderRole === 'student' && !message.readAt
          ? { ...message, readAt }
          : message));
    } catch (error) {
      showFeedback($('#admin-message-feedback'), error.message || 'Could not update the message read status.');
    } finally {
      if (state.adminReadMarkInFlight === studentId) state.adminReadMarkInFlight = '';
    }
  }

  async function openAdminConversation(studentId, { fromNotification = false } = {}) {
    if (!isOwner() || !studentId) return;
    closeAllNotify();
    if (!state.adminStudents.some((student) => student.id === studentId)) {
      // The student may be filtered out by the current search; show everyone.
      $('#student-search').value = '';
      await loadAdminStudents('');
    }
    if (state.selectedStudentId !== studentId) {
      $('#message-body').value = '';
      showFeedback($('#admin-message-feedback'), '');
    }
    state.selectedStudentId = studentId;
    renderAdminStudents(state.adminStudents);
    void markSelectedStudentMessagesRead();
    const panel = $('#admin-messages-panel');
    if (fromNotification) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightPanel(panel);
    } else {
      $('#admin-message-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    $('#message-body').focus({ preventScroll: true });
  }

  $('#admin-notify-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-notify-key]');
    if (item) void openAdminConversation(item.dataset.notifyKey, { fromNotification: true });
  });

  // ---- Sub-admins (owner only) ----
  function renderSubAdmins(subAdmins) {
    const container = $('#admin-sub-admins');
    $('#admin-sub-admin-total').textContent = String(subAdmins.length);
    if (!subAdmins.length) return emptyMessage(container, 'No sub-admins yet. Create one above to give someone view-only access.');
    const tableElement = table(['Name', 'Email', 'Created', 'Last sign-in', 'Action']);
    const body = $('tbody', tableElement);
    for (const subAdmin of subAdmins) {
      const row = document.createElement('tr');
      const name = cell(row, subAdmin.fullName);
      name.dir = 'auto';
      cell(row, subAdmin.email);
      cell(row, adminDateText(subAdmin.createdAt));
      cell(row, subAdmin.lastLoginAt ? adminDateText(subAdmin.lastLoginAt) : 'Never');
      const action = cell(row, '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'hub-table-action hub-table-action--danger';
      remove.dataset.removeSubAdmin = subAdmin.id;
      remove.dataset.subAdminName = subAdmin.fullName;
      remove.textContent = 'Remove access';
      action.append(remove);
      body.append(row);
    }
    container.replaceChildren(tableElement);
  }

  async function loadSubAdmins() {
    try {
      const result = await api('/api/admin/sub-admins');
      renderSubAdmins(result.subAdmins || []);
    } catch (error) {
      if (error.status === 401 || error.status === 403) return adminSignedOut();
      emptyMessage($('#admin-sub-admins'), error.message || 'Could not load sub-admins.');
    }
  }

  $('#sub-admin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = $('#sub-admin-feedback');
    showFeedback(feedback, '');
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api('/api/admin/sub-admins', {
        method: 'POST',
        body: {
          fullName: $('#sub-admin-name').value,
          email: $('#sub-admin-email').value,
          password: $('#sub-admin-password').value,
        },
        csrfToken: state.sessionCsrf,
      });
      form.reset();
      showFeedback(feedback, `${result.subAdmin.fullName} can now sign in at /admin/login with view-only access.`, 'success');
      await loadSubAdmins();
    } catch (error) {
      $('#sub-admin-password').value = '';
      if (error.status === 401) adminSignedOut();
      else showFeedback(feedback, error.message || 'Could not create the sub-admin.');
    } finally { button.disabled = false; }
  });

  $('#admin-sub-admins').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-sub-admin]');
    if (!button) return;
    if (!window.confirm(`Remove ${button.dataset.subAdminName}'s access? They will be signed out immediately.`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/sub-admins/${encodeURIComponent(button.dataset.removeSubAdmin)}`, {
        method: 'DELETE', csrfToken: state.sessionCsrf,
      });
      showFeedback($('#sub-admin-feedback'), 'Access removed.', 'success');
      await loadSubAdmins();
    } catch (error) {
      button.disabled = false;
      if (error.status === 401) adminSignedOut();
      else showFeedback($('#sub-admin-feedback'), error.message || 'Could not remove this sub-admin.');
    }
  });

  async function refreshAdminSnapshot() {
    try {
      const search = $('#student-search').value.trim();
      const [overview, students, sessions] = await Promise.all([
        api('/api/admin/overview'),
        api(`/api/admin/students?search=${encodeURIComponent(search)}`),
        api('/api/admin/sessions?status=all'),
      ]);
      renderAdminOverview(overview);
      renderAdminStudents(students.students || []);
      renderAdminSessions(sessions.sessions || []);
      // Clear only the refresh warning; keep confirmations from other actions.
      if ($('#admin-status').textContent === ADMIN_REFRESH_WARNING) showAdminStatus('');
    } catch (error) {
      if (error.status === 401 || error.status === 403) { adminSignedOut(); return; }
      showAdminStatus(ADMIN_REFRESH_WARNING);
    }
  }

  async function loadAdminDashboard() {
    document.title = ADMIN_TITLE;
    showView('admin-dashboard');
    showAdminStatus('');
    const owner = isOwner();
    $('#admin-greeting').textContent = state.admin?.fullName
      ? `Welcome, ${state.admin.fullName}. Here is today's attendance and session summary.`
      : 'Follow student attendance and manage study sessions from one place.';
    $('#admin-today').textContent = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(new Date());
    $('#admin-role-badge').classList.toggle('hub-hidden', owner);
    $('#admin-notify').classList.toggle('hub-hidden', !owner);
    $('#admin-messages-panel').classList.toggle('hub-hidden', !owner);
    $('#admin-main-grid').classList.toggle('hub-admin-main-grid--single', !owner);
    $('#admin-reset-total').classList.toggle('hub-hidden', !owner);
    $('#admin-counter-archive-panel').classList.toggle('hub-hidden', !owner);
    $('#admin-sub-admins-panel').classList.toggle('hub-hidden', !owner);
    state.notifyShown.admin = 0;
    try {
      const requests = [api('/api/admin/overview'), api('/api/admin/students'), api('/api/admin/sessions?status=all')];
      if (owner) requests.push(api('/api/admin/messages'), api('/api/admin/study-counter/archive'));
      const [overview, students, sessions, messages, archive] = await Promise.all(requests);
      renderAdminOverview(overview);
      renderAdminStudents(students.students || []);
      if (owner) {
        renderAdminMessages(messages.messages || []);
        renderAdminArchive(archive.archive || []);
        void loadSubAdmins();
      }
      renderAdminSessions(sessions.sessions || []);
      state.adminClockTimer = setInterval(updateAdminTimers, 1000);
      state.adminRefreshTimer = setInterval(refreshAdminSnapshot, 30000);
      if (owner) state.adminMessagesTimer = setInterval(loadAdminMessages, 5000);
    } catch (error) {
      if (error.status === 401 || error.status === 403) adminSignedOut();
      else showAdminStatus(error.message || 'Could not load the admin dashboard.');
    }
  }

  function adminDashboardOpen() {
    return Boolean(state.admin) && !$('#admin-dashboard').classList.contains('hub-hidden');
  }

  function switchAdminPage(path) {
    const archive = path === '/admin/archive';
    state.adminPage = archive ? '/admin/archive' : '/admin';
    $('#admin-main-view').classList.toggle('hub-hidden', archive);
    $('#admin-archive-view').classList.toggle('hub-hidden', !archive);
    $$('[data-admin-page]', $('#admin-nav')).forEach((link) => {
      if (link.dataset.adminPage === state.adminPage) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = archive ? ARCHIVE_TITLE : ADMIN_TITLE;
    updateAdminNotifications();
    if (archive) void loadArchivePage();
  }

  $('#admin-nav').addEventListener('click', (event) => {
    const link = event.target.closest('[data-admin-page]');
    if (!link) return;
    event.preventDefault();
    if (link.dataset.adminPage !== state.adminPage) navigate(link.dataset.adminPage);
  });

  // ---- Daily activity archive: one day at a time ----
  function archiveDayDate(day) { return new Date(`${day}T12:00:00Z`); }

  function archivePeriodLabel(period) {
    if (!period) return 'Earlier activity';
    const format = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const start = period.periodStartedAt ? format.format(new Date(period.periodStartedAt)) : 'Beginning';
    return `${start} – ${format.format(new Date(period.periodEndedAt))}`;
  }

  async function loadArchivePage() {
    try {
      const [daysResult, periodsResult] = await Promise.all([
        api('/api/admin/archive/days'), api('/api/admin/study-counter/archive'),
      ]);
      const archive = state.archive;
      archive.days = daysResult.days || [];
      archive.timeZone = daysResult.timeZone || 'UTC';
      archive.periods = new Map((periodsResult.archive || []).map((period) => [period.id, period]));

      const select = $('#archive-period');
      select.replaceChildren();
      const seen = new Set();
      for (const day of [...archive.days].reverse()) {
        const key = day.periodId || '';
        if (seen.has(key)) continue;
        seen.add(key);
        const option = document.createElement('option');
        option.value = key;
        option.textContent = archivePeriodLabel(archive.periods.get(key));
        select.append(option);
      }
      select.disabled = !archive.days.length;

      const empty = !archive.days.length;
      $('#archive-empty').classList.toggle('hub-hidden', !empty);
      $('#archive-day').classList.toggle('hub-hidden', empty);
      if (empty) {
        archive.index = -1;
        $('#archive-prev').disabled = true;
        $('#archive-next').disabled = true;
        $('#archive-position').textContent = 'No archived days';
        return;
      }
      const wanted = new URLSearchParams(location.search).get('day');
      const index = archive.days.findIndex((day) => day.day === wanted);
      await showArchiveDay(index >= 0 ? index : archive.days.length - 1);
    } catch (error) {
      if (error.status === 401 || error.status === 403) return adminSignedOut();
      showAdminStatus(error.message || 'Could not load the archive.');
    }
  }

  async function showArchiveDay(index) {
    const archive = state.archive;
    const day = archive.days[index];
    if (!day) return;
    archive.index = index;
    const date = archiveDayDate(day.day);
    $('#archive-weekday').textContent = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(date);
    $('#archive-date').textContent = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    $('#archive-period-label').textContent = `Archive period: ${archivePeriodLabel(archive.periods.get(day.periodId || ''))}`;
    $('#archive-session-count').textContent = String(day.sessionCount);
    $('#archive-student-count').textContent = String(day.studentCount);
    $('#archive-total-time').textContent = hms(day.totalSeconds);
    $('#archive-prev').disabled = index === 0;
    $('#archive-next').disabled = index === archive.days.length - 1;
    $('#archive-position').textContent = `Day ${index + 1} of ${archive.days.length}`;
    $('#archive-period').value = day.periodId || '';
    if (location.pathname === '/admin/archive') history.replaceState({}, '', `/admin/archive?day=${day.day}`);

    const container = $('#archive-sessions');
    emptyMessage(container, 'Loading activity…');
    const requestId = ++archive.requestId;
    try {
      const result = await api(`/api/admin/archive/days/${encodeURIComponent(day.day)}`);
      if (requestId !== archive.requestId) return;
      const sessions = result.sessions || [];
      if (!sessions.length) return emptyMessage(container, 'No activity recorded on this day.');
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: archive.timeZone });
      const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: archive.timeZone });
      const otherDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: archive.timeZone });
      const tableElement = table(['Student', 'Started', 'Ended', 'Duration']);
      const body = $('tbody', tableElement);
      for (const session of sessions) {
        const row = document.createElement('tr');
        const identity = cell(row, '');
        const name = document.createElement('strong');
        name.dir = 'auto';
        name.textContent = session.studentName;
        const email = document.createElement('div');
        email.className = 'hub-muted';
        email.dir = 'auto';
        email.textContent = session.email;
        identity.append(name, email);
        cell(row, time.format(new Date(session.startedAt)));
        const ended = session.endedAt ? new Date(session.endedAt) : null;
        cell(row, !ended ? '—' : dayKey.format(ended) === day.day ? time.format(ended) : otherDay.format(ended));
        cell(row, hms(session.durationSeconds));
        body.append(row);
      }
      container.replaceChildren(tableElement);
    } catch (error) {
      if (requestId !== archive.requestId) return;
      if (error.status === 401 || error.status === 403) return adminSignedOut();
      emptyMessage(container, error.message || 'Could not load this day.');
    }
  }

  $('#archive-prev').addEventListener('click', () => { void showArchiveDay(state.archive.index - 1); });
  $('#archive-next').addEventListener('click', () => { void showArchiveDay(state.archive.index + 1); });
  $('#archive-period').addEventListener('change', () => {
    const value = $('#archive-period').value;
    const index = state.archive.days.findIndex((day) => (day.periodId || '') === value);
    if (index >= 0) void showArchiveDay(index);
  });

  // ---- Edit or delete a student account (owner only) ----
  function findStudentForEdit(studentId) {
    const student = state.adminStudents.find((item) => item.id === studentId);
    if (student) return student;
    const session = state.adminSessions.find((item) => item.studentId === studentId);
    return session ? { id: studentId, fullName: session.studentName, email: session.email, phone: session.phone } : null;
  }

  function openStudentEditor(studentId) {
    const student = findStudentForEdit(studentId);
    if (!isOwner() || !student) return;
    state.editingStudentId = studentId;
    $('#student-edit-title').textContent = `Edit ${student.fullName}`;
    $('#student-edit-name').value = student.fullName || '';
    $('#student-edit-email').value = student.email || '';
    $('#student-edit-phone').value = student.phone || '';
    $('#student-edit-password').value = '';
    showFeedback($('#student-edit-feedback'), '');
    $('#student-edit-dialog').showModal();
    $('#student-edit-name').focus();
  }

  function closeStudentEditor() {
    state.editingStudentId = '';
    $('#student-edit-password').value = '';
    if ($('#student-edit-dialog').open) $('#student-edit-dialog').close();
  }

  $('#admin-dashboard').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-student]');
    if (button) openStudentEditor(button.dataset.editStudent);
  });
  $('#student-edit-dialog').addEventListener('click', (event) => {
    if (event.target.closest('[data-dialog-close]')) closeStudentEditor();
  });
  $('#student-edit-dialog').addEventListener('close', () => {
    state.editingStudentId = '';
    $('#student-edit-password').value = '';
  });

  $('#student-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = $('#student-edit-feedback');
    showFeedback(feedback, '');
    if (!form.reportValidity()) return;
    const studentId = state.editingStudentId;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/admin/students/${encodeURIComponent(studentId)}`, {
        method: 'PATCH',
        body: {
          fullName: $('#student-edit-name').value,
          email: $('#student-edit-email').value,
          phone: $('#student-edit-phone').value,
          password: $('#student-edit-password').value,
        },
        csrfToken: state.sessionCsrf,
      });
      closeStudentEditor();
      showAdminStatus(result.passwordChanged
        ? `${result.student.fullName}'s details and password were updated. They must sign in again with the new password.`
        : `${result.student.fullName}'s details were updated.`);
      await refreshAdminSnapshot();
      if (isOwner()) await loadAdminMessages();
    } catch (error) {
      if (error.status === 401) { closeStudentEditor(); adminSignedOut(); return; }
      showFeedback(feedback, error.message || 'Could not save the changes.');
    } finally { button.disabled = false; }
  });

  $('#student-delete').addEventListener('click', async () => {
    const studentId = state.editingStudentId;
    const student = findStudentForEdit(studentId);
    if (!student) return;
    if (!window.confirm(`Delete ${student.fullName} permanently?\n\nThis removes their account, all of their study sessions (including archived ones) and their messages. This cannot be undone.`)) return;
    const button = $('#student-delete');
    button.disabled = true;
    try {
      await api(`/api/admin/students/${encodeURIComponent(studentId)}`, { method: 'DELETE', csrfToken: state.sessionCsrf });
      closeStudentEditor();
      if (state.selectedStudentId === studentId) state.selectedStudentId = '';
      showAdminStatus(`${student.fullName} was deleted from the system.`);
      await refreshAdminSnapshot();
      if (isOwner()) await loadAdminMessages();
    } catch (error) {
      if (error.status === 401) { closeStudentEditor(); adminSignedOut(); return; }
      showFeedback($('#student-edit-feedback'), error.message || 'Could not delete this student.');
    } finally { button.disabled = false; }
  });

  async function renderAdminRoute() {
    try {
      const result = await api('/api/admin/me');
      state.admin = result.admin;
      state.sessionCsrf = result.csrfToken || state.publicCsrf;
      if (!state.sessionCsrf) {
        showAdminLogin('Could not prepare a secure admin session. Reload the page and try again.');
        return;
      }
    } catch {
      state.admin = null;
      state.sessionCsrf = '';
      showAdminLogin();
      return;
    }
    await loadAdminDashboard();
    const path = location.pathname.replace(/\/$/, '');
    if (path === '/admin/login') history.replaceState({}, '', '/admin');
    switchAdminPage(path);
  }

  $('#admin-students-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-message-student]');
    if (button) void openAdminConversation(button.dataset.messageStudent);
  });

  $('#admin-dashboard').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-close-session]');
    if (!button) return;
    const sessionId = button.dataset.closeSession;
    if (!window.confirm("End this student's active study session and save its duration?")) return;
    const matchingButtons = $$('[data-close-session]', $('#admin-dashboard'))
      .filter((item) => item.dataset.closeSession === sessionId);
    matchingButtons.forEach((item) => { item.disabled = true; });
    try {
      await api(`/api/admin/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST', body: {}, csrfToken: state.sessionCsrf,
      });
      await refreshAdminSnapshot();
    } catch (error) {
      window.alert(error.message || 'Could not end the session. Please try again.');
      matchingButtons.forEach((item) => { item.disabled = false; });
    }
  });

  $('#student-search').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => loadAdminStudents($('#student-search').value.trim()), 250);
  });

  $('#admin-message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = $('#admin-message-feedback');
    showFeedback(feedback, '');
    if (!state.selectedStudentId) {
      showFeedback(feedback, 'Choose a student from the list first.');
      return;
    }
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/admin/messages', {
        method: 'POST',
        body: { studentId: state.selectedStudentId, body: $('#message-body').value },
        csrfToken: state.sessionCsrf,
      });
      $('#message-body').value = '';
      showFeedback(feedback, 'Message sent.', 'success');
      await loadAdminMessages();
    } catch (error) { showFeedback(feedback, error.message || 'Could not send the message.'); }
    finally { button.disabled = false; }
  });

  $('#admin-logout').addEventListener('click', async () => {
    const button = $('#admin-logout');
    button.disabled = true;
    try {
      await api('/api/admin/logout', { method: 'POST', body: {}, csrfToken: state.sessionCsrf });
      adminSignedOut();
    } catch (error) {
      showAdminStatus(error.message || 'Could not sign out.');
    }
    finally { button.disabled = false; }
  });

  async function route() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    if (path === '/student') return renderStudentRoute();
    if ((path === '/admin' || path === '/admin/archive') && adminDashboardOpen()) return switchAdminPage(path);
    if (path === '/admin' || path === '/admin/archive' || path === '/admin/login') return renderAdminRoute();
    try {
      const existing = await api('/api/student/me');
      state.sessionCsrf = existing.csrfToken || '';
      return navigate('/student', true);
    } catch { /* The sign-in page remains public. */ }
    showAuthView(location.hash === '#signup' ? 'signup' : 'login');
  }

  window.addEventListener('popstate', route);
  window.addEventListener('hashchange', () => {
    if (location.hash === '#signup' && location.pathname.startsWith('/login')) showAuthView('signup');
  });

  ensurePublicCsrf()
    .catch(() => { /* Forms show a safe retry message if the CSRF endpoint is temporarily unavailable. */ })
    .finally(route);
})();
