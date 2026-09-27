// ─── Input validation for payment requests ───

export const MAX_AMOUNT = Number(process.env.MAX_PAYMENT_AMOUNT) || 10_000_000;

export class ValidationError extends Error {}

// Positive amount in tenge with at most 2 decimals
export const parseAmount = (value, field = 'amount') => {
  if (value === undefined || value === null || value === '') throw new ValidationError(`${field} required`);
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.').trim());
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError(`${field} must be a positive number`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6)
    throw new ValidationError(`${field} must have at most 2 decimal places`);
  if (n > MAX_AMOUNT) throw new ValidationError(`${field} must not exceed ${MAX_AMOUNT}`);
  return n;
};

// Kazakhstan phone → 10 digits without the country code (as the Kaspi API expects)
export const normalizePhone = (value, field = 'phoneNumber') => {
  if (!value) throw new ValidationError(`${field} required`);
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) digits = digits.slice(1);
  if (digits.length !== 10) throw new ValidationError(`${field} must contain 10 digits (e.g. 7071234567)`);
  return digits;
};

export const parseOperationId = (value, field = 'operationId') => {
  if (value === undefined || value === null || value === '') throw new ValidationError(`${field} required`);
  const s = String(value).trim();
  if (!/^\d{1,20}$/.test(s)) throw new ValidationError(`${field} must be a numeric id`);
  return s;
};

export const parseCoordinate = (value, min, max) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// Wraps a route so ValidationError becomes a 400 response
export const validated = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
    res.status(500).json({ error: err.message });
  }
};
