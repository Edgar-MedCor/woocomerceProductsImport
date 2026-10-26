const express = require('express');
const config = require('../../config');
const microsoft = require('../../auth/microsoft');
const onedrive = require('../../storage/onedrive');
const { getApi } = require('../../woo/client');

const router = express.Router();

// Inicio de sesión de Microsoft en curso (código que el admin debe escribir).
let pendingLogin = null;

router.get('/', async (_req, res) => {
  const result = { onedrive: { connected: false }, woo: { url: process.env.WOO_URL || null, ok: false } };

  try {
    const account = await microsoft.getAccount();
    if (account) {
      const me = await onedrive.me();
      result.onedrive = { connected: true, user: me.displayName, email: me.userPrincipalName || me.mail, excelPath: config.excelPath() };
      result.onedrive.root = await onedrive.describeRoot().catch((error) => ({ error: error.message }));
    }
  } catch (error) {
    result.onedrive = { connected: false, error: error.message };
  }
  if (pendingLogin) result.onedrive.pending = pendingLogin.code;

  try {
    await getApi().get('system_status/tools', {}); // petición ligera que exige llaves válidas
    result.woo.ok = true;
  } catch (error) {
    result.woo.error = error.response?.data?.message || error.message;
  }

  res.json({ ok: true, ...result });
});

// Arranca el inicio de sesión con código y responde en cuanto Microsoft da el código.
router.post('/onedrive/connect', async (_req, res, next) => {
  try {
    if (pendingLogin?.code) return res.json({ ok: true, code: pendingLogin.code });
    pendingLogin = { code: null, error: null };

    const codeReady = new Promise((resolve) => {
      microsoft.login((r) => {
        pendingLogin.code = { userCode: r.userCode, verificationUri: r.verificationUri, expiresIn: r.expiresIn };
        resolve();
      })
        .then(() => { pendingLogin = null; })
        .catch((error) => {
          console.error('Inicio de sesión de Microsoft falló:', error.message);
          pendingLogin = null;
          resolve();
        });
    });

    await codeReady;
    if (!pendingLogin?.code) return res.status(500).json({ ok: false, message: 'Microsoft no entregó el código de inicio de sesión.' });
    res.json({ ok: true, code: pendingLogin.code });
  } catch (error) {
    pendingLogin = null;
    next(error);
  }
});

router.post('/onedrive/disconnect', async (_req, res, next) => {
  try {
    await microsoft.logout();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
