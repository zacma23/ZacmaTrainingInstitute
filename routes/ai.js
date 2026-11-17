const express = require('express');
const { getPool } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const {
  getAiStatus,
  scanFaydaIdDocuments,
  analyzePaymentSlipDocument,
  recommendCourseAndPlan,
  draftBulkStudentMessage,
  generateExecutiveBriefing,
  researchWithGrounding,
  transcribeAudioNote,
  generateSpeechAudio,
} = require('../services/geminiService');
const { executeAssistantTool } = require('../services/aiToolExecutor');

const router = express.Router();
router.use(authenticate);

const ALLOWED_DOC_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const ALLOWED_AUDIO_MIMES = new Set(['audio/webm', 'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac']);
const MAX_MEDIA_BYTES = 3.2 * 1024 * 1024;

function validateUploadedFile(fileObj, allowedSet, label = 'File') {
  if (!fileObj || !fileObj.data) return null;
  const mimeType = String(fileObj.mimeType || '').split(';')[0].trim().toLowerCase();
  const base64 = String(fileObj.data).replace(/^data:[^;]+;base64,/, '').trim();
  if (!allowedSet.has(mimeType)) {
    const err = new Error(`${label} format "${mimeType || 'unknown'}" is unsupported.`);
    err.status = 400;
    throw err;
  }
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_MEDIA_BYTES) {
    const err = new Error(`${label} exceeds the 3.2 MB raw size limit (Vercel 4.5 MB request cap).`);
    err.status = 400;
    throw err;
  }
  return { mimeType, data: base64 };
}

function sendAiError(res, err) {
  const status = err.status || (err.message && err.message.includes('API key') ? 503 : 500);
  res.status(status).json({ error: err.message || 'AI operation failed.' });
}

// 1. Check Gemini AI capabilities & status (no secret leakage)
router.get('/status', (_req, res) => {
  res.json(getAiStatus());
});

// 2. Scan / OCR Ethiopian Fayda National ID (Front + Optional Back image or Digital Fayda PDF)
router.post('/scan-fayda-id', async (req, res) => {
  try {
    const { frontFile, backFile } = req.body || {};
    const validFront = validateUploadedFile(frontFile, ALLOWED_DOC_MIMES, 'Front ID');
    if (!validFront) {
      return res.status(400).json({ error: 'Please upload or capture the Fayda National ID image or PDF.' });
    }
    const validBack = backFile && backFile.data ? validateUploadedFile(backFile, ALLOWED_DOC_MIMES, 'Back ID') : null;

    const extracted = await scanFaydaIdDocuments({ frontFile: validFront, backFile: validBack });

    await recordAuditLog({
      user: req.user,
      action: 'SCAN_FAYDA_ID',
      entityType: 'ai_registration',
      details: {
        documentType: extracted.documentType,
        isNationalIdDetected: extracted.isNationalIdDetected,
        confidence: extracted.confidence,
        hasNationalIdNumber: Boolean(extracted.nationalIdNumber),
      },
      ipAddress: req.ip,
    });

    res.json(extracted);
  } catch (err) {
    sendAiError(res, err);
  }
});

// 3. OCR Bank Deposit Slip / Telebirr / CBE Birr Payment Screenshot
router.post('/analyze-payment-slip', async (req, res) => {
  try {
    const { file } = req.body || {};
    const validFile = validateUploadedFile(file, ALLOWED_DOC_MIMES, 'Payment slip');
    if (!validFile) {
      return res.status(400).json({ error: 'Please upload a payment slip, Telebirr screenshot, or bank receipt.' });
    }

    const extracted = await analyzePaymentSlipDocument({ file: validFile });

    await recordAuditLog({
      user: req.user,
      action: 'ANALYZE_PAYMENT_SLIP',
      entityType: 'ai_payment',
      details: {
        isPaymentDocument: extracted.isPaymentDocument,
        paymentMethod: extracted.paymentMethod,
        amountPaid: extracted.amountPaid,
        confidence: extracted.confidence,
      },
      ipAddress: req.ip,
    });

    res.json(extracted);
  } catch (err) {
    sendAiError(res, err);
  }
});

