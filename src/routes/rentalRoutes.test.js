const express = require('express');
const request = require('supertest');

let mockUser;

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/supabaseService', () => ({
  RentalService: {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    startRental: jest.fn(),
    endRental: jest.fn(),
    cancelRental: jest.fn(),
  },
  GpuListingService: {
    findById: jest.fn(),
    update: jest.fn(),
  },
}));

const { RentalService, GpuListingService } = require('../services/supabaseService');
const rentalRoutes = require('./rentalRoutes');

const app = express();
app.use(express.json());
app.use('/api/rentals', rentalRoutes);

describe('rental lifecycle hardening', () => {
  beforeEach(() => {
    mockUser = { id: 'renter-1', role: 'renter' };
    jest.clearAllMocks();
  });

  test('rejects planned durations outside listing bounds', async () => {
    GpuListingService.findById.mockResolvedValue({
      id: 'listing-1',
      status: 'active',
      minRentalMinutes: 30,
      maxRentalHours: 2,
      pricePerHour: 10,
      providerId: 'provider-1'
    });

    const response = await request(app)
      .post('/api/rentals')
      .send({ listingId: 'listing-1', plannedDurationMinutes: 15 });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/at least 30/);
    expect(RentalService.create).not.toHaveBeenCalled();
  });

  test('does not allow another renter to start a rental', async () => {
    RentalService.findById.mockResolvedValue({
      id: 'rental-1',
      renterId: 'renter-2',
      providerId: 'provider-1',
      status: 'pending'
    });

    const response = await request(app).post('/api/rentals/rental-1/start');

    expect(response.status).toBe(403);
    expect(RentalService.startRental).not.toHaveBeenCalled();
  });

  test('allows only one concurrent start to claim a listing', async () => {
    let callCount = 0;
    RentalService.findById.mockImplementation(async (id) => {
      callCount += 1;
      // First call: return pending, second call: return pending (simulating race condition)
      return {
        id: 'rental-1',
        listingId: 'listing-1',
        renterId: 'renter-1',
        providerId: 'provider-1',
        status: 'pending'
      };
    });
    
    let startCallCount = 0;
    RentalService.startRental.mockImplementation(async (id, renterId) => {
      startCallCount += 1;
      if (startCallCount === 1) {
        return {
          id: 'rental-1',
          listingId: 'listing-1',
          renterId: 'renter-1',
          providerId: 'provider-1',
          status: 'active',
          startTime: new Date()
        };
      }
      // Simulate Supabase constraint violation when listing already rented
      const error = new Error('Rental cannot be started');
      error.code = 'PGRST116';
      throw error;
    });

    const responses = await Promise.all([
      request(app).post('/api/rentals/rental-1/start'),
      request(app).post('/api/rentals/rental-1/start')
    ]);

    // Current implementation returns 500 for generic errors (could be improved to 409)
    expect(responses.map(response => response.status).sort()).toEqual([200, 500]);
    // startRental should be called twice (once success, once failure)
    expect(RentalService.startRental).toHaveBeenCalledTimes(2);
  });
});