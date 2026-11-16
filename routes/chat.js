const express = require('express');
const { getPool } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { CHATBOT_ROLES, sendMultiTurnChat } = require('../services/geminiService');

const router = express.Router();

router.use(authenticate);

router.get('/roles', (_req, res) => {
  const roles = Object.values(CHATBOT_ROLES).map((r) => ({
    id: r.id,
    label: r.label,
    model: r.model,
  }));
  res.json({ roles });
});

router.post('/message', async (req, res) => {
  try {
    const { message, history = [], roleId = 'fee_advisor' } = req.body || {};
    const pool = getPool();

    const [settingRows] = await pool.query(
      "SELECT settingValue FROM settings WHERE settingKey = 'instituteName' LIMIT 1"
    );
    const instituteName =
      settingRows.length > 0 && settingRows[0].settingValue
        ? settingRows[0].settingValue
        : 'Addis Skills & Technology Institute';

    const [courses] = await pool.query(
      "SELECT code, name, durationValue, durationUnit, registrationFee, defaultFee FROM courses WHERE status = 'Active' ORDER BY name ASC LIMIT 20"
    );
    const coursesSummary = courses
      .map(
        (c) =>
          `- ${c.code} ${c.name} (${c.durationValue} ${c.durationUnit}): Tuition ${Number(c.defaultFee).toLocaleString()} ETB, Registration ${Number(c.registrationFee).toLocaleString()} ETB`
      )
      .join('\n');

    let statsSummary = '';
    if (req.user.role === 'admin') {
      const [[stAgg]] = await pool.query(
        "SELECT COUNT(*) AS totalStudents, SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS activeStudents FROM students"
      );
      const [[payAgg]] = await pool.query(
        'SELECT COALESCE(SUM(totalCourseFee), 0) AS expectedTotal FROM enrollments'
      );
      const [[txAgg]] = await pool.query(
        'SELECT COALESCE(SUM(amountPaid), 0) AS collectedTotal FROM transactions'
      );
      const [[appPending]] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM registration_applications WHERE status = 'PENDING_ADMIN_APPROVAL'"
      );
      const [[payPending]] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM payment_submissions WHERE status = 'PENDING'"
      );
      statsSummary = [
        `Total Students: ${stAgg.totalStudents || 0} (Active: ${stAgg.activeStudents || 0})`,
        `Expected Tuition: ${Number(payAgg.expectedTotal || 0).toLocaleString()} ETB | Collected: ${Number(txAgg.collectedTotal || 0).toLocaleString()} ETB`,
        `Pending Admin Approvals: ${appPending.cnt || 0} registrations, ${payPending.cnt || 0} payment submissions`,
      ].join('\n');
    }

    const result = await sendMultiTurnChat({
      message,
      history,
      roleId,
      context: {
        instituteName,
        userRole: req.user.role,
        coursesSummary,
        statsSummary,
      },
    });

    res.json(result);
  } catch (err) {
    const status = err.status || (err.message && err.message.includes('API key') ? 503 : 500);
    res.status(status).json({
      error: err.message || 'Unable to generate assistant response.',
    });
  }
});

module.exports = router;
