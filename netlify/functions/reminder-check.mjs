// Hourly payment reminder scan (replaces the in-process node-cron job from the
// standalone Express deployment — Netlify Servers scale to zero, so recurring
// work runs here instead).
process.env.TZ = process.env.TZ || 'Africa/Addis_Ababa';

export default async () => {
  const { initDatabase } = await import('../../config/db.js');
  const { runReminderCheck } = await import('../../services/reminderService.js');
  await initDatabase();
  const result = await runReminderCheck();
  return Response.json({ ok: true, result });
};

export const config = {
  schedule: '@hourly',
};
