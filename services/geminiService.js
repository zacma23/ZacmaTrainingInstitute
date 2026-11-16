const { GoogleGenAI, Type, ThinkingLevel } = require('@google/genai');
const { ETHIOPIAN_REGIONS, validateEthiopianPhone } = require('../utils/ethiopia');

let aiClient = null;
let cachedKey = null;

function isGeminiConfigured() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
}

function getGeminiClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error('Gemini API key is not configured on the server. Check Settings > Secrets.');
    err.status = 503;
    throw err;
  }
  if (!aiClient || cachedKey !== apiKey) {
    cachedKey = apiKey;
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

function mapGeminiError(err) {
  const rawMsg = String(err?.message || 'Gemini AI request failed.');
  if (err?.status === 503) return err;

  let friendly = rawMsg;
  let status = err?.status || 500;

  if (/API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(rawMsg)) {
    status = 403;
    friendly = 'Gemini API key was rejected or lacks permission. Please verify GEMINI_API_KEY in Settings > Secrets.';
  } else if (/RESOURCE_EXHAUSTED|429|quota/i.test(rawMsg)) {
    status = 429;
    friendly = 'Gemini API rate/quota limit reached. Wait a moment and retry or check your billing quota in Settings > Secrets.';
  } else if (/NOT_FOUND|404/i.test(rawMsg)) {
    status = 502;
    friendly = 'Requested Gemini model is currently unavailable. Please retry.';
  }

  const mapped = new Error(friendly);
  mapped.status = status;
  return mapped;
}

async function withRetry(fn, retries = 1) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      const transient = /503|500|ECONNRESET|ETIMEDOUT|fetch failed|UNAVAILABLE/i.test(msg);
      if (i < retries && transient) {
        await new Promise((r) => setTimeout(r, 450 * (i + 1)));
        continue;
      }
      throw mapGeminiError(err);
    }
  }
  throw mapGeminiError(lastErr);
}

function getAiStatus() {
  return {
    configured: isGeminiConfigured(),
    models: {
      reasoningAndVision: 'gemini-4-hydrogen',
      fastDrafter: 'gemini-3.1-flash-lite',
      audioTranscribe: 'gemini-3.5-transcribe',
      textToSpeech: 'gemini-3.8-flash-lite-tts',
    },
    tools: [
      { id: 'fayda_scanner', name: 'Fayda National ID Scanner (Vision & PDF)' },
      { id: 'payment_slip_ocr', name: 'Bank & Telebirr Slip OCR' },
      { id: 'live_db_assistant', name: 'Live Ledger Function-Calling Chat' },
      { id: 'streaming_chat', name: 'Real-Time Streaming Assistant (SSE)' },
      { id: 'search_grounding', name: 'Google Search & URL Grounding' },
      { id: 'voice_transcribe', name: 'Voice Note Transcription' },
      { id: 'voice_tts', name: 'Read-Aloud Audio Summary (TTS)' },
      { id: 'course_recommender', name: 'AI Course & Installment Recommender' },
      { id: 'executive_briefing', name: 'Executive Risk & Revenue Briefing (Admin)' },
    ],
  };
}

