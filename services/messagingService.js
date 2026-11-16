const logger = require('../config/logger');
const { validateEthiopianPhone } = require('../utils/ethiopia');

function normalizePhoneForProvider(rawPhone) {
  const raw = String(rawPhone || '').trim();
  if (!raw) return { valid: false, normalized: '', error: 'Phone number is missing.' };
  const et = validateEthiopianPhone(raw);
  if (et.valid) return et;
  const cleaned = raw.replace(/[\s\-()]/g, '');
  if (/^\+\d{7,15}$/.test(cleaned)) {
    return { valid: true, normalized: cleaned };
  }
  return { valid: false, normalized: '', error: et.error || 'Invalid phone number format.' };
}

/**
 * Honest WhatsApp & SMS Phone Provider Integration Architecture.
 * Never claims a message was sent externally unless a real provider is configured
 * via server environment variables and returns a confirmed HTTP delivery response.
 */
function getGatewayStatus(overrides = {}) {
  const whatsappProvider = (process.env.WHATSAPP_PROVIDER || 'none').trim().toLowerCase();
  let smsProvider = (process.env.SMS_PROVIDER || '').trim().toLowerCase();

  const twilioSid = (process.env.TWILIO_ACCOUNT_SID || process.env.SMS_ACCOUNT_SID || '').trim();
  const twilioToken = (process.env.TWILIO_AUTH_TOKEN || process.env.SMS_API_KEY || '').trim();
  const twilioFrom = (
    overrides.smsFromNumber ||
    process.env.TWILIO_FROM_NUMBER ||
    process.env.SMS_FROM_NUMBER ||
    ''
  ).trim();

  const atUser = (process.env.AFRICASTALKING_USERNAME || process.env.SMS_USERNAME || '').trim();
  const atKey = (process.env.AFRICASTALKING_API_KEY || process.env.SMS_API_KEY || '').trim();

  const afroToken = (process.env.AFROMESSAGE_TOKEN || process.env.SMS_API_KEY || '').trim();
  const afroFromId = (process.env.AFROMESSAGE_IDENTIFIER_ID || overrides.smsFromNumber || process.env.SMS_FROM_NUMBER || '').trim();

  const customUrl = (process.env.SMS_API_URL || '').trim();
  const customKey = (process.env.SMS_API_KEY || '').trim();

  // Auto-detect provider if specific credentials exist even when SMS_PROVIDER wasn't explicitly named
  if (!smsProvider || smsProvider === 'none') {
    if (twilioSid && twilioToken && twilioFrom) smsProvider = 'twilio';
    else if (atUser && atKey) smsProvider = 'africastalking';
    else if (customUrl && customKey) smsProvider = 'custom';
    else smsProvider = 'none';
  }

  const fromNumber = (
    overrides.smsFromNumber ||
    process.env.SMS_FROM_NUMBER ||
    process.env.TWILIO_FROM_NUMBER ||
    ''
  ).trim();
  const senderId = (overrides.smsSenderId || process.env.SMS_SENDER_ID || 'ZacmaTech').trim();

  let smsConfigured = false;
  if (smsProvider === 'twilio') {
    smsConfigured = Boolean(twilioSid && twilioToken && twilioFrom);
  } else if (smsProvider === 'africastalking') {
    smsConfigured = Boolean(atUser && atKey);
  } else if (smsProvider === 'afromessage') {
    smsConfigured = Boolean(afroToken);
  } else if (smsProvider !== 'none') {
    smsConfigured = Boolean(customUrl && customKey);
  }

  const whatsappConfigured =
    whatsappProvider !== 'none' &&
    Boolean(process.env.WHATSAPP_API_URL) &&
    Boolean(process.env.WHATSAPP_API_TOKEN);

  return {
    whatsapp: {
      provider: whatsappConfigured ? whatsappProvider : 'none',
      configured: whatsappConfigured,
      statusMessage: whatsappConfigured
        ? `Configured (${whatsappProvider})`
        : 'Not configured — reminders logged in-app only',
    },
    sms: {
      provider: smsConfigured ? smsProvider : 'none',
      configured: smsConfigured,
      fromNumber,
      senderId,
      statusMessage: smsConfigured
        ? `Configured (${smsProvider}${fromNumber ? ` · From ${fromNumber}` : senderId ? ` · Sender ${senderId}` : ''})`
        : 'Not configured — configure provider env vars in .env / Vercel',
    },
  };
}

/**
 * Attempts real dispatch via the configured phone number / SMS / WhatsApp provider.
 */
