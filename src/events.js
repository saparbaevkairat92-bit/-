import { EventEmitter } from 'events';

// In-process bus for payment status changes (consumed by SSE clients)
export const paymentEvents = new EventEmitter();
paymentEvents.setMaxListeners(0);