const CHATBOT_ROLES = {
  fee_advisor: {
    id: 'fee_advisor',
    label: 'Fee & Policy Advisor (Live DB)',
    model: 'gemini-4-hydrogen',
    useTools: true,
    buildSystemInstruction: (ctx) =>
      [
        `You are the BirrLedger Operations & Financial Advisor for ${ctx.instituteName} (an Ethiopian short-term vocational & technology training institute).`,
        `Current signed-in staff role: ${ctx.userRole === 'admin' ? 'Administrator (full approval, attendance, messaging, and ledger authority)' : 'Accountant (registration & payment intake; Administrator approves & issues official receipts)'}.`,
        `Currency is Ethiopian Birr (ETB) and timezone is Africa/Addis_Ababa.`,
        ctx.coursesSummary ? `Active courses & official fees:\n${ctx.coursesSummary}` : '',
        ctx.statsSummary ? `Live institute summary:\n${ctx.statsSummary}` : '',
        'You have live database lookup tools available. Whenever the staff member asks about specific students, overdue accounts, pending queues, courses, attendance, or institute KPIs, ALWAYS call the appropriate tool first before answering so numbers and names are 100% grounded in live MySQL records.',
        'Strictly respect role access: do not fabricate records. Format balances cleanly in ETB and keep answers structured and scannable.',
      ]
        .filter(Boolean)
        .join('\n\n'),
  },
  reminder_drafter: {
    id: 'reminder_drafter',
    label: 'Fast Reminder & SMS Drafter',
    model: 'gemini-3.1-flash-lite',
    useTools: false,
    buildSystemInstruction: (ctx) =>
      [
        `You are a fast communications assistant for ${ctx.instituteName} in Ethiopia.`,
        `Draft polite, clear, professional payment reminders, due-soon notices, or registration follow-up messages for SMS, WhatsApp, or Telegram in ETB.`,
        `Support English, Amharic (አማርኛ), and bilingual outputs. Keep messages brief and ready to copy-paste or send via SMS.`,
      ].join('\n\n'),
  },
  audit_analyst: {
    id: 'audit_analyst',
    label: 'Operations & Compliance Analyst (Live DB)',
    model: 'gemini-4-hydrogen',
    useTools: true,
    buildSystemInstruction: (ctx) =>
      [
        `You are an internal operations, RBAC, and financial compliance analyst for ${ctx.instituteName}.`,
        `Signed-in staff role: ${ctx.userRole}.`,
        ctx.statsSummary ? `Live institute summary:\n${ctx.statsSummary}` : '',
        'Use the live database tools to inspect overdue balances, pending accountant-to-admin approval queues, attendance compliance, and reconciliation risks. Keep responses factual, concise, and actionable.',
      ]
        .filter(Boolean)
        .join('\n\n'),
  },
  web_researcher: {
    id: 'web_researcher',
    label: 'Web & Policy Researcher (Google Search)',
    model: 'gemini-4-hydrogen',
    useSearchGrounding: true,
    buildSystemInstruction: (ctx) =>
      [
        `You are a research assistant for ${ctx.instituteName} in Ethiopia.`,
        `Use Google Search grounding to answer questions about Ethiopian TVET regulations, Fayda Digital ID (NIDP) policies, Telebirr/CBE payment channels, curriculum trends, or training industry benchmarks.`,
        `Summarize clearly and cite the returned web sources.`,
      ].join('\n\n'),
  },
};

const ASSISTANT_FUNCTION_DECLARATIONS = [
  {
    name: 'search_students',
    description:
      'Search approved students in the institute database by full name, student ID (e.g. ZTI-2026-0001), Fayda National ID number, phone number, or payment status.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Name, Student Code, Fayda National ID, or phone substring to search.',
        },
        paymentStatus: {
          type: Type.STRING,
          description: 'Optional filter: Paid, Partially Paid, Unpaid, or Overdue.',
        },
      },
    },
  },
  {
    name: 'get_student_financial_summary',
    description: 'Fetch detailed tuition fee, total paid, remaining balance, overdue days, and installment schedule for one student by studentCode or full name.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        identifier: {
          type: Type.STRING,
          description: 'Student Code (e.g. ZTI-2026-0001) or student full name.',
        },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'list_courses_and_plans',
    description: 'List active training courses, tuition fees, registration fees, durations, capacity, and enabled payment plans.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description: 'Optional category filter.',
        },
      },
    },
  },
  {
    name: 'get_pending_queues',
    description: 'Get pending student registration applications and pending payment submissions awaiting administrator review (scoped to the current user role).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Maximum rows per queue (default 10).',
        },
      },
    },
  },
  {
    name: 'get_overdue_summary',
    description: 'List students who currently have overdue installments and outstanding balances (Administrator only).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Max overdue students to return (default 10).',
        },
      },
    },
  },
  {
    name: 'get_institute_kpis',
    description: 'Get live institute totals: active students, expected tuition, collected revenue, outstanding balances, pending approvals, and collection rate (Administrator only).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        includeMonthly: {
          type: Type.BOOLEAN,
          description: 'Include current month breakdown.',
        },
      },
    },
  },
  {
    name: 'get_attendance_overview',
    description: 'Get recent student attendance rate and absence statistics across courses (Administrator only).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        courseName: {
          type: Type.STRING,
          description: 'Optional course name filter.',
        },
      },
    },
  },
];

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
    .slice(-20)
    .map((item) => ({
      role: item.role,
      parts: [{ text: item.text.trim().slice(0, 4000) }],
    }));
}

function extractGroundingSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    if (c?.web?.uri && !seen.has(c.web.uri)) {
      seen.add(c.web.uri);
      sources.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
    }
  }
  return sources.slice(0, 10);
}

/**
 * Multi-turn chat with optional Function Calling & Search Grounding
 */
async function sendMultiTurnChat({ message, history, roleId, context, toolExecutor }) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    const err = new Error('Message cannot be empty.');
    err.status = 400;
    throw err;
  }

  const roleCfg = CHATBOT_ROLES[roleId] || CHATBOT_ROLES.fee_advisor;
  const ai = getGeminiClient();
  const formattedHistory = normalizeHistory(history);

  const systemInstruction = roleCfg.buildSystemInstruction(context);

  // Search-grounded mode uses generateContent with history contents
  if (roleCfg.useSearchGrounding) {
    return withRetry(async () => {
      const contents = [
        ...formattedHistory,
        { role: 'user', parts: [{ text: cleanMessage.slice(0, 4000) }] },
      ];
      const response = await ai.models.generateContent({
        model: roleCfg.model,
        contents,
        config: {
          systemInstruction,
          tools: [{ googleSearch: {} }],
        },
      });
      const replyText = (response?.text || '').trim();
      if (!replyText) {
        throw new Error('The research assistant returned an empty response.');
      }
      return {
        reply: replyText,
        model: roleCfg.model,
        roleId: roleCfg.id,
        roleLabel: roleCfg.label,
        toolsUsed: ['googleSearch'],
        sources: extractGroundingSources(response),
      };
    });
  }

  // Standard multi-turn chat or Function-Calling DB agent
  if (!roleCfg.useTools || typeof toolExecutor !== 'function') {
    return withRetry(async () => {
      const chat = ai.chats.create({
        model: roleCfg.model,
        history: formattedHistory,
        config: { systemInstruction },
      });
      const response = await chat.sendMessage({
        message: cleanMessage.slice(0, 4000),
      });
      const replyText = (response?.text || '').trim();
      if (!replyText) {
        throw new Error('The assistant returned an empty response. Please try again.');
      }
      return {
        reply: replyText,
        model: roleCfg.model,
        roleId: roleCfg.id,
        roleLabel: roleCfg.label,
        toolsUsed: [],
        sources: [],
      };
    });
  }

  // Function-calling loop (up to 4 tool rounds)
  return withRetry(async () => {
    const contents = [
      ...formattedHistory,
      { role: 'user', parts: [{ text: cleanMessage.slice(0, 4000) }] },
    ];
    const toolsUsed = [];
    const config = {
      systemInstruction,
      tools: [{ functionDeclarations: ASSISTANT_FUNCTION_DECLARATIONS }],
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    };

    let response = await ai.models.generateContent({
      model: roleCfg.model,
      contents,
      config,
    });

    for (let step = 0; step < 4; step++) {
      const calls = response?.functionCalls;
      if (!calls || calls.length === 0) break;

      const previousContent = response.candidates?.[0]?.content;
      if (!previousContent) break;
      contents.push(previousContent);

      const responseParts = [];
      for (const call of calls) {
        toolsUsed.push(call.name);
        let toolOutput;
        try {
          toolOutput = await toolExecutor(call.name, call.args || {});
        } catch (toolErr) {
          toolOutput = { error: toolErr.message || 'Tool execution failed.' };
        }
        responseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: { result: toolOutput },
          },
        });
      }

      contents.push({ role: 'user', parts: responseParts });
      response = await ai.models.generateContent({
        model: roleCfg.model,
        contents,
        config,
      });
    }

    const replyText = (response?.text || '').trim();
    if (!replyText) {
      throw new Error('The assistant returned an empty response. Please try again.');
    }

    return {
      reply: replyText,
      model: roleCfg.model,
      roleId: roleCfg.id,
      roleLabel: roleCfg.label,
      toolsUsed: [...new Set(toolsUsed)],
      sources: [],
    };
  });
}

