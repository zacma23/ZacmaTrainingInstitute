const ETHIOPIA_TZ = 'Africa/Addis_Ababa';

const ETHIOPIAN_REGIONS = [
  'Addis Ababa',
  'Oromia',
  'Amhara',
  'Tigray',
  'Sidama',
  'Central Ethiopia',
  'South Ethiopia',
  'South West Ethiopia',
  'Somali',
  'Afar',
  'Benishangul-Gumuz',
  'Gambela',
  'Harari',
  'Dire Dawa',
];

/**
 * Returns today's date string (YYYY-MM-DD) in Africa/Addis_Ababa timezone.
 */
function getAddisTodayISO() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ETHIOPIA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Returns YYYY-MM in Africa/Addis_Ababa timezone.
 */
function getAddisMonthISO() {
  return getAddisTodayISO().slice(0, 7);
}

/**
 * Adds months or days cleanly to an ISO date string (YYYY-MM-DD).
 */
function addDaysISO(dateISO, days) {
  const [y, m, d] = String(dateISO).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function addMonthsISO(dateISO, months) {
  const [y, m, d] = String(dateISO).slice(0, 10).split('-').map(Number);
  const targetMonth = m - 1 + months;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, normMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, maxDay);
  const dt = new Date(Date.UTC(targetYear, normMonth, clampedDay));
  return dt.toISOString().slice(0, 10);
}

/**
 * Computes day difference (dateB - dateA) in whole days.
 */
function diffDaysISO(dateA, dateB) {
  const a = String(dateA).slice(0, 10).split('-').map(Number);
  const b = String(dateB).slice(0, 10).split('-').map(Number);
  const msA = Date.UTC(a[0], a[1] - 1, a[2]);
  const msB = Date.UTC(b[0], b[1] - 1, b[2]);
  return Math.round((msB - msA) / 86400000);
}

/**
 * Validates and normalizes Ethiopian phone numbers.
 * Accepts: +2519XXXXXXXX, +2517XXXXXXXX, 2519XXXXXXXX, 09XXXXXXXX, 07XXXXXXXX, 011XXXXXXX
 */
function validateEthiopianPhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { valid: false, normalized: '', error: 'Phone number is required.' };
  }
  const cleaned = rawPhone.replace(/[\s\-()]/g, '');
  if (/^\+251(9|7)\d{8}$/.test(cleaned)) {
    return { valid: true, normalized: cleaned };
  }
  if (/^251(9|7)\d{8}$/.test(cleaned)) {
    return { valid: true, normalized: '+' + cleaned };
  }
  if (/^0(9|7)\d{8}$/.test(cleaned)) {
    return { valid: true, normalized: '+251' + cleaned.slice(1) };
  }
  if (/^(\+251|0)?11\d{7}$/.test(cleaned)) {
    const normalized = cleaned.startsWith('+251')
      ? cleaned
      : cleaned.startsWith('0')
        ? '+251' + cleaned.slice(1)
        : '+251' + cleaned;
    return { valid: true, normalized };
  }
  return {
    valid: false,
    normalized: '',
    error: 'Enter a valid Ethiopian phone number (e.g., 0911223344, 0711223344, or +251911223344).',
  };
}

function formatETB(amount) {
  const num = Number(amount || 0);
  return (
    num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' ETB'
  );
}

/**
 * Prevents CSV formula injection (=, +, -, @) and escapes quotes.
 */
function escapeCsvCell(value) {
  let str = String(value ?? '');
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = {
  ETHIOPIA_TZ,
  ETHIOPIAN_REGIONS,
  getAddisTodayISO,
  getAddisMonthISO,
  addDaysISO,
  addMonthsISO,
  diffDaysISO,
  validateEthiopianPhone,
  formatETB,
  escapeCsvCell,
};
