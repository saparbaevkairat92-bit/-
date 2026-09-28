import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeConfig,
  publicConfig,
  render,
  orderContext,
  customerPhone,
  maskPhone,
  dueEvents,
  DEFAULT_TEMPLATES,
  EVENT_NEW,
  EVENT_ISSUED,
  SmsError,
} from '../src/marketplace/customerSms.js';

describe('mergeConfig', () => {
  it('sets the start point once, on enable', () => {
    let cfg = mergeConfig({}, { enabled: true, apiKey: 'k' }, 100);
    assert.equal(cfg.enabledAtMs, 100);
    cfg = mergeConfig(cfg, { shopName: 'X' }, 200);
    assert.equal(cfg.enabledAtMs, 100); // правка текста не сдвигает
    cfg = mergeConfig(cfg, { enabled: false }, 300);
    cfg = mergeConfig(cfg, { enabled: true, apiKey: 'k' }, 400);
    assert.equal(cfg.enabledAtMs, 400); // повторное включение — с нуля
  });

  it('empty key keeps the old one and never exposes it', () => {
    const cfg = mergeConfig({ apiKey: 'secret-9876' }, { apiKey: '' }, 1);
    assert.equal(cfg.apiKey, 'secret-9876');
    const pub = publicConfig(cfg);
    assert.ok(!JSON.stringify(pub).includes('secret-9876'));
    assert.equal(pub.apiKeyHint, '••••9876');
  });

  it('validates provider and required fields', () => {
    assert.throws(() => mergeConfig({}, { enabled: true }, 1), /ключ/);
    assert.throws(() => mergeConfig({}, { enabled: true, apiKey: 'k', provider: 'smsc' }, 1), /логин/);
    assert.throws(() => mergeConfig({}, { provider: 'whatsapp' }, 1), SmsError);
  });
});

describe('render', () => {
  it('substitutes placeholders and capitalizes', () => {
    assert.equal(
      render(DEFAULT_TEMPLATES[EVENT_NEW], { name: 'Айгерим', order: '555', shop: 'Kaizen' }),
      'Здравствуйте, Айгерим! Ваш заказ №555 в магазине Kaizen принят. Спасибо за покупку!',
    );
  });

  it('reads naturally without a name', () => {
    assert.ok(render(DEFAULT_TEMPLATES[EVENT_NEW], { order: '1' }).startsWith('Здравствуйте! Ваш'));
    assert.ok(render(DEFAULT_TEMPLATES[EVENT_ISSUED], { order: '1' }).startsWith('Заказ №1 выдан'));
  });

  it('does not crash on stray braces', () => {
    assert.equal(render('{oops} №{order}', { order: '7' }), '{oops} №7');
  });
});

describe('order helpers', () => {
  it('builds context with a formatted sum', () => {
    const ctx = orderContext({ code: '555', totalPrice: 15990, customer: { firstName: 'Айгерим' } }, 'Kaizen');
    assert.equal(ctx.name, 'Айгерим');
    assert.equal(ctx.order, '555');
    assert.equal(ctx.shop, 'Kaizen');
    assert.match(ctx.sum, /15\s?990\s₸/);
  });

  it('reads and masks the phone, rejects junk', () => {
    assert.equal(customerPhone({ customer: { cellPhone: '8 701 234 56 78' } }), '+77012345678');
    assert.equal(customerPhone({ customer: {} }), null);
    assert.equal(customerPhone({ customer: { cellPhone: '12' } }), null);
    assert.equal(maskPhone('+77012345678'), '+7701•••5678');
  });
});

describe('dueEvents', () => {
  it('respects the per-event toggles', () => {
    assert.deepEqual(dueEvents({}), [EVENT_NEW, EVENT_ISSUED]);
    assert.deepEqual(dueEvents({ notifyNew: false }), [EVENT_ISSUED]);
    assert.deepEqual(dueEvents({ notifyIssued: false }), [EVENT_NEW]);
  });
});

describe('channel — чат Kaspi или SMS', () => {
  it('chat-only does not need an SMS key', () => {
    const cfg = mergeConfig({}, { enabled: true, channel: 'chat' }, 1);
    assert.equal(cfg.channel, 'chat');
    assert.equal(publicConfig(cfg).channel, 'chat');
  });
  it('SMS and chat+SMS still need the key', () => {
    assert.throws(() => mergeConfig({}, { enabled: true, channel: 'chat_sms' }, 1), SmsError);
    assert.throws(() => mergeConfig({}, { enabled: true, channel: 'fax' }, 1), SmsError);
  });
});