/**
 * Streaming Multi-Turn Chat with Function Calling + SSE Chunk Emission
 */
async function streamMultiTurnChat({ message, history, roleId, context, toolExecutor, onEvent }) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    const err = new Error('Message cannot be empty.');
    err.status = 400;
    throw err;
  }

  const roleCfg = CHATBOT_ROLES[roleId] || CHATBOT_ROLES.fee_advisor;
  const ai = getGeminiClient();
  const formattedHistory = normalizeHistory(history);
  const systemInstruction = roleCfg.buildSystemInstruction(context);

  const contents = [
    ...formattedHistory,
    { role: 'user', parts: [{ text: cleanMessage.slice(0, 4000) }] },
  ];

  const toolsUsed = [];
  let sources = [];

  try {
    // If role uses function calling, resolve any tool calls first, then stream the final answer
    if (roleCfg.useTools && typeof toolExecutor === 'function') {
      const config = {
        systemInstruction,
        tools: [{ functionDeclarations: ASSISTANT_FUNCTION_DECLARATIONS }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      };

      let loopCount = 0;
      while (loopCount < 4) {
        const probe = await ai.models.generateContent({
          model: roleCfg.model,
          contents,
          config,
        });
        const calls = probe?.functionCalls;
        if (!calls || calls.length === 0) {
          // No further tool calls: if probe already gave text, stream or emit directly
          const finalText = (probe?.text || '').trim();
          if (finalText) {
            // Emit cleanly in small readable chunks for responsive UI UX
            const chunkSize = 48;
            for (let i = 0; i < finalText.length; i += chunkSize) {
              onEvent('chunk', { text: finalText.slice(i, i + chunkSize) });
            }
            return {
              reply: finalText,
              model: roleCfg.model,
              roleId: roleCfg.id,
              roleLabel: roleCfg.label,
              toolsUsed: [...new Set(toolsUsed)],
              sources,
            };
          }
          break;
        }

        const previousContent = probe.candidates?.[0]?.content;
        if (!previousContent) break;
        contents.push(previousContent);

        const responseParts = [];
        for (const call of calls) {
          toolsUsed.push(call.name);
          onEvent('tool', { name: call.name, args: call.args || {} });
          let toolOutput;
          try {
            toolOutput = await toolExecutor(call.name, call.args || {});
          } catch (toolErr) {
            toolOutput = { error: toolErr.message || 'Tool execution failed.' };
          }
          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: { result: toolOutput },
            },
          });
        }
        contents.push({ role: 'user', parts: responseParts });
        loopCount++;
      }
    }

    // Stream final response
    const streamConfig = {
      systemInstruction,
      ...(roleCfg.useSearchGrounding ? { tools: [{ googleSearch: {} }] } : {}),
    };

    const stream = await ai.models.generateContentStream({
      model: roleCfg.model,
      contents,
      config: streamConfig,
    });

    let fullText = '';
    for await (const chunk of stream) {
      const piece = chunk?.text || '';
      if (piece) {
        fullText += piece;
        onEvent('chunk', { text: piece });
      }
      const chunkSources = extractGroundingSources(chunk);
      if (chunkSources.length > 0) {
        sources = chunkSources;
      }
    }

    if (roleCfg.useSearchGrounding) {
      toolsUsed.push('googleSearch');
    }

    const trimmed = fullText.trim();
    if (!trimmed) {
      throw new Error('The assistant returned an empty response.');
    }

    return {
      reply: trimmed,
      model: roleCfg.model,
      roleId: roleCfg.id,
      roleLabel: roleCfg.label,
      toolsUsed: [...new Set(toolsUsed)],
      sources,
    };
  } catch (err) {
    throw mapGeminiError(err);
  }
}

