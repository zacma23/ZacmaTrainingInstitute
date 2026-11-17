const nodemailer = require('nodemailer');
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

function normalizeEmailAddress(rawEmail) {
  const clean = String(rawEmail || '').trim();
  if (!clean) {
    return { valid: false, normalized: '', error: 'Email address is missing.' };
  }
  const basicRe = /^[^\s@<>()[\]\\,;:\s@"]+@[^\s@<>()[\]\\,;:\s@"]+\.[^\s@<>()[\]\\,;:\s@"]{2,}$/;
  if (!basicRe.test(clean)) {
    return { valid: false, normalized: '', error: `Invalid email address "${clean}".` };
  }
  return { valid: true, normalized: clean.toLowerCase() };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Honest WhatsApp, SMS Phone Provider, and SMTP/Resend Email Gateway Status.
 * Never claims a message was delivered externally unless a real provider is configured
 * and returns a confirmed delivery response.
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
  const customUrl = (process.env.SMS_API_URL || '').trim();
  const customKey = (process.env.SMS_API_KEY || '').trim();

  // Auto-detect SMS provider if credentials exist even when SMS_PROVIDER wasn't explicitly named
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

  // Email Gateway Detection (Resend HTTP API or Nodemailer SMTP)
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const smtpUrl = (process.env.SMTP_URL || '').trim();
  const smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();

  let emailProvider = 'none';
  if (resendKey) emailProvider = 'resend';
  else if (smtpUrl || (smtpHost && smtpUser && smtpPass)) emailProvider = 'smtp';

  const fromEmail = (
    overrides.emailFromAddress ||
    overrides.instituteEmail ||
    process.env.EMAIL_FROM ||
    process.env.SMTP_FROM ||
    smtpUser ||
    ''
  ).trim();
  const fromName = (
    overrides.emailFromName ||
    overrides.instituteName ||
    process.env.EMAIL_FROM_NAME ||
    'Zacma Technology Institute'
  ).trim();

  const emailConfigured = emailProvider !== 'none';

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
    email: {
      provider: emailProvider,
      configured: emailConfigured,
      fromEmail,
      fromName,
      statusMessage: emailConfigured
        ? `Configured (${emailProvider}${fromEmail ? ` · From ${fromEmail}` : ''})`
        : 'Not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY in .env / Vercel',
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
      return { sent: true, channelStatus: 'SENT', detail: `Sent via Africa's Talking${activeFrom ? ` (${activeFrom})` : ''}` };
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

    // Generic / Custom HTTP Phone Gateway
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

/**
 * Attempts real email dispatch via configured SMTP (Nodemailer) or Resend HTTP API.
 */
async function dispatchEmailMessage({
  toEmail,
  toName = 'Student',
  subject = 'Institute Notification',
  message = '',
  fromEmail = '',
  fromName = '',
  replyTo = '',
  instituteName = 'Zacma Technology Institute',
}) {
  const toCheck = normalizeEmailAddress(toEmail);
  if (!toCheck.valid) {
    return {
      sent: false,
      channelStatus: 'FAILED',
      detail: toCheck.error === 'Email address is missing.' ? 'Student has no email address on file.' : toCheck.error,
    };
  }

  const status = getGatewayStatus({
    emailFromAddress: fromEmail,
    emailFromName: fromName,
    instituteName,
  });

  if (!status.email.configured) {
    return {
      sent: false,
      channelStatus: 'EMAIL_NOT_CONFIGURED',
      detail: 'Email provider credentials (SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY) are not configured in server environment (.env / Vercel).',
    };
  }

  const senderEmail = status.email.fromEmail;
  if (!senderEmail) {
    return {
      sent: false,
      channelStatus: 'FAILED',
      detail: 'No sender email address specified in modal, Settings, or SMTP_USER.',
    };
  }

  const senderCheck = normalizeEmailAddress(senderEmail);
  if (!senderCheck.valid) {
    return {
      sent: false,
      channelStatus: 'FAILED',
      detail: `Invalid sender email: ${senderCheck.error}`,
    };
  }

  const safeFromName = (fromName || status.email.fromName || instituteName).replace(/["\r\n]/g, '').trim();
  const formattedFrom = `${safeFromName} <${senderCheck.normalized}>`;
  const cleanSubject = String(subject || 'Institute Notification').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const cleanText = String(message || '').trim();
  const htmlBody = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
      <div style="background: #0f172a; color: #ffffff; padding: 16px 20px;">
        <div style="font-size: 16px; font-weight: 700;">${escapeHtml(instituteName)}</div>
        <div style="font-size: 12px; color: #cbd5e1; margin-top: 2px;">${escapeHtml(cleanSubject)}</div>
      </div>
      <div style="padding: 20px; line-height: 1.6; font-size: 14px; white-space: pre-wrap;">${escapeHtml(cleanText)}</div>
      <div style="padding: 12px 20px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
        Sent to ${escapeHtml(toName)} &middot; From ${escapeHtml(senderCheck.normalized)}
      </div>
    </div>
  `;

  try {
    if (status.email.provider === 'resend') {
      const resendKey = (process.env.RESEND_API_KEY || '').trim();
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: formattedFrom,
          to: [toCheck.normalized],
          ...(replyTo || senderCheck.normalized ? { reply_to: replyTo || senderCheck.normalized } : {}),
          subject: cleanSubject,
          text: cleanText,
          html: htmlBody,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        logger.warn('Resend API error', { status: res.status, message: payload.message });
        return { sent: false, channelStatus: 'FAILED', detail: payload.message || `Resend HTTP ${res.status}` };
      }
      return {
        sent: true,
        channelStatus: 'SENT',
        detail: `Sent via Resend from ${senderCheck.normalized}${payload.id ? ` (${payload.id})` : ''}`,
      };
    }

    // SMTP via Nodemailer
    const smtpUrl = (process.env.SMTP_URL || '').trim();
    const smtpUser = (process.env.SMTP_USER || '').trim();
    const smtpHost = (process.env.SMTP_HOST || '').trim();
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpSecure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || smtpPort === 465;

    const transport = smtpUrl
      ? nodemailer.createTransport(smtpUrl)
      : nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          auth: {
            user: smtpUser,
            pass: (process.env.SMTP_PASS || '').trim(),
          },
        });

    // If SMTP server authenticates as smtpUser, use senderCheck as replyTo & requested from (with smtpUser fallback if relay rejects alias)
    const info = await transport.sendMail({
      from: formattedFrom,
      to: toCheck.normalized,
      replyTo: replyTo || senderCheck.normalized,
      subject: cleanSubject,
      text: cleanText,
      html: htmlBody,
    });

    return {
      sent: true,
      channelStatus: 'SENT',
      detail: `Email sent from ${senderCheck.normalized}${info.messageId ? ` (${info.messageId})` : ''}`,
    };
  } catch (err) {
    logger.error('Email dispatch failed', { provider: status.email.provider, error: err.message });
    return { sent: false, channelStatus: 'FAILED', detail: err.message };
  }
}

module.exports = {
  normalizePhoneForProvider,
  normalizeEmailAddress,
  getGatewayStatus,
  dispatchReminderMessage,
  dispatchEmailMessage,
};
