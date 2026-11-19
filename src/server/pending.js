// Revisiones pendientes POR USUARIO (cada quien sube la suya). Cuando alguien
// trae, sube o deshace, las revisiones de los demás quedan viejas: se descartan y
// al intentar subir se les explica por qué.
function pendingStore() {
  const reviews = new Map();
  const stale = new Map();
  return {
    set(userId, value) { reviews.set(String(userId), value); stale.delete(String(userId)); },
    has(userId) { return reviews.has(String(userId)); },
    take(userId) {
      const value = reviews.get(String(userId)) || null;
      reviews.delete(String(userId));
      return value;
    },
    invalidate(reason, exceptUserId = null) {
      for (const id of [...reviews.keys()]) {
        if (id === String(exceptUserId)) continue;
        reviews.delete(id);
        stale.set(id, reason);
      }
    },
    missingMessage(userId, action) {
      const reason = stale.get(String(userId));
      return reason
        ? `Tu revisión ya no sirve: ${reason} después de que revisaste. Vuelve a "${action}".`
        : `Primero haz "${action}".`;
    },
  };
}

module.exports = { pendingStore };