/**
 * Scan Ethiopian Fayda National ID (Front + Optional Back image or Digital Fayda PDF)
 */
async function scanFaydaIdDocuments({ frontFile, backFile }) {
  if (!frontFile || !frontFile.data || !frontFile.mimeType) {
    const err = new Error('Please upload or capture the front image/PDF of the Fayda National ID.');
    err.status = 400;
    throw err;
  }

  const ai = getGeminiClient();
  const parts = [
    {
      inlineData: {
        mimeType: frontFile.mimeType,
        data: frontFile.data,
      },
    },
  ];

  if (backFile && backFile.data && backFile.mimeType) {
    parts.push({
      inlineData: {
        mimeType: backFile.mimeType,
        data: backFile.data,
      },
    });
  }

  parts.push({
    text: [
      'Analyze the provided Ethiopian National ID (Fayda / NIDP Digital ID card, Fayda printable PDF slip, or Kebele/Ethiopian ID document).',
      'Extract all visible identity & contact fields accurately:',
      '- Full Name in English (romanized, Title Case if uppercase on card) and in Amharic if printed.',
      '- National ID Number: extract the Fayda FCN (16-digit Fayda Card Number) or FIN (12-digit Fayda Identification Number) or Kebele ID No. Prefer FIN or FCN formatted clearly.',
      '- Gender: return strictly "Male", "Female", or "" if unreadable.',
      '- Date of Birth in YYYY-MM-DD (Gregorian if printed; convert if clearly labeled).',
      '- Ethiopian phone number if shown on card/slip.',
      `- Region: match to the closest official Ethiopian region from this exact list: ${ETHIOPIAN_REGIONS.join(', ')}. Default to "Addis Ababa" if Addis Ababa sub-city is listed.`,
      '- City / Zone and Sub-City / Woreda / Kebele address.',
      '- Set isNationalIdDetected=false if the image is clearly not an identity card/document.',
    ].join('\n'),
  });

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: { parts },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isNationalIdDetected: { type: Type.BOOLEAN },
            documentType: {
              type: Type.STRING,
              description: 'e.g. Fayda National ID, Fayda Digital Slip, Ethiopian Kebele ID, Passport, or Unknown',
            },
            fullNameEnglish: { type: Type.STRING },
            fullNameAmharic: { type: Type.STRING },
            nationalIdNumber: { type: Type.STRING, description: 'Fayda FCN, FIN, or Kebele ID number' },
            gender: { type: Type.STRING, description: 'Male, Female, or empty string' },
            dateOfBirth: { type: Type.STRING, description: 'YYYY-MM-DD or empty string' },
            phone: { type: Type.STRING, description: 'Phone number if visible on ID' },
            region: { type: Type.STRING, description: 'Matched Ethiopian region name' },
            city: { type: Type.STRING, description: 'City or town name' },
            address: { type: Type.STRING, description: 'Sub-city, zone, woreda, kebele, or house number' },
            nationality: { type: Type.STRING },
            expiryDate: { type: Type.STRING },
            confidence: { type: Type.STRING, description: 'HIGH, MEDIUM, or LOW' },
            extractionNotes: { type: Type.STRING, description: 'Helpful verification notes or illegible fields' },
          },
          required: ['isNationalIdDetected', 'documentType', 'fullNameEnglish', 'nationalIdNumber', 'confidence'],
        },
      },
    });

    const parsed = JSON.parse((response?.text || '{}').trim());

    // Normalize phone via Ethiopia validator if extracted
    let normalizedPhone = '';
    if (parsed.phone && String(parsed.phone).trim()) {
      const check = validateEthiopianPhone(String(parsed.phone));
      if (check.valid) {
        normalizedPhone = check.normalized;
      } else {
        normalizedPhone = String(parsed.phone).trim();
      }
    }

    // Match region cleanly to catalog
    let matchedRegion = 'Addis Ababa';
    if (parsed.region) {
      const lower = String(parsed.region).trim().toLowerCase();
      const found = ETHIOPIAN_REGIONS.find(
        (r) => r.toLowerCase() === lower || r.toLowerCase().includes(lower) || lower.includes(r.toLowerCase())
      );
      if (found) matchedRegion = found;
    }

    const genderNorm =
      /^m(ale)?$/i.test(String(parsed.gender || '').trim())
        ? 'Male'
        : /^f(emale)?$/i.test(String(parsed.gender || '').trim())
          ? 'Female'
          : '';

    return {
      isNationalIdDetected: Boolean(parsed.isNationalIdDetected),
      documentType: String(parsed.documentType || 'Fayda National ID'),
      fullName: String(parsed.fullNameEnglish || '').trim(),
      fullNameAmharic: String(parsed.fullNameAmharic || '').trim(),
      nationalIdNumber: String(parsed.nationalIdNumber || '').trim(),
      gender: genderNorm,
      dateOfBirth: String(parsed.dateOfBirth || '').trim(),
      phone: normalizedPhone,
      region: matchedRegion,
      city: String(parsed.city || (matchedRegion === 'Addis Ababa' ? 'Addis Ababa' : '')).trim(),
      address: String(parsed.address || '').trim(),
      nationality: String(parsed.nationality || 'Ethiopian').trim(),
      expiryDate: String(parsed.expiryDate || '').trim(),
      confidence: String(parsed.confidence || 'MEDIUM').toUpperCase(),
      extractionNotes: String(parsed.extractionNotes || '').trim(),
      model: 'gemini-4-hydrogen',
    };
  });
}

