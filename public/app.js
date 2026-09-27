// ─── Kaspi Pay — Frontend App ───

const API = '';

// ─── State ───

let currentOpId = null;
let invoicePollingTimer = null;
let historyOpId = null;
let qrPollingTimer = null;
let qrCountdownTimer = null;
let qrOperationId = null;

// ─── Helpers ───

const $ = (id) => document.getElementById(id);
const digitsOnly = (str) => str.replace(/\D/g, '');

const getSession = () => {
  try {
    return JSON.parse(localStorage.getItem('kaspi_session') || '{}');
  } catch {
    return {};
  }
};

const sessionHeaders = () => {
  const s = getSession();
  const h = {};
  if (s.tokenSN) h['X-Token-SN'] = s.tokenSN;
  if (s.profileId) h['X-Profile-ID'] = String(s.profileId);
  if (s.vtokenSecret) h['X-Vtoken-Secret'] = s.vtokenSecret;
  return h;
};

// ─── Server API key (only needed when the server sets API_KEY) ───

const API_KEY_STORAGE = 'kaspi_api_key';

const apiKeyHeaders = () => {
  const key = localStorage.getItem(API_KEY_STORAGE);
  return key ? { 'X-Api-Key': key } : {};
};

const rawFetch = async (path, opts = {}, retried = false) => {
  const resp = await fetch(API + path, {
    ...opts,
    headers: { ...apiKeyHeaders(), ...sessionHeaders(), ...(opts.headers || {}) },
  });
  if (resp.status === 401 && !retried) {
    const body = await resp
      .clone()
      .json()
      .catch(() => ({}));
    if (body.code === 'API_KEY_REQUIRED') {
      const key = prompt('Сервер защищён API-ключом. Введите ключ:');
      if (key) {
        localStorage.setItem(API_KEY_STORAGE, key.trim());
        return rawFetch(path, opts, true);
      }
    }
  }
  return resp;
};

const apiFetch = async (path, opts = {}) => (await rawFetch(path, opts)).json();

// Protects against double charges when the cashier double-clicks or the network retries
const newIdempotencyKey = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const escapeHtml = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const apiPost = (path, body, headers = {}) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const apiPostOnce = (path, body) => apiPost(path, body, { 'Idempotency-Key': newIdempotencyKey() });

// ─── Session Persistence (localStorage) ───

const SESSION_KEY = 'kaspi_session';

const saveSession = (data) => {
  let prev = {};
  try {
    prev = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
  } catch {}
  const merged = { ...prev, ...data };
  if (data.phone) merged.phoneNumber = data.phone;
  localStorage.setItem(SESSION_KEY, JSON.stringify(merged));
};

const clearSession = () => localStorage.removeItem(SESSION_KEY);

const checkSession = async () => {
  try {
    const resp = await apiFetch('/api/session/check');
    if (resp.active === true) return { active: true };
    return { active: false, error: resp.error || 'Сессия неактивна' };
  } catch {
    return { active: false, error: 'Ошибка проверки сессии' };
  }
};

const tryRestoreSession = async () => {
  const session = getSession();
  if (session.tokenSN && session.vtokenSecret) {
    showMainScreen(session);
    // Verify session is still active on the server
    const result = await checkSession();
    if (!result.active) {
      stopLiveEvents();
      clearSession();
      $('mainScreen').classList.add('hidden');
      $('authScreen').classList.remove('hidden');
      setAuthStep(1);
      showAuthMsg(result.error || 'Сессия истекла. Войдите заново.', 'err');
      return false;
    }
    return true;
  }
  clearSession();
  return false;
};

