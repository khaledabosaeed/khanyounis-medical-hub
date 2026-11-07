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
  };

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
    return new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
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

  function showAuthView(mode = 'login', message = '') {
    showView('auth-panel');
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
      rememberMe: Boolean(data.get('rememberMe')),
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
    $('#student-unread-count').textContent = `${Number(data.unreadMessages) || 0} unread`;

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

  function renderStudentMessages(messages) {
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
      const messages = result.messages || [];
      renderStudentMessages(messages);
      const unread = messages.filter((message) => message.senderRole === 'admin' && !message.readAt).length;
      $('#student-unread-count').textContent = `${unread} unread`;
    } catch (error) {
      if (error.status === 401) await refreshStudentSnapshot();
      else if (!silent) showFeedback($('#student-message-feedback'), error.message || 'Could not load messages.');
    } finally { state.studentMessagesLoading = false; }
  }

  async function renderStudentRoute() {
    showView('student-dashboard');
    $('#student-greeting').textContent = 'Loading your workspace…';
    try {
      const data = await api('/api/student/me');
      renderStudentSnapshot(data);
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
      await loadStudentMessages({ silent: true });
    } catch (error) {
      showFeedback(feedback, error.message || 'Could not send your message.');
    } finally { button.disabled = false; }
  });

  function showAdminLogin(message = '') {
    showView('admin-login-panel');
    showFeedback($('#admin-login-error'), message);
    if (location.pathname !== '/admin/login' || location.search) history.replaceState({}, '', '/admin/login');
    document.title = 'دخول الإدارة | الميدكال هب';
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
      showFeedback($('#admin-login-error'), error.message || 'تعذر تسجيل الدخول. تحقق من البيانات وحاول مجددًا.');
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
      ? `منذ آخر تصفير: ${new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(data.counterResetAt))}`
      : 'إجمالي وقت الطلاب — منذ البداية';
  }

  function renderAdminOverview(data) {
    renderAdminCounter(data);
    $('#admin-students-count').textContent = String(data.studentCount || 0);
    $('#admin-student-total').textContent = String(data.studentCount || 0);
    $('#admin-active-count').textContent = String(data.activeSessionCount || 0);
    $('#admin-active-count-label').textContent = `${data.activeSessionCount || 0} نشطة`;
    $('#admin-completed-count').textContent = String(data.completedSessionCount || 0);
  }

  function renderAdminArchive(archive) {
    const container = $('#admin-counter-archive');
    if (!archive.length) return emptyMessage(container, 'لا يوجد أرشيف محفوظ حتى الآن.');
    const tableElement = table(['الفترة', 'نهاية الفترة', 'الجلسات المكتملة', 'وقت الدراسة']);
    const body = $('tbody', tableElement);
    for (const item of archive) {
      const row = document.createElement('tr');
      cell(row, item.periodStartedAt ? `${adminDateText(item.periodStartedAt)} —` : 'منذ البداية');
      cell(row, adminDateText(item.periodEndedAt));
      cell(row, item.completedSessionCount);
      cell(row, hms(item.totalSeconds));
      body.append(row);
    }
    container.replaceChildren(tableElement);
  }

  $('#admin-reset-total').addEventListener('click', async () => {
    if (state.adminCounterResetting) return;
    if (!window.confirm('هل تريد تصفير وقت الدراسة الكلي في لوحة الإدارة وبدء فترة جديدة من الآن؟ لن تُحذف جلسات الطلاب ولن تتغير أوقاتهم الشخصية.')) return;
    const button = $('#admin-reset-total');
    state.adminCounterResetting = true;
    button.disabled = true;
    try {
      const result = await api('/api/admin/study-counter/reset', {
        method: 'POST', body: { confirmed: true }, csrfToken: state.sessionCsrf,
      });
      renderAdminCounter(result);
      $('#admin-completed-count').textContent = String(result.completedSessionCount || 0);
      $('#admin-status').textContent = 'تم تصفير عداد الإدارة وبدء فترة جديدة. جميع سجلات الطلاب محفوظة.';
      $('#admin-status').classList.remove('hub-hidden');
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.admin = null;
        state.sessionCsrf = '';
        navigate('/admin/login', true);
      } else {
        $('#admin-status').textContent = error.message || 'تعذر تصفير العداد. لم تتغير بداية الفترة.';
        $('#admin-status').classList.remove('hub-hidden');
      }
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
      empty.textContent = 'اختر طالبًا من القائمة لعرض رسائله وإرسال ملاحظة له.';
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
      emptyMessage(messages, 'لا توجد رسائل سابقة لهذا الطالب. يمكنك كتابة أول ملاحظة أدناه.');
      return;
    }
    for (const message of thread) {
      const bubble = document.createElement('article');
      const fromAdmin = message.senderRole ? message.senderRole === 'admin' : Boolean(message.createdByAdmin);
      bubble.className = `hub-message-bubble ${fromAdmin ? 'hub-message-bubble--outgoing' : 'hub-message-bubble--incoming'}`;
      const author = document.createElement('strong');
      author.className = 'hub-message-author';
      author.textContent = fromAdmin ? 'الإدارة' : 'الطالب';
      const body = document.createElement('p');
      body.textContent = message.body;
      body.dir = 'auto';
      const meta = document.createElement('small');
      const receipt = fromAdmin
        ? (message.readAt ? 'قرأها الطالب' : 'بانتظار قراءة الطالب')
        : (message.readAt ? 'قرأتها الإدارة' : 'رسالة جديدة');
      meta.textContent = `${adminDateText(message.createdAt)} · ${receipt}`;
      bubble.append(author, body, meta);
      messages.append(bubble);
    }
    messages.scrollTop = messages.scrollHeight;
  }

  function renderAdminStudents(students) {
    state.adminStudents = students;
    const container = $('#admin-students-list');
    if (!students.some((student) => student.id === state.selectedStudentId)) state.selectedStudentId = '';
    if (!students.length) {
      emptyMessage(container, 'لا يوجد طلاب مطابقون للبحث.');
      renderAdminConversation();
      return;
    }

    container.replaceChildren();
    for (const student of students) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hub-student-row';
      row.classList.toggle('is-selected', student.id === state.selectedStudentId);
      row.setAttribute('aria-pressed', String(student.id === state.selectedStudentId));
      row.dataset.messageStudent = student.id;

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
      sessionCount.textContent = `${student.sessionCount || 0} جلسة`;
      const studyTime = document.createElement('strong');
      studyTime.textContent = hms(student.totalSeconds || 0);
      activity.append(sessionCount, studyTime);
      const arrow = document.createElement('span');
      arrow.className = 'hub-student-row__arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '‹';
      row.append(identity, activity, arrow);
      container.append(row);
    }
    renderAdminConversation();
  }

  async function loadAdminStudents(search = '') {
    try {
      const result = await api(`/api/admin/students?search=${encodeURIComponent(search)}`);
      renderAdminStudents(result.students || []);
    } catch (error) { emptyMessage($('#admin-students-list'), error.message || 'تعذر تحميل قائمة الطلاب.'); }
  }

  function renderAdminSessions(sessions) {
    state.adminSessions = sessions;
    const active = sessions.filter((session) => session.status === 'active');
    const activeContainer = $('#admin-active-sessions');
    $('#admin-active-count-label').textContent = `${active.length} نشطة`;
    if (!active.length) emptyMessage(activeContainer, 'لا توجد جلسات نشطة الآن.');
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
        started.textContent = `بدأت ${adminDateText(session.startedAt)}`;
        details.append(name, email, started);
        identity.append(avatar, details);

        const duration = document.createElement('div');
        duration.className = 'hub-active-session__duration';
        const durationLabel = document.createElement('small');
        durationLabel.textContent = 'مدة الجلسة';
        const timer = document.createElement('strong');
        timer.dataset.adminSessionStarted = session.startedAt || '';
        timer.textContent = hms(activeDuration(session));
        duration.append(durationLabel, timer);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'hub-button hub-button--danger';
        close.dataset.closeSession = session.id;
        close.setAttribute('aria-label', `إنهاء جلسة ${session.studentName}`);
        close.textContent = 'إنهاء الجلسة';
        item.append(identity, duration, close);
        activeContainer.append(item);
      }
    }

    const recent = [...sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 10);
    const recentContainer = $('#admin-recent-sessions');
    if (!recent.length) return emptyMessage(recentContainer, 'لا توجد جلسات في السجل حتى الآن.');
    const tableElement = table(['الطالب', 'الحالة', 'البداية', 'النهاية', 'المدة', 'الإجراء']);
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
      badge.textContent = session.status === 'active' ? 'نشطة' : 'مكتملة';
      status.append(badge);
      cell(row, adminDateText(session.startedAt));
      cell(row, adminDateText(session.endedAt));
      const duration = cell(row, '');
      if (session.status === 'active') {
        duration.dataset.adminSessionStarted = session.startedAt || '';
        duration.textContent = hms(activeDuration(session));
      } else duration.textContent = hms(session.durationSeconds);
      const action = cell(row, '');
      if (session.status === 'active') {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'hub-table-action hub-table-action--danger';
        close.dataset.closeSession = session.id;
        close.textContent = 'إنهاء الجلسة';
        action.append(close);
      } else action.textContent = '—';
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
  }

  async function loadAdminMessages() {
    if (state.adminMessagesLoading) return;
    state.adminMessagesLoading = true;
    try {
      const result = await api('/api/admin/messages');
      renderAdminMessages(result.messages || []);
      await markSelectedStudentMessagesRead();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.admin = null;
        state.sessionCsrf = '';
        navigate('/admin/login', true);
        return;
      }
      state.adminMessages = [];
      renderAdminConversation();
      showFeedback($('#admin-message-feedback'), error.message || 'تعذر تحميل الرسائل.');
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
      state.adminMessages = state.adminMessages.map((message) =>
        message.studentId === studentId && message.senderRole === 'student' && !message.readAt
          ? { ...message, readAt }
          : message);
      renderAdminConversation();
    } catch (error) {
      showFeedback($('#admin-message-feedback'), error.message || 'تعذر تحديث حالة قراءة الرسالة.');
    } finally {
      if (state.adminReadMarkInFlight === studentId) state.adminReadMarkInFlight = '';
    }
  }

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
      $('#admin-status').textContent = '';
      $('#admin-status').classList.add('hub-hidden');
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.admin = null;
        state.sessionCsrf = '';
        navigate('/admin/login', true);
        return;
      }
      $('#admin-status').textContent = 'تعذر تحديث اللوحة مؤقتًا؛ لن تُغلق أي جلسة بسبب انقطاع الشبكة.';
      $('#admin-status').classList.remove('hub-hidden');
    }
  }

  async function loadAdminDashboard() {
    document.title = 'لوحة الإدارة | الميدكال هب';
    showView('admin-dashboard');
    $('#admin-status').textContent = '';
    $('#admin-status').classList.add('hub-hidden');
    $('#admin-greeting').textContent = state.admin?.fullName
      ? `مرحبًا ${state.admin.fullName}، إليك ملخص الحضور والجلسات.`
      : 'تابع حضور الطلاب وأنهِ جلساتهم من مكان واحد.';
    $('#admin-today').textContent = new Intl.DateTimeFormat('ar', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(new Date());
    const isOwner = state.admin?.role === 'owner';
    $('#admin-messages-panel').classList.toggle('hub-hidden', !isOwner);
    $('#admin-reset-total').classList.toggle('hub-hidden', !isOwner);
    $('#admin-counter-archive-panel').classList.toggle('hub-hidden', !isOwner);
    try {
      const requests = [api('/api/admin/overview'), api('/api/admin/students'), api('/api/admin/sessions?status=all')];
      if (isOwner) requests.push(api('/api/admin/messages'), api('/api/admin/study-counter/archive'));
      const [overview, students, sessions, messages, archive] = await Promise.all(requests);
      renderAdminOverview(overview);
      renderAdminStudents(students.students || []);
      if (isOwner) {
        renderAdminMessages(messages.messages || []);
        renderAdminArchive(archive.archive || []);
      }
      renderAdminSessions(sessions.sessions || []);
      state.adminClockTimer = setInterval(updateAdminTimers, 1000);
      state.adminRefreshTimer = setInterval(refreshAdminSnapshot, 30000);
      if (isOwner) state.adminMessagesTimer = setInterval(loadAdminMessages, 5000);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.admin = null;
        state.sessionCsrf = '';
        navigate('/admin/login', true);
      } else {
        $('#admin-status').textContent = error.message || 'تعذر تحميل لوحة الإدارة.';
        $('#admin-status').classList.remove('hub-hidden');
      }
    }
  }

  async function renderAdminRoute() {
    try {
      const result = await api('/api/admin/me');
      state.admin = result.admin;
      state.sessionCsrf = result.csrfToken || state.publicCsrf;
      if (!state.sessionCsrf) {
        showAdminLogin('تعذر تجهيز جلسة الإدارة الآمنة. أعد تحميل الصفحة وحاول مرة أخرى.');
        return;
      }
      await loadAdminDashboard();
    } catch {
      state.admin = null;
      state.sessionCsrf = '';
      showAdminLogin();
    }
  }

  $('#admin-students-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-message-student]');
    if (!button) return;
    if (state.selectedStudentId !== button.dataset.messageStudent) {
      $('#message-body').value = '';
      showFeedback($('#admin-message-feedback'), '');
    }
    state.selectedStudentId = button.dataset.messageStudent;
    renderAdminStudents(state.adminStudents);
    markSelectedStudentMessagesRead();
    $('#admin-message-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#message-body').focus({ preventScroll: true });
  });

  $('#admin-dashboard').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-close-session]');
    if (!button) return;
    const sessionId = button.dataset.closeSession;
    if (!window.confirm('هل تريد إنهاء جلسة الدراسة النشطة لهذا الطالب وحفظ مدتها؟')) return;
    const matchingButtons = $$('[data-close-session]', $('#admin-dashboard'))
      .filter((item) => item.dataset.closeSession === sessionId);
    matchingButtons.forEach((item) => { item.disabled = true; });
    try {
      await api(`/api/admin/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST', body: {}, csrfToken: state.sessionCsrf,
      });
      await refreshAdminSnapshot();
    } catch (error) {
      window.alert(error.message || 'تعذر إنهاء الجلسة. حاول مرة أخرى.');
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
      showFeedback(feedback, 'اختر طالبًا من القائمة أولًا.');
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
      showFeedback(feedback, 'تم إرسال الرسالة بنجاح.', 'success');
      await loadAdminMessages();
    } catch (error) { showFeedback(feedback, error.message || 'تعذر إرسال الرسالة.'); }
    finally { button.disabled = false; }
  });

  $('#admin-logout').addEventListener('click', async () => {
    const button = $('#admin-logout');
    button.disabled = true;
    try {
      await api('/api/admin/logout', { method: 'POST', body: {}, csrfToken: state.sessionCsrf });
      state.admin = null;
      state.sessionCsrf = '';
      navigate('/admin/login', true);
    } catch (error) {
      $('#admin-status').textContent = error.message || 'تعذر تسجيل الخروج.';
      $('#admin-status').classList.remove('hub-hidden');
    }
    finally { button.disabled = false; }
  });

  async function route() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    if (path === '/student') return renderStudentRoute();
    if (path === '/admin' || path === '/admin/login') return renderAdminRoute();
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
