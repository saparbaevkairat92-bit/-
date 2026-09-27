import { Router } from 'express';
import QRCode from 'qrcode';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
import { trackPayment } from '../polling.js';
import { requireAuth, trackingHeaders } from '../middleware/auth.js';
import { idempotent } from '../idempotency.js';
import { parseAmount, parseCoordinate, parseOperationId, validated, ValidationError } from '../validation.js';

const router = Router();

// Default POS location (Almaty) — override per request or via env
const DEFAULT_LAT = Number(process.env.POS_LATITUDE) || 43.204643483375889;
const DEFAULT_LON = Number(process.env.POS_LONGITUDE) || 76.891962364115912;

// Only Kaspi payment links may be rendered, so the endpoint cannot be used as a generic QR service
const KASPI_QR_PREFIXES = ['https://qr.kaspi.kz/', 'https://pay.kaspi.kz/'];

// ─── Render a Kaspi QR locally (SVG / PNG) — no third-party QR services ───
// Placed before requireAuth so an <img src> can load it; it only encodes the given Kaspi link.

router.get(
  '/image',
  validated(async (req, res) => {
    const data = String(req.query.data || '');
    if (!KASPI_QR_PREFIXES.some((p) => data.startsWith(p)) || data.length > 512)
      throw new ValidationError('data must be a Kaspi QR link');
    const size = Math.min(Math.max(Number(req.query.size) || 256, 64), 1024);
    const opts = { errorCorrectionLevel: 'M', margin: 2, width: size };
    res.setHeader('Cache-Control', 'private, max-age=600');
    if (req.query.format === 'png') {
      res.type('png').send(await QRCode.toBuffer(data, opts));
    } else {
      res.type('image/svg+xml').send(await QRCode.toString(data, { ...opts, type: 'svg' }));
    }
  }),
);

router.use(requireAuth);

// ─── Create QR token ───

router.post(
  '/create',
  idempotent,
  validated(async (req, res) => {
    const amount = parseAmount(req.body.amount);
    const url = `${KASPI_QRPAY_URL}/v01/qr-token/create`;
    const payload = JSON.stringify({
      PaymentAmount: amount,
      DeviceInterface: 'Pos',
      Latitude: parseCoordinate(req.body.latitude, -90, 90) ?? DEFAULT_LAT,
      Longitude: parseCoordinate(req.body.longitude, -180, 180) ?? DEFAULT_LON,
    });
    const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
    const resp = await loggedFetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    const kaspiResponse = await resp.json();
    const d = kaspiResponse.Data;
    if (d && d.QrOperationId) {
      const opts = d.QrPaymentBehaviorOptions || {};
      trackPayment(d.QrOperationId, 'qr', trackingHeaders(req), {
        qrToken: d.QrToken,
        expireDate: d.ExpireDate,
        receiptUrl: d.ReceiptUrl,
        amount: d.Amount ?? amount,
        orderNumber: req.body.orderNumber ? String(req.body.orderNumber).slice(0, 64) : undefined,
        pollingIntervals: {
          scanWaitTimeout: Number(opts.qrCodeScanWaitTimeout) || 180,
          scanPollingInterval: Number(opts.qrCodeScanEventPollingInterval) || 3,
          statusCountdown: Number(opts.paymentStatusCountdown) || 2,
          confirmationTimeout: Number(opts.paymentConfirmationTimeout) || 65,
        },
      });
    }
    if (d && d.QrToken) {
      d.QrOriginalToken = d.QrToken;
      d.QrToken = d.QrToken.replace('https://qr.kaspi.kz/', 'https://pay.kaspi.kz/pay/');
      if (req.query.withImage === '1' || req.body.withImage === true) {
        d.QrSvg = await QRCode.toString(d.QrOriginalToken, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      }
    }
    res.json(kaspiResponse);
  }),
);

// ─── QR payment status ───

router.get(
  '/status',
  validated(async (req, res) => {
    const qrOperationId = parseOperationId(req.query.qrOperationId, 'qrOperationId');
    const url = `${KASPI_QRPAY_URL}/v02/kaspi-qr/status?qrOperationId=${qrOperationId}`;
    const resp = await loggedFetch(url, { headers: signedQrPayHeaders(url, req.session) });
    res.json(await resp.json());
  }),
);

export default router;