async function dispatchReminderMessage({
  phone,
  message,
  channel = 'sms',
  fromNumber = '',
  senderId = '',
}) {
  const status = getGatewayStatus({ smsFromNumber: fromNumber, smsSenderId: senderId });
  const normalizedPhone = normalizePhoneForProvider(phone);

  if (!normalizedPhone.valid) {
    return {
      sent: false,
      channelStatus: 'FAILED',
      detail: normalizedPhone.error,
    };
  }

  const to = normalizedPhone.normalized;

  if (channel === 'whatsapp') {
    if (!status.whatsapp.configured) {
      return {
        sent: false,
        channelStatus: 'WHATSAPP_NOT_CONFIGURED',
        detail: 'WhatsApp provider credentials not configured in server environment.',
      };
    }

    try {
      const response = await fetch(process.env.WHATSAPP_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        },
        body: JSON.stringify({
          to,
          from: status.sms.fromNumber || undefined,
          message,
          senderId: status.sms.senderId,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('WhatsApp gateway returned non-OK status', { status: response.status, body: text.slice(0, 200) });
        return { sent: false, channelStatus: 'FAILED', detail: `Gateway HTTP ${response.status}` };
      }

      return { sent: true, channelStatus: 'SENT', detail: 'Dispatched via configured WhatsApp gateway.' };
    } catch (err) {
      logger.error('WhatsApp dispatch failed', { error: err.message });
      return { sent: false, channelStatus: 'FAILED', detail: err.message };
    }
  }

  // SMS / Phone Number Provider Dispatch
  if (!status.sms.configured) {
    return {
      sent: false,
      channelStatus: 'SMS_NOT_CONFIGURED',
      detail: 'Phone/SMS provider credentials are not configured in server environment (.env / Vercel).',
    };
  }

  const provider = status.sms.provider;
  const activeFrom = status.sms.fromNumber;
  const activeSender = status.sms.senderId;

  try {
    if (provider === 'twilio') {
      const sid = (process.env.TWILIO_ACCOUNT_SID || process.env.SMS_ACCOUNT_SID || '').trim();
      const token = (process.env.TWILIO_AUTH_TOKEN || process.env.SMS_API_KEY || '').trim();
      const from = activeFrom || (process.env.TWILIO_FROM_NUMBER || '').trim();
      const authBasic = Buffer.from(`${sid}:${token}`).toString('base64');
      const form = new URLSearchParams({ To: to, From: from, Body: message });

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authBasic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger.warn('Twilio SMS API error', { status: response.status, message: payload.message });
        return { sent: false, channelStatus: 'FAILED', detail: payload.message || `Twilio HTTP ${response.status}` };
      }
      return {
        sent: true,
        channelStatus: 'SENT',
        detail: `Sent via Twilio from ${from}${payload.sid ? ` (${payload.sid})` : ''}`,
      };
    }

    if (provider === 'africastalking') {
      const username = (process.env.AFRICASTALKING_USERNAME || process.env.SMS_USERNAME || '').trim();
      const apiKey = (process.env.AFRICASTALKING_API_KEY || process.env.SMS_API_KEY || '').trim();
      const isSandbox = username.toLowerCase() === 'sandbox';
      const url = isSandbox
        ? 'https://api.sandbox.africastalking.com/version1/messaging'
        : 'https://api.africastalking.com/version1/messaging';

      const form = new URLSearchParams({ username, to, message });
      if (activeFrom || activeSender) {
        form.set('from', activeFrom || activeSender);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger.warn("Africa's Talking SMS API error", { status: response.status });
        return { sent: false, channelStatus: 'FAILED', detail: payload.SMSMessageData?.Message || `HTTP ${response.status}` };
      }
      return { sent: true, channelStatus: 'SENT', detail: "Sent via Africa's Talking" };
    }

    if (provider === 'afromessage') {
      const token = (process.env.AFROMESSAGE_TOKEN || process.env.SMS_API_KEY || '').trim();
      const url = (process.env.SMS_API_URL || 'https://api.afromessage.com/api/send').trim();
      const identifierId = (process.env.AFROMESSAGE_IDENTIFIER_ID || activeFrom || '').trim();

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(identifierId ? { from: identifierId } : {}),
          ...(activeSender ? { sender: activeSender } : {}),
          to,
          message,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.acknowledge === 'error') {
        const errDetail = (payload.response && payload.response.errors && payload.response.errors.join(', ')) || `HTTP ${response.status}`;
        logger.warn('AfroMessage API error', { status: response.status, errDetail });
        return { sent: false, channelStatus: 'FAILED', detail: errDetail };
      }
      return { sent: true, channelStatus: 'SENT', detail: 'Sent via AfroMessage' };
    }

    // Generic / Custom HTTP Phone Gateway (e.g. Android SMS Gateway, local gateway, custom webhook)
    const response = await fetch(process.env.SMS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SMS_API_KEY}`,
      },
      body: JSON.stringify({
        to,
        from: activeFrom || undefined,
        senderId: activeSender,
        message,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn('External SMS gateway returned non-OK status', {
        provider,
        status: response.status,
        body: text.slice(0, 200),
      });
      return { sent: false, channelStatus: 'FAILED', detail: `Gateway HTTP ${response.status}` };
    }

    return {
      sent: true,
      channelStatus: 'SENT',
      detail: `Sent via ${provider}${activeFrom ? ` from ${activeFrom}` : ''}.`,
    };
  } catch (err) {
    logger.error('Messaging dispatch failed', { channel, provider, error: err.message });
    return { sent: false, channelStatus: 'FAILED', detail: err.message };
  }
}

module.exports = {
  normalizePhoneForProvider,
  getGatewayStatus,
  dispatchReminderMessage,
};
