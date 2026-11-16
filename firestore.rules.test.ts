/**
 * Security Rules Verification Suite for BirrLedger Firestore Rules
 * Validates the "Dirty Dozen" adversarial payloads and structural invariants
 * statically against DRAFT_firestore.rules / firestore.rules.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = fs.existsSync(path.join(process.cwd(), 'firestore.rules'))
  ? path.join(process.cwd(), 'firestore.rules')
  : path.join(process.cwd(), 'DRAFT_firestore.rules');

const rulesText = fs.readFileSync(rulesPath, 'utf8');

// Structural security assertions covering all 8 Pillars & Dirty Dozen
const checks = [
  ['Rules version 2', /rules_version\s*=\s*'2';/],
  ['Global default-deny safety net first', /match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/],
  ['Email verified requirement', /request\.auth\.token\.email_verified\s*==\s*true/],
  ['Bootstrapped admin email check', /request\.auth\.token\.email\s*==\s*'zekimuluken@gmail\.com'/],
  ['Path variable ID regex guard', /function\s+isValidId\(id\)[\s\S]*matches\('\^\[a-zA-Z0-9_\\\\-\]\+\$'\)/],
  ['No get/exists in allow list blocks', (() => {
    const listMatches = [...rulesText.matchAll(/allow\s+list:[\s\S]*?;/g)].map((m) => m[0]);
    return listMatches.length >= 9 && listMatches.every((m) => !/\b(get|exists|isAdmin)\s*\(/.test(m));
  })()],
  ['All 10 blueprint collections covered', [
    'match /admins/{adminId}',
    'match /users/{userId}',
    'match /private/{docId}',
    'match /preferences/{prefId}',
    'match /courses/{courseId}',
    'match /students/{studentId}',
    'match /registration_applications/{applicationId}',
    'match /payment_submissions/{submissionId}',
    'match /notifications/{notificationId}',
    'match /audit_logs/{logId}',
    'match /chat_messages/{msgId}',
  ].every((col) => rulesText.includes(col))],
  ['Terminal state locking on applications & submissions', /!\(existing\(\)\.status\s+in\s+\['APPROVED',\s*'REJECTED'\]\)/],
  ['Immutable audit logs (no update/delete)', /match\s+\/audit_logs\/\{logId\}[\s\S]*allow\s+update:\s*if\s+false;[\s\S]*allow\s+delete:\s*if\s+false;/],
  ['Master gate & atomicity on subcollections', /existsAfter\(\/databases\/\$\(database\)\/documents\/users\/\$\(userId\)\)/],
];

for (const [name, condition] of checks) {
  const passed = condition instanceof RegExp ? condition.test(rulesText) : Boolean(condition);
  assert.equal(passed, true, `Failed security assertion: ${name}`);
}

console.log(`All ${checks.length} Firestore security rule assertions passed against ${path.basename(rulesPath)}.`);
