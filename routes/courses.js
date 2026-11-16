const express = require('express');
const { randomUUID } = require('crypto');
const { getPool } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');

const router = express.Router();

// List payment plans (authenticated both roles)
router.get('/payment-plans', authenticate, async (req, res) => {
  try {
    const pool = getPool();
    const [plans] = await pool.query('SELECT * FROM payment_plans WHERE isActive = 1 ORDER BY installmentCount ASC');
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all courses with enrolled student counts (authenticated both roles)
router.get('/courses', authenticate, async (req, res) => {
  try {
    const pool = getPool();
    const [courses] = await pool.query(`
      SELECT c.*,
             COUNT(DISTINCT CASE WHEN s.status != 'Archived' AND e.enrollmentStatus != 'Archived' THEN e.studentId END) AS enrolledStudents
      FROM courses c
      LEFT JOIN enrollments e ON e.courseId = c.id
      LEFT JOIN students s ON s.id = e.studentId
      GROUP BY c.id
      ORDER BY c.name ASC
    `);

    const formatted = courses.map((c) => ({
      ...c,
      registrationFee: Number(c.registrationFee || 0),
      defaultFee: Number(c.defaultFee),
      maxCapacity: Number(c.maxCapacity || 30),
      availablePlans:
        typeof c.availablePlans === 'string' ? JSON.parse(c.availablePlans) : c.availablePlans || ['full'],
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create course (ADMIN ONLY)
router.post('/courses', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const {
      code,
      name,
      category,
      description,
      durationValue,
      durationUnit,
      registrationFee,
      defaultFee,
      availablePlans,
      startDate,
      endDate,
      maxCapacity,
      status,
    } = req.body || {};

    if (!code || !name || !defaultFee) {
      return res.status(400).json({ error: 'Course code, name, and tuition fee are required.' });
    }
    const feeNum = Number(defaultFee);
    const regFeeNum = registrationFee !== undefined && registrationFee !== '' ? Number(registrationFee) : 500;
    const capNum = maxCapacity !== undefined && maxCapacity !== '' ? parseInt(maxCapacity, 10) : 30;
    if (Number.isNaN(feeNum) || feeNum <= 0) {
      return res.status(400).json({ error: 'Tuition fee must be a positive number.' });
    }
    if (Number.isNaN(regFeeNum) || regFeeNum < 0) {
      return res.status(400).json({ error: 'Registration fee cannot be negative.' });
    }

    const pool = getPool();
    const cleanCode = String(code).trim().toUpperCase();
    const cleanName = String(name).trim();

    const [dup] = await pool.query('SELECT id FROM courses WHERE code = ? OR name = ? LIMIT 1', [cleanCode, cleanName]);
    if (dup.length > 0) {
      return res.status(409).json({ error: 'A course with this code or name already exists.' });
    }

    const plans = Array.isArray(availablePlans) && availablePlans.length > 0
      ? availablePlans
      : ['full', '2_months', '3_months', 'custom'];

    const id = randomUUID();
    await pool.query(
      `INSERT INTO courses (id, code, name, category, description, durationValue, durationUnit, registrationFee, defaultFee, availablePlans, startDate, endDate, maxCapacity, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        cleanCode,
        cleanName,
        String(category || 'Technology').trim(),
        String(description || '').trim(),
        parseInt(durationValue || '3', 10),
        durationUnit === 'weeks' ? 'weeks' : 'months',
        regFeeNum,
        feeNum,
        JSON.stringify(plans),
        startDate ? String(startDate).slice(0, 10) : null,
        endDate ? String(endDate).slice(0, 10) : null,
        Number.isNaN(capNum) || capNum <= 0 ? 30 : capNum,
        status === 'Inactive' ? 'Inactive' : 'Active',
      ]
    );

    await recordAuditLog({
      user: req.user,
      action: 'CREATE_COURSE',
      entityType: 'course',
      entityId: id,
      newValue: { code: cleanCode, name: cleanName, registrationFee: regFeeNum, defaultFee: feeNum },
      details: { code: cleanCode, name: cleanName, defaultFee: feeNum, registrationFee: regFeeNum },
      ipAddress: req.ip,
    });

    res.status(201).json({
      id,
      code: cleanCode,
      name: cleanName,
      registrationFee: regFeeNum,
      defaultFee: feeNum,
      availablePlans: plans,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update course (ADMIN ONLY)
router.put('/courses/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    const [existing] = await pool.query('SELECT * FROM courses WHERE id = ? LIMIT 1', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Course not found.' });

    const cur = existing[0];
    const {
      code,
      name,
      category,
      description,
      durationValue,
      durationUnit,
      registrationFee,
      defaultFee,
      availablePlans,
      startDate,
      endDate,
      maxCapacity,
      status,
    } = req.body || {};

    const cleanCode = code ? String(code).trim().toUpperCase() : cur.code;
    const cleanName = name ? String(name).trim() : cur.name;
    const feeNum = defaultFee !== undefined ? Number(defaultFee) : Number(cur.defaultFee);
    const regFeeNum = registrationFee !== undefined ? Number(registrationFee) : Number(cur.registrationFee || 0);
    if (Number.isNaN(feeNum) || feeNum <= 0) {
      return res.status(400).json({ error: 'Tuition fee must be greater than 0.' });
    }
    if (Number.isNaN(regFeeNum) || regFeeNum < 0) {
      return res.status(400).json({ error: 'Registration fee cannot be negative.' });
    }

    const plans = Array.isArray(availablePlans) && availablePlans.length > 0
      ? availablePlans
      : (typeof cur.availablePlans === 'string' ? JSON.parse(cur.availablePlans) : cur.availablePlans);

    await pool.query(
      `UPDATE courses
       SET code = ?, name = ?, category = ?, description = ?, durationValue = ?, durationUnit = ?,
           registrationFee = ?, defaultFee = ?, availablePlans = ?, startDate = ?, endDate = ?, maxCapacity = ?, status = ?
       WHERE id = ?`,
      [
        cleanCode,
        cleanName,
        category !== undefined ? String(category).trim() : cur.category,
        description !== undefined ? String(description).trim() : cur.description,
        durationValue ? parseInt(durationValue, 10) : cur.durationValue,
        durationUnit === 'weeks' || durationUnit === 'months' ? durationUnit : cur.durationUnit,
        regFeeNum,
        feeNum,
        JSON.stringify(plans),
        startDate !== undefined ? (startDate ? String(startDate).slice(0, 10) : null) : cur.startDate,
        endDate !== undefined ? (endDate ? String(endDate).slice(0, 10) : null) : cur.endDate,
        maxCapacity !== undefined ? Math.max(1, parseInt(maxCapacity, 10) || 30) : cur.maxCapacity,
        status === 'Inactive' || status === 'Active' ? status : cur.status,
        req.params.id,
      ]
    );

    await recordAuditLog({
      user: req.user,
      action: 'UPDATE_COURSE',
      entityType: 'course',
      entityId: req.params.id,
      previousValue: { name: cur.name, registrationFee: Number(cur.registrationFee), defaultFee: Number(cur.defaultFee) },
      newValue: { name: cleanName, registrationFee: regFeeNum, defaultFee: feeNum },
      details: { code: cleanCode, name: cleanName, defaultFee: feeNum, registrationFee: regFeeNum },
      ipAddress: req.ip,
    });

    res.json({ message: 'Course updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete course (ADMIN ONLY — supports ?force=true to cascade-delete course with linked records)
router.delete('/courses/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    const [existing] = await pool.query('SELECT * FROM courses WHERE id = ? LIMIT 1', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Course not found.' });

    const [[enrCnt]] = await pool.query('SELECT COUNT(*) AS cnt FROM enrollments WHERE courseId = ?', [req.params.id]);
    const [[appCnt]] = await pool.query('SELECT COUNT(*) AS cnt FROM registration_applications WHERE courseId = ?', [req.params.id]);
    const forceDelete = String(req.query.force || '').toLowerCase() === 'true';

    if ((enrCnt.cnt > 0 || appCnt.cnt > 0) && !forceDelete) {
      return res.status(409).json({
        requiresForce: true,
        enrollmentsCount: enrCnt.cnt,
        applicationsCount: appCnt.cnt,
        error: `Course has ${enrCnt.cnt} enrollment(s) and ${appCnt.cnt} application(s). Confirm force delete to remove the course and its linked records, or set status to Inactive.`,
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (forceDelete) {
        const [enrRows] = await conn.query('SELECT id FROM enrollments WHERE courseId = ?', [req.params.id]);
        const enrIds = enrRows.map((r) => r.id);
        if (enrIds.length > 0) {
          await conn.query('DELETE FROM notifications WHERE enrollmentId IN (?)', [enrIds]);
          await conn.query('DELETE FROM attendance WHERE enrollmentId IN (?)', [enrIds]);
          await conn.query('DELETE FROM receipts WHERE enrollmentId IN (?)', [enrIds]);
          await conn.query('DELETE FROM transactions WHERE enrollmentId IN (?)', [enrIds]);
          await conn.query('DELETE FROM payment_submissions WHERE enrollmentId IN (?)', [enrIds]);
          await conn.query('DELETE FROM installments WHERE enrollmentId IN (?)', [enrIds]);
          await conn.query('DELETE FROM enrollments WHERE id IN (?)', [enrIds]);
        }
        await conn.query('DELETE FROM attendance WHERE courseId = ?', [req.params.id]);

        const [appRows] = await conn.query('SELECT id FROM registration_applications WHERE courseId = ?', [req.params.id]);
        const appIds = appRows.map((r) => r.id);
        if (appIds.length > 0) {
          await conn.query('DELETE FROM notifications WHERE applicationId IN (?)', [appIds]);
          await conn.query('DELETE FROM application_documents WHERE applicationId IN (?)', [appIds]);
          await conn.query('DELETE FROM registration_applications WHERE id IN (?)', [appIds]);
        }
      }

      await conn.query('DELETE FROM courses WHERE id = ?', [req.params.id]);
      await recordAuditLog(
        {
          user: req.user,
          action: 'DELETE_COURSE',
          entityType: 'course',
          entityId: req.params.id,
          previousValue: { code: existing[0].code, name: existing[0].name, forceDelete },
          ipAddress: req.ip,
        },
        conn
      );
      await conn.commit();
    } catch (txErr) {
      await conn.rollback().catch(() => {});
      throw txErr;
    } finally {
      conn.release();
    }

    res.json({ message: 'Course deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
