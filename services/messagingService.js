const logger = require('../config/logger');

/**
 * Honest WhatsApp & SMS Gateway Integration Architecture.
 * Never claims a message was sent externally unless a real provider is configured
 * via environment variables and returns a confirmed delivery response.
 */
function getGatewayStatus() {
  const whatsappProvider = (process.env.WHATSAPP_PROVIDER || 'none').trim().toLowerCase();
  const smsProvider = (process.env.SMS_PROVIDER || 'none').trim().toLowerCase();

  const whatsappConfigured =
    whatsappProvider !== 'none' &&
    Boolean(process.env.WHATSAPP_API_URL) &&
    Boolean(process.env.WHATSAPP_API_TOKEN);

  const smsConfigured =
    smsProvider !== 'none' &&
    Boolean(process.env.SMS_API_URL) &&
    Boolean(process.env.SMS_API_KEY);

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
      statusMessage: smsConfigured
        ? `Configured (${smsProvider})`
        : 'Not configured — reminders logged in-app only',
    },
  };
}

/**
 * Attempts dispatch only if a real provider webhook/API is configured in environment.
 */
async function dispatchReminderMessage({ phone, message, channel = 'whatsapp' }) {
  const status = getGatewayStatus();

  if (channel === 'whatsapp' && !status.whatsapp.configured) {
    return {
      sent: false,
      channelStatus: 'WHATSAPP_NOT_CONFIGURED',
      detail: 'WhatsApp provider credentials not configured in environment.',
    };
  }

  if (channel === 'sms' && !status.sms.configured) {
    return {
      sent: false,
      channelStatus: 'SMS_NOT_CONFIGURED',
      detail: 'SMS provider credentials not configured in environment.',
    };
  }

  try {
    const url = channel === 'whatsapp' ? process.env.WHATSAPP_API_URL : process.env.SMS_API_URL;
    const token = channel === 'whatsapp' ? process.env.WHATSAPP_API_TOKEN : process.env.SMS_API_KEY;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: phone,
        message,
        senderId: process.env.SMS_SENDER_ID || 'BirrLedger',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn('External messaging gateway returned non-OK status', {
        channel,
        status: response.status,
        body: text.slice(0, 200),
      });
      return { sent: false, channelStatus: 'FAILED', detail: `Gateway HTTP ${response.status}` };
    }

    return { sent: true, channelStatus: 'SENT', detail: 'Dispatched via configured gateway.' };
  } catch (err) {
    logger.error('Messaging dispatch failed', { channel, error: err.message });
    return { sent: false, channelStatus: 'FAILED', detail: err.message };
  }
}

module.exports = {
  getGatewayStatus,
  dispatchReminderMessage,
};
