-- Insert old student records from db.json
INSERT INTO students (id, name, rollNumber, course, semester, feeAmount, dueDate, paymentMethod) VALUES 
('29ceb906-dda9-44d9-8bde-354b9c0ac663', 'Rravulakari Ajay', '23UEAE0044', 'B.Tech CSE', '6', 42000, '2026-03-03', 'Cash'),
('bd9e76ed-83ac-44b9-abeb-d81195bedc81', 'R.Veerabhadra', '23UEDC0053', 'B.Tech CSE', '6', 98750, '2026-12-15', 'UPI'),
('913bfd2b-34fe-4d31-99a5-e0672b70e2dd', 'D.Vivek', '23UEDC0014', 'B.Tech CSE', '6', 111000, '2026-06-12', 'UPI');

-- Insert old transaction records from db.json
INSERT INTO transactions (id, transactionId, studentId, amountPaid, paymentDate, mode, notes, receiptNumber, billNumber, upiNumber, upiTransactionId, bankTransactionId) VALUES 
('4dc114b3-6928-4554-bc9c-7cc0899b0603', 'TXN-MMCZRKGJ', '913bfd2b-34fe-4d31-99a5-e0672b70e2dd', 40000, '2026-03-05', 'UPI', '', '', '', '8360692272@ybl', '', ''),
('86b50e6c-29f7-43b3-9696-e76aa6dd6ba2', 'TXN-MMCZ1JEI', 'bd9e76ed-83ac-44b9-abeb-d81195bedc81', 49900, '2026-03-05', 'Card', 'paid', '', 'BILL-TXN-40325', '', '', ''),
('81ff5567-4502-443d-941d-06adda466cb2', 'TXN-MMCYPJHH', 'bd9e76ed-83ac-44b9-abeb-d81195bedc81', 48850, '2026-03-18', 'Cash', '', 'RCP-2026-011', '', '', '', ''),
('036168db-99cc-48da-8dea-217f2ea0f585', 'TXN-MMAXEQTQ', '29ceb906-dda9-44d9-8bde-354b9c0ac663', 42000, '2026-03-03', 'Cash', '', '', '', '', '', ''),
('1e564acb-2ac8-484e-984b-a69c4acd537e', 'TXN-MMCZSU7Z', '913bfd2b-34fe-4d31-99a5-e0672b70e2dd', 40000, '2026-03-05', 'UPI', '', '', '', '8360692272@ybl', '124736849836839', '');