const formatPhone = (digits) => {
  // Format up to 10 digits as "XXX XXX XX XX"
  const d = digits.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  if (d.length <= 8) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`;
};

const attachPhoneFormatter = (el) => {
  el.addEventListener('input', () => {
    const digits = digitsOnly(el.value);
    const formatted = formatPhone(digits);
    if (el.value !== formatted) el.value = formatted;
  });
};

window.addEventListener('DOMContentLoaded', () => {
  tryRestoreSession();
  attachPhoneFormatter($('phoneInput'));
  attachPhoneFormatter($('clientPhone'));
});

// ─── Auth UI Helpers ───

const setAuthStep = (n) => {
  for (let i = 1; i <= 3; i++) {
    $(`authStep${i}`).classList.toggle('hidden', i !== n);
    $(`dot${i}`).className = `step-dot${i < n ? ' done' : i === n ? ' active' : ''}`;
  }
};

const errorText = (body, fallback) =>
  body?.error?.desc ||
  body?.data?.desc ||
  body?.errorMessage ||
  body?.Message ||
  (typeof body?.error === 'string' ? body.error : null) ||
  fallback;

const showAuthMsg = (msg, type) => {
  const el = $('authMsg');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.className = `status-bar status-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
};

const resetAuth = () => {
  setAuthStep(1);
  $('otpInput').value = '';
  showAuthMsg('', '');
};

// ─── Auth Flow ───

let authProcessId = null;

