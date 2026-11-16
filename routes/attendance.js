const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, withTransaction } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { getAddisTodayISO } = require('../utils/ethiopia');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin'));

const VALID_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'];

// GET students + existing attendance marks for a course/batch/date
router.get('/', async (req, res) => {
  try {
    const { courseId, batchName, date } = req.query;
    const pool = getPool();
    const targetDate = String(date || getAddisTodayISO()).slice(0, 10);

    let query = `
      SELECT e.id AS enrollmentId, e.studentId, e.courseId, e.batchName,
             s.studentCode, s.fullName, s.phone, s.status AS studentStatus,
             c.name AS courseName, c.code AS courseCode,
             a.id AS attendanceId, a.status AS attendanceStatus, a.notes, a.editReason, a.updatedAt AS lastMarkedAt
      FROM enrollments e
      JOIN students s ON s.id = e.studentId
      JOIN courses c ON c.id = e.courseId
      LEFT JOIN attendance a
        ON a.studentId = e.studentId AND a.courseId = e.courseId AND a.attendanceDate = ?
      WHERE e.enrollmentStatus IN ('Active', 'Completed') AND s.status IN ('Active', 'Graduated')
    `;
    const params = [targetDate];

    if (courseId) {
      query += ' AND e.courseId = ?';
      params.push(courseId);
    }
    if (batchName) {
      query += ' AND e.batchName = ?';
      params.push(batchName);
    }

    query += ' ORDER BY c.name ASC, s.fullName ASC';
    const [rows] = await pool.query(query, params);

    const [batchRows] = await pool.query(
      "SELECT DISTINCT batchName FROM enrollments WHERE enrollmentStatus != 'Archived' ORDER BY batchName ASC"
    );

    res.json({
      date: targetDate,
      batches: batchRows.map((b) => b.batchName),
      records: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST mark or edit attendance for a course & date (ADMIN ONLY)
router.post('/mark', async (req, res) => {
  try {
    const { courseId, batchName, attendanceDate, editReason, records } = req.body || {};
    if (!courseId || !attendanceDate || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'Course, attendance date, and student attendance records are required.' });
    }

    const cleanDate = String(attendanceDate).slice(0, 10);

    const summary = await withTransaction(async (conn) => {
      let inserted = 0;
      let updated = 0;

      for (const rec of records) {
        const status = String(rec.status || '').toUpperCase();
        if (!VALID_STATUSES.includes(status)) {
          throw new Error(`Invalid attendance status "${rec.status}". Allowed: PRESENT, ABSENT, LATE, EXCUSED.`);
        }

        const [existing] = await conn.query(
          'SELECT * FROM attendance WHERE studentId = ? AND courseId = ? AND attendanceDate = ? LIMIT 1 FOR UPDATE',
          [rec.studentId, courseId, cleanDate]
        );

        if (existing.length > 0) {
          const prev = existing[0];
          if (prev.status !== status && (!editReason || String(editReason).trim().length < 3)) {
            throw new Error('An edit reason (minimum 3 characters) is required when modifying an existing attendance status.');
          }
          await conn.query(
            `UPDATE attendance
             SET status = ?, notes = ?, editReason = ?, batchName = ?, updatedByUserId = ?
             WHERE id = ?`,
            [
              status,
              String(rec.notes || '').trim(),
              prev.status !== status ? String(editReason).trim() : prev.editReason,
              String(batchName || prev.batchName || 'Batch A').trim(),
              req.user.id,
              prev.id,
            ]
          );
          if (prev.status !== status) {
            await recordAuditLog(
              {
                user: req.user,
                action: 'EDIT_ATTENDANCE',
                entityType: 'attendance',
                entityId: prev.id,
                previousValue: { status: prev.status, notes: prev.notes },
                newValue: { status, notes: String(rec.notes || '').trim() },
                reason: String(editReason).trim(),
                details: { studentId: rec.studentId, courseId, attendanceDate: cleanDate },
                ipAddress: req.ip,
              },
              conn
            );
          }
          updated++;
        } else {
          const attId = randomUUID();
          await conn.query(
            `INSERT INTO attendance (id, studentId, enrollmentId, courseId, batchName, attendanceDate, status, notes, recordedByUserId)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              attId,
              rec.studentId,
              rec.enrollmentId,
              courseId,
              String(batchName || 'Batch A').trim(),
              cleanDate,
              status,
              String(rec.notes || '').trim(),
              req.user.id,
            ]
          );
          inserted++;
        }
      }

      await recordAuditLog(
        {
          user: req.user,
          action: 'MARK_ATTENDANCE_BATCH',
          entityType: 'attendance',
          entityId: courseId,
          newValue: { attendanceDate: cleanDate, batchName: batchName || 'Batch A', inserted, updated },
          reason: editReason || 'Daily class attendance recorded',
          details: { courseId, attendanceDate: cleanDate, totalStudents: records.length },
          ipAddress: req.ip,
        },
        conn
      );

      return { inserted, updated, date: cleanDate };
    });

    res.json({ message: `Attendance saved (${summary.inserted} new, ${summary.updated} updated).`, ...summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET daily/monthly/individual attendance report & percentage calculation (ADMIN ONLY)
router.get('/report', async (req, res) => {
  try {
    const { courseId, month, date, studentId } = req.query;
    const pool = getPool();

    let where = "WHERE s.status != 'Archived'";
    const params = [];

    if (courseId) {
      where += ' AND a.courseId = ?';
      params.push(courseId);
    }
    if (month) {
      where += " AND DATE_FORMAT(a.attendanceDate, '%Y-%m') = ?";
      params.push(String(month).slice(0, 7));
    }
    if (date) {
      where += ' AND a.attendanceDate = ?';
      params.push(String(date).slice(0, 10));
    }
    if (studentId) {
      where += ' AND a.studentId = ?';
      params.push(studentId);
    }

    const [summaryRows] = await pool.query(
      `SELECT s.id AS studentId, s.studentCode, s.fullName AS studentName,
              c.id AS courseId, c.name AS courseName, c.code AS courseCode,
              MAX(a.batchName) AS batchName,
              COUNT(*) AS totalDays,
              SUM(CASE WHEN a.status = 'PRESENT' THEN 1 ELSE 0 END) AS daysPresent,
              SUM(CASE WHEN a.status = 'LATE' THEN 1 ELSE 0 END) AS daysLate,
              SUM(CASE WHEN a.status = 'EXCUSED' THEN 1 ELSE 0 END) AS daysExcused,
              SUM(CASE WHEN a.status = 'ABSENT' THEN 1 ELSE 0 END) AS daysAbsent
       FROM attendance a
       JOIN students s ON s.id = a.studentId
       JOIN courses c ON c.id = a.courseId
       ${where}
       GROUP BY s.id, s.studentCode, s.fullName, c.id, c.name, c.code
       ORDER BY s.fullName ASC`,
      params
    );

    const studentsSummary = summaryRows.map((r) => {
      const total = Number(r.totalDays || 0);
      const attended = Number(r.daysPresent || 0) + Number(r.daysLate || 0);
      const pct = total > 0 ? Math.round((attended / total) * 1000) / 10 : 0;
      return {
        ...r,
        totalDays: total,
        daysPresent: Number(r.daysPresent || 0),
        daysLate: Number(r.daysLate || 0),
        daysExcused: Number(r.daysExcused || 0),
        daysAbsent: Number(r.daysAbsent || 0),
        attendancePercentage: pct,
      };
    });

    const [historyRows] = await pool.query(
      `SELECT a.*, s.studentCode, s.fullName AS studentName, c.name AS courseName,
              u.fullName AS recordedByName
       FROM attendance a
       JOIN students s ON s.id = a.studentId
       JOIN courses c ON c.id = a.courseId
       LEFT JOIN users u ON u.id = COALESCE(a.updatedByUserId, a.recordedByUserId)
       ${where}
       ORDER BY a.attendanceDate DESC, s.fullName ASC
       LIMIT 200`,
      params
    );

    res.json({
      studentsSummary,
      history: historyRows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
