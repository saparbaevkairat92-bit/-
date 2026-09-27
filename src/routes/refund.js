import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { idempotent } from '../idempotency.js';
import { parseAmount, parseOperationId, validated } from '../validation.js';
import { logger } from '../logger.js';

const router = Router();

router.use(requireAuth);

// ─── Return (refund) ───

router.post(
  '/create',
  idempotent,
  validated(async (req, res) => {
    const qrOperationId = parseOperationId(req.body.qrOperationId, 'qrOperationId');
    const returnAmount = parseAmount(req.body.returnAmount, 'returnAmount');
    const url = `${KASPI_QRPAY_URL}/v01/kaspi-qr/history-pos-return`;
    const payload = JSON.stringify({
      ReturnAmount: returnAmount,
      QrOperationId: Number(qrOperationId),
      DeviceInterface: 'Pos',
    });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    const body = await resp.json();
    logger.info(
      'REFUND',
      `Refund ${returnAmount} for operation ${qrOperationId} → StatusCode ${body.StatusCode ?? resp.status}`,
    );
    res.json(body);
  }),
);

export default router;
