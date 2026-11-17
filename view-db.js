require('dotenv').config();
const { initDatabase, getPool } = require('./config/db');

async function viewDatabase() {
  try {
    await initDatabase();
    const pool = getPool();

    console.log('\n=== STUDENTS & ENROLLMENTS ===');
    const [students] = await pool.query(`
      SELECT s.studentCode, s.fullName, s.phone, c.name AS course, e.totalCourseFee, s.status
      FROM students s
      LEFT JOIN enrollments e ON e.studentId = s.id
      LEFT JOIN courses c ON c.id = e.courseId
      ORDER BY s.studentCode ASC
    `);
    console.table(students);

    console.log('\n=== TRANSACTIONS ===');
    const [transactions] = await pool.query(`
      SELECT t.transactionId, r.receiptNumber, s.fullName, t.amountPaid, t.paymentDate, t.paymentMethod
      FROM transactions t
      JOIN students s ON t.studentId = s.id
      LEFT JOIN receipts r ON r.transactionId = t.id
      ORDER BY t.paymentDate DESC
    `);
    console.table(transactions);

    await pool.end();
  } catch (err) {
    console.error('Failed to inspect database data:', err.message);
    process.exit(1);
  }
}

viewDatabase();