/**
 * Extract structured transaction details from Telebirr, CBE, Awash, or paper bank slip screenshot/photo
 */
async function analyzePaymentSlipDocument({ file }) {
  if (!file || !file.data || !file.mimeType) {
    const err = new Error('Please upload a payment slip, Telebirr screenshot, or bank receipt image/PDF.');
    err.status = 400;
    throw err;
  }

  const ai = getGeminiClient();
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          { inlineData: { mimeType: file.mimeType, data: file.data } },
          {
            text: [
              'Extract payment transaction details from this Ethiopian payment screenshot, mobile money confirmation (Telebirr, CBE Birr, M-Pesa, Amole), or bank deposit slip.',
              'Map paymentMethod strictly to one of: "Mobile Money", "Bank Transfer", "Cash", or "Other".',
              'Extract amountPaid as a number in ETB, paymentDate in YYYY-MM-DD (if visible), transactionReference (FT/TT/Ref ID), payerName, and bank/wallet provider name.',
            ].join('\n'),
          },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isPaymentDocument: { type: Type.BOOLEAN },
            paymentMethod: { type: Type.STRING, description: 'Mobile Money, Bank Transfer, Cash, or Other' },
            amountPaid: { type: Type.NUMBER },
            paymentDate: { type: Type.STRING, description: 'YYYY-MM-DD or empty' },
            transactionReference: { type: Type.STRING },
            payerName: { type: Type.STRING },
            providerOrBank: { type: Type.STRING },
            confidence: { type: Type.STRING, description: 'HIGH, MEDIUM, or LOW' },
            notes: { type: Type.STRING },
          },
          required: ['isPaymentDocument', 'paymentMethod', 'amountPaid', 'transactionReference', 'confidence'],
        },
      },
    });

    const parsed = JSON.parse((response?.text || '{}').trim());
    const validMethods = ['Cash', 'Bank Transfer', 'Mobile Money', 'Other'];
    const method = validMethods.includes(parsed.paymentMethod) ? parsed.paymentMethod : 'Other';

    return {
      isPaymentDocument: Boolean(parsed.isPaymentDocument),
      paymentMethod: method,
      amountPaid: Number(parsed.amountPaid || 0),
      paymentDate: String(parsed.paymentDate || '').trim().slice(0, 10),
      transactionReference: String(parsed.transactionReference || '').trim(),
      payerName: String(parsed.payerName || '').trim(),
      providerOrBank: String(parsed.providerOrBank || '').trim(),
      confidence: String(parsed.confidence || 'MEDIUM').toUpperCase(),
      notes: String(parsed.notes || '').trim(),
      model: 'gemini-4-hydrogen',
    };
  });
}

