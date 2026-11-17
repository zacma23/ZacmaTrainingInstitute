const TOKEN_KEY = 'birrledger_jwt_token';

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

async function apiRequest(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/auth/setup-admin')) {
    clearToken();
    if (typeof window.handleSessionExpired === 'function') {
      window.handleSessionExpired();
    }
  }
  return res;
}

async function apiJson(url, options = {}) {
  const res = await apiRequest(url, options);
  const rawText = await res.text().catch(() => '');
  let data = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      const cleanSnippet = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
      if (cleanSnippet) {
        data = { detail: cleanSnippet };
      }
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function downloadAuthorizedFile(url, filename) {
  const res = await apiRequest(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Download failed.');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(objectUrl);
  a.remove();
}

function fmtETB(amount) {
  const n = Number(amount || 0);
  return (
    n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' ETB'
  );
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const s = String(dateStr).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function getAddisTodayClientISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusTagClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid' || s === 'active' || s === 'completed' || s === 'approved' || s === 'present') return 'status-paid';
  if (
    s.includes('partial') ||
    s.includes('due today') ||
    s.includes('due soon') ||
    s === 'graduated' ||
    s === 'pending' ||
    s === 'pending_admin_approval' ||
    s === 'correction_required' ||
    s === 'late' ||
    s === 'excused'
  ) {
    return 'status-partial';
  }
  if (s.includes('overdue') || s === 'unpaid' || s === 'suspended' || s === 'inactive' || s === 'rejected' || s === 'absent') {
    return 'status-danger';
  }
  return 'status-neutral';
}

function formatStatusLabel(status) {
  const map = {
    PENDING_ADMIN_APPROVAL: 'Pending Approval',
    CORRECTION_REQUIRED: 'Correction Required',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    PENDING: 'Pending',
    REGISTRATION_FEE: 'Registration Fee',
    COURSE_FEE: 'Tuition Fee',
    COMBINED: 'Reg + Tuition',
  };
  return map[status] || String(status || '—');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3800);
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
  if (window.lucide) window.lucide.createIcons();
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

let confirmResolver = null;
function askConfirm({ title = 'Confirm Action', message = 'Are you sure?', okLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;
    const okBtn = document.getElementById('confirmModalOkBtn');
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    openModal('confirmModal');
  });
}

function resolveConfirmModal(accepted) {
  closeModal('confirmModal');
  if (confirmResolver) {
    const fn = confirmResolver;
    confirmResolver = null;
    fn(Boolean(accepted));
  }
}

let reasonResolver = null;
function askReasonModal({
  title = 'Provide Reason',
  message = '',
  label = 'Reason / Comment *',
  placeholder = 'Enter clear details (minimum 3 characters)...',
  okLabel = 'Submit',
  danger = true,
  required = true,
}) {
  return new Promise((resolve) => {
    reasonResolver = { resolve, required };
    document.getElementById('reasonModalTitle').textContent = title;
    document.getElementById('reasonModalMessage').textContent = message;
    document.getElementById('reasonModalLabel').textContent = label;
    const input = document.getElementById('reasonModalInput');
    input.value = '';
    input.placeholder = placeholder;
    document.getElementById('reasonModalError').style.display = 'none';
    const okBtn = document.getElementById('reasonModalOkBtn');
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    openModal('reasonModal');
    setTimeout(() => input.focus(), 50);
  });
}

function resolveReasonModal(accepted) {
  if (!reasonResolver) return;
  const { resolve, required } = reasonResolver;
  if (!accepted) {
    reasonResolver = null;
    closeModal('reasonModal');
    resolve(null);
    return;
  }
  const val = document.getElementById('reasonModalInput').value.trim();
  const errEl = document.getElementById('reasonModalError');
  if (required && val.length < 3) {
    errEl.textContent = 'Please enter at least 3 characters.';
    errEl.style.display = 'block';
    return;
  }
  reasonResolver = null;
  closeModal('reasonModal');
  resolve(val);
}

window.openModal = openModal;
window.closeModal = closeModal;
window.resolveConfirmModal = resolveConfirmModal;
window.resolveReasonModal = resolveReasonModal;
window.formatStatusLabel = formatStatusLabel;
window.askReasonModal = askReasonModal;