const sendPhone = async () => {
  const phone = digitsOnly($('phoneInput').value);
  if (phone.length < 10) return showAuthMsg('Введите 10 цифр номера', 'err');

  const btn = $('btnSendPhone');
  btn.disabled = true;
  btn.innerHTML = 'Отправка...<span class="loader"></span>';
  showAuthMsg('', '');

  try {
    const init = await apiPost('/api/auth/init');
    if (!init.success) {
      showAuthMsg(errorText(init.body, 'Не удалось связаться с Kaspi. Попробуйте ещё раз.'), 'err');
      return;
    }

    authProcessId = init.processId;

    const resp = await apiPost('/api/auth/send-phone', { phoneNumber: phone, processId: authProcessId });
    if (resp.success) {
      $('otpDesc').textContent = resp.desc || `SMS отправлен на +7${phone}`;
      setAuthStep(2);
    } else {
      showAuthMsg(errorText(resp.body, 'Не удалось отправить SMS. Проверьте номер.'), 'err');
    }
  } catch (e) {
    showAuthMsg(`Ошибка сети: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Получить SMS код';
  }
};

const verifyOtp = async () => {
  const otp = digitsOnly($('otpInput').value);
  if (!otp) return showAuthMsg('Введите код', 'err');

  const btn = $('btnVerifyOtp');
  btn.disabled = true;
  btn.innerHTML = 'Проверка...<span class="loader"></span>';
  showAuthMsg('', '');

  try {
    const resp = await apiPost('/api/auth/verify-otp', { otp, processId: authProcessId });
    if (resp.success && resp.step === 'finished') {
      saveSession(resp);
      authProcessId = null;
      showMainScreen(resp);
    } else {
      showAuthMsg(errorText(resp.body, 'Неверный код. Попробуйте ещё раз.'), 'err');
    }
  } catch (e) {
    showAuthMsg(`Ошибка: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Подтвердить';
  }
};

// ─── Main Screen ───

const showMainScreen = (data) => {
  $('authScreen').classList.add('hidden');
  $('mainScreen').classList.remove('hidden');
  startLiveEvents();
  if (data) {
    $('userName').textContent = data.phone || '—';
    $('userOrg').textContent = data.orgName || '—';
    $('userAvatar').textContent = (data.orgName || 'K')[0].toUpperCase();
  }
};

const logout = async () => {
  stopLiveEvents();
  const { tokenSN } = getSession();
  clearSession();
  await apiPost('/api/auth/logout', { tokenSN });
  $('mainScreen').classList.add('hidden');
  $('authScreen').classList.remove('hidden');
  $('phoneInput').value = '';
  $('otpInput').value = '';
  setAuthStep(1);
  showAuthMsg('', '');
};

const TABS = { invoice: 'Invoice', qr: 'Qr', history: 'History', sales: 'Sales', reports: 'Reports' };

const switchTab = (tab) => {
  for (const [name, suffix] of Object.entries(TABS)) {
    $(`${name}Tab`).classList.toggle('hidden', tab !== name);
    $(`tab${suffix}`).classList.toggle('active', tab === name);
  }
  if (tab === 'history') loadHistory();
  if (tab === 'sales') loadSales();
  if (tab === 'reports') loadReport();
};

// ─── Invoice ───

const statusBadge = (status) => {
  const map = {
    RemotePaymentCreated: ['Ожидает оплаты', 'pending'],
    Processed: ['Оплачен', 'paid'],
    RemotePaymentCanceled: ['Отменён', 'canceled'],
    RemotePaymentRejected: ['Отклонён', 'canceled'],
    Expired: ['Истёк', 'expired'],
  };
  const [label, cls] = map[status] || [status, 'pending'];
  return `<span class="badge badge-${cls}">${label}</span>`;
};

const renderDetails = (data, containerId) => {
  if (!data) return;
  const el = $(containerId);
  const rows = (data.DynamicDetails || [])
    .sort((a, b) => a.Order - b.Order)
    .map(
      ({ Title, Data, IsBold }) =>
        `<div class="detail-row">
        <span class="detail-label">${Title}</span>
        <span class="detail-value" style="${IsBold ? 'font-weight:700' : ''}">${Data}</span>
      </div>`,
    )
    .join('');
  el.innerHTML = `<div style="text-align:center;margin:12px 0;">${statusBadge(data.Status)}</div>${rows}`;
};

const stopInvoicePolling = () => {
  if (invoicePollingTimer) {
    clearInterval(invoicePollingTimer);
    invoicePollingTimer = null;
  }
};

const refreshInvoice = async () => {
  if (!currentOpId) return null;
  try {
    const resp = await apiFetch(`/api/invoice/details?operationId=${currentOpId}`);
    renderDetails(resp.Data, 'invoiceDetails');
    const { Status: status } = resp.Data || {};
    $('btnCancel').classList.toggle('hidden', status !== 'RemotePaymentCreated');
    if (status && status !== 'RemotePaymentCreated') stopInvoicePolling();
    return status;
  } catch (e) {
    console.error(e);
    return null;
  }
};

const startInvoicePolling = () => {
  stopInvoicePolling();
  refreshInvoice();
  invoicePollingTimer = setInterval(refreshInvoice, 5000);
};

const createInvoice = async () => {
  const phone = digitsOnly($('clientPhone').value);
  const amount = $('invoiceAmount').value;
  const comment = $('invoiceComment').value || 'Оплата';
  if (!phone || !amount) return alert('Заполните телефон и сумму');

  const btn = $('btnCreate');
  btn.disabled = true;
  btn.innerHTML = 'Создание...<span class="loader"></span>';

  try {
    const resp = await apiPostOnce('/api/invoice/create', {
      phoneNumber: phone,
      amount: Number(amount),
      comment,
    });

    if (resp.Data?.QrOperationId) {
      currentOpId = resp.Data.QrOperationId;
      $('invoiceOpId').textContent = `#${currentOpId}`;
      $('invoiceResult').classList.remove('hidden');
      $('clientPhone').value = '';
      $('invoiceAmount').value = '';
      $('invoiceComment').value = '';
      $('clientInfo').classList.add('hidden');
      startInvoicePolling();
    } else {
      alert(errorText(resp, 'Не удалось создать счёт. Попробуйте ещё раз.'));
    }
  } catch (e) {
    alert(`Ошибка: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Выставить счёт';
  }
};

const cancelInvoice = async () => {
  if (!currentOpId || !confirm('Отменить счёт?')) return;
  try {
    await apiPost('/api/invoice/cancel', { operationId: currentOpId });
    refreshInvoice();
  } catch (e) {
    alert(`Ошибка: ${e.message}`);
  }
};

// ─── QR Code ───

const QR_PENDING_STATUSES = ['QrTokenCreated', 'Wait', 'QrTokenScanned', 'PaymentConfirmation'];

const qrStatusBadge = (status) => {
  const map = {
    QrTokenCreated: ['Ожидание сканирования', 'info'],
    Wait: ['Ожидание оплаты', 'info'],
    QrTokenScanned: ['Отсканирован', 'info'],
    PaymentConfirmation: ['Подтверждение оплаты...', 'warn'],
    Processed: ['Оплачено ✅', 'ok'],
    CancelledByUser: ['Отменено клиентом', 'err'],
    NotConfirmedByUser: ['Не подтверждено', 'err'],
    CancelledByExternalSource: ['Отменено', 'err'],
    Rejected: ['Отклонено', 'err'],
    QrTokenDiscarded: ['QR не отсканирован', 'err'],
    Expired: ['Время оплаты истекло', 'err'],
    ProcessingFailed: ['Ошибка обработки', 'err'],
    InsufficientFunds: ['Недостаточно средств', 'err'],
    InsufficientFundsError: ['Недостаточно средств', 'err'],
    Error: ['Ошибка', 'err'],
  };
  const [label, cls] = map[status] || [status, 'info'];
  return { label, cls };
};

const stopQrPolling = () => {
  if (qrPollingTimer) {
    clearInterval(qrPollingTimer);
    qrPollingTimer = null;
  }
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer);
    qrCountdownTimer = null;
  }
};

const showQrStatus = (status) => {
  if (!status) return;
  const { label, cls } = qrStatusBadge(status);
  const el = $('qrStatus');
  el.className = `status-bar status-${cls}`;
  el.textContent = label;
  if (!QR_PENDING_STATUSES.includes(status)) stopQrPolling();
};

const pollQrStatus = async () => {
  if (!qrOperationId) return;
  try {
    const resp = await apiFetch(`/api/qr/status?qrOperationId=${qrOperationId}`);
    showQrStatus(resp.Data?.Status);
  } catch (e) {
    console.error('QR polling error:', e);
  }
};

const startQrCountdown = (seconds) => {
  let remaining = seconds;
  const timerEl = $('qrTimer');
  const tick = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerEl.textContent = `Осталось: ${m}:${String(s).padStart(2, '0')}`;
    if (remaining <= 0) {
      timerEl.textContent = 'Время истекло';
      stopQrPolling();
    }
    remaining--;
  };
  tick();
  qrCountdownTimer = setInterval(tick, 1000);
};

// QR is rendered by our own server — the payment link never leaves it
const renderQr = (svg) => `<div class="qr-box">${svg || '<p style="color:#c62828;">QR не получен</p>'}</div>`;

const createQr = async () => {
  const amount = $('qrAmount').value;
  if (!amount) return alert('Введите сумму');

  const btn = $('btnCreateQr');
  btn.disabled = true;
  btn.innerHTML = 'Создание...<span class="loader"></span>';

  stopQrPolling();

  try {
    const resp = await apiPostOnce('/api/qr/create', { amount: Number(amount), withImage: true });

    if (resp.Data?.QrToken) {
      qrOperationId = resp.Data.QrOperationId;
      const options = resp.Data.QrPaymentBehaviorOptions || {};
      const pollInterval = (parseInt(options.qrCodeScanEventPollingInterval) || 3) * 1000;
      const waitTimeout = parseInt(options.qrCodeScanWaitTimeout) || 180;

      $('qrCodeContainer').innerHTML = renderQr(resp.Data.QrSvg);
      $('qrStatus').className = 'status-bar status-info';
      $('qrStatus').textContent = 'Ожидание сканирования...';
      $('qrResult').classList.remove('hidden');
      $('qrAmount').value = '';

      startQrCountdown(waitTimeout);
      qrPollingTimer = setInterval(pollQrStatus, pollInterval);
    } else {
      alert(errorText(resp, 'Не удалось создать QR. Попробуйте ещё раз.'));
    }
  } catch (e) {
    alert(`Ошибка: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Создать QR';
  }
};

const resetQr = () => {
  stopQrPolling();
  qrOperationId = null;
  $('qrResult').classList.add('hidden');
  $('qrCodeContainer').innerHTML = '';
  $('qrTimer').textContent = '';
};

// ─── Client Phone Lookup ───

$('clientPhone').addEventListener('blur', async function () {
  const phone = digitsOnly(this.value);
  const info = $('clientInfo');
  if (phone.length < 10) {
    info.classList.add('hidden');
    return;
  }
  try {
    const resp = await apiFetch(`/api/invoice/client-info?phoneNumber=${phone}`);
    if (resp.Data?.ClientName) {
      info.textContent = `✓ ${resp.Data.ClientName} (${resp.Data.ClientStatus})`;
      info.style.background = '#e8f5e9';
      info.style.color = '#2e7d32';
      info.classList.remove('hidden');
    } else {
      info.textContent = '✗ Клиент не найден';
      info.style.background = '#ffebee';
      info.style.color = '#c62828';
      info.classList.remove('hidden');
    }
  } catch {
    info.classList.add('hidden');
  }
});

// ─── History ───

const loadHistory = async () => {
  const list = $('historyList');
  list.innerHTML =
    '<p style="text-align:center;color:#888;">Загрузка...<span class="loader" style="border-color:#888;border-top-color:transparent;"></span></p>';
  try {
    const resp = await apiPost('/api/invoice/history');
    const ops = resp.Data?.Operations || [];
    if (!ops.length) {
      list.innerHTML = '<p style="text-align:center;color:#888;">Нет операций</p>';
      return;
    }
    list.innerHTML = ops
      .map(
        (op) => `
        <div class="op-item" onclick="showHistoryDetail(${op.Id})">
          <div class="op-row">
            <div>
              <div class="op-name">${op.ClientName || op.ClientShortName || '—'}</div>
              <div class="op-date">${new Date(op.OrderRegDate).toLocaleString('ru')}</div>
            </div>
            <div style="text-align:right;">
              <div class="op-amount">${op.Amount}</div>
              ${statusBadge(op.Status)}
            </div>
          </div>
        </div>`,
      )
      .join('');
  } catch (e) {
    list.innerHTML = `<p style="color:#c62828;">Ошибка: ${e.message}</p>`;
  }
};

const showHistoryDetail = async (opId) => {
  historyOpId = opId;
  const panel = $('historyDetail');
  const content = $('historyDetailContent');
  content.innerHTML = '<p style="text-align:center;">Загрузка...</p>';
  panel.classList.remove('hidden');
  try {
    const resp = await apiFetch(`/api/invoice/details?operationId=${opId}`);
    renderDetails(resp.Data, 'historyDetailContent');
    $('btnCancelFromHistory').classList.toggle('hidden', resp.Data?.Status !== 'RemotePaymentCreated');
  } catch {
    content.innerHTML = '<p style="color:#c62828;">Ошибка</p>';
  }
};

const cancelFromHistory = async () => {
  if (!historyOpId || !confirm('Отменить счёт?')) return;
  try {
    await apiPost('/api/invoice/cancel', { operationId: historyOpId });
    showHistoryDetail(historyOpId);
    loadHistory();
  } catch (e) {
    alert(`Ошибка: ${e.message}`);
  }
};

// ─── Sales (operations history + details + refund) ───

let salesOpId = null;

const loadSales = async () => {
  const list = $('salesList');
  const stats = $('salesStats');
  list.innerHTML =
    '<p style="text-align:center;color:#888;">Загрузка...<span class="loader" style="border-color:#888;border-top-color:transparent;"></span></p>';
  stats.innerHTML = '';
  try {
    const now = new Date();
    const endDate =
      now.getFullYear() +
      '-' +
      String(now.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(now.getDate()).padStart(2, '0') +
      'T23:59:59.000+0500';
    const resp = await apiPost('/api/history/operations', { endDate });
    const data = resp.Data || {};
    // Stats
    const s = data.Statistic || {};
    stats.innerHTML = `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
      <div style="background:#e8f5e9;padding:8px 14px;border-radius:10px;text-align:center;"><div style="font-size:12px;color:#2e7d32;">Продажи</div><div style="font-weight:700;color:#2e7d32;">${s.SalesAmount ?? 0} ₸</div><div style="font-size:11px;color:#888;">${s.SalesCount ?? 0} шт</div></div>
      <div style="background:#ffebee;padding:8px 14px;border-radius:10px;text-align:center;"><div style="font-size:12px;color:#c62828;">Возвраты</div><div style="font-weight:700;color:#c62828;">${s.ReturnsAmount ?? 0} ₸</div><div style="font-size:11px;color:#888;">${s.ReturnsCount ?? 0} шт</div></div>
    </div>`;
    // Operations list
    const dailySets = data.DailySets || [];
    if (!dailySets.length) {
      list.innerHTML = '<p style="text-align:center;color:#888;">Нет операций</p>';
      return;
    }
    let html = '';
    for (const day of dailySets) {
      html += `<div style="font-size:13px;color:#888;margin:12px 0 4px;font-weight:600;">${day.Date || ''}</div>`;
      for (const op of day.Operations || []) {
        const isReturn = op.OperationType === 1;
        const sign = isReturn ? '+' : '';
        const color = isReturn ? '#c62828' : '#1a1a1a';
        html += `<div class="op-item" onclick="showSalesDetail(${op.Id}, ${op.OperationMethod || 0})">
          <div class="op-row">
            <div>
              <div class="op-name">${op.ClientName || op.ClientShortName || '—'}</div>
              <div class="op-date">${op.Time || ''}</div>
            </div>
            <div style="text-align:right;">
              <div class="op-amount" style="color:${color};">${sign}${op.Amount} ₸</div>
            </div>
          </div>
        </div>`;
      }
    }
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = `<p style="color:#c62828;">Ошибка: ${e.message}</p>`;
  }
};

const showSalesDetail = async (id, operationMethod) => {
  salesOpId = id;
  const panel = $('salesDetail');
  const content = $('salesDetailContent');
  const refundSection = $('refundSection');
  const refundMsg = $('refundMsg');
  content.innerHTML = '<p style="text-align:center;">Загрузка...</p>';
  refundSection.classList.add('hidden');
  refundMsg.classList.add('hidden');
  panel.classList.remove('hidden');
  try {
    const resp = await apiPost('/api/history/details', { id, operationMethod: operationMethod || 0 });
    const d = resp.Data || {};
    let rows = '';
    const fields = [
      ['Сумма', d.Amount ? `${d.Amount} ₸` : null],
      ['Клиент', d.ClientName || d.ClientShortName],
      ['Дата', d.OrderRegDate ? new Date(d.OrderRegDate).toLocaleString('ru') : null],
      ['Статус', d.StatusDescription],
      ['Доступно к возврату', d.AvailableReturnAmount != null ? `${d.AvailableReturnAmount} ₸` : null],
      ['Тип возврата', d.PossibleReturnType],
      ['Чек', d.ReceiptUrl ? `<a href="${d.ReceiptUrl}" target="_blank">Открыть</a>` : null],
    ];
    for (const [label, value] of fields) {
      if (value != null)
        rows += `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
    }
    // Returns history
    if (d.Returns && d.Returns.length) {
      rows += '<div style="margin-top:12px;font-weight:600;font-size:14px;">Возвраты:</div>';
      for (const r of d.Returns) {
        rows += `<div class="detail-row"><span class="detail-label">${r.Date || ''}</span><span class="detail-value" style="color:#c62828;">${r.Amount} ₸</span></div>`;
      }
    }
    content.innerHTML = rows || '<p style="color:#888;">Нет данных</p>';
    // Show refund if available
    const returnAmount = parseFloat(String(d.AvailableReturnAmount || '0').replace(/[^\d.]/g, ''));
    if (returnAmount > 0) {
      $('refundAmount').value = returnAmount;
      $('refundAmount').max = returnAmount;
      refundSection.classList.remove('hidden');
    }
  } catch (e) {
    content.innerHTML = `<p style="color:#c62828;">Ошибка: ${e.message}</p>`;
  }
};

const createRefund = async () => {
  const amount = $('refundAmount').value;
  if (!salesOpId || !amount) return alert('Укажите сумму возврата');
  if (!confirm(`Вернуть ${amount} ₸?`)) return;
  const btn = $('btnRefund');
  const msg = $('refundMsg');
  btn.disabled = true;
  btn.innerHTML = 'Возврат...<span class="loader"></span>';
  msg.classList.add('hidden');
  try {
    const resp = await apiPostOnce('/api/refund/create', { qrOperationId: salesOpId, returnAmount: Number(amount) });
    if (resp.StatusCode === 0) {
      msg.className = 'status-bar status-ok';
      msg.textContent = 'Возврат выполнен успешно';
    } else {
      msg.className = 'status-bar status-err';
      msg.textContent = resp.Description || resp.Message || 'Ошибка возврата';
    }
    msg.classList.remove('hidden');
    // Refresh detail
    showSalesDetail(salesOpId, 0);
  } catch (e) {
    msg.className = 'status-bar status-err';
    msg.textContent = `Ошибка: ${e.message}`;
    msg.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сделать возврат';
  }
};

// ─── Live payment events (SSE over fetch, so auth headers can be sent) ───

let liveController = null;
let liveRetryTimer = null;

const EVENT_TOASTS = {
  'payment.success': ['Оплата получена', 'ok'],
  'payment.failed': ['Оплата не прошла', 'err'],
  'payment.expired': ['Время оплаты истекло', 'warn'],
  'payment.lost': ['Статус платежа неизвестен', 'warn'],
};

const showToast = (text, cls) => {
  const el = document.createElement('div');
  el.className = `toast status-bar status-${cls}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
};

const handleLiveEvent = (name, data) => {
  if (name === 'ready') {
    $('liveDot').classList.add('on');
    return;
  }
  if (data.type === 'qr' && String(data.paymentId) === String(qrOperationId)) showQrStatus(data.status);
  if (data.type === 'invoice' && String(data.paymentId) === String(currentOpId)) refreshInvoice();
  const toast = EVENT_TOASTS[name];
  if (toast) showToast(`${toast[0]}${data.amount ? ` · ${data.amount} ₸` : ''} (#${data.paymentId})`, toast[1]);
  if (!$('reportsTab').classList.contains('hidden') && toast) loadReport();
};

const stopLiveEvents = () => {
  clearTimeout(liveRetryTimer);
  if (liveController) liveController.abort();
  liveController = null;
  $('liveDot').classList.remove('on');
};

const startLiveEvents = async () => {
  if (liveController) return;
  const { tokenSN, vtokenSecret } = getSession();
  if (!tokenSN || !vtokenSecret) return;
  liveController = new AbortController();
  const controller = liveController;
  try {
    const resp = await rawFetch('/api/payments/events', { signal: controller.signal });
    // A rejected session will not start working by itself — stop instead of reconnecting forever
    if (resp.status === 401) {
      stopLiveEvents();
      return;
    }
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) {
          try {
            handleLiveEvent(name, JSON.parse(data));
          } catch (e) {
            console.error('Live event error:', e);
          }
        }
      }
    }
  } catch (e) {
    if (controller.signal.aborted) return;
    console.warn('Live events disconnected:', e.message);
  }
  if (liveController !== controller) return;
  // Reconnect unless we logged out
  liveController = null;
  $('liveDot').classList.remove('on');
  liveRetryTimer = setTimeout(startLiveEvents, 5000);
};

// ─── Reports (local payments ledger) ───

const EVENT_LABELS = {
  'payment.success': ['Оплачено', 'paid'],
  'payment.failed': ['Отказ', 'canceled'],
  'payment.expired': ['Истёк', 'expired'],
  'payment.lost': ['Неизвестно', 'pending'],
};

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const reportRange = () => {
  const days = Number($('reportPeriod').value) || 1;
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return `from=${ymd(from)}&to=${ymd(to)}`;
};

const tile = (label, value, color) =>
  `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value" style="color:${color}">${value}</div></div>`;

const loadReport = async () => {
  const box = $('reportSummary');
  const list = $('reportPayments');
  box.innerHTML = '<p style="text-align:center;color:#888;">Загрузка...</p>';
  try {
    const range = reportRange();
    const [summary, payments] = await Promise.all([
      apiFetch(`/api/reports/summary?${range}`),
      apiFetch(`/api/reports/payments?${range}&limit=50`),
    ]);
    if (summary.error) throw new Error(summary.error);
    const t = summary.totals;
    box.innerHTML = `<div class="tiles">
      ${tile('Выручка', `${t.revenue} ₸`, '#2e7d32')}
      ${tile('Оплат', t.success, '#1a1a1a')}
      ${tile('Средний чек', `${t.averageCheck} ₸`, '#1a1a1a')}
      ${tile('Конверсия', `${t.conversion}%`, '#1565c0')}
    </div>
    <div style="font-size:12px;color:#888;text-align:center;margin-top:8px;">
      Отказы: ${t.failed} · Истекли: ${t.expired} · Неизвестно: ${t.lost}
    </div>
    ${summary.byDay
      .map(
        (d) =>
          `<div class="detail-row"><span class="detail-label">${escapeHtml(d.date)}</span><span class="detail-value">${d.revenue} ₸ · ${d.success}/${d.count}</span></div>`,
      )
      .join('')}`;
    const items = payments.items || [];
    list.innerHTML = items.length
      ? items
          .map((p) => {
            const [label, cls] = EVENT_LABELS[p.event] || [p.event, 'pending'];
            return `<div class="op-item"><div class="op-row">
              <div><div class="op-name">${p.type === 'qr' ? 'QR' : 'Счёт'} #${escapeHtml(p.paymentId)}</div>
              <div class="op-date">${new Date(p.timestamp).toLocaleString('ru')}</div></div>
              <div style="text-align:right;"><div class="op-amount">${escapeHtml(p.amount ?? '—')} ₸</div>
              <span class="badge badge-${cls}">${label}</span></div>
            </div></div>`;
          })
          .join('')
      : '<p style="text-align:center;color:#888;">Нет платежей за период</p>';
  } catch (e) {
    box.innerHTML = `<p style="color:#c62828;">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
};

const downloadReportCsv = async () => {
  try {
    const resp = await rawFetch(`/api/reports/export.csv?${reportRange()}`);
    if (!resp.ok) throw new Error(errorText(await resp.json().catch(() => ({})), `HTTP ${resp.status}`));
    const blob = await resp.blob();
    const name = /filename="([^"]+)"/.exec(resp.headers.get('Content-Disposition') || '')?.[1] || 'kaspi-payments.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    alert(`Ошибка: ${e.message}`);
  }
};

// ─── Expose to HTML onclick handlers ───

Object.assign(window, {
  sendPhone,
  verifyOtp,
  resetAuth,
  logout,
  switchTab,
  createInvoice,
  refreshInvoice,
  cancelInvoice,
  createQr,
  resetQr,
  loadHistory,
  showHistoryDetail,
  cancelFromHistory,
  loadSales,
  showSalesDetail,
  createRefund,
  loadReport,
  downloadReportCsv,
});

// ─── Init ───

(() => {
  setAuthStep(1);
  const session = getSession();
  if (session.tokenSN && session.vtokenSecret) {
    showMainScreen(session);
  }
})();
