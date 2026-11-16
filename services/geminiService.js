const { GoogleGenAI } = require('@google/genai');

let aiClient = null;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error('Gemini API key is not configured on the server. Check Settings > Secrets.');
    err.status = 503;
    throw err;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

const CHATBOT_ROLES = {
  fee_advisor: {
    id: 'fee_advisor',
    label: 'Fee & Policy Advisor',
    model: 'gemini-4-hydrogen',
    buildSystemInstruction: (ctx) =>
      [
        `You are the BirrLedger Financial & Operations Advisor for ${ctx.instituteName} (an Ethiopian short-term vocational & technology training institute).`,
        `Current signed-in staff role: ${ctx.userRole === 'admin' ? 'Administrator (full approval & ledger authority)' : 'Accountant (registration & payment intake; Administrator issues official receipts)'}.`,
        `Currency is Ethiopian Birr (ETB) and timezone is Africa/Addis_Ababa.`,
        ctx.coursesSummary ? `Active courses and fees:\n${ctx.coursesSummary}` : '',
        ctx.statsSummary ? `Live institute summary:\n${ctx.statsSummary}` : '',
        'Give concise, accurate, practical answers tailored to Ethiopian training institute workflows, installment schedules (full, 2-month, 3-month, 6-month, custom), and RBAC policies. Keep responses clear and scannable.',
      ]
        .filter(Boolean)
        .join('\n\n'),
  },
  reminder_drafter: {
    id: 'reminder_drafter',
    label: 'Fast Reminder Drafter',
    model: 'gemini-3.1-flash-lite',
    buildSystemInstruction: (ctx) =>
      [
        `You are a fast communications assistant for ${ctx.instituteName} in Ethiopia.`,
        `Draft polite, clear, professional payment reminders, due-soon notices, or registration follow-up messages for SMS, WhatsApp, or Telegram in ETB.`,
        `Keep messages brief, respectful, and ready to copy-paste. Include English or Amharic/bilingual phrasing when helpful.`,
      ].join('\n\n'),
  },
  audit_analyst: {
    id: 'audit_analyst',
    label: 'Operations & Compliance Helper',
    model: 'gemini-4-hydrogen',
    buildSystemInstruction: (ctx) =>
      [
        `You are an internal operations and compliance analyst for ${ctx.instituteName}.`,
        `Signed-in staff role: ${ctx.userRole}.`,
        ctx.statsSummary ? `Live institute summary:\n${ctx.statsSummary}` : '',
        'Help analyze outstanding balances, overdue installments, accountant-to-admin approval queues, receipt verification steps, and month-end reconciliation checklists without exposing raw private credentials.',
      ]
        .filter(Boolean)
        .join('\n\n'),
  },
};

function normalizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .filter(
      (item) =>
        item &&
        (item.role === 'user' || item.role === 'model') &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
    )
    .slice(-24)
    .map((item) => ({
      role: item.role,
      parts: [{ text: item.text.trim().slice(0, 4000) }],
    }));
}

async function sendMultiTurnChat({ message, history, roleId, context }) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    const err = new Error('Message cannot be empty.');
    err.status = 400;
    throw err;
  }

  const roleCfg = CHATBOT_ROLES[roleId] || CHATBOT_ROLES.fee_advisor;
  const ai = getGeminiClient();
  const formattedHistory = normalizeHistory(history);

  const chat = ai.chats.create({
    model: roleCfg.model,
    history: formattedHistory,
    config: {
      systemInstruction: roleCfg.buildSystemInstruction(context),
    },
  });

  const response = await chat.sendMessage({
    message: cleanMessage.slice(0, 4000),
  });

  const replyText = (response && response.text ? response.text : '').trim();
  if (!replyText) {
    throw new Error('The assistant returned an empty response. Please try again.');
  }

  return {
    reply: replyText,
    model: roleCfg.model,
    roleId: roleCfg.id,
    roleLabel: roleCfg.label,
  };
}

module.exports = {
  CHATBOT_ROLES,
  sendMultiTurnChat,
};
