let currentReceiptPayload = null;

async function openReceiptModal(transactionOrReceiptId) {
  try {
    const data = await apiJson(`/api/transactions/${encodeURIComponent(transactionOrReceiptId)}/receipt`);
    currentReceiptPayload = data;
    renderReceiptPreview(data);
    openModal('receiptModal');
  } catch (err) {
    showToast(err.message || 'Failed to load receipt', 'error');
  }
}

function renderReceiptPreview({ receipt, institute }) {
  const area = document.getElementById('printableReceiptArea');
  const instName = institute.instituteName || 'Addis Skills & Technology Institute';
  const instPhone = institute.institutePhone || '';
  const instAddress = institute.instituteAddress || 'Addis Ababa, Ethiopia';
  const footerNote = institute.receiptFooterNote || 'Official training fee payment receipt.';

  area.innerHTML = `
    <div class="receipt-top">
      <div class="receipt-org">
        <img src="/assets/images/institute_logo.jpg" alt="Institute Logo" referrerpolicy="no-referrer" onerror="this.style.display='none'" />
        <div>
          <h2 style="font-size:18px; margin-bottom:2px;">${esc(instName)}</h2>
          <div style="font-size:12px; color:#475569;">${esc(instAddress)}</div>
          <div style="font-size:12px; color:#475569;">Tel: ${esc(instPhone)}</div>
        </div>
      </div>
      <div class="receipt-meta-box">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#64748b;">Official Payment Receipt</div>
        <div class="mono" style="font-size:17px; font-weight:700; margin-top:2px;">${esc(receipt.receiptNumber)}</div>
        <div class="mono" style="font-size:12px; color:#475569;">Txn: ${esc(receipt.txnCode)}</div>
      </div>
    </div>

    <div class="receipt-grid">
      <div><strong>Student Name:</strong> ${esc(receipt.studentName)}</div>
      <div><strong>Student ID:</strong> <span class="mono">${esc(receipt.studentCode)}</span></div>
      <div><strong>Course Enrolled:</strong> ${esc(receipt.courseName)} (${esc(receipt.courseCode)})</div>
      <div><strong>Payment Date:</strong> <span class="mono">${fmtDate(receipt.paymentDate)}</span></div>
      <div><strong>Student Phone:</strong> <span class="mono">${esc(receipt.studentPhone)}</span></div>
      <div><strong>Payment Method:</strong> ${esc(receipt.paymentMethod)}${receipt.transactionReference ? ` (${esc(receipt.transactionReference)})` : ''}</div>
    </div>

    <table class="receipt-amount-table">
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Amount (ETB)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Total Agreed Course Tuition Fee</td>
          <td class="num">${fmtETB(receipt.totalCourseFee)}</td>
        </tr>
        <tr>
          <td>Previous Outstanding Balance</td>
          <td class="num">${fmtETB(receipt.previousBalance)}</td>
        </tr>
        <tr>
          <td><strong>Amount Paid This Receipt</strong></td>
          <td class="num"><strong>${fmtETB(receipt.amountPaid)}</strong></td>
        </tr>
        <tr>
          <td><strong>Remaining Balance</strong></td>
          <td class="num"><strong>${fmtETB(receipt.remainingBalance)}</strong></td>
        </tr>
      </tbody>
    </table>

    <div style="font-size:12.5px; color:#334155; margin-bottom:12px;">
      <strong>Received By:</strong> ${esc(receipt.receivedByName || receipt.issuedBy)}
      ${receipt.notes ? `<br/><strong>Notes:</strong> ${esc(receipt.notes)}` : ''}
      ${receipt.isAdjustment ? `<br/><strong>Adjustment Reason:</strong> ${esc(receipt.adjustmentReason)}` : ''}
    </div>

    <div class="receipt-signatures">
      <div class="sig-line">Cashier / Authorized Signature</div>
      <div class="sig-line">Student / Payer Signature &amp; Stamp</div>
    </div>

    <div class="receipt-footer-note">
      ${esc(footerNote)}
    </div>
  `;
}

