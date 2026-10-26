const fs = require('fs');
const path = require('path');
const { PublicClientApplication } = require('@azure/msal-node');
const config = require('../config');

const CACHE_FILE = path.join(config.STATE_DIR, 'msal-cache.json');

const cachePlugin = {
  async beforeCacheAccess(ctx) {
    if (fs.existsSync(CACHE_FILE)) ctx.tokenCache.deserialize(fs.readFileSync(CACHE_FILE, 'utf8'));
  },
  async afterCacheAccess(ctx) {
    if (!ctx.cacheHasChanged) return;
    fs.mkdirSync(config.STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, ctx.tokenCache.serialize(), { mode: 0o600 });
  },
};

let app;
function getApp() {
  app ??= new PublicClientApplication({
    auth: { clientId: config.ms.clientId(), authority: config.ms.authority },
    cache: { cachePlugin },
  });
  return app;
}

// Inicio de sesión interactivo con código (una sola vez por equipo/servidor).
// `onCode` recibe { userCode, verificationUri, message, expiresIn }.
async function login(onCode = (r) => console.log(`\n${r.message}\n`)) {
  const result = await getApp().acquireTokenByDeviceCode({
    scopes: config.ms.scopes,
    deviceCodeCallback: onCode,
  });
  // Una sola cuenta conectada: la recién iniciada reemplaza a cualquier otra
  // (si no, el panel podría seguir usando la anterior).
  const cache = getApp().getTokenCache();
  for (const other of await cache.getAllAccounts()) {
    if (other.homeAccountId !== result.account.homeAccountId) await cache.removeAccount(other);
  }
  return result.account;
}

async function getAccount() {
  const [account] = await getApp().getTokenCache().getAllAccounts();
  return account || null;
}

async function logout() {
  const account = await getAccount();
  if (account) await getApp().getTokenCache().removeAccount(account);
}

// Token silencioso usando la sesión guardada; MSAL lo renueva solo.
async function getAccessToken() {
  const [account] = await getApp().getTokenCache().getAllAccounts();
  if (!account) throw new Error('No hay sesión de Microsoft. Ejecuta primero: npm run login');
  try {
    const result = await getApp().acquireTokenSilent({ account, scopes: config.ms.scopes });
    return result.accessToken;
  } catch (error) {
    throw new Error(`La sesión de Microsoft expiró o fue revocada (${error.errorCode || error.message}). Ejecuta: npm run login`);
  }
}

module.exports = { login, logout, getAccount, getAccessToken };
