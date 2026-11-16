const express = require('express');
const { authenticate } = require('../middleware/auth');
const { CHATBOT_ROLES, sendMultiTurnChat, streamMultiTurnChat } = require('../services/geminiService');
const { buildAssistantContext, executeAssistantTool } = require('../services/aiToolExecutor');

const router = express.Router();

router.use(authenticate);

router.get('/roles', (_req, res) => {
  const roles = Object.values(CHATBOT_ROLES).map((r) => ({
    id: r.id,
    label: r.label,
    model: r.model,
    useTools: Boolean(r.useTools),
    useSearchGrounding: Boolean(r.useSearchGrounding),
  }));
  res.json({ roles });
});

router.post('/message', async (req, res) => {
  try {
    const { message, history = [], roleId = 'fee_advisor' } = req.body || {};
    const context = await buildAssistantContext(req.user);

    const result = await sendMultiTurnChat({
      message,
      history,
      roleId,
      context,
      toolExecutor: (name, args) => executeAssistantTool(name, args, req.user),
    });

    res.json(result);
  } catch (err) {
    const status = err.status || (err.message && err.message.includes('API key') ? 503 : 500);
    res.status(status).json({
      error: err.message || 'Unable to generate assistant response.',
    });
  }
});

// Server-Sent Events (SSE) Streaming Endpoint
router.post('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const writeEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { message, history = [], roleId = 'fee_advisor' } = req.body || {};
    const context = await buildAssistantContext(req.user);

    const result = await streamMultiTurnChat({
      message,
      history,
      roleId,
      context,
      toolExecutor: (name, args) => executeAssistantTool(name, args, req.user),
      onEvent: writeEvent,
    });

    writeEvent('done', result);
    res.end();
  } catch (err) {
    writeEvent('error', {
      error: err.message || 'Unable to stream assistant response.',
      status: err.status || 500,
    });
    res.end();
  }
});

module.exports = router;
