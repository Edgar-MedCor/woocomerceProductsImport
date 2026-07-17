function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function isEmpty(value) {
  return cleanText(value) === '';
}

function toNumber(value, fallback = null) {
  const text = cleanText(value).replace(/,/g, '');
  if (!text) return fallback;
  const num = Number(text);
  return Number.isFinite(num) ? num : fallback;
}

function splitList(value) {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(',')
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function splitAttributeValues(value) {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split('|')
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function slugify(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = {
  cleanText,
  isEmpty,
  toNumber,
  splitList,
  splitAttributeValues,
  slugify,
};