// 4. AI Course & Installment Plan Recommender
router.post('/recommend-course', async (req, res) => {
  try {
    const { applicantProfile } = req.body || {};
    if (!applicantProfile || !String(applicantProfile).trim()) {
      return res.status(400).json({ error: 'Please describe student goals, background, or budget.' });
    }
    const pool = getPool();
    const [courses] = await pool.query(
      "SELECT id, code, name, description, durationValue, durationUnit, registrationFee, defaultFee, availablePlans FROM courses WHERE status = 'Active' ORDER BY name ASC"
    );
    if (courses.length === 0) {
      return res.status(404).json({ error: 'No active courses available in catalog.' });
    }
    const result = await recommendCourseAndPlan({ applicantProfile, courses });
    res.json(result);
  } catch (err) {
    sendAiError(res, err);
  }
});

// 5. AI Bilingual / Localized Student Message & SMS Drafter
router.post('/draft-message', async (req, res) => {
  try {
    const { audienceLabel = 'Selected Students', tone = 'Polite', language = 'English', customTopic = '' } = req.body || {};
    const pool = getPool();
    const [rows] = await pool.query("SELECT settingValue FROM settings WHERE settingKey = 'instituteName' LIMIT 1");
    const instituteName = rows[0]?.settingValue || 'Zacma Technology Institute';

    const drafted = await draftBulkStudentMessage({
      audienceLabel,
      tone,
      language,
      customTopic,
      instituteName,
      senderName: req.user.fullName,
    });
    res.json(drafted);
  } catch (err) {
    sendAiError(res, err);
  }
});

// 6. Admin-Only Executive Financial, Risk & Attendance Briefing
router.post('/executive-briefing', requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query("SELECT settingValue FROM settings WHERE settingKey = 'instituteName' LIMIT 1");
    const instituteName = rows[0]?.settingValue || 'Zacma Technology Institute';

    const [kpis, overdue, attendance, queues] = await Promise.all([
      executeAssistantTool('get_institute_kpis', {}, req.user),
      executeAssistantTool('get_overdue_summary', { limit: 8 }, req.user),
      executeAssistantTool('get_attendance_overview', {}, req.user),
      executeAssistantTool('get_pending_queues', { limit: 6 }, req.user),
    ]);

    const briefing = await generateExecutiveBriefing({
      instituteName,
      statsSnapshot: { kpis, overdue, attendance, queues },
    });

    res.json({ ...briefing, snapshot: { kpis, overdueCount: overdue.overdueCount } });
  } catch (err) {
    sendAiError(res, err);
  }
});

// 7. Grounded Web & Policy Research (Google Search or URL Context)
router.post('/research', async (req, res) => {
  try {
    const { query, urls = [] } = req.body || {};
    const pool = getPool();
    const [rows] = await pool.query("SELECT settingValue FROM settings WHERE settingKey = 'instituteName' LIMIT 1");
    const instituteName = rows[0]?.settingValue || 'Zacma Technology Institute';

    const result = await researchWithGrounding({ query, urls, instituteName });
    res.json(result);
  } catch (err) {
    sendAiError(res, err);
  }
});

// 8. Voice Note Transcription (gemini-3.5-transcribe)
router.post('/transcribe', async (req, res) => {
  try {
    const { file, promptHint = '' } = req.body || {};
    const validAudio = validateUploadedFile(file, ALLOWED_AUDIO_MIMES, 'Audio');
    if (!validAudio) {
      return res.status(400).json({ error: 'Audio recording or file is required.' });
    }
    const result = await transcribeAudioNote({
      audioBase64: validAudio.data,
      mimeType: validAudio.mimeType,
      promptHint,
    });
    res.json(result);
  } catch (err) {
    sendAiError(res, err);
  }
});

// 9. Text-to-Speech WAV Synthesis (gemini-3.8-flash-lite-tts)
router.post('/tts', async (req, res) => {
  try {
    const { text, voiceName = 'Kore', style } = req.body || {};
    const result = await generateSpeechAudio({ text, voiceName, style });
    res.json(result);
  } catch (err) {
    sendAiError(res, err);
  }
});

module.exports = router;