function downloadCurrentReceiptPdf() {
  if (!currentReceiptPayload) return;
  const { receipt, institute } = currentReceiptPayload;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF library unavailable; use Print Receipt to save as PDF.', 'error');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const left = 48;
  const right = 547;
  let y = 52;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(institute.instituteName || 'Addis Skills & Technology Institute', left, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`${institute.instituteAddress || 'Addis Ababa, Ethiopia'} | Tel: ${institute.institutePhone || ''}`, left, y);
  y += 18;

  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(1.5);
  doc.line(left, y, right, y);
  y += 24;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`OFFICIAL FEE RECEIPT: ${receipt.receiptNumber}`, left, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Date: ${fmtDate(receipt.paymentDate)}`, right, y, { align: 'right' });
  y += 22;

  const lines = [
    ['Student Name', receipt.studentName, 'Student ID', receipt.studentCode],
    ['Course', `${receipt.courseName} (${receipt.courseCode})`, 'Transaction ID', receipt.txnCode],
    ['Phone', receipt.studentPhone, 'Payment Method', receipt.paymentMethod],
    ['Reference', receipt.transactionReference || '—', 'Received By', receipt.receivedByName || receipt.issuedBy],
  ];

  for (const [l1, v1, l2, v2] of lines) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${l1}:`, left, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(v1), left + 95, y);

    doc.setFont('helvetica', 'bold');
    doc.text(`${l2}:`, 315, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(v2), 405, y);
    y += 18;
  }

  y += 12;
  doc.setFillColor(241, 245, 249);
  doc.rect(left, y, right - left, 24, 'F');
  doc.setFont('helvetica', 'bold');
  doc.text('Fee Summary', left + 8, y + 16);
  doc.text('Amount (ETB)', right - 8, y + 16, { align: 'right' });
  y += 38;

  const summaryRows = [
    ['Total Agreed Course Fee', fmtETB(receipt.totalCourseFee)],
    ['Previous Balance', fmtETB(receipt.previousBalance)],
    ['Amount Paid (This Receipt)', fmtETB(receipt.amountPaid)],
    ['Remaining Balance', fmtETB(receipt.remainingBalance)],
  ];

  for (const [label, val] of summaryRows) {
    const isBold = label.includes('Paid') || label.includes('Remaining');
    doc.setFont('helvetica', isBold ? 'bold' : 'normal');
    doc.text(label, left + 8, y);
    doc.text(val, right - 8, y, { align: 'right' });
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.5);
    doc.line(left, y + 6, right, y + 6);
    y += 22;
  }

  if (receipt.notes) {
    y += 10;
    doc.setFont('helvetica', 'normal');
    doc.text(`Notes: ${receipt.notes}`, left, y);
    y += 20;
  }

  y += 40;
  doc.setDrawColor(51, 65, 85);
  doc.line(left, y, left + 180, y);
  doc.line(340, y, right, y);
  y += 14;
  doc.setFontSize(9);
  doc.text('Cashier / Authorized Signature', left, y);
  doc.text('Student / Payer Signature', 340, y);

  y += 32;
  doc.setTextColor(100, 116, 139);
  doc.text(institute.receiptFooterNote || 'Official training fee receipt.', left, y);

  doc.save(`${receipt.receiptNumber}.pdf`);
}

let currentConfirmationPayload = null;

async function openSubmissionConfirmationModal(type, id) {
  try {
    const endpoint =
      type === 'application'
        ? `/api/applications/${encodeURIComponent(id)}/confirmation`
        : `/api/payment-submissions/${encodeURIComponent(id)}/confirmation`;
    const data = await apiJson(endpoint);
    currentConfirmationPayload = data;
    renderConfirmationPreview(data);
    openModal('confirmationModal');
  } catch (err) {
    showToast(err.message || 'Failed to load submission confirmation', 'error');
  }
}

