// Order routes: auth scoping, idempotency plumbing and stable error codes.
let mockUser;

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    if (!mockUser) return res.status(401).json({ message: 'No token' });
    req.user = mockUser;
    next();
  },
  renterAuth: (req, res, next) => {
    if (!mockUser) return res.status(401).json({ message: 'No token' });
    if (!['renter', 'admin'].includes(mockUser.role)) {
      return res.status(403).json({ message: 'Access denied. Renter only.' });
    }
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/orderService', () => {
  class OrderError extends Error {
    constructor(message, code = 'order_error', status = 400, extra = {}) {
      super(message);
      this.code = code;
      this.status = status;
      this.extra = extra;
    }
  }
  class OrdersUnavailable extends OrderError {
    constructor() {
      super('Orders are not available on this deployment yet (migration 013 not applied).',
        'orders_unavailable', 503);
    }
  }
  return {
    OrderError,
    OrdersUnavailable,
    createDraft: jest.fn(),
    listOrders: jest.fn(),
    getOrder: jest.fn(),
    reserve: jest.fn(),
    pay: jest.fn(),
    cancel: jest.fn()
  };
});

jest.mock('../services/idempotencyService', () => {
  class IdempotencyError extends Error {
    constructor(message, code = 'idempotency_error', status = 409, extra = {}) {
      super(message);
      this.code = code;
      this.status = status;
      this.extra = extra;
    }
  }
  return {
    IdempotencyError,
    run: jest.fn()
  };
});

const express = require('express');
const request = require('supertest');

const orders = require('../services/orderService');
const idempotency = require('../services/idempotencyService');
const orderRoutes = require('./orderRoutes');

const app = express();
app.use(express.json());
app.use('/api/orders', orderRoutes);

const ORDER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORDER = { id: ORDER_ID, status: 'draft', items: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'renter-1', role: 'renter' };
  // Pass-through: the real replay/conflict logic has its own test file.
  idempotency.run.mockImplementation(async ({ handler }) => {
    const result = await handler();
    return { replay: false, ...result };
  });
});

describe('POST /api/orders', () => {
  test('creates a draft for a renter and forwards the key', async () => {
    orders.createDraft.mockResolvedValue(ORDER);

    const res = await request(app)
      .post('/api/orders')
      .set('Idempotency-Key', 'key-12345678')
      .send({ items: [{ listingId: 'l-1', plannedDurationMinutes: 60 }] });

    expect(res.status).toBe(201);
    expect(res.body.order.id).toBe(ORDER_ID);
    expect(orders.createDraft).toHaveBeenCalledWith({
      renterId: 'renter-1',
      items: [{ listingId: 'l-1', plannedDurationMinutes: 60 }]
    });
    expect(idempotency.run).toHaveBeenCalledWith(expect.objectContaining({
      key: 'key-12345678',
      scope: 'orders.create',
      userId: 'renter-1'
    }));
  });

  test('a provider cannot create a renter order', async () => {
    mockUser = { id: 'provider-1', role: 'provider' };

    const res = await request(app)
      .post('/api/orders')
      .set('Idempotency-Key', 'key-12345678')
      .send({ items: [] });

    expect(res.status).toBe(403);
    expect(orders.createDraft).not.toHaveBeenCalled();
  });

  test('a missing key is a 400 with a stable code', async () => {
    idempotency.run.mockRejectedValue(
      new idempotency.IdempotencyError('A valid Idempotency-Key header is required', 'idempotency_key_required', 400)
    );

    const res = await request(app).post('/api/orders').send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  test('a replayed answer is marked so the client can tell', async () => {
    orders.createDraft.mockResolvedValue(ORDER);
    idempotency.run.mockResolvedValue({ replay: true, status: 201, body: { success: true, order: ORDER } });

    const res = await request(app)
      .post('/api/orders')
      .set('Idempotency-Key', 'key-12345678')
      .send({ items: [{ listingId: 'l-1', plannedDurationMinutes: 60 }] });

    expect(res.status).toBe(201);
    expect(res.get('Idempotent-Replay')).toBe('true');
    expect(orders.createDraft).not.toHaveBeenCalled();
  });
});

describe('GET /api/orders', () => {
  test('lists only the caller’s orders', async () => {
    orders.listOrders.mockResolvedValue({ orders: [ORDER], pagination: { page: 1, limit: 20, total: 1, pages: 1 } });

    const res = await request(app).get('/api/orders?page=2&limit=5&status=draft');

    expect(res.status).toBe(200);
    expect(orders.listOrders).toHaveBeenCalledWith('renter-1', { page: '2', limit: '5', status: 'draft' });
  });

  test('rejects a malformed order id before touching the service', async () => {
    const res = await request(app).get('/api/orders/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_order_id');
    expect(orders.getOrder).not.toHaveBeenCalled();
  });
});

describe('order mutations', () => {
  test('reserve passes the TTL through', async () => {
    orders.reserve.mockResolvedValue(ORDER);

    const res = await request(app)
      .post(`/api/orders/${ORDER_ID}/reserve`)
      .set('Idempotency-Key', 'key-12345678')
      .send({ ttlSeconds: 300 });

    expect(res.status).toBe(200);
    expect(orders.reserve).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      renterId: 'renter-1',
      ttlSeconds: 300
    });
  });

  test('a busy machine keeps its item and listing ids', async () => {
    orders.reserve.mockRejectedValue(
      new orders.OrderError('A machine is already reserved', 'listing_busy', 409, { itemId: 'item-1', listingId: 'l-1' })
    );

    const res = await request(app)
      .post(`/api/orders/${ORDER_ID}/reserve`)
      .set('Idempotency-Key', 'key-12345678')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'listing_busy', itemId: 'item-1', listingId: 'l-1' });
  });

  test('a stale quote returns the new order so the app can show it', async () => {
    const refreshed = { ...ORDER, total: 7.5 };
    orders.reserve.mockRejectedValue(
      new orders.OrderError('Prices changed', 'quote_stale', 409, { order: refreshed })
    );

    const res = await request(app)
      .post(`/api/orders/${ORDER_ID}/reserve`)
      .set('Idempotency-Key', 'key-12345678')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('quote_stale');
    expect(res.body.order.total).toBe(7.5);
  });

  test('pay answers 503 while migration 013 is pending', async () => {
    orders.pay.mockRejectedValue(new orders.OrdersUnavailable());

    const res = await request(app)
      .post(`/api/orders/${ORDER_ID}/pay`)
      .set('Idempotency-Key', 'key-12345678')
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('orders_unavailable');
  });

  test('a partial cancel forwards the selected item ids', async () => {
    orders.cancel.mockResolvedValue({ ...ORDER, total: 4 });

    const res = await request(app)
      .post(`/api/orders/${ORDER_ID}/cancel`)
      .set('Idempotency-Key', 'key-12345678')
      .send({ itemIds: ['item-2'] });

    expect(res.status).toBe(200);
    expect(orders.cancel).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      renterId: 'renter-1',
      itemIds: ['item-2']
    });
  });
});
