# Application Walkthrough: Student Fee Tracker

![Demo Recording](/C:/Users/konakanchi%20kotesh/.gemini/antigravity-ide/brain/3c877d44-c001-4704-bda3-329783f9d15a/fee_tracker_demo_1783441601505.webp)

This document provides a detailed, page-by-page explanation of the **Student Fee Payment & Transaction Tracker** application. It is structured as a single-page application (SPA) where the sidebar navigation switches between different views ("slides" or "pages").

---

## 1. Dashboard (`Dashboard Overview`)
The Dashboard is the landing page and the control center for your fee collection analytics.

- **Stats Grid:** At the top, there are four key statistic cards:
  - **Total Students:** The total number of students enrolled in the system.
  - **Total Fees:** The expected total amount of fees from all enrolled students.
  - **Collected:** The total amount of money actually received (sum of all transactions).
  - **Balance Due:** The remaining amount left to be collected (Total Fees - Collected).
- **Payment Status (Progress Bars):** Visual representation of where students stand in their payments:
  - **Paid:** Green bar indicating the number of students who have paid their fees in full.
  - **Partial:** Yellow bar indicating students who have paid a portion of their fees but still have a balance.
  - **Pending:** Red bar indicating students who have not made any payments yet.
- **Recent Transactions:** A quick-view list showing the 5 most recent payments processed, allowing admins to instantly see the latest activity.

---

## 2. Students (`Student Fee Records`)
This view is a comprehensive list and management area for all enrolled students.

- **Search & Filters:** A toolbar at the top allows you to:
  - **Search:** Quickly find a student by typing their Name or Roll Number.
  - **Course Filter:** Filter students by their specific course (e.g., B.Tech CSE).
  - **Semester Filter:** Filter by their current semester.
- **Data Table:** Displays the list of students with the following columns:
  - **Details:** Name, Roll Number, Course, Semester.
  - **Financials:** Total Fee, Paid Amount, Balance, Due Date, and Status (Paid, Partially Paid, Pending).
- **Actions Column:** Each row has buttons to:
  - **View (👁️):** Opens a detailed modal showing the student's complete profile and their personal transaction history.
  - **Edit (✏️):** Opens the Add/Edit modal to update the student's information.
  - **Delete (🗑️):** Removes the student (and all their associated payments) from the database. *Note: This requires Admin credentials.*

---

## 3. Add Payment (`Record Payment`)
This is the data entry view where new payments are recorded against a specific student.

- **Select Student:** A dropdown to select which student is making the payment.
- **Live Info Panel:** Once a student is selected, a panel dynamically appears showing their Total Fee, Already Paid amount, current Balance, and Status. This ensures the admin knows exactly how much the student owes before entering an amount.
- **Amount & Date:** Fields to enter the exact amount paid (which cannot exceed the remaining balance) and the date of payment.
- **Mode of Payment:** A selection grid for how the payment was made:
  - 💵 **Cash:** Prompts for a Receipt Number.
  - 💳 **Card:** Prompts for a Transaction Bill Number.
  - 📱 **UPI:** Prompts for a UPI ID/Number and the specific UPI Transaction ID.
  - 🏦 **Bank Transfer:** Prompts for a Bank Transaction ID or Reference Number.
- **Notes:** An optional field for any additional remarks.

---

## 4. Transactions (`Transaction History`)
This view provides a complete audit trail of every single payment recorded in the system.

- **Filters:** Extensive filtering options to narrow down records:
  - **Student Filter:** View payments made by a specific student.
  - **Mode Filter:** View payments made via a specific method (e.g., only UPI payments).
  - **Date Range:** Select a "From" and "To" date to see payments within a specific timeframe.
- **Summary Header:** Dynamically shows the total number of transactions and total amount collected based on the currently applied filters.
- **Data Table:** Displays detailed transaction records including the unique Txn ID, Student details, Amount, Date, Mode, Reference (dynamically built based on the mode), and Notes.
- **Export to CSV:** A button that generates and downloads a `.csv` file containing the currently filtered transaction data, useful for accounting or backup purposes.

---

## 5. Modals (Pop-up Views)
In addition to the main pages, the application uses modals to handle specific interactions without navigating away:

- **Add/Edit Student Modal:** 
  - Accessed via the "+ Add Student" button in the header or the "Edit" button in the Students table.
  - Provides a form to input Name, Roll Number, Course, Semester, Total Fee, Due Date, and Preferred Payment Method.
- **Student Details Modal:**
  - Accessed via the "View" button in the Students table.
  - Shows a rich view of the student's profile, financial summary, and a dedicated table of just their personal payment history.