function renderConfirmationPreview(data) {
  const area = document.getElementById('printableConfirmationArea');
  const inst = data.institute || {};
  const sub = data.submission || {};
  const isReg = data.confirmationType === 'REGISTRATION_APPLICATION';

  const instName = inst.instituteName || 'Addis Skills & Technology Institute';
  const instPhone = inst.institutePhone || '';
  const instAddress = inst.instituteAddress || 'Addis Ababa, Ethiopia';

  const refNo = isReg ? sub.applicationNumber : sub.submissionRef;
  const studentName = isReg ? sub.fullName : sub.studentName;
  const studentPhone = isReg ? sub.phone : sub.studentPhone;
  const amountVal = isReg ? sub.totalInitialSubmitted : sub.amountSubmitted;
  const dateVal = isReg ? sub.registrationDate : sub.paymentDate;

  area.innerHTML = `
    <div class="non-official-banner">
      NOT AN OFFICIAL RECEIPT — SUBMISSION CONFIRMATION ONLY<br/>
      <span>Official payment receipts are issued solely after Administrator verification and approval.</span>
    </div>

    <div class="receipt-top" style="margin-top:16px;">
      <div class="receipt-org">
        <img src="/assets/images/institute_logo.jpg" alt="Institute Logo" referrerpolicy="no-referrer" onerror="this.style.display='none'" />
        <div>
          <h2 style="font-size:17px; margin-bottom:2px;">${esc(instName)}</h2>
          <div style="font-size:12px; color:#475569;">${esc(instAddress)}</div>
          <div style="font-size:12px; color:#475569;">Tel: ${esc(instPhone)}</div>
        </div>
      </div>
      <div class="receipt-meta-box">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#b45309; font-weight:700;">Submission Confirmation</div>
        <div class="mono" style="font-size:16px; font-weight:700; margin-top:2px;">${esc(refNo)}</div>
        <div class="mono" style="font-size:12px; color:#475569;">Status: ${esc(formatStatusLabel(sub.status))}</div>
      </div>
    </div>

    <div class="receipt-grid">
      <div><strong>Applicant / Student:</strong> ${esc(studentName)}</div>
      <div><strong>${isReg ? 'Submission Ref' : 'Student ID'}:</strong> <span class="mono">${esc(isReg ? sub.submissionRef : sub.studentCode)}</span></div>
      <div><strong>Course:</strong> ${esc(sub.courseName)} (${esc(sub.courseCode)})</div>
      <div><strong>Submission Date:</strong> <span class="mono">${fmtDate(dateVal)}</span></div>
      <div><strong>Phone:</strong> <span class="mono">${esc(studentPhone || '—')}</span></div>
      <div><strong>Payment Method:</strong> ${esc(sub.paymentMethod || 'Cash')}${sub.transactionReference ? ` (${esc(sub.transactionReference)})` : ''}</div>
    </div>

    <table class="receipt-amount-table">
      <thead>
        <tr>
          <th>Submission Summary</th>
          <th class="num">Amount (ETB)</th>
        </tr>
      </thead>
      <tbody>
        ${
          isReg
            ? `
          <tr><td>Official Registration Fee</td><td class="num">${fmtETB(sub.officialRegistrationFee)}</td></tr>
          <tr><td>Official Course Tuition Fee</td><td class="num">${fmtETB(sub.officialCourseFee)}</td></tr>
          <tr><td>Initial Registration Amount Submitted</td><td class="num">${fmtETB(sub.initialRegistrationPaid)}</td></tr>
          <tr><td>Initial Tuition Amount Submitted</td><td class="num">${fmtETB(sub.initialCoursePaid)}</td></tr>
          <tr><td><strong>Total Initial Payment Submitted (Pending Approval)</strong></td><td class="num"><strong>${fmtETB(amountVal)}</strong></td></tr>
        `
            : `
          <tr><td>Total Agreed Course Fee</td><td class="num">${fmtETB(sub.totalCourseFee)}</td></tr>
          <tr><td><strong>Payment Amount Submitted (Pending Approval)</strong></td><td class="num"><strong>${fmtETB(amountVal)}</strong></td></tr>
        `
        }
      </tbody>
    </table>

    <div style="font-size:12.5px; color:#334155; margin-bottom:12px;">
      <strong>Submitted By (Accountant):</strong> ${esc(sub.submittedByName)}
      ${sub.notes || sub.submissionNotes ? `<br/><strong>Notes:</strong> ${esc(sub.notes || sub.submissionNotes)}` : ''}
      ${sub.adminComment || sub.rejectionReason ? `<br/><strong>Admin Review Note:</strong> ${esc(sub.adminComment || sub.rejectionReason)}` : ''}
    </div>

    <div class="receipt-footer-note" style="color:#991b1b; font-weight:600;">
      NOTICE: THIS DOCUMENT IS A SUBMISSION ACKNOWLEDGEMENT ONLY AND IS NOT AN OFFICIAL PAYMENT RECEIPT.
    </div>
  `;
}