/**
 * Recommend active course and installment plan for a prospective student
 */
async function recommendCourseAndPlan({ applicantProfile, courses }) {
  const ai = getGeminiClient();
  const catalogText = courses
    .map(
      (c) =>
        `ID=${c.id} | Code=${c.code} | Name=${c.name} | Duration=${c.durationValue} ${c.durationUnit} | RegFee=${c.registrationFee} ETB | Tuition=${c.defaultFee} ETB | Plans=${JSON.stringify(c.availablePlans || ['full'])} | Desc=${c.description || ''}`
    )
    .join('\n');

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Prospective student background/budget/interest:\n${String(applicantProfile || '').slice(0, 1500)}\n\nAvailable Institute Courses:\n${catalogText}\n\nRecommend the single best course and most suitable installment plan from the exact course IDs and plans listed above.`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedCourseId: { type: Type.STRING },
            recommendedCourseName: { type: Type.STRING },
            recommendedPlanCode: { type: Type.STRING, description: 'full, 2_months, 3_months, or 6_months' },
            suggestedInitialDepositEtb: { type: Type.NUMBER },
            rationale: { type: Type.STRING },
          },
          required: ['recommendedCourseId', 'recommendedCourseName', 'recommendedPlanCode', 'rationale'],
        },
      },
    });
    return {
      ...JSON.parse((response?.text || '{}').trim()),
      model: 'gemini-4-hydrogen',
    };
  });
}

/**
 * Draft bilingual or localized SMS/WhatsApp message templates for student notifications
 */
async function draftBulkStudentMessage({ audienceLabel, tone = 'Polite', language = 'English', customTopic = '', instituteName = 'Zacma Technology Institute' }) {
  const ai = getGeminiClient();
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: [
        `Write a concise SMS/WhatsApp notification for ${instituteName}.`,
        `Target audience: ${audienceLabel}`,
        `Tone: ${tone}`,
        `Language: ${language}`,
        customTopic ? `Topic/Instructions: ${customTopic}` : 'Topic: Tuition installment reminder and support desk hours.',
        'You MAY include template variables {studentName}, {studentCode}, {courseName}, {balance}, {instituteName} verbatim so the portal personalizes them per student.',
        'Keep the SMS crisp (ideally under 300 characters unless bilingual) and provide a short subject title.',
      ].join('\n'),
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            message: { type: Type.STRING },
          },
          required: ['title', 'message'],
        },
      },
    });
    return {
      ...JSON.parse((response?.text || '{}').trim()),
      model: 'gemini-3.1-flash-lite',
    };
  });
}

/**
 * Admin-only Executive Financial, Risk & Attendance Briefing
 */
async function generateExecutiveBriefing({ statsSnapshot, instituteName }) {
  const ai = getGeminiClient();
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Analyze this live operational snapshot for ${instituteName} (currency ETB) and produce a sharp executive briefing for the Institute Administrator:\n\n${JSON.stringify(statsSnapshot, null, 2)}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            healthScore: { type: Type.INTEGER, description: 'Operational health score 1-100' },
            keyInsights: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            immediateActions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            spokenSummary: {
              type: Type.STRING,
              description: 'A natural 3-sentence summary suitable for voice read-aloud.',
            },
          },
          required: ['headline', 'healthScore', 'keyInsights', 'immediateActions', 'spokenSummary'],
        },
      },
    });

    return {
      ...JSON.parse((response?.text || '{}').trim()),
      model: 'gemini-4-hydrogen',
    };
  });
}

/**
 * Grounded Web & Policy Research (Google Search or URL Context)
 */
async function researchWithGrounding({ query, urls = [], instituteName = 'Zacma Technology Institute' }) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    const err = new Error('Research question is required.');
    err.status = 400;
    throw err;
  }

  const ai = getGeminiClient();
  const cleanUrls = Array.isArray(urls)
    ? urls
        .map((u) => String(u || '').trim())
        .filter((u) => /^https?:\/\//i.test(u))
        .slice(0, 10)
    : [];

  return withRetry(async () => {
    const useUrlContext = cleanUrls.length > 0;
    const prompt = useUrlContext
      ? `Answer for ${instituteName}:\n${cleanQuery}\n\nReference URLs:\n${cleanUrls.join('\n')}`
      : cleanQuery;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction: `You are a research advisor for ${instituteName} in Ethiopia. Provide accurate, structured answers backed by live web/URL grounding.`,
        tools: useUrlContext ? [{ urlContext: {} }] : [{ googleSearch: {} }],
      },
    });

    return {
      answer: (response?.text || '').trim(),
      sources: extractGroundingSources(response),
      mode: useUrlContext ? 'urlContext' : 'googleSearch',
      model: 'gemini-4-hydrogen',
    };
  });
}

/**
 * Audio Note Transcription (gemini-3.5-transcribe)
 */
async function transcribeAudioNote({ audioBase64, mimeType = 'audio/webm', promptHint = '' }) {
  if (!audioBase64) {
    const err = new Error('Audio data is required for transcription.');
    err.status = 400;
    throw err;
  }

  const ai = getGeminiClient();
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: promptHint
              ? `Transcribe this audio accurately. Context: ${promptHint}`
              : 'Transcribe this staff voice note accurately in English or Amharic as spoken. Return only the clean transcript.',
          },
        ],
      },
    });

    return {
      transcript: (response?.text || '').trim(),
      model: 'gemini-3.5-transcribe',
    };
  });
}

/**
 * Text-to-Speech Audio Generation (gemini-3.8-flash-lite-tts) -> Complete WAV base64
 */
async function generateSpeechAudio({ text, voiceName = 'Kore', style = 'Clear, warm, professional assistant voice' }) {
  const cleanText = String(text || '').trim().slice(0, 2500);
  if (!cleanText) {
    const err = new Error('Text is required for speech generation.');
    err.status = 400;
    throw err;
  }

  const allowedVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
  const safeVoice = allowedVoices.includes(voiceName) ? voiceName : 'Kore';

  const ai = getGeminiClient();
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: cleanText,
              speechMetadata: { style },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: safeVoice },
          },
        },
      },
    });

    const base64Audio = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error('Speech synthesis did not return audio data.');
    }

    return {
      audioBase64: base64Audio,
      mimeType: 'audio/wav',
      voiceName: safeVoice,
      model: 'gemini-3.8-flash-lite-tts',
    };
  });
}

module.exports = {
  CHATBOT_ROLES,
  ASSISTANT_FUNCTION_DECLARATIONS,
  getAiStatus,
  isGeminiConfigured,
  sendMultiTurnChat,
  streamMultiTurnChat,
  scanFaydaIdDocuments,
  analyzePaymentSlipDocument,
  recommendCourseAndPlan,
  draftBulkStudentMessage,
  generateExecutiveBriefing,
  researchWithGrounding,
  transcribeAudioNote,
  generateSpeechAudio,
};
