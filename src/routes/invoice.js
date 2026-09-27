import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { trackPayment } from '../polling.js';
import { requireAuth, trackingHeaders } from '../middleware/auth.js';
import { idempotent } from '../idempotency.js';
import { normalizePhone, parseAmount, parseOperationId, validated } from '../validation.js';

const router = Router();

router.use(requireAuth);

const MAX_COMMENT_LENGTH = 200;

// ─── Client info ───

router.get(
  '/client-info',
  validated(async (req, res) => {
    const phoneNumber = normalizePhone(req.query.phoneNumber);
    const url = `${KASPI_QRPAY_URL}/v01/remote/client-info?phoneNumber=${phoneNumber}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  }),
);

// ─── Create invoice ───

router.post(
  '/create',
  idempotent,
  validated(async (req, res) => {
    const phoneNumber = normalizePhone(req.body.phoneNumber);
    const amount = parseAmount(req.body.amount);
    const comment = String(req.body.comment || '').slice(0, MAX_COMMENT_LENGTH);

    const url = `${KASPI_QRPAY_URL}/v01/remote/create`;
    const payload = JSON.stringify({ PhoneNumber: phoneNumber, Amount: amount, Comment: comment });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    const kaspiResponse = await resp.json();
    const d = kaspiResponse.Data;
    if (d && d.QrOperationId) {
      trackPayment(d.QrOperationId, 'invoice', trackingHeaders(req), {
        amount: d.Amount ?? amount,
        clientMobile: d.ClientMobile,
        receiptUrl: d.ReceiptUrl,
        orderNumber: d.OrderNumber,
      });
    }
    res.json(kaspiResponse);
  }),
);

// ─── Invoice details ───

router.get(
  '/details',
  validated(async (req, res) => {
    const operationId = parseOperationId(req.query.operationId);
    const url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${operationId}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  }),
);

// ─── Cancel invoice ───

router.post(
  '/cancel',
  validated(async (req, res) => {
    const operationId = parseOperationId(req.body.operationId);
    const url = `${KASPI_QRPAY_URL}/v01/remote/cancel`;
    const payload = JSON.stringify({ qrOperationId: Number(operationId) });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    res.json(await resp.json());
  }),
);

// ─── Invoice history ───

router.post(
  '/history',
  validated(async (req, res) => {
    const maxResult = Math.min(Math.max(Number(req.body?.maxResult) || 20, 1), 100);
    const url = `${KASPI_QRPAY_URL}/v01/remote/history`;
    const payload = JSON.stringify({ MaxResult: maxResult });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    res.json(await resp.json());
  }),
);

export default router;