function downloadCurrentConfirmationPdf() {
  if (!currentConfirmationPayload) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF library unavailable; use Print to save as PDF.', 'error');
    return;
  }
  const { submission: sub, institute: inst, confirmationType } = currentConfirmationPayload;
  const isReg = confirmationType === 'REGISTRATION_APPLICATION';
  const refNo = isReg ? sub.applicationNumber : sub.submissionRef;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const left = 48;
  const right = 547;
  let y = 48;

  doc.setFillColor(254, 242, 242);
  doc.rect(left, y, right - left, 32, 'F');
  doc.setTextColor(153, 27, 27);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('NOT AN OFFICIAL RECEIPT — SUBMISSION CONFIRMATION ONLY', (left + right) / 2, y + 20, { align: 'center' });
  y += 50;

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(15);
  doc.text(inst.instituteName || 'Addis Skills & Technology Institute', left, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`${inst.instituteAddress || 'Addis Ababa, Ethiopia'} | Tel: ${inst.institutePhone || ''}`, left, y);
  y += 22;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Reference: ${refNo} (${formatStatusLabel(sub.status)})`, left, y);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  const rows = [
    ['Applicant / Student', isReg ? sub.fullName : `${sub.studentName} (${sub.studentCode})`],
    ['Course', `${sub.courseName} (${sub.courseCode})`],
    ['Submission Date', fmtDate(isReg ? sub.registrationDate : sub.paymentDate)],
    ['Payment Method', `${sub.paymentMethod || 'Cash'}${sub.transactionReference ? ` (${sub.transactionReference})` : ''}`],
    ['Amount Submitted', fmtETB(isReg ? sub.totalInitialSubmitted : sub.amountSubmitted)],
    ['Submitted By', sub.submittedByName || '—'],
  ];
  for (const [k, v] of rows) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${k}:`, left, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(v), left + 140, y);
    y += 20;
  }

  y += 24;
  doc.setTextColor(153, 27, 27);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('IMPORTANT: Official receipts are issued strictly after Administrator approval.', left, y);
  doc.save(`${refNo}_CONFIRMATION_NOT_OFFICIAL.pdf`);
}

document.addEventListener('DOMContentLoaded', () => {
  const printBtn = document.getElementById('printReceiptBtn');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      document.body.classList.remove('print-confirmation-mode');
      window.print();
    });
  }
  const pdfBtn = document.getElementById('downloadReceiptPdfBtn');
  if (pdfBtn) pdfBtn.addEventListener('click', downloadCurrentReceiptPdf);

  const printConfBtn = document.getElementById('printConfirmationBtn');
  if (printConfBtn) {
    printConfBtn.addEventListener('click', () => {
      document.body.classList.add('print-confirmation-mode');
      window.print();
      setTimeout(() => document.body.classList.remove('print-confirmation-mode'), 500);
    });
  }
  const pdfConfBtn = document.getElementById('downloadConfirmationPdfBtn');
  if (pdfConfBtn) pdfConfBtn.addEventListener('click', downloadCurrentConfirmationPdf);
});

window.openReceiptModal = openReceiptModal;
window.openSubmissionConfirmationModal = openSubmissionConfirmationModal;
