const request = require('supertest');
const { app } = require('./server');

describe('server foundation', () => {
  test('reports service health', async () => {
    const response = await request(app).get('/health');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      status: 'ok'
    }));
  });

  test('returns a JSON 404 response for unknown routes', async () => {
    const response = await request(app).get('/not-a-route');

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: 'Route not found'
    });
  });
});
